import { currentLanguage, onTextChange } from "./i18n";
import { t } from "./text";
/** Pure derivations for the dashboards (no React), unit-tested in tests/stats-view.test.ts. */
import type { StatsDay, StatsMetrics, StatsSnapshot } from "./stats";

/** Completed ÷ (completed + failed). Canceled turns are mostly your own interrupts, so they count neither way. */
export const successRate = (metrics: Pick<StatsMetrics, "completed" | "failed">): number | null => {
  const finished = metrics.completed + metrics.failed;
  return finished ? metrics.completed / finished : null;
};
/** Messages, tool calls and edits are counted from each turn's new timeline items, so older history has none. */
export const hasContent = (metrics: Pick<StatsMetrics, "userMessages" | "assistantMessages" | "toolCalls">): boolean => metrics.userMessages + metrics.assistantMessages + metrics.toolCalls > 0;
export const averageTurnMs = (metrics: Pick<StatsMetrics, "runMs" | "runSamples">): number | null => metrics.runSamples ? metrics.runMs / metrics.runSamples : null;
/** Average number of agents working while any is working. */
export const parallelism = (metrics: Pick<StatsMetrics, "runMs" | "busyMs">): number | null => metrics.busyMs > 60_000 ? metrics.runMs / metrics.busyMs : null;
/**
 * Average concurrency over the days that have busy time. Work time also comes from history recorded before busy time
 * was tracked, so the first tracked day is left out when later days exist, and a ratio above the observed peak
 * (a partly tracked day) reads as unknown instead of "4000 Agents at once".
 */
export function observedParallelism(daily: readonly StatsDay[], peak: number): number | null {
  const tracked = daily.filter(day => day.busyMs > 0), days = tracked.length > 1 ? tracked.slice(1) : tracked;
  const ratio = parallelism({ runMs: days.reduce((sum, day) => sum + day.runMs, 0), busyMs: days.reduce((sum, day) => sum + day.busyMs, 0) });
  return ratio !== null && (peak <= 0 || ratio <= peak + 0.05) ? ratio : null;
}

/** 1.2k / 3.4万 style for Chinese UI: below 10k plain with separators, then 万 / 亿. */
export function bigNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value), chinese = currentLanguage() === "zh-CN";
  if (abs < (chinese ? 10_000 : 1_000)) return Math.round(value).toLocaleString("en-US");
  if (abs < (chinese ? 100_000_000 : 1_000_000)) return t("sharedStatsView.m001", { value1: (value / (chinese ? 10_000 : 1_000)).toFixed(abs < 100_000 ? 1 : 0).replace(/\.0$/, "") });
  return t("sharedStatsView.m002", { value1: (value / (chinese ? 100_000_000 : 1_000_000)).toFixed(1).replace(/\.0$/, "") });
}
/** 45 秒 / 12 分 / 3.4 小时 / 12 小时 — compact, for tiles and axes. */
export function shortHours(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0";
  const minutes = milliseconds / 60_000;
  if (minutes < 1) return t("sharedStatsView.m003", { value1: Math.round(milliseconds / 1000) });
  if (minutes < 60) return t("sharedStatsView.m004", { value1: Math.round(minutes) });
  const hours = minutes / 60;
  return t("sharedStatsView.m005", { value1: hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours).toLocaleString("en-US") });
}
export const percent = (value: number | null, digits = 0) => value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;

const weekdayOf = (day: string) => (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;
const nextDay = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
/**
 * Next `days` days from the mean of the same weekday over the last 28 days (a weekday baseline).
 * Returns nothing until at least 7 days have data.
 */
export function weekdayForecast(daily: readonly StatsDay[], pick: (day: StatsDay) => number, days = 7): Array<{ day: string; value: number }> {
  const recent = daily.slice(-28);
  if (!recent.length || recent.filter(day => pick(day) > 0).length < 7) return [];
  const sums = Array(7).fill(0), counts = Array(7).fill(0);
  for (const day of recent) { const weekday = weekdayOf(day.day); sums[weekday] += pick(day); counts[weekday]++; }
  const last = recent.at(-1)!.day;
  return Array.from({ length: days }, (_, index) => { const day = nextDay(last, index + 1), weekday = weekdayOf(day); return { day, value: counts[weekday] ? sums[weekday] / counts[weekday] : 0 }; });
}

export function peakOf(values: readonly number[]): { index: number; value: number } | null {
  let best = -1;
  values.forEach((value, index) => { if (value > 0 && (best < 0 || value > values[best]!)) best = index; });
  return best < 0 ? null : { index: best, value: values[best]! };
}
export let weekdayNames = [t("sharedStatsView.m006"), t("sharedStatsView.m007"), t("sharedStatsView.m008"), t("sharedStatsView.m009"), t("sharedStatsView.m010"), t("sharedStatsView.m011"), t("sharedStatsView.m012")];
/** 深夜 / 清晨 / 上午 / 中午 / 下午 / 晚上 */
export function dayPart(hour: number): string {
  return hour < 5 ? t("sharedStatsView.m013") : hour < 8 ? t("sharedStatsView.m014") : hour < 11 ? t("sharedStatsView.m015") : hour < 13 ? t("sharedStatsView.m016") : hour < 18 ? t("sharedStatsView.m017") : hour < 23 ? t("sharedStatsView.m018") : t("sharedStatsView.m019");
}

export interface Achievement {
  id: string; title: string; description: string; icon: string;
  /** Two palette hues for the badge gradient. */
  colors: readonly [string, string];
  current: number; target: number; unlocked: boolean;
}
/** Growth badges (成长档案), computed from the snapshot so they can evolve without server changes. */
export function achievements(stats: StatsSnapshot): Achievement[] {
  const all = stats.allTime, total = stats.punchcard.turns.reduce((sum, value) => sum + value, 0);
  const night = stats.punchcard.turns.reduce((sum, value, index) => sum + (index % 24 < 5 ? value : 0), 0);
  const dawn = stats.punchcard.turns.reduce((sum, value, index) => sum + (index % 24 >= 5 && index % 24 < 8 ? value : 0), 0);
  const today = stats.daily.at(-1);
  const finished = stats.totals.completed + stats.totals.failed;
  const make = (id: string, title: string, description: string, icon: string, colors: readonly [string, string], current: number, target: number): Achievement =>
    ({ id, title, description, icon, colors, current: Math.min(current, target), target, unlocked: current >= target });
  return [
    make("first-light", t("sharedStatsView.m020"), t("sharedStatsView.m021"), "Lightbulb", ["amber", "orange"], all.sessions, 1),
    make("today", t("sharedStatsView.m022"), t("sharedStatsView.m023"), "Sun", ["orange", "pink"], (today?.sessions ?? 0) + (today?.turns ?? 0), 1),
    make("streak-3", t("sharedStatsView.m024"), t("sharedStatsView.m025"), "Flame", ["orange", "red"], Math.max(stats.streak.current, stats.streak.longest), 3),
    make("streak-7", t("sharedStatsView.m026"), t("sharedStatsView.m027"), "Flame", ["pink", "red"], Math.max(stats.streak.current, stats.streak.longest), 7),
    make("streak-30", t("sharedStatsView.m028"), t("sharedStatsView.m029"), "Crown", ["amber", "pink"], Math.max(stats.streak.current, stats.streak.longest), 30),
    make("sessions-100", t("sharedStatsView.m030"), t("sharedStatsView.m031"), "Rocket", ["blue", "violet"], all.sessions, 100),
    make("sessions-1000", t("sharedStatsView.m032"), t("sharedStatsView.m033"), "Rocket", ["violet", "fuchsia"], all.sessions, 1000),
    make("turns-1000", t("sharedStatsView.m034"), t("sharedStatsView.m035"), "MessagesSquare", ["cyan", "blue"], all.turns, 1000),
    make("parallel-5", t("sharedStatsView.m036"), t("sharedStatsView.m037"), "Network", ["violet", "blue"], stats.records.peakParallel?.count ?? all.peakParallel, 5),
    make("parallel-10", t("sharedStatsView.m038"), t("sharedStatsView.m039"), "Zap", ["fuchsia", "violet"], stats.records.peakParallel?.count ?? all.peakParallel, 10),
    make("models-5", t("sharedStatsView.m040"), t("sharedStatsView.m041"), "Gem", ["fuchsia", "pink"], stats.models.filter(row => row.key !== "__other__" && row.key !== "unknown").length, 5),
    make("night-owl", t("sharedStatsView.m042"), t("sharedStatsView.m043"), "Moon", ["indigo", "violet"], night, 50),
    make("early-bird", t("sharedStatsView.m044"), t("sharedStatsView.m045"), "Sunrise", ["amber", "lime"], dawn, 20),
    make("code-10k", t("sharedStatsView.m046"), t("sharedStatsView.m047"), "FileCode2", ["green", "lime"], all.linesAdded, 10_000),
    make("tools-10k", t("sharedStatsView.m048"), t("sharedStatsView.m049"), "Wrench", ["teal", "cyan"], all.toolCalls, 10_000),
    make("steady", t("sharedStatsView.m050"), t("sharedStatsView.m051"), "ShieldCheck", ["green", "teal"], finished >= 200 ? Math.round((successRate(stats.totals) ?? 0) * 100) : 0, 98),
    make("commander", t("sharedStatsView.m052"), t("sharedStatsView.m053"), "Workflow", ["sky", "blue"], all.childSessions, 50),
    make("marathon", t("sharedStatsView.m054"), t("sharedStatsView.m055"), "Timer", ["red", "orange"], Math.floor((stats.records.longestTurn?.ms ?? 0) / 60_000), 60),
  ].map(badge => total === 0 && badge.id === "night-owl" ? { ...badge, current: 0, unlocked: false } : badge);
}
/** Level from unlocked badges: every 3 badges is one level. */
export function level(badges: readonly Achievement[]): { level: number; unlocked: number; total: number; progress: number } {
  const unlocked = badges.filter(badge => badge.unlocked).length;
  return { level: Math.floor(unlocked / 3) + 1, unlocked, total: badges.length, progress: (unlocked % 3) / 3 };
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  weekdayNames = [t("sharedStatsView.m006"), t("sharedStatsView.m007"), t("sharedStatsView.m008"), t("sharedStatsView.m009"), t("sharedStatsView.m010"), t("sharedStatsView.m011"), t("sharedStatsView.m012")];
});
