import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getBackground, type BackgroundAgent, type BackgroundResponse } from "../shared/background";
import type { ProviderBridge } from "./provider-subagents";
import { contentRevision } from "./revision";
import type { StatsDirectory } from "./stats-directory";

type RunStatus = "running" | "completed" | "failed" | "canceled";
/** `since` is the current run's start; `exact` when a restart was seen live rather than estimated from `createdAt`. */
interface Run { status: RunStatus; since: number | null; exact: boolean; activity: number; label: string | null }
/** One entry of the host's per-Agent subagent list (`agent.provider_subagents.list`). */
export interface ListedSubagent { id: string; status: string; title?: string | null; description?: string | null; createdAt?: string | null; updatedAt?: string | null }
/** Directory fields that decide which parents may be asked. */
export interface BackgroundParent { id: string; status: string; archivedAt: string | null; lastUserMessageAt?: string | null }
type EventStream = Pick<PaseoApi, "observeEvents">;

const MAX_PARENTS = 500, MAX_RUNS = 100, CONCURRENCY = 4;
const RECONCILE_MS = 60_000, FULL_SYNC_MS = 10 * 60_000;
const STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed", "canceled"]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const time = (value: unknown): number | null => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
const statusOf = (value: unknown): RunStatus | null => typeof value === "string" && STATUSES.has(value) ? value as RunStatus : null;
// A Task description says what the subagent does; its title is usually only the subagent type.
const labelOf = (value: Record<string, unknown>) => text(value.description, 120) ?? text(value.title, 120);

async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await task(items[next++]!); }));
}

/**
 * Provider subagents per parent Agent, for 后台执行中. Live from the host's `agent.provider_subagents.update` session
 * events; bootstrapped and repaired from the per-Agent list. That list makes the host load an unloaded Agent (ACP
 * providers replay it and it looks freshly updated), so only Agents seen live by this plugin process are ever asked:
 * a lifecycle hook or a subagent event since it started, and no `agent.closed` since. The directory's status alone does not
 * prove it: an unloaded Agent reports its persisted last status, which stays `running` / `idle` after the daemon was killed
 * or a close timed out.
 */
export class BackgroundTracker {
  private readonly parents = new Map<string, Map<string, Run>>();
  /** Each loaded parent's latest user message as of the last walk: a subagent created before it was resumed since. */
  private readonly asked = new Map<string, number>();
  /** Agents this process has seen live (hooks, subagent events), most recent last. */
  private readonly seen = new Set<string>();
  private stream: ReturnType<EventStream["observeEvents"]> | null = null;
  private opened: Promise<void> = Promise.resolve();
  private live = false;
  private fullSyncDue = true;
  private lastFullSync = -Infinity;
  private lastReconcile = -Infinity;
  private syncing: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly list: (parentAgentId: string) => Promise<readonly ListedSubagent[]>, private readonly now: () => number = Date.now) {}

  /** Opens the host's subagent stream once; resolves when it is live or failed. Hosts without `observeEvents` never open it. */
  attach(paseo: EventStream): Promise<void> {
    if (this.closed || this.stream || typeof paseo.observeEvents !== "function") return this.opened;
    let handle: ReturnType<EventStream["observeEvents"]>;
    try { handle = paseo.observeEvents(["agent.provider_subagents.update"]); } catch { return this.opened; }
    this.stream = handle;
    let started = false, settle = () => {};
    this.opened = new Promise<void>(resolve => { settle = resolve; });
    handle.subscribe({
      // The first snapshot opens the stream. A later one follows a reconnect, and events in that gap are gone.
      snapshot: () => { if (this.stream !== handle) return; if (started) this.fullSyncDue = true; started = true; this.live = true; settle(); },
      update: message => { if (this.stream === handle) this.receive(message); },
      error: () => {
        if (this.stream !== handle) return;
        this.stream = null; this.live = false; this.fullSyncDue = true; settle();
        void handle.release().catch(() => {});
      },
    });
    return this.opened;
  }

  /** The Agent is loaded in the host right now: it just reported a lifecycle event. */
  markLive(agentId: string): void {
    if (!agentId || agentId.length > 256) return;
    this.seen.delete(agentId); this.seen.add(agentId);
    while (this.seen.size > 4_000) this.seen.delete(this.seen.values().next().value!);
  }
  /** The host closed (unloaded) the Agent; asking about it again would load it. */
  markClosed(agentId: string): void { this.seen.delete(agentId); }
  isLive(agentId: string): boolean { return this.seen.has(agentId); }

  receive(message: unknown): void {
    const event = record(message);
    if (this.closed || event.type !== "agent.provider_subagents.update") return;
    const payload = record(event.payload), now = this.now();
    if (payload.kind === "upsert") {
      const subagent = record(payload.subagent), parentId = text(subagent.parentAgentId, 256), id = text(subagent.id, 512), status = statusOf(subagent.status);
      if (!parentId || !id || !status) return;
      // The host streams subagents of loaded parents only.
      this.markLive(parentId);
      const previous = this.parents.get(parentId)?.get(id), at = time(subagent.updatedAt) ?? now;
      // A restart seen live is exact. A first sight starts at its creation unless it was created before the parent's
      // latest message (then it was resumed and its start is unknown).
      const created = time(subagent.createdAt);
      if (status === "running" && previous && previous.status !== "running") this.put(parentId, id, status, at, labelOf(subagent), at, true);
      else if (previous?.status === "running") this.put(parentId, id, status, at, labelOf(subagent), previous.since, previous.exact);
      else this.put(parentId, id, status, at, labelOf(subagent), created !== null && created >= (this.asked.get(parentId) ?? 0) ? created : null, false);
    } else if (payload.kind === "timeline") {
      const parentId = text(payload.parentAgentId, 256), id = text(payload.subagentId, 512);
      if (!parentId || !id) return;
      this.markLive(parentId);
      const run = this.parents.get(parentId)?.get(id), at = time(payload.timestamp) ?? now;
      // Output from an unknown subagent is work in progress; a late row after its end does not restart it.
      if (!run) this.put(parentId, id, "running", at, null, null, false);
      else if (run.status === "running") run.activity = Math.max(run.activity, at);
    } else if (payload.kind === "remove") {
      const parentId = text(payload.parentAgentId, 256), id = text(payload.subagentId, 512), runs = parentId ? this.parents.get(parentId) : undefined;
      if (runs && id && runs.delete(id) && !runs.size) this.parents.delete(parentId!);
    }
  }

  private put(parentId: string, id: string, status: RunStatus, at: number, label: string | null, since: number | null, exact: boolean): void {
    let runs = this.parents.get(parentId);
    if (!runs) {
      runs = new Map();
      this.parents.set(parentId, runs);
      while (this.parents.size > MAX_PARENTS) this.parents.delete(this.parents.keys().next().value!);
    }
    const previous = runs.get(id), running = status === "running";
    runs.delete(id);
    runs.set(id, { status, since: running ? since : null, exact: running && exact, activity: Math.max(previous?.activity ?? 0, at), label: label ?? previous?.label ?? null });
    while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
  }

  /**
   * Bootstraps after the stream opens or reconnects and every 10 minutes; in between, re-reads only parents with running
   * subagents, once a minute. `refreshedAt` is when `agents` was walked.
   */
  sync(agents: readonly BackgroundParent[], refreshedAt: number): Promise<void> {
    if (this.closed || !this.live) return Promise.resolve();
    if (this.syncing) return this.syncing;
    const now = this.now();
    const listed = new Map(agents.map(agent => [agent.id, agent]));
    const loaded = new Map(agents.filter(agent => !agent.archivedAt && agent.status !== "closed" && this.seen.has(agent.id)).map(agent => [agent.id, agent]));
    this.asked.clear();
    for (const agent of loaded.values()) this.asked.set(agent.id, time(agent.lastUserMessageAt) ?? 0);
    // Closing or archiving an Agent cancels or drops its subagents. Forget parents the walk shows closed or archived,
    // unless heard from since that walk; parents it does not list at all (it may be truncated) stay.
    for (const [parentId, runs] of this.parents) {
      if (listed.has(parentId) && !loaded.has(parentId) && Math.max(...[...runs.values()].map(run => run.activity)) < refreshedAt) this.parents.delete(parentId);
    }
    let targets: BackgroundParent[];
    if (this.fullSyncDue || now - this.lastFullSync >= FULL_SYNC_MS) {
      targets = [...loaded.values()];
      this.fullSyncDue = false; this.lastFullSync = now;
    } else if (now - this.lastReconcile >= RECONCILE_MS) {
      targets = [...this.parents].filter(([id, runs]) => loaded.has(id) && [...runs.values()].some(run => run.status === "running")).map(([id]) => loaded.get(id)!);
    } else return Promise.resolve();
    this.lastReconcile = now;
    if (!targets.length) return Promise.resolve();
    this.syncing = pool(targets, CONCURRENCY, parent => this.reread(parent)).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async reread(parent: BackgroundParent): Promise<void> {
    const askedAt = this.now();
    let listed: readonly ListedSubagent[];
    // An unanswered parent keeps what the stream said.
    try { listed = await this.list(parent.id); } catch { return; }
    if (this.closed) return;
    const asked = time(parent.lastUserMessageAt) ?? 0, seen = new Set<string>();
    for (const value of listed.slice(0, MAX_RUNS)) {
      const entry = record(value), id = text(entry.id, 512), status = statusOf(entry.status);
      if (!id || !status) continue;
      seen.add(id);
      const previous = this.parents.get(parent.id)?.get(id);
      // The stream reported this subagent while the list was being answered: that report is newer.
      if (previous && previous.activity >= askedAt) continue;
      const created = time(entry.createdAt);
      if (status === "running" && previous?.status === "running" && previous.exact) {
        this.put(parent.id, id, status, time(entry.updatedAt) ?? askedAt, labelOf(entry), previous.since, true);
        continue;
      }
      // A subagent created before the last message was resumed since then: its current run's start is unknown.
      this.put(parent.id, id, status, time(entry.updatedAt) ?? askedAt, labelOf(entry), created !== null && created >= asked ? created : null, false);
    }
    const runs = this.parents.get(parent.id);
    if (!runs) return;
    for (const [id, run] of runs) if (!seen.has(id) && run.activity < askedAt) runs.delete(id);
    if (!runs.size) this.parents.delete(parent.id);
  }

  /** Parents with running subagents, for the 看板 counts. */
  runningIds(): Set<string> {
    return new Set([...this.parents].filter(([, runs]) => [...runs.values()].some(run => run.status === "running")).map(([id]) => id));
  }

  snapshot(): BackgroundAgent[] {
    const agents: BackgroundAgent[] = [];
    for (const [agentId, runs] of this.parents) {
      const running = [...runs.values()].filter(run => run.status === "running").sort((a, b) => b.activity - a.activity);
      if (!running.length) continue;
      const starts = running.map(run => run.since);
      // Minute precision: subagent output must not change the revision on every row.
      const updatedAt = Math.floor(running[0]!.activity / 60_000) * 60_000;
      agents.push({ agentId, running: Math.min(running.length, 100),
        since: starts.every(start => start !== null) ? new Date(Math.min(...starts as number[])).toISOString() : null,
        updatedAt: updatedAt > 0 ? new Date(updatedAt).toISOString() : null,
        labels: [...new Set(running.map(run => run.label).filter((label): label is string => !!label))].slice(0, 3) });
    }
    return agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  read(input: { revision?: string } = {}): BackgroundResponse {
    const agents = this.snapshot(), revision = contentRevision([this.live, agents]);
    if (input.revision === revision) return { mode: "unchanged", unchanged: true, revision };
    return { mode: "full", unchanged: false, revision, available: this.live, agents };
  }

  async close(): Promise<void> {
    this.closed = true;
    const stream = this.stream;
    this.stream = null; this.live = false;
    await stream?.release().catch(() => {});
  }
}

/** Waits for `work` at most `ms`; whatever is known by then is answered. */
export function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work.then(() => {}, () => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

/** 后台执行中 for the session list (`observatory.background.get`) and the 看板 counts. */
export function registerBackground(server: PluginServerContext, { directory, bridge }: { directory: StatsDirectory; bridge: Pick<ProviderBridge, "request"> }) {
  const tracker = new BackgroundTracker(async parentAgentId => {
    const payload = await bridge.request({ type: "agent.provider_subagents.list.request", parentAgentId }, "agent.provider_subagents.list.response");
    return Array.isArray(payload.subagents) ? payload.subagents as ListedSubagent[] : [];
  });
  server.handle(getBackground, async (input, { paseo }) => {
    await settleWithin(tracker.attach(paseo), 2_000);
    await directory.refresh(paseo);
    await settleWithin(tracker.sync(directory.agents, directory.refreshedAt), 4_000);
    return tracker.read(input);
  });
  return { tracker, async close() { await tracker.close(); } };
}
