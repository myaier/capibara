import { commandResult, displayCommand, hostCommand, hostPlatform, outputTail, pickWorkspace, terminalInvocation,
  type HostCommandKind, type HostJob, type HostJobResult } from "../shared/hosts";
import type { PluginSource } from "../shared/plugin-update";
import { t } from "../shared/text";

export interface Store<T> { get(): T; set(next: T): void; subscribe(listener: () => void): () => void }
export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) { value = next; for (const listener of [...listeners]) listener(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export function setEntry<T>(store: Store<ReadonlyMap<string, T>>, key: string, value: T | null) {
  const next = new Map(store.get());
  if (value === null) next.delete(key); else next.set(key, value);
  store.set(next);
}

/** The part of Paseo's client API a command needs: a workspace to open a terminal in, and the terminal. */
export interface CommandHost {
  workspaces: { list(): Promise<{ entries: ReadonlyArray<{ id: string; workspaceDirectory?: string; projectRootPath?: string; archivingAt?: string | null }> }> };
  terminals: { create(options: { workspaceId: string; name?: string; command?: string; args?: string[] }): Promise<{
    readonly id: string; capture(options?: { stripAnsi?: boolean }): Promise<{ lines: string[] }>; kill(): Promise<void>;
    /** The terminal, or null once Paseo discarded it (its process exited). */
    refresh(): Promise<unknown>;
  }> };
}
export interface CommandDeps {
  acquire(serverId: string): CommandHost;
  /** Resolves true once an installation of this plugin on that host registers with this client. */
  registered(serverId: string, timeoutMs: number): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const POLL_MS = 1_500, COMMAND_TIMEOUT_MS = 10 * 60_000, REGISTER_TIMEOUT_MS = 2 * 60_000;
// Module scope, not component state: closing the dialog or the panel keeps following a command.
export const hostJobs = createStore<ReadonlyMap<string, HostJob>>(new Map());
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * Runs one install, enable or upgrade (see `hostCommand`) on another host in a terminal of one of its workspaces, and follows it
 * until the host's installation registers. Success closes the terminal; a failure keeps it open with the output's last lines on
 * the job. A host has at most one command at a time.
 */
export async function runHostCommand(serverId: string, kind: HostCommandKind, source: PluginSource | null | undefined, deps: CommandDeps,
  jobs: Store<ReadonlyMap<string, HostJob>> = hostJobs): Promise<HostJobResult | "busy"> {
  const running = jobs.get().get(serverId);
  if (running && running.state !== "failed") return "busy";
  const steps = hostCommand(kind, source), startedAt = deps.now();
  setEntry(jobs, serverId, { serverId, kind, command: steps ? steps.map(displayCommand).join(" && ") : "", state: "running", startedAt, result: null, output: [], error: null, workspaceId: null, terminalId: null });
  const mine = () => jobs.get().get(serverId)?.startedAt === startedAt;
  const update = (patch: Partial<HostJob>) => { const job = jobs.get().get(serverId); if (job && mine()) setEntry(jobs, serverId, { ...job, ...patch }); };
  const fail = (result: HostJobResult, error: string, output?: string[]) => { update({ state: "failed", result, error, ...(output ? { output } : {}) }); return result; };
  if (!steps) return fail("error", t("hosts.noSource"));
  try {
    const host = deps.acquire(serverId);
    const workspace = pickWorkspace((await host.workspaces.list()).entries);
    if (!workspace) return fail("no-workspace", t("hosts.noWorkspace"));
    const invocation = terminalInvocation(hostPlatform(workspace.directory), steps);
    const terminal = await host.terminals.create({ workspaceId: workspace.id, name: t("hosts.terminalName"), command: invocation.command, args: invocation.args });
    update({ workspaceId: workspace.id, terminalId: terminal.id });
    for (;;) {
      await deps.sleep(POLL_MS);
      if (!mine()) return "error";
      const lines = (await terminal.capture({ stripAnsi: true })).lines, output = outputTail(lines), result = commandResult(lines);
      // Paseo drops a terminal whose process ended, output and all; without an outcome line there is nothing left to wait for.
      if (!lines.length && !await terminal.refresh().catch(() => null)) return fail("error", t("hosts.terminalGone"), jobs.get().get(serverId)?.output ?? []);
      if (result === "ok") { update({ state: "waiting", result, output }); break; }
      if (result) return fail(result, t(result === "no-cli" ? "hosts.noCli" : "hosts.commandFailed"), output);
      update({ output });
      if (deps.now() - startedAt >= COMMAND_TIMEOUT_MS) return fail("timeout", t("hosts.commandTimeout"), output);
    }
    // The host's daemon starts the installation, which then registers with this client like any other.
    if (!await deps.registered(serverId, REGISTER_TIMEOUT_MS)) return fail("not-running", t("hosts.notRunningAfter"));
    if (mine()) setEntry(jobs, serverId, null);
    await terminal.kill().catch(() => {});
    return "ok";
  } catch (error) { return fail("error", message(error)); }
}
