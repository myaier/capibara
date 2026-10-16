import { fleetFiltersSchema } from "./fleet-scope";
import { onTextChange } from "./i18n";
import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Dashboard statistics (看板 / 明细 / 横评). The server aggregates the whole agent directory (including archived
 * sessions) and its own observations into one compact snapshot, so phones over relay receive a few KB instead of
 * the directory or raw buckets.
 *
 * Sources: `sessions`/`childSessions` come from the directory (`createdAt`, exact in any timezone); turn metrics come
 * from lifecycle hooks (backfilled once from the analytics store); message/tool/code metrics come from the timeline
 * delta passed to `agent.turn_ended` and exist only from `contentSince` on. Days and hours are local to the device:
 * its IANA `timeZone` when the server knows that zone (each UTC hour converted with its own offset, so a range across
 * a daylight-saving change stays exact), else the fixed `utcOffsetMinutes` (UTC+8 → 480, UTC−7 → -420);
 * weekday 0 = Monday … 6 = Sunday.
 */
export const STATS_RANGES = ["7d", "30d", "90d"] as const;
export type StatsRange = typeof STATS_RANGES[number];
export const statsRangeDays: Record<StatsRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

const count = z.number().int().nonnegative();
const duration = z.number().nonnegative().finite();
const iso = z.iso.datetime();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** An IANA zone name as `Intl.DateTimeFormat().resolvedOptions().timeZone` reports it (Europe/Berlin, Etc/GMT+8, UTC). */
export const statsTimeZoneSchema = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/);

/** Additive per-period metrics, except `peakParallel`, which aggregates with max. */
export const statsMetricsSchema = z.object({
  /** Agents created in the period, archived ones included; `childSessions` are the sub-agents among them. */
  sessions: count, childSessions: count,
  /** Observed turns: started, and how the finished ones ended. */
  turns: count, completed: count, failed: count, canceled: count,
  /** Summed turn durations; `runSamples` = finished turns that had a duration. */
  runMs: duration, runSamples: count,
  /** Wall-clock time with at least one turn running, and the most turns running at once. */
  busyMs: duration, peakParallel: count,
  /** Permission requests and the time spent waiting on them. */
  approvals: count, waitMs: duration,
  /** Timeline content of finished turns (from `contentSince` on). */
  userMessages: count, assistantMessages: count,
  toolCalls: count, toolFailures: count,
  /** edit + write tool calls, lines they added / removed, and distinct files changed per turn (summed over turns). */
  edits: count, linesAdded: count, linesRemoved: count, filesChanged: count,
  shellCalls: count, webCalls: count, subagentCalls: count,
  errors: count, compactions: count,
});
export type StatsMetrics = z.infer<typeof statsMetricsSchema>;
export const statsDaySchema = statsMetricsSchema.extend({ day });
export type StatsDay = z.infer<typeof statsDaySchema>;

/** One row of a breakdown (model, provider harness, vendor, project). Metrics cover the selected range. */
export const statsBreakdownRowSchema = statsMetricsSchema.extend({
  key: z.string().min(1).max(1024),
  label: z.string().max(240),
  /** anthropic / openai / google / xai / moonshot / deepseek / bytedance / other; null for projects. */
  vendor: z.string().max(40).nullable(),
  activeDays: count,
  lastActiveAt: iso.nullable(),
  /** Currently running turns and non-archived sessions. */
  running: count, open: count,
  /** Sums of the latest reported context window use over agents that reported one. */
  contextUsed: count.nullable(), contextMax: count.nullable(),
});
export type StatsBreakdownRow = z.infer<typeof statsBreakdownRowSchema>;

export const TOOL_KINDS = ["shell", "read", "edit", "search", "web", "agent", "plan", "other"] as const;
export type ToolKind = typeof TOOL_KINDS[number];
export const statsToolSchema = z.object({ name: z.string().max(160), kind: z.enum(TOOL_KINDS), calls: count, failures: count });
export type StatsTool = z.infer<typeof statsToolSchema>;

export const statsSnapshotSchema = z.object({
  fleetDetails: z.object({ activeDates: z.array(day), groupDates: z.record(z.string(), z.record(z.string(), z.array(day))),
    filtered: z.boolean(), concurrency: z.enum(["host", "host_lower_bound", "unavailable"]), toolNamesComplete: z.boolean() }).optional(),
  generatedAt: iso,
  range: z.enum(STATS_RANGES),
  utcOffsetMinutes: z.number().int().min(-840).max(840),
  /** The IANA zone the days were grouped in; null (or absent from older servers) when the fixed offset was used. */
  timeZone: statsTimeZoneSchema.nullable().optional(),
  /** Local calendar days of the range, oldest first; the last one is today. */
  from: day, to: day,
  /** Earliest turn observation (incl. backfill) and start of timeline content collection. */
  observedSince: iso.nullable(), contentSince: iso.nullable(),
  /** The directory walk stopped early (very large hosts); session counts are then lower bounds. */
  directoryTruncated: z.boolean(),
  totals: statsMetricsSchema,
  /** The equally long period right before the range, for period-over-period changes. */
  previous: statsMetricsSchema,
  allTime: statsMetricsSchema,
  /** One entry per local day of the range, oldest first. */
  daily: z.array(statsDaySchema).max(90),
  /** 52 weeks + the current week, Monday-aligned: `start` is a Monday, arrays have one value per day up to today. */
  calendar: z.object({ start: day, sessions: z.array(count).max(371), turns: z.array(count).max(371) }),
  /** Range totals by local weekday × hour: index = weekday * 24 + hour. */
  punchcard: z.object({ sessions: z.array(count).length(168), turns: z.array(count).length(168) }),
  streak: z.object({ current: count, longest: count, longestEnd: day.nullable(), activeDays: count, activeDaysAllTime: count }),
  records: z.object({
    busiestDay: z.object({ day, sessions: count, turns: count }).nullable(),
    longestTurn: z.object({ ms: duration, agentId: z.string().max(256), title: z.string().max(240), model: z.string().max(240).nullable(), at: iso }).nullable(),
    peakParallel: z.object({ count, at: iso }).nullable(),
    busiestSession: z.object({ agentId: z.string().max(256), title: z.string().max(240), turns: count }).nullable(),
  }),
  live: z.object({ open: count, running: count, approvals: count, unread: count, idle: count }),
  subagents: z.object({ parents: count, children: count, maxFanout: count, maxDepth: count }),
  models: z.array(statsBreakdownRowSchema).max(10000),
  providers: z.array(statsBreakdownRowSchema).max(10000),
  vendors: z.array(statsBreakdownRowSchema).max(10000),
  projects: z.array(statsBreakdownRowSchema).max(10000),
  /** Rows beyond the limits above are summed into one row with key "__other__" (label 其他). */
  tools: z.array(statsToolSchema).max(30000),
  toolKinds: z.array(statsToolSchema).max(TOOL_KINDS.length),
});
export type StatsSnapshot = z.infer<typeof statsSnapshotSchema>;

const revision = z.string().min(1).max(80);
export const statsResponseSchema = z.discriminatedUnion("mode", [
  statsSnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export const getStats = defineRpc({
  name: "observatory.stats.get",
  // `timeZone` is optional so older clients keep working (fixed offset); the server also falls back to the offset for a
  // zone it does not know, or whose current offset disagrees with the device's (outdated time zone data on either side).
  input: z.object({ complete: z.boolean().optional(), filters: fleetFiltersSchema.optional(), range: z.enum(STATS_RANGES), utcOffsetMinutes: z.number().int().min(-840).max(840), timeZone: statsTimeZoneSchema.optional(), revision: revision.optional() }),
  output: statsResponseSchema,
});
export type StatsState = StatsSnapshot & { revision?: string };
export function mergeStats(previous: StatsState | undefined, response: StatsResponse): StatsState {
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return { ...snapshot, revision: response.revision }; }
  if (!previous) throw new Error(t("sharedStats.m001"));
  return previous;
}

export function emptyStatsMetrics(): StatsMetrics {
  return { sessions: 0, childSessions: 0, turns: 0, completed: 0, failed: 0, canceled: 0, runMs: 0, runSamples: 0, busyMs: 0, peakParallel: 0,
    approvals: 0, waitMs: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolFailures: 0, edits: 0, linesAdded: 0, linesRemoved: 0,
    filesChanged: 0, shellCalls: 0, webCalls: 0, subagentCalls: 0, errors: 0, compactions: 0 };
}
/** Adds `delta` into `target` in place; `peakParallel` keeps the maximum. */
export function addStatsMetrics(target: StatsMetrics, delta: Partial<StatsMetrics>): StatsMetrics {
  for (const key of Object.keys(target) as (keyof StatsMetrics)[]) {
    const value = delta[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    target[key] = key === "peakParallel" ? Math.max(target[key], value) : target[key] + value;
  }
  return target;
}

/** Vendor of a model / provider harness, for brand colours and the 按厂商 breakdown. */
export function vendorOf(model: string | null | undefined, provider?: string | null): string {
  const text = `${model ?? ""} ${provider ?? ""}`.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|anthropic/.test(text)) return "anthropic";
  if (/gpt|codex|openai|\bo[134]\b|o[134]-/.test(text)) return "openai";
  if (/gemini|google|palm|bard/.test(text)) return "google";
  if (/grok|xai/.test(text)) return "xai";
  if (/kimi|moonshot/.test(text)) return "moonshot";
  if (/deepseek/.test(text)) return "deepseek";
  if (/doubao|seed|trae|volc|byte/.test(text)) return "bytedance";
  if (/qwen|tongyi/.test(text)) return "alibaba";
  if (/glm|zhipu/.test(text)) return "zhipu";
  return "other";
}
export let vendorNames: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI", moonshot: "Moonshot", deepseek: "DeepSeek",
  bytedance: t("sharedStats.m002"), alibaba: t("sharedStats.m003"), zhipu: t("sharedStats.m004"), other: t("sharedStats.m005"),
};

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  vendorNames = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI", moonshot: "Moonshot", deepseek: "DeepSeek",
  bytedance: t("sharedStats.m002"), alibaba: t("sharedStats.m003"), zhipu: t("sharedStats.m004"), other: t("sharedStats.m005"),
};
});
