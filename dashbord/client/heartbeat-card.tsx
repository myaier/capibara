import { t } from "../shared/text";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Button, MetaLine, Spacer, fontSize, hairline, radius, space } from "./kit";
import { Breathe, Flash, useChangeCount } from "./motion";
import { PhasePill, Spinner, hueColor, tint, tintAlpha, type Hue } from "./status";
import { useClock } from "./ui";
import { RunGlyph, runLooks, runMoment, untilLabel } from "./schedule-looks";
import { cadenceText, clockOf, dayWord, describeRunError, deviceTimeZone, heartbeatWake, parseTime, runQuota, type HeartbeatSummary } from "../shared/schedules";

/**
 * Heartbeats (schedules that prompt an existing Agent) seen from the Agent they wake. Pink, like heartbeats on 定时运行.
 * Data: `useHeartbeats(hostId, enabled).data?.byAgent.get(agentId)` (client/use-schedules.ts), most relevant first.
 */

/**
 * 「22:35 唤醒」 on a session row: the next wake in device time (明天 07:35 / 10月13日 07:35 when not today), 心跳唤醒中 while
 * one runs, 心跳已暂停 in grey; nothing when every heartbeat has finished. It breathes in the last 15 minutes before a wake.
 * Without `now` it keeps its own 30-second clock, so a memoized row need not re-render on a timer; rows without heartbeats
 * mount no clock at all.
 */
export function HeartbeatBadge({ theme, heartbeats, now }: { theme: PluginTheme; heartbeats: readonly HeartbeatSummary[] | undefined; now?: number }) {
  if (!heartbeats?.length) return null;
  return now === undefined ? <TickingBadge theme={theme} heartbeats={heartbeats} /> : <WakeBadge theme={theme} heartbeats={heartbeats} now={now} />;
}
function TickingBadge({ theme, heartbeats }: { theme: PluginTheme; heartbeats: readonly HeartbeatSummary[] }) {
  return <WakeBadge theme={theme} heartbeats={heartbeats} now={useClock(30_000)} />;
}
function WakeBadge({ theme, heartbeats, now }: { theme: PluginTheme; heartbeats: readonly HeartbeatSummary[]; now: number }) {
  const wake = heartbeatWake(heartbeats, now);
  if (!wake) return null;
  const { colors } = theme, paused = wake.state === "paused", running = wake.state === "running";
  const mark = paused ? colors.foregroundMuted : hueColor(theme, running ? "run" : "pink"), text = paused ? colors.foregroundMuted : hueColor(theme, running ? "run" : "pink", "text");
  return <View accessibilityLabel={wake.description} style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0, height: 18, paddingHorizontal: 6, borderRadius: radius.full,
    backgroundColor: paused ? colors.surface2 : tint(mark, tintAlpha(theme)) }}>
    {running ? <Spinner size={10} color={mark} /> : <Breathe active={wake.soon}><Icon name={paused ? "AlarmClockOff" : "AlarmClock"} size={10} color={mark} /></Breathe>}
    <Text numberOfLines={1} style={{ color: text, fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{wake.label}</Text>
  </View>;
}

/**
 * The host fails a run whose Agent stops at an approval, though the prompt went in and the Agent waits on you: on the Agent's
 * own card that reads as delivered, in amber, not as a failure (恢复后续跑 counts it delivered too).
 */
const awaitsApproval = (run: HeartbeatSummary["lastRun"]) => run?.status === "failed" && /is waiting for permission/.test(run.error ?? "");
/** The state pill of one heartbeat: 唤醒中 blue, 等待唤醒 pink (即将唤醒 solid), 已暂停 grey, 已完成 green, 已唤醒 amber or 已结束 red / grey. */
function stateOf(heartbeat: HeartbeatSummary, now: number): { label: string; hue: Hue; icon?: string; solid?: boolean } {
  if (heartbeat.lastRun?.status === "running") return { label: t("coreHeartbeatCard.waking"), hue: "run" };
  if (heartbeat.status === "paused") return { label: t("coreHeartbeatCard.paused"), hue: "muted", icon: "CirclePause" };
  if (heartbeat.status === "completed") return heartbeat.lastRun?.status === "succeeded" ? { label: t("coreHeartbeatCard.completed"), hue: "ok", icon: "Check" }
    : awaitsApproval(heartbeat.lastRun) ? { label: t("coreHeartbeatCard.woken"), hue: "amber", icon: "Hand" }
    : heartbeat.lastRun?.status === "failed" ? { label: t("coreHeartbeatCard.ended"), hue: "fail", icon: "X" } : { label: t("coreHeartbeatCard.ended"), hue: "muted", icon: "CircleStop" };
  const at = parseTime(heartbeat.nextRunAt);
  return at && at <= now ? { label: t("coreHeartbeatCard.wakingSoon"), hue: "pink", icon: "AlarmClock", solid: true } : { label: t("coreHeartbeatCard.waitingToWake"), hue: "pink", icon: "AlarmClock" };
}
/** 下次 今天 22:35（3 小时后）. */
function nextWake(heartbeat: HeartbeatSummary, now: number): string | null {
  const at = heartbeat.status === "active" ? parseTime(heartbeat.nextRunAt) : 0;
  if (!at) return null;
  const until = untilLabel(heartbeat.nextRunAt, now);
  return t("coreHeartbeatCard.next", { value1: dayWord(at, now), value2: clockOf(at), value3: until ? t("coreHeartbeatCard.message", { value1: until }) : "" });
}

/**
 * Agent 详情 → 结果, for an Agent heartbeats wake: the plan (一次性 · 10月11日 22:35（东京时间）· 本地 09:35), the next wake, 第 1/1 次,
 * the last result, other heartbeats on the same Agent, and 「在定时运行中查看」 (`onOpenAll` with the heartbeat's schedule id).
 * The card itself is not pressable: the button is its only target, so web never nests buttons. Nothing renders without heartbeats.
 */
export function HeartbeatCard({ theme, heartbeats, onOpenAll }: { theme: PluginTheme; heartbeats: readonly HeartbeatSummary[] | undefined; onOpenAll?: (scheduleId: string) => void }) {
  const now = useClock(30_000), zone = useMemo(deviceTimeZone, []);
  const primary = heartbeats?.[0];
  // A heartbeat firing (or finishing) while the card is on screen flashes it once.
  const changes = useChangeCount(primary ? `${primary.scheduleId}:${primary.status}:${primary.lastRun?.status ?? ""}:${primary.lastRun?.startedAt ?? ""}` : "");
  if (!primary) return null;
  const { colors } = theme, pink = hueColor(theme, "pink"), others = heartbeats!.slice(1);
  const state = stateOf(primary, now), running = primary.lastRun?.status === "running";
  const soon = primary.status === "active" && parseTime(primary.nextRunAt) - now <= 15 * 60_000;
  const last = primary.lastRun, waiting = awaitsApproval(last), error = last?.status === "failed" && !waiting ? describeRunError(last.error)?.summary : null;
  return <View testID="heartbeat-card" style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: hairline, borderColor: tint(pink, 0.45), backgroundColor: tint(pink, tintAlpha(theme) * 0.6) }}>
    <Flash count={changes} color={tint(pink, tintAlpha(theme) + 0.1)} radius={radius.lg} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Breathe active={running || soon}><Icon name="HeartPulse" size={15} color={pink} /></Breathe>
      <Text style={{ color: hueColor(theme, "pink", "text"), fontSize: fontSize.meta, fontWeight: "700" }}>{t("coreHeartbeatCard.heartbeat")}</Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{primary.name}</Text>
      <Spacer />
      {running ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}><Spinner size={12} color={hueColor(theme, "run")} /><PhasePill theme={theme} hue="run" label={state.label} /></View>
        : <PhasePill theme={theme} hue={state.hue} icon={state.icon} label={state.label} solid={state.solid} />}
    </View>
    {/* Non-breaking spaces keep 「第 1/1 次」 and 「3 小时后」 whole; the meta wraps only between parts. */}
    <MetaLine theme={theme} numberOfLines={2} parts={[cadenceText(primary, zone, now)]} />
    <MetaLine theme={theme} numberOfLines={2} parts={[nextWake(primary, now), runQuota(primary.runs, primary.maxRuns)].map(part => part ? part.replace(/ /g, "\u00a0") : part)} />
    {last ? <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {waiting ? <Icon name="Hand" size={14} color={hueColor(theme, "amber")} /> : <RunGlyph theme={theme} status={last.status} size={14} />}
        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.small }}>
          {last.status === "running" ? t("coreHeartbeatCard.thisRunStarted", { value1: runMoment(last.startedAt) }) : t("coreHeartbeatCard.last", { value1: waiting ? t("coreHeartbeatCard.wake") : runLooks[last.status].label, value2: runMoment(last.endedAt ?? last.startedAt) })}
        </Text>
      </View>
      {waiting ? <Text numberOfLines={2} style={{ color: hueColor(theme, "amber", "text"), fontSize: fontSize.small, lineHeight: 19 }}>{t("coreHeartbeatCard.thePromptWasDeliveredTheAgentIs")}</Text> : null}
      {error ? <Text numberOfLines={2} style={{ color: hueColor(theme, "fail", "text"), fontSize: fontSize.small, lineHeight: 19 }}>{error}</Text> : null}
    </View> : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>{t("coreHeartbeatCard.hasNotRunYet")}</Text>}
    {others.length ? <View style={{ gap: 2, paddingTop: 2 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{t("coreHeartbeatCard.otherHeartbeats", { count: others.length })}</Text>
      {others.slice(0, 3).map(other => <MetaLine key={other.scheduleId} theme={theme} parts={[other.name, cadenceText(other, zone, now), stateOf(other, now).label]} />)}
    </View> : null}
    {onOpenAll ? <View style={{ alignItems: "flex-start" }}><Button theme={theme} size="sm" tone="pink" icon="CalendarRange" label={t("coreHeartbeatCard.viewInScheduledRuns")} onPress={() => onOpenAll(primary.scheduleId)} /></View> : null}
  </View>;
}
