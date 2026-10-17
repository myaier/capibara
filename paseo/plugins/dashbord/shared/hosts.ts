import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OBSERVATORY_PLUGIN_ID, type ChangelogEntry, type PluginSource, type UpdateState } from "./plugin-update";

/**
 * The 主机 panel's model: one row per host Paseo is connected to, what state this plugin is in there, and what one click may do.
 * Installed hosts update through their own reviewed update RPC. A host without a running installation can only be reached through
 * Paseo's public client API: its daemon config tells whether the plugin is installed, disabled or plugins are off, and install,
 * enable, upgrade and turning plugins on run `paseo …` commands in a terminal of one of its workspaces.
 */

/** A host as Paseo lists it to plugins (`useHosts()`). */
export interface HostSummary { serverId: string; label: string; status: "idle" | "connecting" | "online" | "offline" | "error" }
/** The only facts kept from a host's daemon config, which also carries provider credentials. */
export interface HostPluginConfig { pluginsEnabled: boolean; installed: boolean; enabled: boolean }
/** Paseo starts plugins only when `pluginsEnabled` is true, and an entry only when it is not disabled. Everything else is dropped. */
export function pluginConfigState(config: unknown): HostPluginConfig {
  const value = config && typeof config === "object" ? config as Record<string, unknown> : {};
  const plugins = value.plugins && typeof value.plugins === "object" ? value.plugins as Record<string, unknown> : {};
  const entry = plugins[OBSERVATORY_PLUGIN_ID];
  const installed = !!entry && typeof entry === "object";
  return { pluginsEnabled: value.pluginsEnabled === true, installed, enabled: installed && (entry as Record<string, unknown>).enabled !== false };
}

/** When each host was last seen online and what it ran: offline hosts show it, and whether they still need the target. */
export interface HostMemory { serverId: string; label: string; version: string | null; revision: string | null; seenAt: string }
const hostMemory = z.object({ serverId: z.string().min(1).max(256), label: z.string().max(256), version: z.string().max(80).nullable(),
  revision: z.string().max(64).nullable(), seenAt: z.iso.datetime() });
export const HOST_MEMORY_MAX = 64;
export const hostMemorySchema = z.object({ hosts: z.array(hostMemory).max(HOST_MEMORY_MAX) });
export const getHostMemory = defineRpc({ name: "observatory.hosts.memory.get", input: z.object({}), output: hostMemorySchema });
export const rememberHosts = defineRpc({ name: "observatory.hosts.memory.put", input: hostMemorySchema, output: hostMemorySchema });
/** Newer sightings replace older ones per host; the most recently seen hosts are kept. */
export function mergeHostMemory(stored: readonly HostMemory[], seen: readonly HostMemory[]): HostMemory[] {
  const byHost = new Map(stored.map(entry => [entry.serverId, entry]));
  for (const entry of seen) {
    const previous = byHost.get(entry.serverId);
    if (!previous || Date.parse(entry.seenAt) >= Date.parse(previous.seenAt)) byHost.set(entry.serverId, entry);
  }
  return [...byHost.values()].sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt)).slice(0, HOST_MEMORY_MAX);
}

/** The first release whose installations answer the update RPC; older ones can only be upgraded from their command line. */
export const MIN_UPDATE_RPC_VERSION = "2.18.0-dev.9";
/** `2.18.0-dev.10` style versions: numeric parts, a release after its `dev.N` builds. NaN when either cannot be read. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z]+\.(\d+))?$/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] : null;
  };
  const left = parse(a), right = parse(b);
  if (!left || !right) return NaN;
  for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  return 0;
}

export type HostCommandKind = "install" | "enable" | "upgrade" | "plugins-on";
export type HostJobResult = "ok" | "failed" | "no-cli" | "no-workspace" | "timeout" | "not-running" | "error";
/** A command this client runs in a terminal on another host. */
export interface HostJob {
  serverId: string; kind: HostCommandKind; command: string;
  /** `waiting`: the command succeeded and the installation has not registered yet. */
  state: "running" | "waiting" | "failed";
  startedAt: number; result: HostJobResult | null; output: string[]; error: string | null;
  workspaceId: string | null; terminalId: string | null;
}

/** Everything the panel knows about one host. */
export interface HostFacts {
  host: HostSummary;
  /** An installation of this plugin that registered with this client (identity handshake passed). */
  registered: { version: string } | null;
  update: { state: UpdateState | null; error: string | null };
  /** Read only for online hosts without a registered installation. */
  config: { value: HostPluginConfig | null; error: string | null };
  memory: HostMemory | null;
  job: HostJob | null;
  /** An update this client started there and still follows; `queued` while it waits for commands on other hosts. */
  pending: { commit: string; startedAt: number; queued?: boolean } | null;
  ignored: boolean;
  /** The installation that serves this page: updated last, because updating it reloads the panel. */
  page: boolean;
  /** Online long enough that an installed, enabled plugin should have registered. */
  settled: boolean;
  /** Its last check of its source predates the page's: an offer that differs from the target may just be out of date. */
  stale?: boolean;
}

export type HostRowState = "offline" | "connecting" | "checking" | "plugins-off" | "missing" | "disabled" | "too-old"
  | "job-running" | "job-waiting" | "job-failed" | "queued" | "updating" | "update-failed" | "outdated" | "diverged" | "check-failed" | "current";
export type HostRowAction = HostCommandKind | "update" | "retry-job" | "retry-update";
export interface HostRow {
  serverId: string; label: string; state: HostRowState; action: HostRowAction | null;
  page: boolean; ignored: boolean; version: string | null; revision: string | null;
  /** 暂不更新 was chosen for the revision it is offered: listed, but no prompt. */
  dismissed: boolean;
  job: HostJob | null; error: string | null;
  /** When the running update started, for its progress estimate. */
  updatingSince: number | null;
  /** While updating: building, or restarting (the installation stopped answering or left the registry). */
  phase: "building" | "restarting" | null;
  /** Offline: when it was last seen, and whether it then ran something other than the target (待同步). */
  lastSeen: string | null; pendingSync: boolean;
}
/** The revision every installed host is brought to, with the release notes since the page's version. */
export interface SyncTarget { commit: string; version: string | null; entries: ChangelogEntry[]; truncated: boolean }

/**
 * The page's installation decides the target: its newer revision, or its own when it is current. Each host previews its own
 * source, so only a host whose preview names the same revision can be updated to it (the apply refuses anything else).
 */
export function syncTarget(facts: readonly HostFacts[]): SyncTarget | null {
  const page = facts.find(fact => fact.page)?.update.state;
  if (!page) return null;
  if (page.available) return { commit: page.available.commit, version: page.available.version, entries: page.available.entries, truncated: page.available.truncated };
  if (!page.revision) return null;
  // The page is current: another host behind it has the notes for the versions it lacks.
  const notes = facts.map(fact => fact.update.state?.available).find(available => available?.commit === page.revision);
  return { commit: page.revision, version: page.version, entries: notes?.entries ?? [], truncated: notes?.truncated ?? false };
}

export function hostRow(fact: HostFacts, target: SyncTarget | null): HostRow {
  const state = fact.update.state, job = fact.registered && fact.job?.state !== "running" ? null : fact.job;
  const row = (rowState: HostRowState, action: HostRowAction | null = null, error: string | null = null): HostRow => ({
    serverId: fact.host.serverId, label: fact.host.label, state: rowState, action, page: fact.page, ignored: fact.ignored,
    // Offline: what it ran when last seen, not a registration that may not have been withdrawn yet.
    version: rowState === "offline" ? fact.memory?.version ?? state?.version ?? fact.registered?.version ?? null : state?.version ?? fact.registered?.version ?? null,
    revision: state?.revision ?? (rowState === "offline" ? fact.memory?.revision ?? null : null), dismissed: !!state?.dismissed, job, error,
    updatingSince: rowState === "updating" ? (state?.updating && !state.updating.error ? Date.parse(state.updating.startedAt) : fact.pending?.startedAt ?? null) : null,
    phase: rowState === "updating" ? (!fact.registered || fact.update.error ? "restarting" : "building") : null,
    lastSeen: rowState === "offline" ? fact.memory?.seenAt ?? null : null,
    // Known to have run another revision when last seen; it is prompted again once it is back online.
    pendingSync: rowState === "offline" && !!target && !!fact.memory?.revision && fact.memory.revision !== target.commit,
  });
  if (job?.state === "running") return row("job-running");
  if (job?.state === "failed") return row("job-failed", "retry-job", job.error);
  const status = fact.host.status;
  if (status === "connecting") return row("connecting");
  if (status !== "online") return row("offline");
  // An update restarts the installation, which leaves the registry until the new revision registers.
  if (!fact.registered && fact.pending) return row("updating");
  if (fact.registered) {
    if (fact.pending?.queued) return row("queued");
    // Installations before the update RPC are upgraded from their command line.
    if (compareVersions(fact.registered.version, MIN_UPDATE_RPC_VERSION) < 0) return row("too-old", "upgrade");
    if (!state) return fact.update.error ? row("check-failed", null, fact.update.error) : row("checking");
    if (state.updating?.error) return row("update-failed", "retry-update", state.updating.error);
    if (state.updating || (fact.pending && state.revision !== fact.pending.commit)) return row("updating");
    if (!target) return state.available ? row("outdated", "update") : row(state.error ? "check-failed" : "current", null, state.error);
    if (state.revision === target.commit) return row("current");
    if (state.available?.commit === target.commit) return row("outdated", "update");
    // A check still running, or older than the one that set the target, cannot tell another source from a stale answer.
    if (state.checking || fact.stale) return row("checking");
    return row(state.error ? "check-failed" : "diverged", null, state.error);
  }
  if (job?.state === "waiting") return row("job-waiting");
  const config = fact.config.value;
  if (!config && !fact.config.error) return row("checking");
  // An unreadable config cannot say whether the plugin is there; installing is offered, and an existing one makes the command fail visibly.
  if (!config) return row("check-failed", "install", fact.config.error);
  if (!config.pluginsEnabled) return row("plugins-off", "plugins-on");
  if (!config.installed) return row("missing", "install");
  if (!config.enabled) return row("disabled", "enable");
  // Installed and enabled but not registered: too old for this client's protocol, or failing to start. A host that just connected
  // may still be starting it.
  return fact.settled ? row("too-old", "upgrade") : row("checking");
}

/** Rows needing a decision; ignored hosts never prompt. */
const ATTENTION: readonly HostRowState[] = ["plugins-off", "missing", "disabled", "too-old", "outdated", "update-failed", "job-failed"];
const BUSY: readonly HostRowState[] = ["queued", "updating", "job-running", "job-waiting"];
export function hostSummary(rows: readonly HostRow[]) {
  const active = rows.filter(row => !row.ignored);
  return {
    total: rows.length, attention: active.filter(row => ATTENTION.includes(row.state) && !(row.state === "outdated" && row.dismissed)).length,
    busy: rows.filter(row => BUSY.includes(row.state)).length,
    failed: active.filter(row => row.state === "update-failed" || row.state === "job-failed").length,
  };
}

/** 全部同步: every non-ignored host that can move to the target. The page's own update goes last. */
export function planSync(rows: readonly HostRow[]): { updates: string[]; commands: Array<{ serverId: string; kind: HostCommandKind }> } {
  const active = rows.filter(row => !row.ignored);
  const updates = active.filter(row => row.state === "outdated" || row.state === "update-failed")
    .sort((a, b) => Number(a.page) - Number(b.page)).map(row => row.serverId);
  const commands = active.flatMap(row => {
    const kind: HostCommandKind | null = row.state === "plugins-off" ? "plugins-on" : row.state === "missing" ? "install" : row.state === "disabled" ? "enable"
      : row.state === "too-old" ? "upgrade" : row.state === "job-failed" && row.job ? row.job.kind : null;
    return kind ? [{ serverId: row.serverId, kind }] : [];
  });
  return { updates, commands };
}

/**
 * Arguments reach a shell, so they are limited to characters that no shell treats specially (no spaces, quotes, `$`, `%`, `^`,
 * `&`, `|`, `;`, redirections or globs). A source that does not fit is refused rather than quoted.
 */
const SAFE_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._~:/@+-]{0,299}$/, SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/**
 * The `paseo` invocations, run in order: install from the page's own source; enable the configured plugin; upgrade applies
 * what the host's own source offers (`--yes`, keeping the ref it follows) and reloads it, which also restarts one that failed.
 * Turning plugins on edits the host's config and has its daemon reload it, which starts every enabled plugin there; the install
 * or enable this plugin still needs according to that host's `config` follows.
 */
export function hostCommand(kind: HostCommandKind, source: PluginSource | null | undefined, config?: HostPluginConfig | null): string[][] | null {
  if (kind === "plugins-on") {
    const then = config && !config.installed ? hostCommand("install", source) : config && !config.enabled ? hostCommand("enable", source) : [];
    return then ? [["daemon", "config", "set", "pluginsEnabled", "true"], ["daemon", "reload"], ...then] : null;
  }
  if (kind === "enable") return [["plugin", "enable", OBSERVATORY_PLUGIN_ID]];
  if (kind === "upgrade") return [["plugin", "update", OBSERVATORY_PLUGIN_ID, "--yes"], ["plugin", "reload", OBSERVATORY_PLUGIN_ID]];
  if (!source || !SAFE_SOURCE.test(source.reference)) return null;
  if (source.ref !== null && !SAFE_REF.test(source.ref)) return null;
  return [["plugin", "add", source.reference, ...(source.ref ? ["--ref", source.ref] : [])]];
}
export const displayCommand = (args: readonly string[]) => ["paseo", ...args].join(" ");

export type HostPlatform = "windows" | "posix";
export function hostPlatform(directory: string): HostPlatform {
  return /^[A-Za-z]:[\\/]/.test(directory) || directory.startsWith("\\\\") ? "windows" : "posix";
}
/** A workspace whose terminal can run the command; any is fine, the command does not depend on its directory. */
export function pickWorkspace(entries: ReadonlyArray<{ id: string; workspaceDirectory?: string; projectRootPath?: string; archivingAt?: string | null }>):
  { id: string; directory: string } | null {
  for (const entry of entries) {
    const directory = entry.workspaceDirectory || entry.projectRootPath;
    if (entry.id && directory && !entry.archivingAt) return { id: entry.id, directory };
  }
  return null;
}

const RESULT_MARK = "__OBSERVATORY_HOST_COMMAND__";
/**
 * An explicit shell, so the outcome line has one syntax: cmd.exe on Windows (PowerShell may resolve `paseo.ps1` and stop at
 * the execution policy; `call` returns from a `paseo.cmd` shim), `/bin/sh` elsewhere. When `paseo` is not on the daemon's PATH,
 * sh also asks the login shell and tries the usual install locations, including the CLI inside Paseo.app.
 * The shell stays open afterwards (`cmd /k`, an interactive login shell): Paseo discards a terminal whose process exited, with
 * its output, so the outcome line could not be read. The client closes the terminal after a success.
 */
export function terminalInvocation(platform: HostPlatform, steps: readonly (readonly string[])[]): { command: string; args: string[] } {
  const lines = steps.map(args => args.join(" "));
  if (platform === "windows") {
    const chain = lines.map(line => `call paseo ${line}`).join(" && ");
    return { command: "cmd.exe", args: ["/d", "/s", "/k", `where paseo >nul 2>nul && ((${chain}) && echo ${RESULT_MARK} ok || echo ${RESULT_MARK} failed) || echo ${RESULT_MARK} no-cli`] };
  }
  const candidates = ['"$HOME/.local/bin/paseo"', "/opt/homebrew/bin/paseo", "/usr/local/bin/paseo", "/Applications/Paseo.app/Contents/Resources/bin/paseo"].join(" ");
  return { command: "/bin/sh", args: ["-c", [
    "P=$(command -v paseo 2>/dev/null)",
    `if [ -z "$P" ] && [ -n "$SHELL" ]; then P=$("$SHELL" -lc 'command -v paseo' 2>/dev/null | tail -n 1); fi`,
    `if [ -n "$P" ] && [ ! -x "$P" ]; then P=; fi`,
    `for C in ${candidates}; do [ -n "$P" ] && break; [ -x "$C" ] && P=$C; done`,
    `if [ -z "$P" ]; then R=no-cli; else ${lines.map(line => `echo "+ paseo ${line}"`).join("; ")}; if ${lines.map(line => `"$P" ${line}`).join(" && ")}; then R=ok; else R=failed; fi; fi`,
    `echo "${RESULT_MARK} $R"`,
    `exec "\${SHELL:-/bin/sh}" -il`,
  ].join("; ")] };
}
/** The outcome line the invocation prints last, or null while the command still runs. */
export function commandResult(lines: readonly string[]): "ok" | "failed" | "no-cli" | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = new RegExp(`^${RESULT_MARK} (ok|failed|no-cli)$`).exec(lines[index]!.trim());
    if (match) return match[1] as "ok" | "failed" | "no-cli";
  }
  return null;
}
/** The last lines worth showing next to a failure: no outcome marker, no blank lines, each bounded. */
export function outputTail(lines: readonly string[], count = 6): string[] {
  return lines.map(line => line.trimEnd()).filter(line => line.trim() && !line.includes(RESULT_MARK)).slice(-count).map(line => line.slice(0, 240));
}
