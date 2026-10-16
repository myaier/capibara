import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { statsTimeZoneSchema } from "./stats";

const count = z.number().nonnegative().finite();
const sample = count.nullable();
const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
/**
 * 明细 → 观测 is laid out in the device's time zone (opus-F40): a 7-day heatmap of local hours and 28 local days. The
 * server keeps UTC hour buckets for 29 days (enough for 28 local days in any zone) and sends the local days it sums
 * from them, the hours of the heatmap's 7 days, and the zone's offsets over that time, so this module can place every
 * UTC hour on its local day and hour without the client's own zone data.
 */
export const HEATMAP_DAYS = 7, ANALYTICS_DAYS = 28;
/** Hour buckets in a reply: the heatmap's 7 local days, with room for a daylight-saving hour and a whole-day zone change. */
export const ANALYTICS_REPLY_HOURS = 8 * 24;
export const activityMetricsSchema = z.object({
  eventCount: count, started: count, completed: count, failed: count, canceled: count,
  runMs: count, runSamples: count.default(0), waitMs: count,
  /** Peak reported samples, deliberately not additive provider billing totals. */
  inputTokens: sample, outputTokens: sample, cachedTokens: sample, costUsd: sample, usageSamples: count,
});
export const analyticsBucketSchema = activityMetricsSchema.extend({ bucketStart: z.iso.datetime(), coveredMs: count.optional(),
  /** Local days only: the device's calendar date (`bucketStart` is the UTC hour the day's first bucket starts at). */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /**
   * A local day from before hourly history (2.13 and older kept 7 days of hours): its UTC calendar day of the same date
   * stands in, so its edges can be off by the zone's offset. Gone once that history ages out (28 days).
   */
  approximate: z.boolean().optional() });
/**
 * The clock a reply is laid out in. `name`: the device's IANA zone (null: only its fixed offset was usable).
 * `offsets`: [UTC hour start in epoch ms, minutes east of UTC] from which each offset applies, oldest first.
 */
export const analyticsZoneSchema = z.object({
  name: z.string().max(64).nullable(),
  offsets: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().min(-1080).max(1080)])).min(1).max(64),
});
export const observationIntervalSchema = z.object({ start: z.iso.datetime(), end: z.iso.datetime() });
export const agentAnalyticsSchema = activityMetricsSchema.extend({
  agentId: z.string().min(1).max(256), provider: z.string().max(128), workspaceId: z.string().max(512).nullable(),
  projectId: z.string().max(1024).nullable(), projectName: z.string().max(240).nullable(), projectRootPath: z.string().max(2048).nullable(),
});
export const usageSampleSchema = z.object({
  id: z.string().max(128), agentId: z.string().max(256), provider: z.string().max(128),
  workspaceId: z.string().max(512).nullable(), projectId: z.string().max(1024).nullable(), at: z.iso.datetime(),
  inputTokens: sample, outputTokens: sample, cachedTokens: sample, costUsd: sample,
});
export const analyticsSnapshotSchema = z.object({
  startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), persistenceError: z.string().nullable(),
  usageBasis: z.literal("provider_reported_snapshot"), usageAggregation: z.literal("peak_per_bucket"),
  /** UTC hour buckets of the heatmap's local days (older servers: the last 168 UTC hours). */
  hours: z.array(analyticsBucketSchema).max(ANALYTICS_REPLY_HOURS),
  /** Local days with activity, oldest first, each with `day` (older servers: UTC calendar days without it). */
  days: z.array(analyticsBucketSchema).max(ANALYTICS_DAYS),
  agents: z.array(agentAnalyticsSchema).max(2_000), usage: z.array(usageSampleSchema).max(1_000),
  agentsTruncated: z.boolean(),
  coverageIntervals: z.array(observationIntervalSchema).max(2048).optional(),
  coverageResolutionMs: count.optional(),
  projectId: z.string().nullable().optional(),
  projectHistoryTruncated: z.boolean().optional(),
  /** The device clock the days and hours follow; null: the client sent none, so they are UTC (and say so). */
  zone: analyticsZoneSchema.nullable().optional(),
  /** Hour buckets are complete from here on; before it only UTC days were kept (data from 2.13 and older). */
  hourlyFrom: z.iso.datetime().optional(),
});
const revision = z.string().min(1).max(80);
/** The open coverage interval advances with every heartbeat; it travels with unchanged replies instead of bumping the revision. */
export const analyticsResponseSchema = z.discriminatedUnion("mode", [
  analyticsSnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision, coverageTail: observationIntervalSchema.nullable() }),
]);
/**
 * `utcOffsetMinutes` and `timeZone` are the device's clock, as `observatory.stats.get` takes them: the zone gives each
 * past hour its own offset when the server knows it and it agrees with the offset now; both are optional, and without
 * them the reply is laid out in UTC and says so.
 */
export const getAnalytics = defineRpc({ name: "observatory.analytics.get", input: z.object({ projectId: z.string().min(1).max(1024).optional(), revision: revision.optional(),
  utcOffsetMinutes: z.number().int().min(-840).max(840).optional(), timeZone: statsTimeZoneSchema.optional() }), output: analyticsResponseSchema });
export type ActivityMetrics = z.infer<typeof activityMetricsSchema>;
export type AnalyticsBucket = z.infer<typeof analyticsBucketSchema>;
export type AnalyticsZone = z.infer<typeof analyticsZoneSchema>;
export type AgentAnalytics = z.infer<typeof agentAnalyticsSchema>;
export type UsageSample = z.infer<typeof usageSampleSchema>;
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;
export type AnalyticsState = AnalyticsSnapshot & { revision?: string };
export type ObservationInterval = z.infer<typeof observationIntervalSchema>;

/** Client cache update; an unchanged reply only moves the open coverage interval forward. */
export function mergeAnalytics(previous: AnalyticsState | undefined, response: AnalyticsResponse | AnalyticsSnapshot): AnalyticsState {
  if (!("mode" in response)) return response;
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return snapshot; }
  if (!previous) throw new Error(t("sharedAnalytics.m001"));
  const intervals = previous.coverageIntervals ?? [], tail = response.coverageTail, last = intervals.at(-1);
  if (!tail || !last || last.start !== tail.start || last.end === tail.end) return previous;
  return { ...previous, coverageIntervals: [...intervals.slice(0, -1), { ...tail }] };
}
/** Usage charts read each Agent's first-listed and newest sample; older repeats never render. */
export function latestUsageSamples(samples: readonly UsageSample[]): UsageSample[] {
  const newest = new Map<string, UsageSample>(), listed = new Set<string>();
  for (const sample of samples) { const previous = newest.get(sample.agentId); if (!previous || Date.parse(sample.at) > Date.parse(previous.at)) newest.set(sample.agentId, sample); }
  return samples.filter(sample => { if (!listed.has(sample.agentId)) { listed.add(sample.agentId); return true; } return newest.get(sample.agentId) === sample; });
}

export function emptyActivityMetrics(): ActivityMetrics {
  return { eventCount: 0, started: 0, completed: 0, failed: 0, canceled: 0, runMs: 0, runSamples: 0, waitMs: 0,
    inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null, usageSamples: 0 };
}
/** Only lifecycle counts/durations are additive. Unknown usage stays null; samples use a maximum. */
export function sumActivityMetrics(rows: readonly ActivityMetrics[]): ActivityMetrics {
  const result = emptyActivityMetrics();
  for (const row of rows) {
    for (const key of ["eventCount", "started", "completed", "failed", "canceled", "runMs", "runSamples", "waitMs", "usageSamples"] as const) result[key] += row[key];
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "costUsd"] as const) {
      if (row[key] !== null) result[key] = result[key] === null ? row[key] : Math.max(result[key], row[key]);
    }
  }
  return result;
}
/** Offset east of UTC (ms) in force at `at`; UTC without a zone. */
export function analyticsOffsetAt(zone: AnalyticsZone | null | undefined, at: number): number {
  const offsets = zone?.offsets;
  if (!offsets?.length) return 0;
  let minutes = offsets[0]![1];
  for (const [from, value] of offsets) { if (from > at) break; minutes = value; }
  return minutes * 60_000;
}
/**
 * The local calendar day (days since 1970-01-01) of an instant. An hour bucket belongs to the day and hour its start
 * falls on: in a zone half or three quarters of an hour off UTC (Asia/Kolkata, Asia/Kathmandu) a local "hour" of the
 * heatmap is the UTC hour starting at :30 or :45 (09:30–10:30 is hour 9), and a local day runs from 00:30 to 00:30.
 */
export const analyticsLocalDay = (at: number, zone: AnalyticsZone | null | undefined): number => Math.floor((at + analyticsOffsetAt(zone, at)) / DAY_MS);
export const analyticsLocalHour = (at: number, zone: AnalyticsZone | null | undefined): number => new Date(at + analyticsOffsetAt(zone, at)).getUTCHours();
/** YYYY-MM-DD of a day number. */
export const analyticsDayText = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** The UTC hour where local day `day` begins: the first hour bucket whose start falls on that day or later. */
export function analyticsDayStart(day: number, zone: AnalyticsZone | null | undefined): number {
  // From an hour before the earliest the offset at that UTC midnight allows (a daylight-saving change moves it by one or two).
  let at = Math.floor((day * DAY_MS - analyticsOffsetAt(zone, day * DAY_MS)) / HOUR_MS) * HOUR_MS - 3 * HOUR_MS;
  while (analyticsLocalDay(at, zone) < day) at += HOUR_MS;
  return at;
}
const sign = (minutes: number) => `${minutes < 0 ? "−" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
/** How a reply's days are cut, for the page: 本机时区 America/New_York · 本机时区 UTC−07:00（固定偏移） · UTC（没有取得本机时区）. */
export function analyticsZoneLabel(zone: AnalyticsZone | null | undefined, now = Date.now()): string {
  if (!zone) return t("sharedAnalytics.m002");
  return zone.name ? t("sharedAnalytics.m003", { value1: zone.name }) : t("sharedAnalytics.m004", { value1: sign(analyticsOffsetAt(zone, now) / 60_000) });
}

export interface HourlyHeatmapCell {
  /** `${day}:${hour}`: unique per cell, also where no hour exists. */
  key: string; day: string; hour: number;
  /** Local minute the cell's hour starts at: 0, or 30 / 45 in zones offset by part of an hour. */
  minute: number;
  /** The first UTC hour in the cell; null when the hour does not exist that day (skipped when clocks went forward). */
  bucketStart: string | null;
  /** UTC hours in the cell: 1, 2 for the repeated hour when clocks went back, 0 for the skipped one. */
  utcHours: number; exists: boolean;
  observed: boolean; isFuture: boolean;
  value: number | null; metrics: AnalyticsBucket | null;
  coverage: "full" | "partial" | "none" | "unknown"; coveredMs: number | null;
}
export function coveredDuration(intervals: readonly ObservationInterval[], from: number, to: number): number {
  if (to <= from) return 0;
  const ranges = intervals.map(interval => [Math.max(from, Date.parse(interval.start)), Math.min(to, Date.parse(interval.end))] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [start, stop] of ranges) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return total;
}
/**
 * The last `days` local days (default 7) × 24 local hours, oldest first, with explicit pre-observation / future cells
 * rather than invented zeros. Each UTC hour lands on the local day and hour its start falls on, with the offset in force
 * then: the day clocks go back has one hour holding two UTC hours (summed), the day they go forward has an hour that
 * does not exist (`exists: false`, no value: not a zero). Without a zone the days are UTC days.
 */
export function buildHourlyHeatmap(hours: readonly AnalyticsBucket[], options: {
  now?: number; startedAt?: string; days?: number; metric?: keyof ActivityMetrics; coverageIntervals?: readonly ObservationInterval[];
  zone?: AnalyticsZone | null; hourlyFrom?: string;
} = {}): HourlyHeatmapCell[] {
  const now = options.now ?? Date.now(), zone = options.zone ?? null;
  const days = Math.min(HEATMAP_DAYS, Math.max(1, Math.floor(options.days ?? HEATMAP_DAYS)));
  const today = analyticsLocalDay(now, zone), first = today - (days - 1);
  const observedSince = options.startedAt ? Date.parse(options.startedAt) : -Infinity;
  // Hours before hourly history began are unknown, not quiet (data from 2.13 and older).
  const hourlySince = options.hourlyFrom ? Date.parse(options.hourlyFrom) : -Infinity;
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const buckets = new Map(hours.map(bucket => [Date.parse(bucket.bucketStart), bucket]));
  const slots = new Map<string, number[]>();
  for (let at = analyticsDayStart(first, zone), end = analyticsDayStart(today + 1, zone); at < end; at += HOUR_MS) {
    const key = `${analyticsDayText(analyticsLocalDay(at, zone))}:${analyticsLocalHour(at, zone)}`;
    slots.set(key, [...(slots.get(key) ?? []), at]);
  }
  const metric = options.metric ?? "eventCount";
  const additive = !["inputTokens", "outputTokens", "cachedTokens", "costUsd"].includes(metric);
  return Array.from({ length: days * 24 }, (_, index) => {
    const day = analyticsDayText(first + Math.floor(index / 24)), hour = index % 24, key = `${day}:${hour}`, starts = slots.get(key) ?? [];
    const firstAt = starts[0];
    if (firstAt === undefined) return { key, day, hour, minute: 0, bucketStart: null, utcHours: 0, exists: false, observed: false, isFuture: false, value: null, metrics: null, coverage: "none" as const, coveredMs: null };
    const found = starts.flatMap(at => { const bucket = buckets.get(at); return bucket ? [bucket] : []; });
    const metrics: AnalyticsBucket | null = found.length ? { ...sumActivityMetrics(found), bucketStart: new Date(firstAt).toISOString() } : null;
    const isFuture = firstAt > currentHour;
    const span = starts.reduce((sum, at) => sum + Math.max(0, Math.min(HOUR_MS, now - at)), 0);
    const coveredMs = options.coverageIntervals === undefined ? null : starts.reduce((sum, at) => sum + coveredDuration(options.coverageIntervals!, at, Math.min(at + HOUR_MS, now)), 0);
    const observed = !isFuture && firstAt >= hourlySince && (coveredMs === null ? starts.at(-1)! + HOUR_MS > observedSince : coveredMs > 0);
    const coverage: HourlyHeatmapCell["coverage"] = coveredMs === null ? "unknown" : coveredMs <= 0 ? "none" : coveredMs >= span - 1 ? "full" : "partial";
    return { key, day, hour, minute: new Date(firstAt + analyticsOffsetAt(zone, firstAt)).getUTCMinutes(), bucketStart: new Date(firstAt).toISOString(), utcHours: starts.length, exists: true,
      observed, isFuture, coverage, coveredMs, value: observed ? metrics?.[metric] ?? (additive ? 0 : null) : null, metrics };
  });
}

export interface DailyCell {
  /** Local date, and the UTC instants the local day runs between (its first hour bucket to the next day's). */
  day: string; start: number; end: number;
  observed: boolean; coveredMs: number; bucket: AnalyticsBucket | null;
  /** From before hourly history: the UTC calendar day of that date (see analyticsBucketSchema). */
  approximate: boolean;
}
/** The last `count` local days (default 28), oldest first, empty ones included, for the daily chart and the period totals. */
export function buildDailySeries(analytics: Pick<AnalyticsSnapshot, "days" | "zone" | "coverageIntervals">, options: { now?: number; count?: number } = {}): DailyCell[] {
  const now = options.now ?? Date.now(), zone = analytics.zone ?? null, count = Math.min(ANALYTICS_DAYS, Math.max(1, Math.floor(options.count ?? ANALYTICS_DAYS)));
  const today = analyticsLocalDay(now, zone), buckets = new Map(analytics.days.map(bucket => [bucket.day ?? bucket.bucketStart.slice(0, 10), bucket]));
  return Array.from({ length: count }, (_, index) => {
    const number = today - (count - 1) + index, day = analyticsDayText(number), start = analyticsDayStart(number, zone), end = analyticsDayStart(number + 1, zone);
    const coveredMs = coveredDuration(analytics.coverageIntervals ?? [], start, Math.min(end, now)), bucket = buckets.get(day) ?? null;
    return { day, start, end, observed: coveredMs > 0, coveredMs, bucket, approximate: bucket?.approximate === true };
  });
}
