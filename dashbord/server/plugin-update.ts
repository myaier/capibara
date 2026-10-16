import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { applyUpdate, changelogSince, dismissUpdate, getUpdate, OBSERVATORY_PLUGIN_ID, OBSERVATORY_VERSION, type UpdateState } from "../shared/plugin-update";
import { t } from "../shared/text";
import type { ProviderBridge } from "./provider-subagents";
import { telemetryDirectory } from "./telemetry";

type Bridge = Pick<ProviderBridge, "request">;
export type GitRunner = (args: string[]) => Promise<string>;
type Preview = { outcome?: string; error?: string; current?: { identity?: { kind?: string; remote?: string; pluginPath?: string }; currentRevision?: string };
  target?: { kind?: string; commit?: string }; proposal?: unknown };
const CHECK_INTERVAL_MS = 30 * 60_000, JUST_UPDATED_MS = 30 * 60_000;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 400);

export function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/**
 * Paseo has no plugin auto-update: its reviewed preview/apply requests are the only way to replace an installation. This
 * previews the installation's own source every 30 minutes while a panel asks, reads the target's changelog from a private
 * shallow copy, and applies only the revision the person reviewed. The apply restarts this process, so its answer may never
 * arrive; the panel recognises success by the new revision.
 */
export class PluginUpdates {
  private closed = false;
  private checking: Promise<void> | null = null;
  private checkedAt = 0;
  private revision: string | null = null;
  private available: UpdateState["available"] = null;
  private error: string | null = null;
  private updating: UpdateState["updating"] = null;
  private dismissed: string | null = null;
  /** The update this installation last started. The process it restarts into reports it once the new revision runs. */
  private applied: { commit: string; from: string; startedAt: string } | null = null;
  private loaded: Promise<void>;
  constructor(private bridge: Bridge, private directory = telemetryDirectory(), private git: GitRunner = runGit, private now = Date.now) {
    this.loaded = readFile(join(directory, "update.json"), "utf8").then(text => {
      const stored = record(JSON.parse(text)), applied = record(stored.applied);
      this.dismissed = typeof stored.dismissed === "string" ? stored.dismissed : null;
      if (typeof applied.commit === "string" && typeof applied.from === "string" && typeof applied.startedAt === "string")
        this.applied = { commit: applied.commit, from: applied.from, startedAt: applied.startedAt };
    }).catch(() => {});
  }

  async get(refresh = false): Promise<UpdateState> {
    await this.loaded;
    if (!this.checking && (refresh || !this.checkedAt || this.now() - this.checkedAt >= CHECK_INTERVAL_MS)) {
      this.checking = this.check().finally(() => { this.checking = null; });
    }
    return this.snapshot();
  }
  async dismiss(commit: string): Promise<UpdateState> {
    await this.loaded;
    this.dismissed = commit;
    await this.save();
    return this.snapshot();
  }
  async apply(commit: string): Promise<UpdateState> {
    if (this.closed) throw new Error(t("pluginUpdate.unavailable"));
    if (this.updating && !this.updating.error) return this.snapshot();
    const preview = await this.preview();
    if (preview.outcome !== "update" || preview.target?.commit !== commit || !preview.proposal) throw new Error(t("pluginUpdate.changed"));
    const updating = { commit, startedAt: new Date(this.now()).toISOString(), error: null as string | null };
    this.updating = updating;
    this.applied = { commit, from: OBSERVATORY_VERSION, startedAt: updating.startedAt };
    await this.save().catch(() => {});
    // Building and verifying the new revision can take minutes; success stops this process before the answer.
    void this.bridge.request({ type: "plugin.source.update.apply.request", proposals: [preview.proposal] }, "plugin.source.update.apply.response", 10 * 60_000)
      .then(payload => {
        const result = record((payload.plugins as unknown[] | undefined)?.find(item => record(item).id === OBSERVATORY_PLUGIN_ID));
        if (result.outcome !== "updated") updating.error = typeof result.error === "string" ? result.error.slice(0, 400) : t("pluginUpdate.failed");
      })
      .catch(error => { updating.error = message(error); });
    return this.snapshot();
  }
  close() { this.closed = true; }
  private async save() {
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, "update.json"), temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ dismissed: this.dismissed, applied: this.applied }), { mode: 0o600 });
    await rename(temporary, file);
  }

  private snapshot(): UpdateState {
    return { version: OBSERVATORY_VERSION, revision: this.revision, available: this.available,
      dismissed: !!this.available && this.available.commit === this.dismissed, checking: !!this.checking,
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null, error: this.error, updating: this.updating,
      justUpdated: !this.updating && this.applied && this.revision === this.applied.commit && this.now() - Date.parse(this.applied.startedAt) < JUST_UPDATED_MS
        ? { from: this.applied.from, to: OBSERVATORY_VERSION, commit: this.applied.commit, startedAt: this.applied.startedAt } : null };
  }
  private async preview(): Promise<Preview> {
    const payload = await this.bridge.request({ type: "plugin.source.update.preview.request", pluginId: OBSERVATORY_PLUGIN_ID }, "plugin.source.update.preview.response", 60_000);
    const preview = record((payload.plugins as unknown[] | undefined)?.find(item => record(item).id === OBSERVATORY_PLUGIN_ID)) as Preview;
    if (!preview.outcome) throw new Error(t("pluginUpdate.unavailable"));
    if (preview.outcome === "error") throw new Error(preview.error?.slice(0, 400) || t("pluginUpdate.unavailable"));
    return preview;
  }
  private async check() {
    try {
      const preview = await this.preview();
      this.revision = preview.current?.currentRevision ?? null;
      const commit = preview.target?.kind === "git" ? preview.target.commit : undefined;
      if (preview.outcome !== "update" || !commit) this.available = null;
      // Notes that could not be read (offline, credentials) are retried at the next check.
      else if (this.available?.commit !== commit || !this.available.version) {
        const identity = preview.current?.identity;
        const notes = identity?.kind === "git" && identity.remote ? await this.changelog(identity.remote, identity.pluginPath ?? "", commit) : null;
        this.available = { commit, version: notes?.version ?? null, entries: notes?.entries ?? [], truncated: notes?.truncated ?? true };
      }
      this.error = null;
    } catch (error) { this.error = message(error); }
    this.checkedAt = this.now();
  }
  /** Fetches only the target commit into a bare repository of its own; the installed checkout is never touched. */
  private async changelog(remote: string, pluginPath: string, commit: string) {
    const repository = join(this.directory, "update-source.git");
    try {
      await mkdir(this.directory, { recursive: true });
      if (!await stat(join(repository, "HEAD")).then(() => true, () => false)) await this.git(["init", "--bare", "-q", repository]);
      await this.git(["-C", repository, "fetch", "--depth=1", "--no-tags", "-q", "--", remote, commit]);
      const prefix = pluginPath.replace(/^\/+|\/+$/g, "");
      const markdown = await this.git(["-C", repository, "show", `${commit}:${prefix ? `${prefix}/` : ""}CHANGELOG.md`]);
      return changelogSince(markdown, OBSERVATORY_VERSION);
    } catch { return null; }
  }
}

export function registerPluginUpdates(server: PluginServerContext, bridge: Bridge) {
  const service = new PluginUpdates(bridge);
  server.handle(getUpdate, input => service.get(input.refresh === true));
  server.handle(dismissUpdate, input => service.dismiss(input.commit));
  server.handle(applyUpdate, input => service.apply(input.commit));
  return () => service.close();
}
