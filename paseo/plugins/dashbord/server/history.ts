import { onTextChange } from "../shared/i18n";
import { t } from "../shared/text";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getSessionEvidence, restoreFailureText, restoreSession, restoreSessionStatus, type RestoreOutcome, type RestoreSessionResult } from "../shared/history";
import { object, string } from "../shared/timeline";
import type { ProviderBridge } from "./provider-subagents";
import { fetchTrajectory } from "./trajectory";
import { rememberArchiveReadOrigin } from "./read-state";

export interface HistoryTransport { request(message: Record<string, unknown>, responseType: string): Promise<Record<string, unknown>> }
/** What a running restore reports (its current step) and how plugin shutdown stops it before the next host request. */
export interface RestoreProgress { onStep?: (message: string) => void; signal?: AbortSignal }
let CANCELED = t("serverHistory.m001");
/** The host's reasons a workspace cannot come back (its own messages are English). */
let UNRECOVERABLE: Record<string, string> = {
  workspace_not_found: t("serverHistory.m002"),
  project_not_found: t("serverHistory.m003"),
  workspace_directory_missing: t("serverHistory.m004"),
  project_directory_missing: t("serverHistory.m005"),
};
const hostText = (error: unknown) => error instanceof Error ? error.message : String(error);
/**
 * Explicit session restoration. `refresh_agent_request` reopens persistence,
 * unlike PaseoApi.handle.refresh(), which is only a snapshot read. No prompt is
 * sent, no agent is created, and sibling archived agents are left archived.
 */
export async function restoreArchivedSession(paseo: PaseoApi, agentId: string, transport: HistoryTransport, rememberOrigin?: typeof rememberArchiveReadOrigin, progress: RestoreProgress = {}): Promise<RestoreOutcome> {
  let result: RestoreOutcome = { status: "failed", agentId, workspaceId: null, workspaceRestored: false,
    workspaceAction: null, message: t("serverHistory.m006") };
  // A step that changes something waits for the previous one and never starts once the plugin is shutting down.
  const step = (message: string) => { if (progress.signal?.aborted) throw new Error(CANCELED); progress.onStep?.(message); };
  try {
    step(t("serverHistory.m007"));
    const handle = paseo.agents.ref(agentId);
    const initial = await handle.refresh();
    if (!initial?.agent) return { ...result, status: "needs_native", message: t("serverHistory.m008") };
    const agent = initial.agent;
    result.workspaceId = agent.workspaceId ?? null;
    if (!agent.archivedAt) return { ...result, status: "already_active", message: t("serverHistory.m009") };
    if (agent.status === "running" || agent.activeTurn) return { ...result, status: "needs_native", message: t("serverHistory.m010") };
    if (!agent.persistence || agent.providerUnavailable) return { ...result, status: "needs_native", message: t("serverHistory.m011") };
    await rememberOrigin?.({agentId,archivedAt:agent.archivedAt,lastUserMessageAt:agent.lastUserMessageAt??null});
    if (agent.workspaceId) {
      step(t("serverHistory.m012"));
      const workspace = await paseo.workspaces.ref(agent.workspaceId).refresh();
      if (!workspace) {
        const inspection = await transport.request({ type: "workspace.recovery.inspect.request", workspaceId: agent.workspaceId }, "workspace.recovery.inspect.response");
        const state = object(inspection.state);
        if (state.kind !== "recoverable") {
          if (state.reason !== "workspace_not_archived") return { ...result, status: "needs_native", message: UNRECOVERABLE[string(state.reason)] ?? t("serverHistory.m013") };
        } else {
          if (state.action !== "unarchive" && state.action !== "restore") return { ...result, status: "needs_native", message: t("serverHistory.m014") };
          step(state.action === "restore" ? t("serverHistory.m015") : t("serverHistory.m016"));
          const restored = await transport.request({ type: "workspace.recovery.restore.request", workspaceId: agent.workspaceId }, "workspace.recovery.restore.response")
            .catch(error => { throw new Error(t("serverHistory.m017", { value1: hostText(error) })); });
          if (restored.accepted !== true) throw new Error(t("serverHistory.m018", { value1: string(restored.error) || t("serverHistory.m019") }));
          result = { ...result, workspaceRestored: true, workspaceAction: state.action };
        }
      }
    }
    // Another client may already have restored or started the session while its
    // workspace was being recovered. Never refresh an active session here.
    const current = await handle.refresh();
    if (!current?.agent) throw new Error(t("serverHistory.m020"));
    if (!current.agent.archivedAt) return { ...result, status: "already_active", message: t("serverHistory.m021") };
    if (current.agent.status === "running" || current.agent.activeTurn) return { ...result, status: "needs_native", message: t("serverHistory.m022") };
    step(t("serverHistory.m023"));
    const refreshed = await transport.request({ type: "refresh_agent_request", agentId }, "status");
    if (refreshed.status !== "agent_refreshed" || refreshed.agentId !== agentId) throw new Error(t("serverHistory.m024"));
    progress.onStep?.(t("serverHistory.m025"));
    const confirmed = await handle.refresh();
    if (!confirmed?.agent || confirmed.agent.archivedAt) throw new Error(t("serverHistory.m026"));
    return { ...result, status: "restored", message: result.workspaceRestored ? t("serverHistory.m027") : t("serverHistory.m028") };
  } catch (error) {
    return { ...result, status: "failed", message: `${restoreFailureText(error)}${result.workspaceRestored ? t("serverHistory.m029") : ""}` };
  }
}

export interface RestoreJobOptions { now?: () => number; /** How long a start waits for a quick outcome before answering pending. */ quickMs?: number; /** How long an ended restore stays readable. */ keepMs?: number }
export interface HistoryOptions extends RestoreJobOptions { /** Records where an archived read came from (default: the read-state store; tests pass their own). */ rememberOrigin?: typeof rememberArchiveReadOrigin }
interface RestoreJob { id: string; agentId: string; view: RestoreSessionResult; endedAt: number | null; abort: AbortController }
/**
 * Restores run as server-side jobs read by id: the host gives a plugin RPC 30 s, while rebuilding a worktree and reopening a
 * session can take minutes (each host request may wait two). A second request for the same Agent joins the running restore;
 * an outcome stays readable for ten minutes.
 */
export class RestoreJobs {
  private readonly jobs = new Map<string, RestoreJob>();
  private readonly running = new Map<string, RestoreJob>();
  private readonly now: () => number;
  private readonly quickMs: number;
  private readonly keepMs: number;
  private closed = false;
  constructor(options: RestoreJobOptions = {}) { this.now = options.now ?? Date.now; this.quickMs = options.quickMs ?? 2500; this.keepMs = options.keepMs ?? 10 * 60_000; }
  /** Answers within `quickMs`: the outcome when the restore is that quick (an active session, a missing record), else `pending`. */
  async start(agentId: string, run: (progress: RestoreProgress) => Promise<RestoreOutcome>): Promise<RestoreSessionResult> {
    this.prune();
    const joined = this.running.get(agentId); if (joined) return { ...joined.view };
    const pending: RestoreSessionResult = { status: "pending", agentId, workspaceId: null, workspaceRestored: false, workspaceAction: null, message: t("serverHistory.m030"), jobId: null };
    if (this.closed) return { ...pending, status: "failed", message: CANCELED };
    const job: RestoreJob = { id: randomUUID(), agentId, view: pending, endedAt: null, abort: new AbortController() };
    job.view = { ...pending, jobId: job.id };
    this.jobs.set(job.id, job); this.running.set(agentId, job);
    const done = Promise.resolve().then(() => run({ signal: job.abort.signal, onStep: message => { if (job.endedAt === null) job.view = { ...job.view, message }; } }))
      .catch((error: unknown): RestoreOutcome => ({ status: "failed", agentId, workspaceId: null, workspaceRestored: false, workspaceAction: null, message: restoreFailureText(error) }))
      .then(outcome => { job.endedAt = this.now(); job.view = { ...outcome, jobId: job.id }; if (this.running.get(agentId) === job) this.running.delete(agentId); });
    // A referenced timer: an RPC is waiting on it, and the restore it races may hold no handle of its own.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, this.quickMs); })]);
    if (timer) clearTimeout(timer);
    return { ...job.view };
  }
  status(jobId: string): RestoreSessionResult | null { this.prune(); const job = this.jobs.get(jobId); return job ? { ...job.view } : null; }
  /** Plugin shutdown: running restores stop before their next host request, and nothing is readable any more. */
  close() { this.closed = true; for (const job of this.running.values()) job.abort.abort(); this.running.clear(); this.jobs.clear(); }
  private prune() {
    const now = this.now();
    for (const [id, job] of this.jobs) if (job.endedAt !== null && now - job.endedAt > this.keepMs) this.jobs.delete(id);
    // Bounded: beyond 64 entries the oldest ended ones go first.
    for (const [id, job] of this.jobs) { if (this.jobs.size <= 64) break; if (job.endedAt !== null) this.jobs.delete(id); }
  }
}

export function registerHistory(server: PluginServerContext, bridge: Pick<ProviderBridge, "request">, { rememberOrigin = rememberArchiveReadOrigin, ...options }: HistoryOptions = {}): () => void {
  // Restoring a workspace can take a while; these requests wait up to two minutes, so the restore runs as a job the client reads.
  const transport: HistoryTransport = { request: (message, responseType) => bridge.request(message, responseType, 120_000) };
  const restores = new RestoreJobs(options);
  server.handle(restoreSession, ({ agentId }, { paseo }) => restores.start(agentId, progress => restoreArchivedSession(paseo, agentId, transport, rememberOrigin, progress)));
  server.handle(restoreSessionStatus, ({ jobId }) => restores.status(jobId));
  server.handle(getSessionEvidence, async ({ agentId }, { paseo }) => {
    const trajectory = await fetchTrajectory(paseo, agentId, { limit: 300, maxCharacters: 80000 });
    return { agentId, turns: trajectory.counts.userTurns, tools: trajectory.counts.tools, toolFailures: trajectory.counts.toolFailures,
      errors: trajectory.counts.errors, firstTimelineAt: trajectory.coverage.firstAt, lastTimelineAt: trajectory.coverage.lastAt,
      sampleSize: trajectory.rows.length, complete: trajectory.coverage.complete, hasOlder: trajectory.coverage.hasOlder,
      coverageReason: trajectory.coverage.reason, completionEvidence: trajectory.completionEvidence };
  });
  return () => { restores.close(); };
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  CANCELED = t("serverHistory.m001");
  UNRECOVERABLE = {
  workspace_not_found: t("serverHistory.m002"),
  project_not_found: t("serverHistory.m003"),
  workspace_directory_missing: t("serverHistory.m004"),
  project_directory_missing: t("serverHistory.m005"),
};
});
