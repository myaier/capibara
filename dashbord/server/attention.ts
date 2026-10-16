import { isInternalAgent } from "../shared/internal-agents";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "./paseo-types";
import { createAgentDirectory, type AgentDirectoryApi, type AgentDirectorySubscription } from "../shared/directory-store";
import { enrichAgents, type BackgroundAgent } from "../shared/background";
import { applyArchiveReadOrigin, applyReadReceipt, type AgentRecord, type AgentTodo } from "../shared/model";
import { needsAttention } from "../shared/dashboard-model";
import { isCompletionSnoozed, type CompletionSnooze, type ObservatorySettings } from "../shared/preferences";
import { applyLiveExtras, attentionPhase, entryOf, getAttention, getLiveExtras, loudPhases, phaseRank, type AttentionResponse, type AttentionSummary, type LiveExtra, type LiveExtrasResponse } from "../shared/attention";
import type { TelemetrySnapshot } from "../shared/telemetry";
import type { ReadReceipt, ArchiveReadOrigin } from "../shared/read-state";
import { normalizeTimelinePage, object, projectTimelineRows, string, type TimelineItem } from "../shared/timeline";
import { redactSecrets } from "./redaction";
import { contentRevision } from "./revision";

/** What the summary is computed from; the same inputs (and rules) the page uses. */
export interface AttentionSources {
  telemetry(): Promise<TelemetrySnapshot>;
  background(): BackgroundAgent[];
  /** Whether an Agent is loaded in the host now (seen live by this process): only those may have their timeline read. */
  isLive(agentId: string): boolean;
  receipts(): Promise<{ receipts: ReadReceipt[]; archiveOrigins: ArchiveReadOrigin[] }>;
  preferences(): Promise<{ snoozes: CompletionSnooze[]; settings: ObservatorySettings }>;
  /** Failed scheduled runs since an instant (定时运行 row); null when unknown. */
  scheduleFailures?(sinceMs: number): Promise<number | null>;
  /** The device's IANA zone a badge read reported (server/device-zone.ts `DeviceZone.note`), already shaped like a zone name. */
  noteZone?(zone: string): void;
}
export interface AttentionOptions { now?: () => number; idleMs?: number; todoEveryMs?: number; maxTodoReads?: number }
type EventStream = ReturnType<PaseoApi["observeEvents"]>;

const NOTE_MAX = 160, MAX_NOTES = 500, ASK_MAX = 120;
/** The host's attention note (its notification body, the reply's start) as one redacted line. */
export function noteOf(body: unknown): string | null {
  const text = redactSecrets(string(body)).replace(/\s+/g, " ").trim();
  return text ? text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text : null;
}
/** The sentence a reply's 快捷回复 answer (shared/reply.ts `nudgeSentence`), redacted like a note, on one line of at most 120 characters. */
export function askOf(sentence: unknown): string | null {
  const text = redactSecrets(string(sentence)).replace(/\s+/g, " ").trim(), chars = Array.from(text);
  return text ? chars.length > ASK_MAX ? `${chars.slice(0, ASK_MAX - 1).join("")}…` : text : null;
}
/** The latest todo list in projected rows: how many are done and what is in progress (B12). */
export function todoOf(items: readonly TimelineItem[], at: string): AgentTodo | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.type !== "todo" || !Array.isArray(item.items)) continue;
    const tasks = item.items.map(object), done = tasks.filter(task => task.completed === true || task.status === "completed").length;
    const active = tasks.find(task => task.status === "in_progress") ?? tasks.find(task => task.completed !== true && task.status !== "completed");
    const current = string(active?.activeForm).trim() || string(active?.text).trim();
    return tasks.length ? { done, total: tasks.length, current: current ? current.slice(0, 40) : null, at } : null;
  }
  return null;
}

/**
 * The host-wide 需要处理 summary behind the sidebar badge (opus-B1), and the live extras of loaded Agents: the running turn's
 * todo progress (opus-B12), the host's attention notes (opus-B11) and the sentence each latest reply's 快捷回复 answer (P2-1).
 * It keeps its own directory observation while someone reads it and lets go after `idleMs` without a read, so a host nobody
 * looks at carries no observation.
 */
export class AttentionIndex {
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly todoEveryMs: number;
  private readonly maxTodoReads: number;
  private directory: ReturnType<typeof createAgentDirectory> | null = null;
  private started: Promise<void> | null = null;
  private stream: EventStream | null = null;
  private paseo: PaseoApi | null = null;
  private lastRead = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly notes = new Map<string, { note: string; at: string }>();
  private readonly asks = new Map<string, { ask: string; at: string }>();
  private readonly todos = new Map<string, AgentTodo>();
  private readonly todoReadAt = new Map<string, number>();
  private todoReading: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly sources: AttentionSources, options: AttentionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.todoEveryMs = options.todoEveryMs ?? 30_000;
    this.maxTodoReads = options.maxTodoReads ?? 8;
  }

  /** Start (or keep) the directory observation and the attention-note stream for this connection. */
  attach(paseo: PaseoApi): Promise<void> {
    this.lastRead = this.now();
    if (this.closed) return Promise.resolve();
    this.paseo = paseo;
    if (!this.idleTimer) { this.idleTimer = setInterval(() => this.release(false), 60_000); this.idleTimer.unref?.(); }
    if (!this.stream && typeof paseo.observeEvents === "function") {
      try {
        const handle = paseo.observeEvents(["agent_attention_required"]);
        this.stream = handle;
        handle.subscribe({ snapshot: () => {}, update: message => this.receive(message), error: () => { if (this.stream === handle) { this.stream = null; void handle.release().catch(() => {}); } } });
      } catch { this.stream = null; }
    }
    if (!this.directory) {
      const api: AgentDirectoryApi = {
        list: options => paseo.agents.list(options) as never,
        observe: options => paseo.agents.list({ ...options, subscribe: {} }).then(result => result.subscription as unknown as AgentDirectorySubscription),
      };
      const directory = createAgentDirectory(api, { includeArchived: false, notifyDelayMs: 0 });
      this.directory = directory;
      directory.start(true);
      this.started = directory.refresh();
    }
    return this.started ?? Promise.resolve();
  }

  /** `agent_attention_required`: the note is what the host would notify with (the reply's start, the request's title). */
  receive(message: unknown): void {
    const event = object(message), payload = object(event.payload);
    if (this.closed || event.type !== "agent_attention_required") return;
    const agentId = string(payload.agentId), at = Date.parse(string(payload.timestamp));
    if (!agentId || agentId.length > 256 || !Number.isFinite(at)) return;
    // Only a finished turn's note explains a result or a reply that asks; a request's note would be read as one later.
    if (string(payload.reason) === "finished") {
      const note = noteOf(object(payload.notification).body);
      this.notes.delete(agentId);
      if (note) this.notes.set(agentId, { note, at: new Date(at).toISOString() });
      while (this.notes.size > MAX_NOTES) this.notes.delete(this.notes.keys().next().value!);
    }
    // A live observation already delivers the Agent's new state; only a polling fallback is read again now.
    const directory = this.directory;
    if (directory && !directory.getSnapshot().live) void directory.refresh();
  }
  /**
   * `agent.turn_ended`: the closing sentence its final reply's 快捷回复 answer (`nudgeSentence` of that reply, null when it
   * invites nothing or there is none), at the turn's end. Memory only, like the notes: a new turn and a reload forget it, and
   * the popover then offers no quick reply (the detail still does, under the reply itself).
   */
  noteAsk(agentId: string, sentence: string | null, at: string = new Date(this.now()).toISOString()): void {
    if (this.closed || !agentId || agentId.length > 256) return;
    const ask = sentence ? askOf(sentence) : null, when = Date.parse(at);
    this.asks.delete(agentId);
    if (ask && Number.isFinite(when)) this.asks.set(agentId, { ask, at: new Date(when).toISOString() });
    while (this.asks.size > MAX_NOTES) this.asks.delete(this.asks.keys().next().value!);
  }
  /** A new turn makes the old todo list, note and quick replies' sentence stale. */
  turnStarted(agentId: string): void { this.todos.delete(agentId); this.todoReadAt.delete(agentId); this.asks.delete(agentId); }
  /** The turn's final todo list is no longer progress; the next turn reads it again. */
  turnEnded(agentId: string): void { this.todos.delete(agentId); this.todoReadAt.delete(agentId); }
  closedAgent(agentId: string): void { this.todos.delete(agentId); this.todoReadAt.delete(agentId); }

  /** The page's records, enriched exactly as the page does it (lifecycle, background, receipts, notes, todos). */
  private async records(): Promise<{ agents: AgentRecord[]; truncated: boolean; ready: boolean; failed: boolean }> {
    const directory = this.directory?.getSnapshot();
    if (!directory) return { agents: [], truncated: false, ready: false, failed: false };
    const [telemetry, receipts] = await Promise.all([this.sources.telemetry(), this.sources.receipts()]);
    const byReceipt = new Map(receipts.receipts.map(receipt => [receipt.agentId, receipt])), byOrigin = new Map(receipts.archiveOrigins.map(origin => [origin.agentId, origin]));
    const visible = directory.agents.filter(agent => !agent.archivedAt && !isInternalAgent(agent));
    const enriched = enrichAgents(visible, telemetry, { agents: this.sources.background() })
      .map(agent => applyReadReceipt(applyArchiveReadOrigin(agent, byOrigin.get(agent.id)), byReceipt.get(agent.id)));
    // Ready once a read went through; a failed one (even after that) is reported, so no stale or partial number is shown.
    return { agents: applyLiveExtras(enriched, this.extras()), truncated: directory.truncated, ready: directory.lastSyncedAt !== null, failed: directory.error !== null };
  }

  async summary(): Promise<AttentionSummary> {
    const [{ agents, truncated, ready, failed }, { snoozes, settings }] = await Promise.all([this.records(), this.sources.preferences()]);
    const now = this.now();
    const waiting = agents.filter(agent => needsAttention(agent, isCompletionSnoozed(agent, snoozes, now), { childCompletions: settings.childCompletions }))
      .map(agent => ({ agent, phase: attentionPhase(agent) ?? "unread" as const }))
      .map(({ agent, phase }) => ({ entry: entryOf(agent, phase), rank: phaseRank[phase] }))
      .sort((a, b) => a.rank - b.rank || (Date.parse(a.entry.since ?? "") || Infinity) - (Date.parse(b.entry.since ?? "") || Infinity) || a.entry.agentId.localeCompare(b.entry.agentId));
    // Todo progress is read for the page's live extras only; the badge does not need it.
    const scheduleFailures = this.sources.scheduleFailures ? await this.sources.scheduleFailures(now - 86_400_000).catch(() => null) : null;
    return { count: waiting.length, truncated, blocking: waiting.filter(item => item.rank === 0).length, loud: waiting.filter(item => loudPhases.has(item.entry.phase)).length,
      entries: waiting.slice(0, 8).map(item => item.entry), scheduleFailures, ready, failed };
  }

  async read(input: { revision?: string } = {}): Promise<AttentionResponse> {
    const summary = await this.summary(), revision = contentRevision(summary);
    return input.revision === revision ? { mode: "unchanged", unchanged: true, revision } : { ...summary, mode: "full", unchanged: false, revision };
  }

  extras(): LiveExtra[] {
    const ids = new Set([...this.notes.keys(), ...this.todos.keys(), ...this.asks.keys()]);
    return [...ids].slice(-500).map(agentId => ({ agentId, todo: this.todos.get(agentId) ?? null, note: this.notes.get(agentId)?.note ?? null, noteAt: this.notes.get(agentId)?.at ?? null,
      ask: this.asks.get(agentId)?.ask ?? null, askAt: this.asks.get(agentId)?.at ?? null }));
  }
  async readExtras(input: { revision?: string } = {}): Promise<LiveExtrasResponse> {
    const records = await this.records();
    void this.readTodos(records.agents);
    const agents = this.extras(), revision = contentRevision(agents);
    return input.revision === revision ? { mode: "unchanged", unchanged: true, revision } : { mode: "full", unchanged: false, revision, agents };
  }

  /**
   * Todo progress of running Agents: their timeline tail, read at most every `todoEveryMs` each and only for Agents this
   * process has seen live (a running Agent is loaded; asking about an unloaded one would load it).
   */
  private readTodos(agents: readonly AgentRecord[]): Promise<void> {
    const paseo = this.paseo;
    if (!paseo || this.todoReading || this.closed) return this.todoReading ?? Promise.resolve();
    const now = this.now();
    const due = agents.filter(agent => agent.status === "running" && agent.activeTurnStartedAt && !agent.archivedAt && this.sources.isLive(agent.id)
      && now - (this.todoReadAt.get(agent.id) ?? -Infinity) >= this.todoEveryMs).slice(0, this.maxTodoReads);
    if (!due.length) return Promise.resolve();
    this.todoReading = (async () => {
      for (const agent of due) {
        if (this.closed) return;
        this.todoReadAt.set(agent.id, now);
        try {
          const page = normalizeTimelinePage(await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20, projection: "projected" }));
          const start = Date.parse(agent.activeTurnStartedAt!);
          // Only this turn's lists count; an older one in the tail is the previous turn's.
          const rows = projectTimelineRows(page.rows).filter(row => Date.parse(row.timestamp) >= start - 1000);
          const todo = todoOf(rows.map(row => row.item), new Date(now).toISOString());
          if (todo) this.todos.set(agent.id, todo);
        } catch { /* keep the last known progress */ }
      }
      while (this.todoReadAt.size > 2_000) this.todoReadAt.delete(this.todoReadAt.keys().next().value!);
    })().finally(() => { this.todoReading = null; });
    return this.todoReading;
  }

  /** Let go of the observation and the stream when nobody has read for a while (or on close). */
  private release(force: boolean): void {
    if (!force && this.now() - this.lastRead < this.idleMs) return;
    this.directory?.stop(); this.directory = null; this.started = null;
    const stream = this.stream; this.stream = null;
    void stream?.release().catch(() => {});
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }
  close(): void { this.closed = true; this.release(true); this.notes.clear(); this.todos.clear(); this.asks.clear(); }
}

export function registerAttention(server: PluginServerContext, sources: AttentionSources, options: AttentionOptions = {}) {
  const index = new AttentionIndex(sources, options);
  const ready = async (paseo: PaseoApi) => {
    // The first read waits briefly for the directory; later reads answer from it at once.
    await Promise.race([index.attach(paseo).catch(() => {}), new Promise<void>(resolve => { const timer = setTimeout(resolve, 4_000); timer.unref?.(); })]);
  };
  server.handle(getAttention, async (input, { paseo }) => { if (input.timeZone) sources.noteZone?.(input.timeZone); await ready(paseo); return index.read(input); });
  server.handle(getLiveExtras, async (input, { paseo }) => { await ready(paseo); return index.readExtras(input); });
  return index;
}
