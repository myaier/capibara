import { z } from "zod";
import { agentAnalyticsSchema, analyticsBucketSchema, usageSampleSchema, emptyActivityMetrics, observationIntervalSchema, coveredDuration,
  ANALYTICS_DAYS, HEATMAP_DAYS, analyticsDayStart, analyticsDayText, analyticsLocalDay,
  type ActivityMetrics, type AgentAnalytics, type AnalyticsBucket, type AnalyticsSnapshot, type AnalyticsZone, type UsageSample, type ObservationInterval } from "../shared/analytics";
import type { TelemetryEvent } from "../shared/telemetry";
import { statsZone, type StatsZone } from "./stats-types";

const HOUR = 3_600_000, DAY = 86_400_000;
/**
 * UTC hour buckets are kept 29 days: 28 local days ending today start at most 28 days and an hour before now in any zone
 * (opus-F40). 2.13 kept 168 hours, which a US evening's local week already outran. UTC days stay (29) for the stats
 * backfill, each project's Agent list, and data from before hourly history (`hourlyFrom`).
 */
const HOUR_BUCKETS = (ANALYTICS_DAYS + 1) * 24, DAY_BUCKETS = ANALYTICS_DAYS + 1;
const attributedBucketSchema = analyticsBucketSchema.extend({ agentId: z.string(), projectId: z.string().nullable(), period: z.enum(["hour", "day"]) });
const stateSchema = z.object({ startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  hours: z.array(analyticsBucketSchema).max(HOUR_BUCKETS + 24), days: z.array(analyticsBucketSchema).max(DAY_BUCKETS + 2),
  agents: z.array(agentAnalyticsSchema).max(2_000), usage: z.array(usageSampleSchema).max(1_000),
  agentsTruncated: z.boolean(), coverageIntervals: z.array(observationIntervalSchema).max(2048).optional(),
  attributedBuckets: z.array(attributedBucketSchema).max(18_000).optional(), attributionStartedAt: z.iso.datetime().optional(), projectHistoryTruncated: z.boolean().optional(),
  hourlyFrom: z.iso.datetime().optional() });

/** The client's clock, as `observatory.analytics.get` takes it; without it the reply is UTC and says so. */
export interface AnalyticsDevice { timeZone?: string | null; utcOffsetMinutes?: number | null }
/**
 * The device's clock as statsZone builds it. Clients send their offset with the zone name (statsZone checks one against
 * the other, the device winning); a zone known by name alone (DeviceZone, for work without a client) gets the offset it
 * has at `now`. Null when neither is usable: the caller then works in UTC and says so.
 */
export function deviceZone(timeZone: string | null | undefined, utcOffsetMinutes: number | null | undefined, now: number): StatsZone | null {
  if (typeof utcOffsetMinutes === "number" && Number.isInteger(utcOffsetMinutes) && Math.abs(utcOffsetMinutes) <= 840) return statsZone(utcOffsetMinutes, timeZone, now);
  if (!timeZone) return null;
  // Every offset in use is a whole number of quarter hours from UTC−12 to UTC+14; statsZone names the zone only with its own.
  for (let minutes = -720; minutes <= 840; minutes += 15) { const zone = statsZone(minutes, timeZone, now); if (zone.name) return zone; }
  return null;
}
/**
 * A zone's offsets at every UTC hour start from `from` to `to`, as the wire carries them: only the changes, the first
 * one from 0 (it holds for anything earlier too), so the list, and with it the reply's revision, stays the same from
 * hour to hour until a change enters or leaves the range.
 */
export function zoneOffsets(zone: StatsZone, from: number, to: number): AnalyticsZone["offsets"] {
  const offsets: AnalyticsZone["offsets"] = [];
  for (let at = Math.max(0, Math.floor(from / HOUR) * HOUR); at <= to && offsets.length < 64; at += HOUR) {
    const minutes = Math.round(zone.offsetAt(at) / 60_000);
    if (offsets.at(-1)?.[1] !== minutes) offsets.push([offsets.length ? at : 0, minutes]);
  }
  return offsets.length ? offsets : [[0, 0]];
}
export interface AnalyticsAgent {
  id: string; provider?: string; workspaceId?: string | null;
  projectId?: string | null; projectName?: string | null; projectRootPath?: string | null;
}
export interface ReportedUsage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalCostUsd?: number }
const valid = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const safeText = (value: string | null | undefined, maximum: number) => typeof value === "string" && value.length ? value.slice(0, maximum) : null;
function merge(target: ActivityMetrics, delta: ActivityMetrics) {
  for (const key of ["eventCount", "started", "completed", "failed", "canceled", "runMs", "runSamples", "waitMs", "usageSamples"] as const) target[key] += delta[key];
  for (const key of ["inputTokens", "outputTokens", "cachedTokens", "costUsd"] as const) {
    if (delta[key] !== null) target[key] = target[key] === null ? delta[key] : Math.max(target[key], delta[key]);
  }
}
const metricsOf = ({ eventCount, started, completed, failed, canceled, runMs, runSamples, waitMs, inputTokens, outputTokens, cachedTokens, costUsd, usageSamples }: ActivityMetrics): ActivityMetrics =>
  ({ eventCount, started, completed, failed, canceled, runMs, runSamples, waitMs, inputTokens, outputTokens, cachedTokens, costUsd, usageSamples });
/**
 * Which Agent an attributed bucket is kept under. A project's hours need none: one bucket per project and hour keeps 29
 * days of them small (only the per-Agent days feed a project's Agent list, and hours not yet placed in a project wait per
 * Agent for updateAttribution to move them).
 */
const attributionOwner = (period: "hour" | "day", projectId: string | null, agentId: string): string => period === "hour" && projectId !== null ? "" : agentId;

/** Takes the hour's counts out of a UTC day's remainder (peaks cannot be taken out and stay: an approximation's edge). */
function subtract(target: ActivityMetrics, delta: ActivityMetrics) {
  for (const key of ["eventCount", "started", "completed", "failed", "canceled", "runMs", "runSamples", "waitMs", "usageSamples"] as const) target[key] = Math.max(0, target[key] - delta[key]);
}

/**
 * The reply's local days and heatmap hours from UTC buckets (opus-F40). Every hour from `hourlyFrom` on is added to the
 * local day its start falls on, with the offset in force then. Before `hourlyFrom` (data from 2.13 and older, which kept
 * 168 hours) only UTC days exist: each such day adds what its hours do not already hold to the local day of the same
 * date, so every event counts exactly once, and that day is `approximate` (its edges are off by the zone's offset) —
 * except in UTC itself, where the UTC day is the local day.
 */
function localView(hourly: readonly AnalyticsBucket[], daily: readonly AnalyticsBucket[], options: { zone: AnalyticsZone | null; now: number; hourlyFrom: number; intervals: readonly ObservationInterval[] }) {
  const { zone, now, hourlyFrom, intervals } = options;
  const today = analyticsLocalDay(now, zone), first = today - (ANALYTICS_DAYS - 1);
  const sums = new Map<number, ActivityMetrics>(), rest = new Map<string, ActivityMetrics>();
  for (const bucket of daily) if (Date.parse(bucket.bucketStart) < hourlyFrom) rest.set(bucket.bucketStart.slice(0, 10), metricsOf(bucket));
  for (const bucket of hourly) {
    const at = Date.parse(bucket.bucketStart), day = analyticsLocalDay(at, zone);
    if (at < hourlyFrom) continue;
    const held = rest.get(bucket.bucketStart.slice(0, 10));
    if (held) subtract(held, bucket);
    if (day < first || day > today) continue;
    const sum = sums.get(day) ?? emptyActivityMetrics(); merge(sum, bucket); sums.set(day, sum);
  }
  const days: AnalyticsBucket[] = [];
  for (let day = first; day <= today; day++) {
    const start = analyticsDayStart(day, zone), end = analyticsDayStart(day + 1, zone), text = analyticsDayText(day);
    const hours = sums.get(day) ?? null, older = rest.get(text), early = older && older.eventCount + older.usageSamples > 0 ? older : null;
    let metrics = hours;
    if (early) { if (hours) merge(early, hours); metrics = early; }
    if (!metrics) continue;
    const approximate = !!early && !(start === day * DAY && end === (day + 1) * DAY);
    days.push({ ...metrics, bucketStart: new Date(start).toISOString(), day: text, coveredMs: coveredDuration(intervals, start, end), ...(approximate ? { approximate: true } : {}) });
  }
  const from = Math.max(hourlyFrom, analyticsDayStart(today - (HEATMAP_DAYS - 1), zone));
  const hours = hourly.filter(bucket => { const at = Date.parse(bucket.bucketStart); return at >= from && at <= now; })
    .map(bucket => ({ ...metricsOf(bucket), bucketStart: bucket.bucketStart, coveredMs: coveredDuration(intervals, Date.parse(bucket.bucketStart), Date.parse(bucket.bucketStart) + HOUR) }))
    .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
  return { days, hours };
}

/** Serialized by TelemetryStore and persisted in the same atomic transaction. */
export class AnalyticsAccumulator {
  private startedAt: string;
  private updatedAt: string;
  private readonly hours = new Map<string, AnalyticsBucket>();
  private readonly days = new Map<string, AnalyticsBucket>();
  private readonly agents = new Map<string, AgentAnalytics>();
  private usage: UsageSample[] = [];
  private agentsTruncated = false;
  private readonly sessionStart: number;
  private lastHeartbeat: number;
  private coverageIntervals: ObservationInterval[];
  private attributedBuckets = new Map<string, z.infer<typeof attributedBucketSchema>>();
  private attributionStartedAt: string;
  private projectHistoryTruncated = false;
  /** Hour buckets are complete from this UTC hour on (the start, or for data from 2.13 and older the edge of its 168 hours). */
  private hourlyFrom: number;
  constructor(now: number) {
    this.startedAt = this.updatedAt = this.attributionStartedAt = new Date(now).toISOString(); this.sessionStart = this.lastHeartbeat = now;
    this.coverageIntervals = [{ start: this.startedAt, end: this.startedAt }]; this.hourlyFrom = Math.floor(now / HOUR) * HOUR;
  }

  restore(value: unknown): boolean {
    const result = stateSchema.safeParse(value);
    if (!result.success) return false;
    const state = result.data;
    this.startedAt = state.startedAt; this.updatedAt = state.updatedAt; this.agentsTruncated = state.agentsTruncated;
    this.hours.clear(); this.days.clear(); this.agents.clear();
    for (const bucket of state.hours) this.hours.set(bucket.bucketStart, bucket);
    for (const bucket of state.days) this.days.set(bucket.bucketStart, bucket);
    for (const agent of state.agents) this.agents.set(agent.agentId, agent);
    this.usage = state.usage;
    // 2.13 and older pruned hours to the last 168 at every heartbeat: the hours are complete only from that edge of the
    // last one it saw. Taken from the latest heartbeat or event it saved, so the edge is never earlier than the truth.
    const lastSeen = Math.max(Date.parse(state.updatedAt), ...(state.coverageIntervals ?? []).map(interval => Date.parse(interval.end)).filter(Number.isFinite));
    this.hourlyFrom = state.hourlyFrom ? Date.parse(state.hourlyFrom) : Math.max(Math.floor(Date.parse(state.startedAt) / HOUR) * HOUR, Math.floor(lastSeen / HOUR) * HOUR - 167 * HOUR);
    this.coverageIntervals = [...(state.coverageIntervals ?? []), { start: new Date(this.sessionStart).toISOString(), end: new Date(this.sessionStart).toISOString() }].slice(-2048);
    this.lastHeartbeat = this.sessionStart;
    this.attributedBuckets = new Map((state.attributedBuckets ?? []).map(bucket => [JSON.stringify([bucket.agentId, bucket.period, bucket.bucketStart, bucket.projectId]), bucket]));
    this.attributionStartedAt = state.attributionStartedAt ?? new Date(this.sessionStart).toISOString();
    this.projectHistoryTruncated = state.projectHistoryTruncated ?? false;
    return true;
  }
  serialize() {
    return { startedAt: this.startedAt, updatedAt: this.updatedAt, hours: [...this.hours.values()], days: [...this.days.values()],
      agents: [...this.agents.values()], usage: this.usage, agentsTruncated: this.agentsTruncated, coverageIntervals: this.coverageIntervals.map(interval => ({ ...interval })),
      attributedBuckets: [...this.attributedBuckets.values()], attributionStartedAt: this.attributionStartedAt, projectHistoryTruncated: this.projectHistoryTruncated,
      hourlyFrom: new Date(this.hourlyFrom).toISOString() };
  }
  /**
   * The page's view at `now`, in the device's clock (`device`, from the RPC; UTC with `zone: null` without it): the 28
   * local days with activity and the hour buckets of the heatmap's 7 local days (opus-F40). Internal readers (the stats
   * backfill) pass no device and read UTC days.
   */
  snapshot(now: number, persistenceError: string | null, projectId?: string, device?: AnalyticsDevice): AnalyticsSnapshot {
    this.prune(now);
    const state = this.serialize();
    const grouped = (period: "hour" | "day") => {
      const groups = new Map<string, AnalyticsBucket>();
      for (const item of this.attributedBuckets.values()) {
        if (item.period !== period || item.projectId !== projectId) continue;
        const bucket = groups.get(item.bucketStart) ?? { bucketStart: item.bucketStart, ...emptyActivityMetrics() };
        merge(bucket, item); groups.set(item.bucketStart, bucket);
      }
      return [...groups.values()];
    };
    const intervals = projectId ? state.coverageIntervals.map(interval => ({ start: new Date(Math.max(Date.parse(interval.start), Date.parse(this.attributionStartedAt))).toISOString(), end: interval.end })).filter(interval => interval.start <= interval.end) : state.coverageIntervals;
    const selectedAgents = projectId ? state.agents.map(agent => ({ ...agent, ...emptyActivityMetrics() })).filter(agent => {
      let found = false;
      for (const bucket of this.attributedBuckets.values()) if (bucket.period === "day" && bucket.projectId === projectId && bucket.agentId === agent.agentId) { merge(agent, bucket); found = true; }
      if (found && agent.projectId !== projectId) { agent.projectId = projectId; agent.projectName = projectId; }
      return found;
    }) : state.agents;
    const named = device ? deviceZone(device.timeZone, device.utcOffsetMinutes, now) : null;
    // Offsets over everything kept, and two days ahead for today's later hours.
    const zone: AnalyticsZone | null = named ? { name: named.name, offsets: zoneOffsets(named, now - (HOUR_BUCKETS + 48) * HOUR, now + 2 * DAY) } : null;
    const local = localView(projectId ? grouped("hour") : state.hours, projectId ? grouped("day") : state.days, { zone, now, hourlyFrom: this.hourlyFrom, intervals });
    return { startedAt: projectId ? this.attributionStartedAt : state.startedAt, updatedAt: state.updatedAt, agentsTruncated: state.agentsTruncated,
      coverageIntervals: intervals, persistenceError, usageBasis: "provider_reported_snapshot", usageAggregation: "peak_per_bucket", coverageResolutionMs: 30_000, projectId: projectId ?? null,
      projectHistoryTruncated: !!projectId && (this.projectHistoryTruncated || [...this.attributedBuckets.values()].some(bucket => bucket.projectId === null)),
      hours: local.hours, days: local.days, zone, hourlyFrom: state.hourlyFrom,
      agents: selectedAgents.map(agent => ({ ...agent })), usage: state.usage.filter(sample => !projectId || sample.projectId === projectId).map(sample => ({ ...sample })) };
  }
  heartbeat(at: number): void {
    if (!Number.isFinite(at) || at < this.lastHeartbeat) return;
    const stamp = new Date(at).toISOString();
    const current = this.coverageIntervals.at(-1);
    // A missed heartbeat longer than 90s indicates suspended/offline collection.
    if (!current || at - this.lastHeartbeat > 90_000) this.coverageIntervals.push({ start: stamp, end: stamp });
    else current.end = stamp;
    this.lastHeartbeat = at;
    if (this.coverageIntervals.length > 2048) this.coverageIntervals = this.coverageIntervals.slice(-2048);
    this.prune(at);
  }
  recordEvent(event: TelemetryEvent, agent: AnalyticsAgent, waitMs = 0): void {
    const metrics = emptyActivityMetrics();
    metrics.eventCount = 1;
    metrics.started = event.type === "turn_started" ? 1 : 0;
    metrics.completed = event.type === "turn_completed" ? 1 : 0;
    metrics.failed = event.type === "turn_failed" ? 1 : 0;
    metrics.canceled = event.type === "turn_canceled" ? 1 : 0;
    metrics.runMs = event.type.startsWith("turn_") && event.type !== "turn_started" ? event.durationMs ?? 0 : 0;
    metrics.runSamples = event.type.startsWith("turn_") && event.type !== "turn_started" && event.durationMs !== undefined ? 1 : 0;
    metrics.waitMs = waitMs;
    this.recordMetrics(agent, Date.parse(event.at), metrics);
  }
  /** Reports whether placement metadata or unattributed history actually changed, so unchanged reads never rewrite storage. */
  updateAttribution(agent: AnalyticsAgent): boolean {
    const before = this.agents.get(agent.id), previous = before && JSON.stringify(before);
    let changed = previous !== JSON.stringify(this.agent(agent));
    if (agent.projectId) {
      for (const [key, bucket] of [...this.attributedBuckets]) if (bucket.agentId === agent.id && bucket.projectId === null) {
        this.attributedBuckets.delete(key);
        const owner = attributionOwner(bucket.period, agent.projectId, bucket.agentId);
        const targetKey = JSON.stringify([owner, bucket.period, bucket.bucketStart, agent.projectId]);
        const target = this.attributedBuckets.get(targetKey);
        if (target) merge(target, bucket); else this.attributedBuckets.set(targetKey, { ...bucket, agentId: owner, projectId: agent.projectId });
        changed = true;
      }
      for (const sample of this.usage) if (sample.agentId === agent.id && sample.projectId === null) { sample.projectId = agent.projectId; changed = true; }
    }
    return changed;
  }
  /** False for repeated sample IDs and reports without any usable value. */
  recordUsage(id: string, agent: AnalyticsAgent, at: string, usage: ReportedUsage): boolean {
    if (this.usage.some(sample => sample.id === id)) return false;
    const report = { inputTokens: valid(usage.inputTokens), outputTokens: valid(usage.outputTokens),
      cachedTokens: valid(usage.cachedInputTokens), costUsd: valid(usage.totalCostUsd) };
    if (Object.values(report).every(value => value === null)) return false;
    const current = this.agent(agent);
    this.usage.unshift({ id, agentId: agent.id, provider: current.provider, workspaceId: current.workspaceId,
      projectId: current.projectId, at, ...report });
    if (this.usage.length > 1_000) this.usage.length = 1_000;
    this.recordMetrics(agent, Date.parse(at), { ...emptyActivityMetrics(), ...report, usageSamples: 1 });
    return true;
  }
  private recordMetrics(agent: AnalyticsAgent, at: number, metrics: ActivityMetrics): void {
    if (!Number.isFinite(at)) return;
    this.heartbeat(at);
    this.updatedAt = new Date(Math.max(Date.parse(this.updatedAt), at)).toISOString();
    for (const [map, interval] of [[this.hours, HOUR], [this.days, DAY]] as const) {
      const key = new Date(Math.floor(at / interval) * interval).toISOString();
      const bucket = map.get(key) ?? { bucketStart: key, ...emptyActivityMetrics() };
      merge(bucket, metrics); map.set(key, bucket);
      const period = interval === HOUR ? "hour" : "day";
      const projectId = agent.projectId ?? this.agents.get(agent.id)?.projectId ?? null, owner = attributionOwner(period, projectId, agent.id);
      const attributedKey = JSON.stringify([owner, period, key, projectId]);
      const attributed = this.attributedBuckets.get(attributedKey) ?? { agentId: owner, projectId, period, bucketStart: key, ...emptyActivityMetrics() };
      merge(attributed, metrics); this.attributedBuckets.set(attributedKey, attributed);
    }
    merge(this.agent(agent), metrics);
    this.prune(Math.max(at, Date.parse(this.updatedAt)));
  }
  private agent(agent: AnalyticsAgent): AgentAnalytics {
    const current = this.agents.get(agent.id) ?? { agentId: agent.id, provider: "unknown", workspaceId: null,
      projectId: null, projectName: null, projectRootPath: null, ...emptyActivityMetrics() };
    if (agent.provider) current.provider = safeText(agent.provider, 128) ?? "unknown";
    if (agent.workspaceId !== undefined) current.workspaceId = safeText(agent.workspaceId, 512);
    if (agent.projectId !== undefined) current.projectId = safeText(agent.projectId, 1024);
    if (agent.projectName !== undefined) current.projectName = safeText(agent.projectName, 240);
    if (agent.projectRootPath !== undefined) current.projectRootPath = safeText(agent.projectRootPath, 2048);
    this.agents.delete(agent.id); this.agents.set(agent.id, current);
    while (this.agents.size > 2_000) { this.agents.delete(this.agents.keys().next().value!); this.agentsTruncated = true; }
    return current;
  }
  private prune(now: number): void {
    this.coverageIntervals = this.coverageIntervals.filter(interval => Date.parse(interval.end) >= now - (DAY_BUCKETS + 1) * DAY).slice(-2048);
    for (const [key, bucket] of this.attributedBuckets) if (Date.parse(bucket.bucketStart) < (bucket.period === "hour" ? Math.floor(now / HOUR) * HOUR - (HOUR_BUCKETS - 1) * HOUR : Math.floor(now / DAY) * DAY - (DAY_BUCKETS - 1) * DAY)) this.attributedBuckets.delete(key);
    while (this.attributedBuckets.size > 18_000) { this.attributedBuckets.delete(this.attributedBuckets.keys().next().value!); this.projectHistoryTruncated = true; }
    for (const [map, interval, limit] of [[this.hours, HOUR, HOUR_BUCKETS], [this.days, DAY, DAY_BUCKETS]] as const) {
      const minimum = Math.floor(now / interval) * interval - (limit - 1) * interval;
      for (const key of map.keys()) if (Date.parse(key) < minimum) map.delete(key);
      if (map.size > limit) for (const key of [...map.keys()].sort().slice(0, map.size - limit)) map.delete(key);
    }
  }
}
