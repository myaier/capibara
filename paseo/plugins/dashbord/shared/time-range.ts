import { onTextChange } from "./i18n";
import { t } from "./text";
import type { AgentRecord } from "./model";
import { isUnreadCompletion, stopUnseen, timestamp } from "./model";
export type TimeRange = "24h" | "7d" | "30d" | "all";
export const DEFAULT_TIME_RANGE: TimeRange = "7d";
export let rangeLabels: Record<TimeRange, string> = { "24h": t("sharedTimeRange.m001"), "7d": t("sharedTimeRange.m002"), "30d": t("sharedTimeRange.m003"), all: t("sharedTimeRange.m004") };
/** Best known execution timestamp; archival metadata alone is never execution. */
export function historyActivityTimestamp(agent: AgentRecord): number | null {
  if (!agent.archivedAt) return timestamp(agent.lastActivityAt) ?? timestamp(agent.updatedAt) ?? timestamp(agent.createdAt);
  const markers = [agent.lastExecutionAt, agent.lastUserMessageAt, agent.activeTurnStartedAt, agent.attentionTimestamp]
    .map(timestamp).filter((value): value is number => value !== null);
  if (markers.length) return Math.max(...markers);
  const archiveTime = timestamp(agent.archivedAt);
  const retained = [agent.lastActivityAt, agent.updatedAt].map(timestamp)
    .filter((value): value is number => value !== null && archiveTime !== null && value < archiveTime);
  return retained.length ? Math.max(...retained) : timestamp(agent.createdAt);
}
/**
 * Never hidden by the time range: live work, unread results, and what still waits for you (an error or a stop not seen yet,
 * a closed session's cut-off turn included, a question not answered), so 需要处理 counts the same here as in the sidebar badge.
 */
function pinned(agent: AgentRecord): boolean {
  if (agent.archivedAt) return false;
  if (["running", "waiting", "initializing"].includes(agent.status) || isUnreadCompletion(agent) || stopUnseen(agent)) return true;
  return agent.status === "error" ? agent.requiresAttention !== false : agent.requiresAttention === true && agent.status === "idle";
}
export function withinRange(agent: AgentRecord, range: TimeRange = DEFAULT_TIME_RANGE, now = Date.now()): boolean {
  if (range === "all") return true;
  if (pinned(agent)) return true;
  if (!Number.isFinite(now)) return false;
  const since = now - (range === "24h" ? 1 : range === "7d" ? 7 : 30) * 86400_000;
  const time = historyActivityTimestamp(agent);
  return time !== null && time >= since && time <= now;
}
const rangeSpan = (range: TimeRange) => (range === "24h" ? 1 : range === "7d" ? 7 : 30) * 86400_000;
/** The earliest instant after `now` at which `withinRange` can change for one of these agents; Infinity if none. */
export function nextRangeChange(agents: readonly AgentRecord[], range: TimeRange, now: number): number {
  if (range === "all" || !Number.isFinite(now)) return Infinity;
  const span = rangeSpan(range);
  let next = Infinity;
  for (const agent of agents) {
    if (pinned(agent)) continue;
    const time = historyActivityTimestamp(agent);
    if (time === null) continue;
    if (time > now) next = Math.min(next, time);
    if (time + span + 1 > now) next = Math.min(next, time + span + 1);
  }
  return next;
}
/** The earliest instant after `now` at which one of these timestamps leaves the range window; Infinity if none. */
export function nextWindowExit(times: readonly number[], range: TimeRange, now: number): number {
  if (range === "all" || !Number.isFinite(now)) return Infinity;
  const span = rangeSpan(range);
  let next = Infinity;
  for (const time of times) if (Number.isFinite(time) && time + span + 1 > now) next = Math.min(next, time + span + 1);
  return next;
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  rangeLabels = { "24h": t("sharedTimeRange.m001"), "7d": t("sharedTimeRange.m002"), "30d": t("sharedTimeRange.m003"), all: t("sharedTimeRange.m004") };
});
