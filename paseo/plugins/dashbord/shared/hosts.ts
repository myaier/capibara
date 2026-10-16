import { OBSERVATORY_PLUGIN_ID, type ChangelogEntry, type PluginSource, type UpdateState } from "./plugin-update";

/**
 * The 主机 panel's model: one row per host Paseo is connected to, what state this plugin is in there, and what one click may do.
 * Installed hosts update through their own reviewed update RPC. A host without a running installation can only be reached through
 * Paseo's public client API, so one `paseo plugin …` command runs in a terminal of one of its workspaces. The device never reads a
 * host's daemon config (it carries provider credentials), so that command copes with every reason the plugin is not running.
 */

/** A host as Paseo lists it to plugins (`useHosts()`). */
export interface HostSummary { serverId: string; label: string; status: "idle" | "connecting" | "online" | "offline" | "error" }

/** `install` for a host without a running installation, `repair` for one whose update service does not answer; the same command. */
export type HostCommandKind = "install" | "repair";
export type HostJobResult = "ok" | "failed" | "no-cli" | "no-workspace" | "timeout" | "not-running" | "error";
/** A command this client runs in a terminal on another host. */
export interface HostJob {
  serverId: string; kind: HostCommandKind; command: string;
  /** `waiting`: the command succeeded and the new installation has not registered yet. */
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
  job: HostJob | null;
  /** An update this client started there and still follows. */
  pending: { commit: string; startedAt: number } | null;
  ignored: boolean;
  /** The installation that serves this page: updated last, because updating it reloads the panel. */
  page: boolean;
  /** Online long enough that a missing registration means no running installation. */
  settled: boolean;
}

export type HostRowState = "offline" | "connecting" | "checking" | "missing"
  | "job-running" | "job-waiting" | "job-failed" | "updating" | "update-failed" | "outdated" | "diverged" | "check-failed" | "current";
export type HostRowAction = "install" | "repair" | "retry-job" | "retry-update";
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
    version: state?.version ?? fact.registered?.version ?? null, revision: state?.revision ?? null, dismissed: !!state?.dismissed, job, error,
    updatingSince: rowState === "updating" ? (state?.updating && !state.updating.error ? Date.parse(state.updating.startedAt) : fact.pending?.startedAt ?? null) : null,
    phase: rowState === "updating" ? (!fact.registered || fact.update.error ? "restarting" : "building") : null,
  });
  if (job?.state === "running") return row("job-running");
  if (job?.state === "failed") return row("job-failed", "retry-job", job.error);
  const status = fact.host.status;
  if (status === "connecting") return row("connecting");
  if (status !== "online") return row("offline");
  // An update restarts the installation, which leaves the registry until the new revision registers.
  if (!fact.registered && fact.pending) return row("updating");
  if (fact.registered) {
    // An installation that runs but whose update service does not answer is likely too old for it: the command can update it.
    if (!state) return fact.update.error ? row("check-failed", "repair", fact.update.error) : row("checking");
    if (state.updating?.error) return row("update-failed", "retry-update", state.updating.error);
    if (state.updating || (fact.pending && state.revision !== fact.pending.commit)) return row("updating");
    if (!target) return row(state.available ? "outdated" : state.error ? "check-failed" : "current", null, state.error);
    if (state.revision === target.commit) return row("current");
    if (state.available?.commit === target.commit) return row("outdated");
    return row(state.error ? "check-failed" : "diverged", null, state.error);
  }
  if (job?.state === "waiting") return row("job-waiting");
  // Not installed, disabled or failing to start look alike from here; a host that just connected may still be starting it.
  return fact.settled ? row("missing", "install") : row("checking");
}

/** Rows needing a decision; ignored hosts never prompt. */
const ATTENTION: readonly HostRowState[] = ["missing", "outdated", "update-failed", "job-failed"];
const BUSY: readonly HostRowState[] = ["updating", "job-running", "job-waiting"];
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
    const kind: HostCommandKind | null = row.state === "missing" ? "install" : row.state === "job-failed" && row.job ? row.job.kind : null;
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
 * Install from the page's own source. Paseo refuses to add an ID that is already configured, so when that fails the plugin is
 * enabled and updated in place instead: from its own source, keeping the ref it follows (`--yes` applies what that source offers).
 * An installation from another source is therefore never replaced behind the person's back.
 */
export interface HostCommand { add: string[]; fallback: string[][] }
export function hostCommand(source: PluginSource | null | undefined): HostCommand | null {
  if (!source || !SAFE_SOURCE.test(source.reference)) return null;
  if (source.ref !== null && !SAFE_REF.test(source.ref)) return null;
  return { add: ["plugin", "add", source.reference, ...(source.ref ? ["--ref", source.ref] : [])],
    fallback: [["plugin", "enable", OBSERVATORY_PLUGIN_ID], ["plugin", "update", OBSERVATORY_PLUGIN_ID, "--yes"]] };
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
 */
export function terminalInvocation(platform: HostPlatform, command: HostCommand): { command: string; args: string[] } {
  const add = command.add.join(" "), fallback = command.fallback.map(args => args.join(" "));
  if (platform === "windows") {
    const steps = `call paseo ${add} || (${fallback.map(line => `call paseo ${line}`).join(" && ")})`;
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `where paseo >nul 2>nul && ((${steps}) && echo ${RESULT_MARK} ok || echo ${RESULT_MARK} failed) || echo ${RESULT_MARK} no-cli`] };
  }
  const candidates = ['"$HOME/.local/bin/paseo"', "/opt/homebrew/bin/paseo", "/usr/local/bin/paseo", "/Applications/Paseo.app/Contents/Resources/bin/paseo"].join(" ");
  return { command: "/bin/sh", args: ["-c", [
    "P=$(command -v paseo 2>/dev/null)",
    `if [ -z "$P" ] && [ -n "$SHELL" ]; then P=$("$SHELL" -lc 'command -v paseo' 2>/dev/null | tail -n 1); fi`,
    `if [ -n "$P" ] && [ ! -x "$P" ]; then P=; fi`,
    `for C in ${candidates}; do [ -n "$P" ] && break; [ -x "$C" ] && P=$C; done`,
    `if [ -z "$P" ]; then echo "${RESULT_MARK} no-cli"; exit 127; fi`,
    `echo "+ paseo ${add}"`,
    `if "$P" ${add}; then R=ok; elif ${fallback.map(line => `"$P" ${line}`).join(" && ")}; then R=ok; else R=failed; fi`,
    `echo "${RESULT_MARK} $R"`,
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
