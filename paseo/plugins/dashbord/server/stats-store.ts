import type { FleetFilters } from "../shared/fleet-scope";
import { translator } from "../shared/i18n";
import { t } from "../shared/text";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PaseoApi, AgentTimelineItem } from "./paseo-types";
import { addStatsMetrics, emptyStatsMetrics, statsMetricsSchema, statsToolSchema, TOOL_KINDS, type StatsMetrics,
  type StatsRange, type StatsResponse, type StatsSnapshot, type StatsTool, type ToolKind } from "../shared/stats";
import type { ActivityMetrics, AnalyticsSnapshot } from "../shared/analytics";
import type { TelemetrySnapshot, TurnOutcome } from "../shared/telemetry";
import { telemetryDirectory, type TelemetryStore } from "./telemetry";
import { ensurePrivateDirectory } from "./paseo-home";
import { StatsDirectory } from "./stats-directory";
import { settleWithin, type BackgroundTracker } from "./background";
import { buildStatsSnapshot } from "./stats-snapshot";
import { extractTurnContent } from "./turn-content";
import { STATS_HOUR_MS as HOUR, statsDay, statsDayText, statsHour, statsLocalDay, statsZone,
  type StatsAgentRecord, type StatsAttribution, type StatsHour, type StatsToolHour } from "./stats-types";

// One retention window for every hour-keyed list: 92 days of UTC hours hold a 90-day local range in any zone (±14 h).
const MAX_HOURS = 92 * 24, MAX_AGENTS = 2_000;
// Agent × hour buckets exist only for hours an Agent was active. A busy host (about 20 Agents a day) makes 30–60 a
// day, about 5,000 in 92 days. The 30,000 cap (about 15 MB in memory and 7 MB in stats.json, which leaves out zero
// metrics) keeps all 92 days up to about 300 Agent-hours a day; beyond that the oldest hours go first, so 7 / 30 天
// stay complete the longest.
const MAX_ATTRIBUTIONS = 30_000;
// Tool names: at most 60 an hour (formerly a day) and 30,000 in all (about 2 MB on disk), the oldest hours' names
// going first while their exact per-kind totals stay. A busy host uses about 100 a day.
const MAX_HOUR_TOOLS = 60, MAX_TOOL_NAMES = 30_000;
// Per-UTC-day lists written by 2.12.0 and earlier, read only to migrate them.
const LEGACY_ATTRIBUTIONS = 20_000, LEGACY_TOOL_DAYS = 92;
const MAX_TURN_MS = 12 * HOUR, WRITE_DELAY = 20_000, MAX_FILE_BYTES = 64 * 1024 * 1024;
const id = z.string().min(1).max(256), time = z.number().finite().nonnegative();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/), iso = z.iso.datetime();
const toolList = (maximum: number) => z.array(statsToolSchema).max(maximum);
const recordSchema = z.object({ agentId: id, lastKey: z.string().nullable(), maxTurnMs: time, maxTurnAt: iso.nullable(), updatedAt: time });
/**
 * Still version 1: the hour lists are new fields that 2.12.0 and earlier ignore, and the per-UTC-day lists they read
 * are written empty. A downgrade therefore keeps the file and its 看板 hours (only 明细 / 横评 history starts over)
 * instead of setting the whole file aside as corrupt.
 */
const savedSchema = z.object({ version: z.literal(1), change: z.number().int().nonnegative(), backfilled: z.boolean(),
  observedSince: iso.nullable(), contentSince: iso,
  hours: z.array(statsMetricsSchema.extend({ hour: iso })).max(MAX_HOURS),
  /** Agent × UTC hour; metrics that are zero are left out. */
  agentHours: z.array(statsMetricsSchema.partial().extend({ agentId: id, hour: iso, lastActiveAt: iso })).max(MAX_ATTRIBUTIONS).default([]),
  toolHours: z.array(z.object({ hour: iso, tools: toolList(MAX_HOUR_TOOLS), kinds: toolList(TOOL_KINDS.length) })).max(MAX_HOURS).default([]),
  attributions: z.array(statsMetricsSchema.extend({ agentId: id, day, lastActiveAt: iso })).max(LEGACY_ATTRIBUTIONS).default([]),
  toolDays: z.array(z.object({ day, tools: toolList(60), kinds: toolList(8).optional() })).max(LEGACY_TOOL_DAYS).default([]),
  records: z.array(recordSchema).max(MAX_AGENTS), running: z.array(z.tuple([id, time])),
  permissions: z.array(z.object({ agentId: id, requests: z.array(z.tuple([z.string().max(64), time])).max(32) })),
});
/** Oldest hour key other than `except`; keys are `statsHour` strings, which sort chronologically. */
function oldestHour(map: ReadonlyMap<string, unknown>, except: string): string | undefined {
  let oldest: string | undefined;
  for (const key of map.keys()) if (key !== except && (oldest === undefined || key < oldest)) oldest = key;
  return oldest;
}
/** Zero metrics are implied on disk: most Agent-hours carry a handful of the 25. */
const sparse = (bucket: StatsAttribution) => Object.fromEntries(Object.entries(bucket).filter(([, value]) => value !== 0));
/** The `statsHour` key of a saved ISO time (any valid spelling), or null. */
function hourKey(stamp: string): string | null {
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? statsHour(at) : null;
}
/** Hour of a 2.12.0 per-UTC-day Agent bucket: its latest activity, which lies inside that day, else UTC noon. */
function legacyAgentHour(day: string, lastActiveAt: string): string | null {
  const at = Date.parse(lastActiveAt);
  return Number.isFinite(at) && statsDay(at) === day ? statsHour(at) : hourKey(`${day}T12:00:00.000Z`);
}

export type StatsObservation =
  | { type: "turn_started"; agentId: string }
  | { type: "turn_ended"; agentId: string; outcome: TurnOutcome; timeline: readonly AgentTimelineItem[] }
  | { type: "permission_requested" | "permission_resolved"; agentId: string; requestId: string };
export interface StatsStoreOptions {
  directory?: string; now?: () => number;
  /** Shared directory walker (a private one is created when omitted). */
  agents?: StatsDirectory;
  telemetry?: Pick<TelemetryStore, "analyticsSnapshot" | "snapshot"> & Partial<Pick<TelemetryStore, "awaitingAgents">>;
  /** Provider subagents still working after their parent's turn (后台执行中). */
  background?: Pick<BackgroundTracker, "sync" | "runningIds">;
}

function activity(metrics: ActivityMetrics): StatsMetrics {
  return { ...emptyStatsMetrics(), turns: Math.floor(metrics.started), completed: Math.floor(metrics.completed),
    failed: Math.floor(metrics.failed), canceled: Math.floor(metrics.canceled), runMs: metrics.runMs,
    runSamples: Math.floor(metrics.runSamples), waitMs: metrics.waitMs };
}

/**
 * Hooks are synchronous and only inspect the new timeline suffix. Register them after `ready`:
 * this establishes the telemetry backfill boundary before live observation begins.
 * No prompt, tool arguments, outputs, or file paths are retained.
 */
export class StatsStore {
  readonly ready: Promise<void>;
  private readonly directory: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly directoryCache: StatsDirectory;
  private readonly replies?: Pick<TelemetryStore, "awaitingAgents">;
  private readonly background?: StatsStoreOptions["background"];
  private readonly hours = new Map<string, StatsHour>();
  /** UTC hour → Agent → metrics, only for hours an Agent was active (see MAX_ATTRIBUTIONS). */
  private readonly attributions = new Map<string, Map<string, StatsAttribution>>();
  private attributionCount = 0;
  /** UTC hour → tool names (at most 60) and exact per-kind totals; an hour with names always has kinds. */
  private readonly toolNames = new Map<string, Map<string, StatsTool>>();
  private readonly toolKinds = new Map<string, Map<ToolKind, StatsTool>>();
  private toolNameCount = 0;
  private readonly records = new Map<string, StatsAgentRecord>();
  private readonly running = new Map<string, number>();
  /** When each Agent's latest turn ended, to overrule a directory walk that still shows it running. */
  private readonly ended = new Map<string, number>();
  private readonly permissions = new Map<string, Map<string, number>>();
  private observedSince: string | null = null;
  private contentSince: string;
  private backfilled = false;
  private change = 0;
  private lastAdvance: number;
  private prunedHour = "";
  private dirty = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes = Promise.resolve();
  private memo = new Map<string, { revision: string; snapshot: StatsSnapshot }>();
  private initialized = false;
  private storageReadable = true;

  constructor(options: StatsStoreOptions = {}) {
    this.directory = options.directory ?? telemetryDirectory(); this.file = join(this.directory, "stats.json");
    this.now = options.now ?? Date.now; this.lastAdvance = this.now();
    this.contentSince = new Date(this.lastAdvance).toISOString();
    this.directoryCache = options.agents ?? new StatsDirectory(this.now);
    if (options.telemetry?.awaitingAgents) this.replies = options.telemetry as Pick<TelemetryStore, "awaitingAgents">;
    this.background = options.background;
    // Restore before returning the synchronous plugin contribution, so lifecycle IPC cannot
    // fall into an asynchronous reload gap. Writes remain off the lifecycle path.
    this.restore();
    if (this.backfilled) {
      this.initialized = true; this.ready = Promise.resolve(); this.prune(this.now());
      if (this.dirty) this.scheduleWrite();
      return;
    }
    this.ready = this.initialize(options.telemetry).catch(() => {
      // Storage/source errors cannot prevent the plugin's other contributions from loading.
      this.observedSince ??= this.contentSince;
      this.backfilled = true; this.changed();
    }).finally(() => {
      this.lastAdvance = this.now();
      this.contentSince = new Date(this.lastAdvance).toISOString();
      this.initialized = true;
      this.prune(this.now());
      if (this.dirty) this.scheduleWrite();
    });
  }

  record(observation: StatsObservation): void {
    if (this.closed || !this.initialized) return;
    try {
      const at = this.now();
      if (!observation.agentId || observation.agentId.length > 256 || !Number.isFinite(at) || at < 0) return;
      this.applySafely(observation, at);
    } catch { /* A malformed provider item must never escape a lifecycle hook. */ }
  }

  private applySafely(observation: StatsObservation, at: number): void {
    try {
      this.advance(at);
      const agentId = observation.agentId, state = this.agent(agentId, at);
      switch (observation.type) {
        case "turn_started":
          this.running.set(agentId, at);
          this.add(agentId, at, { turns: 1 });
          this.observePeak(at);
          break;
        case "turn_ended": {
          const start = this.running.get(agentId);
          const delta: Partial<StatsMetrics> = { [observation.outcome]: 1 };
          if (start !== undefined) {
            const ms = Math.max(0, at - start); delta.runMs = ms; delta.runSamples = 1;
            if (ms > state.maxTurnMs || state.maxTurnAt === null) { state.maxTurnMs = ms; state.maxTurnAt = new Date(at).toISOString(); }
          }
          this.running.delete(agentId);
          this.ended.delete(agentId); this.ended.set(agentId, at);
          while (this.ended.size > MAX_AGENTS) this.ended.delete(this.ended.keys().next().value!);
          this.add(agentId, at, delta);
          const content = extractTurnContent(observation.timeline, state.lastKey);
          state.lastKey = content.lastKey;
          this.add(agentId, at, content.metrics);
          this.addTools(at, content.tools);
          break;
        }
        case "permission_requested": {
          const requests = this.permissions.get(agentId) ?? new Map<string, number>();
          const key = createHash("sha256").update(observation.requestId).digest("hex");
          if (!requests.has(key)) {
            requests.set(key, at);
            while (requests.size > 32) requests.delete(requests.keys().next().value!);
            this.permissions.set(agentId, requests); this.add(agentId, at, { approvals: 1 });
          }
          break;
        }
        case "permission_resolved": {
          const requests = this.permissions.get(agentId), key = createHash("sha256").update(observation.requestId).digest("hex");
          const start = requests?.get(key);
          if (start !== undefined) { this.add(agentId, at, { waitMs: Math.max(0, at - start) }); requests!.delete(key); }
          if (!requests?.size) this.permissions.delete(agentId);
          break;
        }
      }
      this.changed(); this.prune(at);
    } catch { /* Keep all other lifecycle consumers operational. */ }
  }

  async read(input: { complete?: boolean; filters?: FleetFilters; range: StatsRange; utcOffsetMinutes: number; timeZone?: string; revision?: string }, paseo: PaseoApi): Promise<StatsResponse> {
    await this.ready;
    await this.directoryCache.refresh(paseo);
    if (this.background) await settleWithin(this.background.sync(this.directoryCache.agents, this.directoryCache.refreshedAt), 4_000);
    const now = this.now();
    // Commit the partial advance once. A later read/end starts at this new boundary.
    this.advance(now);
    if (this.directoryCache.loaded) {
      const known = new Map(this.directoryCache.agents.map(agent => [agent.id, agent]));
      for (const [agentId, start] of this.running) {
        const agent = known.get(agentId);
        // Cached idle descriptors pre-dating a new hook cannot invalidate that turn.
        if (agent && agent.status !== "running" && !agent.activeTurn && start <= this.directoryCache.refreshedAt) {
          this.running.delete(agentId); this.changed();
        }
      }
    }
    this.prune(now);
    const awaiting = this.replies?.awaitingAgents(this.directoryCache.agents) ?? new Set<string>();
    const walkedAt = this.directoryCache.refreshedAt, background = this.background?.runningIds() ?? new Set<string>();
    // A turn that ended after the walk is over, even while the cached walk still shows it running.
    const ended = new Set([...this.ended].filter(([agentId, at]) => at > walkedAt && !this.running.has(agentId)).map(([agentId]) => agentId));
    // The zone actually applied (null: the fixed offset) and its local today are part of both the revision and the memo
    // key, so another zone, or the same zone past local midnight, never gets an earlier projection.
    const zone = statsZone(input.utcOffsetMinutes, input.timeZone, now), today = statsDayText(statsLocalDay(now, zone));
    const revision = createHash("sha256").update(JSON.stringify([translator().language, translator().hash, this.change, this.directoryCache.digest,
      input.complete, input.filters, input.range, input.utcOffsetMinutes, zone.name, today, [...this.running.keys()].sort(), [...awaiting].sort(),
      [...background].sort(), [...ended].sort()])).digest("hex").slice(0, 24);
    if (input.revision === revision) return { mode: "unchanged", unchanged: true, revision };
    const key = JSON.stringify([input.complete, input.filters, input.range, input.utcOffsetMinutes, zone.name]), cached = this.memo.get(key);
    let snapshot = cached?.revision === revision ? cached.snapshot : undefined;
    if (!snapshot) {
      snapshot = buildStatsSnapshot({ complete: input.complete, filters: input.filters, now, range: input.range, utcOffsetMinutes: input.utcOffsetMinutes, timeZone: zone.name,
        hours: [...this.hours.values()], attributions: this.attributionList(), toolHours: this.tools(),
        records: [...this.records.values()], running: this.running, directory: this.directoryCache.agents,
        observedSince: this.observedSince, contentSince: this.contentSince, directoryTruncated: this.directoryCache.truncated, awaiting,
        background, ended, walkedAt });
      this.memo.delete(key); this.memo.set(key, { revision, snapshot });
      while (this.memo.size > 12) this.memo.delete(this.memo.keys().next().value!);
    }
    return { ...snapshot, mode: "full", unchanged: false, revision };
  }

  private agent(agentId: string, at: number): StatsAgentRecord {
    const state = this.records.get(agentId) ?? { agentId, lastKey: null, maxTurnMs: 0, maxTurnAt: null, updatedAt: at };
    state.updatedAt = at; this.records.delete(agentId); this.records.set(agentId, state);
    while (this.records.size > MAX_AGENTS) {
      const old = this.records.keys().next().value!;
      // Cursor LRU eviction must not terminate an independently tracked active turn/request.
      this.records.delete(old);
    }
    return state;
  }

  private addHour(at: number, metrics: Partial<StatsMetrics>): void {
    const hour = statsHour(at), bucket = this.hours.get(hour) ?? { hour, ...emptyStatsMetrics() };
    addStatsMetrics(bucket, metrics); this.hours.set(hour, bucket);
  }
  private addAttribution(agentId: string, at: number, metrics: Partial<StatsMetrics>): void {
    const hour = statsHour(at), members = this.membersOf(hour);
    let bucket = members.get(agentId);
    if (!bucket) { bucket = { agentId, hour, lastActiveAt: new Date(at).toISOString(), ...emptyStatsMetrics() }; members.set(agentId, bucket); this.attributionCount++; }
    else if (at > Date.parse(bucket.lastActiveAt)) bucket.lastActiveAt = new Date(at).toISOString();
    addStatsMetrics(bucket, metrics);
    this.evictAttributions(hour);
  }
  private membersOf(hour: string): Map<string, StatsAttribution> {
    let members = this.attributions.get(hour);
    if (!members) { members = new Map(); this.attributions.set(hour, members); }
    return members;
  }
  /** Restore and migration: adds a whole Agent-hour, merging with one already held. */
  private mergeAttribution(bucket: StatsAttribution): void {
    const members = this.membersOf(bucket.hour), current = members.get(bucket.agentId);
    if (!current) { members.set(bucket.agentId, bucket); this.attributionCount++; return; }
    addStatsMetrics(current, bucket);
    if (Date.parse(bucket.lastActiveAt) > Date.parse(current.lastActiveAt)) current.lastActiveAt = bucket.lastActiveAt;
  }
  /** Whole oldest hours go first; the hour being written only loses entries if it alone is above the cap. */
  private evictAttributions(keep: string): void {
    while (this.attributionCount > MAX_ATTRIBUTIONS) {
      const oldest = oldestHour(this.attributions, keep);
      if (oldest !== undefined) { this.attributionCount -= this.attributions.get(oldest)!.size; this.attributions.delete(oldest); continue; }
      const first = this.attributions.get(keep)?.keys().next();
      if (!first || first.done) return;
      this.attributions.get(keep)!.delete(first.value); this.attributionCount--;
    }
  }
  private attributionList(): StatsAttribution[] { return [...this.attributions.values()].flatMap(members => [...members.values()]); }
  private add(agentId: string, at: number, metrics: Partial<StatsMetrics>): void { this.addHour(at, metrics); this.addAttribution(agentId, at, metrics); }

  private observePeak(at: number): void {
    const peakParallel = this.running.size;
    if (!peakParallel) return;
    this.addHour(at, { peakParallel });
    for (const agentId of this.running.keys()) this.addAttribution(agentId, at, { peakParallel });
  }

  private advance(at: number): void {
    if (at < this.lastAdvance) return;
    let cursor = this.lastAdvance;
    // Expire at the exact 12h boundary, including when no hooks/RPCs arrived in between.
    while (cursor < at && this.running.size) {
      for (const [agentId, started] of this.running) if (started + MAX_TURN_MS <= cursor) { this.running.delete(agentId); this.changed(); }
      if (!this.running.size) break;
      const end = Math.min(at, Math.floor(cursor / HOUR) * HOUR + HOUR, ...[...this.running.values()].map(start => start + MAX_TURN_MS));
      const busyMs = end - cursor, peakParallel = this.running.size;
      this.addHour(cursor, { busyMs, peakParallel });
      // Share wall time across concurrent participants, preserving additive attribution totals.
      for (const agentId of this.running.keys()) this.addAttribution(agentId, cursor, { busyMs: busyMs / peakParallel, peakParallel });
      cursor = end; this.changed();
    }
    for (const [agentId, started] of this.running) if (started + MAX_TURN_MS <= at) { this.running.delete(agentId); this.changed(); }
    this.lastAdvance = at;
    this.observePeak(at);
  }

  private addTools(at: number, tools: readonly StatsTool[]): void {
    if (!tools.length) return;
    const hour = statsHour(at);
    this.mergeTools(hour, tools, tools); this.evictToolNames(hour);
  }
  /** Adds named counts (new names only while the hour has fewer than 60) and per-kind totals to one hour. */
  private mergeTools(hour: string, tools: readonly StatsTool[], kinds: readonly StatsTool[]): void {
    const names = this.toolNames.get(hour) ?? new Map<string, StatsTool>(), totals = this.toolKinds.get(hour) ?? new Map<ToolKind, StatsTool>();
    for (const tool of kinds) {
      const total = totals.get(tool.kind) ?? { name: tool.kind, kind: tool.kind, calls: 0, failures: 0 };
      total.calls += tool.calls; total.failures += tool.failures; totals.set(tool.kind, total);
    }
    for (const tool of tools) {
      const key = JSON.stringify([tool.name, tool.kind]), current = names.get(key);
      if (current) { current.calls += tool.calls; current.failures += tool.failures; }
      else if (names.size < MAX_HOUR_TOOLS) { names.set(key, { ...tool }); this.toolNameCount++; }
    }
    if (names.size) this.toolNames.set(hour, names);
    this.toolKinds.set(hour, totals);
  }
  private evictToolNames(keep: string): void {
    while (this.toolNameCount > MAX_TOOL_NAMES) {
      const oldest = oldestHour(this.toolNames, keep);
      if (oldest === undefined) return;
      this.toolNameCount -= this.toolNames.get(oldest)!.size; this.toolNames.delete(oldest);
    }
  }
  private tools(): StatsToolHour[] {
    return [...this.toolKinds].map(([hour, kinds]) => ({ hour, tools: [...(this.toolNames.get(hour)?.values() ?? [])], kinds: [...kinds.values()] }));
  }

  private prune(at: number): void {
    const hour = statsHour(at);
    if (hour === this.prunedHour) return;
    this.prunedHour = hour;
    const minimum = Date.parse(hour) - (MAX_HOURS - 1) * HOUR, expired = (key: string) => Date.parse(key) < minimum;
    for (const key of this.hours.keys()) if (expired(key)) { this.hours.delete(key); this.changed(); }
    for (const [key, members] of this.attributions) if (expired(key)) { this.attributions.delete(key); this.attributionCount -= members.size; this.changed(); }
    for (const key of this.toolKinds.keys()) if (expired(key)) { this.toolKinds.delete(key); this.changed(); }
    for (const [key, names] of this.toolNames) if (expired(key)) { this.toolNames.delete(key); this.toolNameCount -= names.size; this.changed(); }
  }
  private changed(): void { this.change++; this.dirty = true; if (this.initialized) this.scheduleWrite(); }
  private scheduleWrite(): void {
    if (this.closed || this.timer || !this.storageReadable) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, WRITE_DELAY);
    this.timer.unref?.();
  }

  private async initialize(telemetry: StatsStoreOptions["telemetry"]): Promise<void> {
    if (telemetry) {
      const [analytics, summaries] = await Promise.all([telemetry.analyticsSnapshot(), telemetry.snapshot()]);
      this.backfill(analytics, summaries);
    } else this.observedSince = this.contentSince;
    this.backfilled = true; this.changed();
  }
  private backfill(analytics: AnalyticsSnapshot, telemetry: TelemetrySnapshot): void {
    this.observedSince = analytics.startedAt;
    const covered = new Set<string>();
    for (const bucket of analytics.hours) { covered.add(bucket.bucketStart.slice(0, 10)); this.addHour(Date.parse(bucket.bucketStart), activity(bucket)); }
    for (const bucket of analytics.days) if (!covered.has(bucket.bucketStart.slice(0, 10))) this.addHour(Date.parse(bucket.bucketStart) + 12 * HOUR, activity(bucket));
    const lastActivity = new Map<string, number>();
    const remember = (agentId: string, stamp: string | null | undefined) => {
      const at = stamp ? Date.parse(stamp) : NaN;
      if (Number.isFinite(at)) lastActivity.set(agentId, Math.max(lastActivity.get(agentId) ?? 0, at));
    };
    for (const agent of telemetry.agents) { remember(agent.agentId, agent.turnEndedAt); remember(agent.agentId, agent.turnStartedAt); }
    for (const event of telemetry.events) remember(event.agentId, event.at);
    for (const sample of analytics.usage) remember(sample.agentId, sample.at);
    for (const agent of analytics.agents) this.addAttribution(agent.agentId, lastActivity.get(agent.agentId) ?? Date.parse(analytics.updatedAt), activity(agent));
  }

  private restore(): void {
    let content: string;
    try {
      const details = statSync(this.file);
      if (details.size > MAX_FILE_BYTES) { this.quarantine(); return; }
      content = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // An inaccessible valid file is not corrupt, and must not be replaced by a fresh ledger.
      this.storageReadable = false;
      console.warn(t("serverStatsStore.m001"));
      return;
    }
    try {
      const saved = savedSchema.parse(JSON.parse(content));
      this.observedSince = saved.observedSince; this.contentSince = saved.contentSince;
      this.change = saved.change; this.backfilled = saved.backfilled;
      for (const bucket of saved.hours) this.hours.set(bucket.hour, bucket);
      for (const { hour, ...entry } of saved.agentHours) {
        const key = hourKey(hour);
        if (key) this.mergeAttribution({ ...emptyStatsMetrics(), ...entry, hour: key });
      }
      for (const entry of saved.toolHours) { const key = hourKey(entry.hour); if (key) this.mergeTools(key, entry.tools, entry.kinds); }
      // 2.12.0 and earlier kept these two per UTC day, which cannot be split exactly. An Agent-day moves whole to the
      // hour of its latest activity (inside that UTC day by construction); a tool day to the hour that halves that day's
      // tool calls in the 看板 hours (they carry the same per-hour totals), so it lands on the local day that had most
      // of them. UTC noon stands in when neither is known.
      for (const { day, ...bucket } of saved.attributions) {
        const hour = legacyAgentHour(day, bucket.lastActiveAt);
        if (hour) this.mergeAttribution({ ...bucket, hour });
      }
      for (const bucket of saved.toolDays) { const hour = this.legacyToolHour(bucket.day); if (hour) this.mergeTools(hour, bucket.tools, bucket.kinds ?? bucket.tools); }
      this.evictAttributions(""); this.evictToolNames("");
      // Rewritten in the hour layout with the next write.
      if (saved.attributions.length || saved.toolDays.length) this.changed();
      for (const record of saved.records.sort((a, b) => a.updatedAt - b.updatedAt)) this.records.set(record.agentId, record);
      for (const [agentId, start] of saved.running) if (start + MAX_TURN_MS > this.lastAdvance) this.running.set(agentId, start);
      for (const entry of saved.permissions) this.permissions.set(entry.agentId, new Map(entry.requests));
      // No unobserved process downtime is charged as busy time after restore.
    } catch { this.quarantine(); }
  }
  /** Hour of a 2.12.0 tool day: where the day's tool calls in the 看板 hours reach half (UTC noon without any). */
  private legacyToolHour(day: string): string | null {
    const start = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(start)) return null;
    const calls = Array.from({ length: 24 }, (_, index) => this.hours.get(statsHour(start + index * HOUR))?.toolCalls ?? 0);
    const total = calls.reduce((sum, value) => sum + value, 0);
    let seen = 0;
    return statsHour(start + (total ? calls.findIndex(value => (seen += value) * 2 >= total) : 12) * HOUR);
  }
  private quarantine(): void {
    try { renameSync(this.file, `${this.file}.corrupt`); }
    catch { this.storageReadable = false; }
    this.changed();
  }

  /** Atomic serialized writes; normal writes are delayed by 20s and close also fsyncs. */
  flush(durable = false): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.writes = this.writes.then(async () => {
      await this.ready;
      if (!this.storageReadable) return;
      if (!this.dirty) {
        if (durable) { const handle = await open(this.file, "r").catch(() => null); if (handle) { try { await handle.sync(); } finally { await handle.close(); } } }
        return;
      }
      const change = this.change;
      const payload = JSON.stringify({ version: 1, change, backfilled: this.backfilled, observedSince: this.observedSince, contentSince: this.contentSince,
        hours: [...this.hours.values()], agentHours: this.attributionList().map(sparse), toolHours: this.tools(), attributions: [], toolDays: [],
        records: [...this.records.values()], running: [...this.running], permissions: [...this.permissions].map(([agentId, requests]) => ({ agentId, requests: [...requests] })) });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await ensurePrivateDirectory(this.directory);
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(payload, "utf8"); if (durable) await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.file);
        this.dirty = this.change !== change;
      } finally { await unlink(temporary).catch(() => {}); }
    }).catch(() => { this.dirty = true; }).finally(() => { if (this.dirty) this.scheduleWrite(); });
    return this.writes;
  }
  async close(): Promise<void> {
    if (this.closed) { await this.writes; return; }
    this.closed = true; await this.ready; this.advance(this.now()); this.prune(this.now()); await this.flush(true);
  }
}
