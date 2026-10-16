import { FleetSource, FleetCoverageNotice } from "./fleet-status";
import { currentLanguage, joinList } from "../shared/i18n";
import { t } from "../shared/text";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenParams, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./fleet-client";
import { FlatList, Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { cadenceText, describeRunError, deviceTimeZone, filterRuns, groupRunsByDay, normalizeRunQuery, parseTime, runQuota, type RunFilter, type RunStatus, type RunWindow,
  type ScheduleRunRow, type ScheduleSummary } from "../shared/schedules";
import { getAgentResult } from "../shared/results";
import { ActionMenu, Badge, Banner, Button, Chip, ChipBar, EmptyState, IconButton, MetaLine, SearchField, Skeleton, Spacer, SplitView, SyncStatus, Toolbar,
  fontSize, hairline, radius, relativeTime, space, useCompactLayout, type MenuAction } from "./kit";
import { Flash, Pop, useChangeCount } from "./motion";
import { LiveTimer, PhasePill, StatusChip, hueColor, tint, tintAlpha } from "./status";
import { InfoButton, KeyValue, PaneLabel, useClock } from "./ui";
import { OutputText } from "./result-view";
import { openExternalUrl } from "./open-url";
import { RunGlyph, linkTone, runDurationLabel, runLooks, runMoment, runTimeLabel, untilLabel } from "./schedule-looks";
import { clearScheduleFocus, focusFromParams, onScheduleFocus, peekScheduleFocus, type ScheduleFocus } from "./schedule-focus";
import { useScheduleRun, useScheduleRuns } from "./use-schedules";

/**
 * 定时运行: what every Paseo schedule produced — status, duration, the Agent and workspace, the recorded final reply,
 * merge/pull requests. Paseo's own 计划 page manages schedules; this page only reads.
 */
const DAY = 86_400_000;
/** `heartbeats` null: not chosen on this device yet — shown only when every schedule is a heartbeat (see ScheduleSurface). */
type ViewChoice = { status: RunStatus | "all"; scheduleId: string | "all"; heartbeats: boolean | null };
const DEFAULT_VIEW: ViewChoice = { status: "all", scheduleId: "all", heartbeats: null };
// Filters stay for this app session on this device (never synced); search text is not kept.
const remembered = new Map<string, ViewChoice & { window: RunWindow }>();

/** `value` once it has stopped changing for `ms` (search runs on the server, so not on every keystroke). */
function useSettled<Value>(value: Value, ms: number): Value {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return settled;
}

/** Last ten runs as small blocks, oldest first: a schedule's health at a glance. */
function HealthStrip({ theme, recent }: { theme: PluginTheme; recent: readonly RunStatus[] }) {
  const slots = Array.from({ length: 10 }, (_, index) => recent[index - (10 - recent.length)] ?? null);
  return <View accessibilityLabel={recent.length ? t("secondaryScheduleBoard.lastRuns", { count: recent.length, value2: joinList(recent.map(status => runLooks[status].label)) }) : t("secondaryScheduleBoard.noRunsYet")} style={{ flexDirection: "row", gap: 3 }}>
    {slots.map((status, index) => <View key={index} style={{ width: 9, height: 14, borderRadius: 2,
      backgroundColor: status === null ? theme.colors.surface2 : hueColor(theme, runLooks[status].hue), opacity: status === "unknown" ? 0.45 : 1 }} />)}
  </View>;
}

const CARD_WIDTH = 212;
function ScheduleCard({ theme, schedule, selected, now, zone, onPress }: { theme: PluginTheme; schedule: ScheduleSummary; selected: boolean; now: number; zone: string | null; onPress: () => void }) {
  const { colors } = theme, deleted = schedule.status === "deleted", failing = schedule.recent.at(-1) === "failed", heartbeat = schedule.kind === "heartbeat";
  const accent = failing ? hueColor(theme, "fail") : schedule.running ? hueColor(theme, "run") : heartbeat ? hueColor(theme, "pink") : hueColor(theme, "violet");
  const next = schedule.status === "active" ? untilLabel(schedule.nextRunAt, now) : null;
  const state = deleted ? t("secondaryScheduleBoard.deleted") : schedule.status === "paused" ? t("secondaryScheduleBoard.paused") : schedule.status === "completed" ? t("secondaryScheduleBoard.ended") : next ? t("secondaryScheduleBoard.next", { value1: next }) : null;
  // The plan first: when the line is cut, the heartbeat's Agent goes before a one-shot's local time does.
  const cadence = [cadenceText(schedule, zone, now), heartbeat ? schedule.target : null].filter(Boolean).join(" · ");
  return <Pressable accessibilityRole="button" accessibilityLabel={t("secondaryScheduleBoard.runs", { value1: schedule.name, value2: schedule.total, value3: schedule.failed ? t("secondaryScheduleBoard.failed", { value1: schedule.failed }) : "", value4: state ? t("secondaryScheduleBoard.message", { value1: state }) : "" })} accessibilityState={{ selected }} aria-pressed={selected} onPress={onPress}
    style={pressState => ({ width: CARD_WIDTH, gap: 6, paddingVertical: 9, paddingHorizontal: 11, borderRadius: radius.lg, borderWidth: selected ? 1.5 : hairline,
      borderColor: selected ? accent : failing ? tint(accent, 0.55) : colors.border,
      backgroundColor: selected ? tint(accent, tintAlpha(theme)) : (pressState as { hovered?: boolean }).hovered ? colors.surface1 : colors.surface0, opacity: deleted && !selected ? 0.75 : 1 })}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name={heartbeat ? "HeartPulse" : deleted ? "CalendarX2" : "CalendarClock"} size={13} color={deleted ? colors.foregroundMuted : heartbeat ? hueColor(theme, "pink") : hueColor(theme, "violet")} />
      <Text numberOfLines={1} style={{ flexGrow: 1, flexShrink: 1, color: deleted ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{schedule.name}</Text>
      {schedule.running ? <LiveDot theme={theme} /> : schedule.failed ? <Text style={{ color: hueColor(theme, "fail", "text"), fontSize: fontSize.meta, fontWeight: "800", fontVariant: ["tabular-nums"] }}>✕{schedule.failed}</Text> : null}
    </View>
    <FleetSource theme={theme} id={schedule.id} />
    <HealthStrip theme={theme} recent={schedule.recent} />
    <View style={{ gap: 1 }}>
      {/* Two lines: a one-shot in another zone also gives its local time (一次性 · 10月11日 22:35（东京时间）· 本地 09:35). */}
      <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{cadence || t("secondaryScheduleBoard.unknownSchedule")}</Text>
      <Text numberOfLines={1} style={{ color: deleted || schedule.status !== "active" ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.meta, lineHeight: 17, fontVariant: ["tabular-nums"] }}>
        {[state, runQuota(schedule.total, schedule.maxRuns)].filter(Boolean).join(" · ")}
      </Text>
    </View>
  </Pressable>;
}

/**
 * Schedules as cards that filter the feed. Phones scroll them sideways; wider screens show one row and fold the rest
 * behind 「另外 N 个任务」 (the selected one always stays in view).
 */
function ScheduleStrip({ theme, compact, schedules, selectedId, now, zone, onSelect }: { theme: PluginTheme; compact: boolean; schedules: readonly ScheduleSummary[]; selectedId: string;
  now: number; zone: string | null; onSelect: (id: string) => void }) {
  const { colors } = theme;
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const card = (schedule: ScheduleSummary) => <ScheduleCard key={schedule.id} theme={theme} schedule={schedule} now={now} zone={zone} selected={selectedId === schedule.id} onPress={() => onSelect(schedule.id)} />;
  if (!schedules.length) return null;
  if (compact) return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.sm }}>
    {schedules.map(card)}
  </ScrollView>;
  const perRow = width ? Math.max(1, Math.floor((width - 2 * space.md + space.sm) / (CARD_WIDTH + space.sm))) : schedules.length;
  const folds = schedules.length > perRow, folded = folds && !expanded;
  let shown = folded ? schedules.slice(0, Math.max(1, perRow - 1)) : [...schedules];
  const selected = schedules.find(schedule => schedule.id === selectedId);
  if (folded && selected && !shown.includes(selected)) shown = [...shown.slice(0, -1), selected];
  const more = schedules.length - shown.length;
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.sm }}>
    {shown.map(card)}
    {folds ? <Pressable accessibilityRole="button" accessibilityLabel={folded ? t("secondaryScheduleBoard.showMoreSchedules", { value1: more }) : t("secondaryScheduleBoard.collapseSchedules")} onPress={() => setExpanded(!expanded)}
      style={state => ({ width: CARD_WIDTH, minHeight: 84, alignItems: "center", justifyContent: "center", gap: 4, borderRadius: radius.lg, borderWidth: hairline, borderStyle: "dashed", borderColor: colors.border,
        backgroundColor: (state as { hovered?: boolean }).hovered ? colors.surface1 : "transparent" })}>
      <Icon name={folded ? "ChevronDown" : "ChevronUp"} size={16} color={hueColor(theme, "violet")} />
      <Text style={{ color: hueColor(theme, "violet", "text"), fontSize: fontSize.small, fontWeight: "600" }}>{folded ? t("secondaryScheduleBoard.moreSchedules", { value1: more }) : t("secondaryScheduleBoard.collapse")}</Text>
    </Pressable> : null}
  </View>;
}
function LiveDot({ theme }: { theme: PluginTheme }) {
  return <View accessibilityLabel={t("secondaryScheduleBoard.running")} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hueColor(theme, "run") }} />;
}

/** One run. The whole row is the press target; nothing inside it is a button (no nested buttons on web). */
const RunRow = memo(function RunRow({ run, theme, selected, now, onSelect }: { run: ScheduleRunRow; theme: PluginTheme; selected: boolean; now: number; onSelect: (id: string) => void }) {
  const { colors } = theme, look = runLooks[run.status], color = hueColor(theme, look.hue), muted = look.hue === "muted";
  const changes = useChangeCount(run.status);
  const wash = selected ? colors.surface2 : run.status === "failed" ? tint(color, tintAlpha(theme) * 0.5) : run.status === "running" ? tint(color, tintAlpha(theme) * 0.35) : undefined;
  const agentTitle = run.agent?.title && run.agent.title !== run.scheduleName ? run.agent.title : null;
  const deleted = run.source !== "schedule";
  const trailing = run.status === "running" ? <LiveTimer since={run.startedAt} color={hueColor(theme, "run", "text")} />
    : run.status === "failed" ? <PhasePill theme={theme} hue="fail" label={t("secondaryScheduleBoard.failed2")} solid />
    : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{runTimeLabel(run.startedAt, now)}</Text>;
  const message = describeRunError(run.error)?.summary ?? run.preview;
  const badges = run.link || run.kind === "heartbeat" || deleted || (!run.agent && run.kind === "new-agent");
  return <Pressable accessibilityRole="button" accessibilityLabel={t("secondaryScheduleBoard.message2", { value1: run.scheduleName, value2: look.label, value3: relativeTime(run.startedAt, now) })} accessibilityState={{ selected }} aria-pressed={selected} onPress={() => onSelect(run.id)}
    style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, paddingHorizontal: space.md, borderRadius: radius.md,
      backgroundColor: wash ?? ((state as { hovered?: boolean }).hovered || state.pressed ? colors.surface1 : "transparent") })}>
    <Flash count={changes} color={tint(color, tintAlpha(theme) + 0.1)} radius={radius.md} />
    {!muted ? <View style={{ position: "absolute", left: 0, top: 11, bottom: 11, width: 3, borderRadius: 2, backgroundColor: color, opacity: run.status === "succeeded" ? 0.6 : 1 }} /> : null}
    <View style={{ minHeight: 20, justifyContent: "center" }}><Pop count={changes} size={16}><RunGlyph theme={theme} status={run.status} /></Pop></View>
    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: run.status === "succeeded" || muted ? "500" : "700" }}>{run.scheduleName}</Text>
        {trailing}
      </View>
      <FleetSource theme={theme} id={run.id} />
      <MetaLine theme={theme} parts={[agentTitle, runDurationLabel(run), run.workspace?.branch, run.projectName]} />
      {badges ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
        {run.link ? <Badge theme={theme} tone={linkTone(run)} icon={run.link.state === "merged" ? "GitMerge" : "GitPullRequest"} label={`${run.link.label}${run.link.state === "merged" ? t("secondaryScheduleBoard.merged") : ""}`} /> : null}
        {run.kind === "heartbeat" ? <Badge theme={theme} tone="pink" icon="HeartPulse" label={t("secondaryScheduleBoard.heartbeat")} /> : null}
        {!run.agent && run.kind === "new-agent" ? <Badge theme={theme} tone="amber" icon="CircleOff" label={t("secondaryScheduleBoard.agentNotStarted")} /> : null}
        {deleted ? <Badge theme={theme} icon="CalendarX2" label={t("secondaryScheduleBoard.scheduleDeleted")} /> : null}
      </View> : null}
      {message ? <Text numberOfLines={2} style={{ color: run.error ? hueColor(theme, "fail", "text") : colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{message}</Text> : null}
    </View>
  </Pressable>;
});

type FeedItem = { kind: "group"; key: string; label: string; count: number; failed: number; today: boolean } | { kind: "run"; key: string; run: ScheduleRunRow } | { kind: "more"; key: string };

function GroupHeader({ theme, label, count, failed, today }: { theme: PluginTheme; label: string; count: number; failed: number; today: boolean }) {
  const { colors } = theme;
  return <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 32, paddingHorizontal: space.md, paddingTop: space.sm }}>
    <Icon name={today ? "CalendarCheck" : "CalendarDays"} size={12} color={today ? hueColor(theme, "violet") : colors.foregroundMuted} />
    <Text style={{ color: today ? hueColor(theme, "violet", "text") : colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{label}</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{count}</Text>
    {failed ? <Text style={{ color: hueColor(theme, "fail", "text"), fontSize: fontSize.meta, fontWeight: "600" }}>{t("secondaryScheduleBoard.failed3", { value1: failed })}</Text> : null}
  </View>;
}

function RunDetail({ run, schedule, theme, compact, navigation, onClose, now, zone }: { run: ScheduleRunRow; schedule: ScheduleSummary | undefined; theme: PluginTheme; compact: boolean;
  navigation: PluginSurfaceProps["navigation"]; onClose: () => void; now: number; zone: string | null }) {
  const { colors } = theme, toast = useToast(), look = runLooks[run.status];
  const detail = useScheduleRun(run.id, run.status === "running");
  const readResult = useRpc(getAgentResult);
  const [transcript, setTranscript] = useState<{ state: "idle" | "loading" | "ready" | "error"; text: string | null; error?: string }>({ state: "idle", text: null });
  // The host directory is walked once a minute, so a run that just started may name an Agent the index has not seen yet.
  const fresh = run.status === "running" || now - parseTime(run.startedAt) < 5 * 60_000;
  const agentId = run.agent && (run.agent.known || fresh) ? run.agent.id : null;
  // Paseo keeps the record of an Agent whose project was removed but cannot open its session or workspace any more.
  const unlisted = run.agent?.listed === false;
  const loadTranscript = useCallback(async () => {
    if (!agentId) return;
    setTranscript({ state: "loading", text: null });
    try {
      const answer = await readResult({ agentId });
      if (answer.mode !== "full") throw new Error(t("secondaryScheduleBoard.theResultHasNotChangedTry"));
      setTranscript({ state: "ready", text: answer.latestReply?.text ?? null });
    } catch (error) { setTranscript({ state: "error", text: null, error: error instanceof Error ? error.message : t("secondaryScheduleBoard.readFailed") }); }
  }, [agentId, readResult]);
  // Host navigation may throw or return a rejected promise; either way the user gets a toast.
  const open = (action: () => unknown, failure: string) => {
    const fail = (error: unknown) => toast.error(t("secondaryScheduleBoard.message3", { value1: failure, value2: error instanceof Error ? error.message : t("secondaryScheduleBoard.tryAgainLater") }));
    try { void Promise.resolve(action()).catch(fail); } catch (error) { fail(error); }
  };
  const copyId = () => { void copyText(run.id).then(() => toast.show(t("secondaryScheduleBoard.runIdCopied"))).catch(() => toast.error(t("secondaryScheduleBoard.copyFailed"))); };
  const inset = compact ? space.lg : space.xl;
  const duration = runDurationLabel(run);
  const output = detail.data?.output ?? null;
  const error = describeRunError(run.error);
  const heartbeatTarget = run.kind === "heartbeat" ? run.agent?.title ?? schedule?.target : null;
  const body = <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingTop: space.lg, paddingBottom: space.xxl, gap: space.lg }}>
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 26 }}>
        <PhasePill theme={theme} hue={look.hue} icon={run.status === "running" ? undefined : look.icon} label={look.label} solid={run.status === "failed"} />
        {run.status === "running" ? <LiveTimer since={run.startedAt} color={hueColor(theme, "run", "text")} prefix={t("secondaryScheduleBoard.runningFor")} /> : duration ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryScheduleBoard.took", { value1: duration })}</Text> : null}
        <Spacer />
        {!compact ? <><IconButton theme={theme} icon="Copy" label={t("secondaryScheduleBoard.copyRunId")} size="sm" onPress={copyId} /><IconButton theme={theme} icon="X" label={t("secondaryScheduleBoard.closeDetails")} size="sm" onPress={onClose} /></> : null}
      </View>
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.heading, fontWeight: "600", lineHeight: 26 }}>{run.scheduleName}</Text>
      <MetaLine theme={theme} numberOfLines={2} parts={[run.kind === "heartbeat" ? t("secondaryScheduleBoard.heartbeat2", { value1: heartbeatTarget ?? t("secondaryScheduleBoard.agent") }) : null, schedule ? cadenceText(schedule, zone, now) : null, schedule?.provider, run.projectName, runMoment(run.startedAt)]} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingTop: space.xs }}>
        {agentId && navigation && !unlisted ? <Button theme={theme} variant="primary" icon="ArrowUpRight" label={run.agent?.archivedAt ? t("secondaryScheduleBoard.openSessionArchived") : t("secondaryScheduleBoard.openSession")} onPress={() => open(() => navigation.openAgent({ agentId }), t("secondaryScheduleBoard.couldNotOpenSession"))} /> : null}
        {run.workspace && navigation && !unlisted ? <Button theme={theme} icon="FolderGit2" label={t("secondaryScheduleBoard.openWorkspace")} onPress={() => open(() => navigation.openWorkspace({ workspaceId: run.workspace!.id }), t("secondaryScheduleBoard.couldNotOpenWorkspace"))} /> : null}
        {run.link ? <Button theme={theme} tone={linkTone(run)} icon={run.link.state === "merged" ? "GitMerge" : "GitPullRequest"} label={t("secondaryScheduleBoard.open", { value1: run.link.label })} onPress={() => { void openExternalUrl(run.link!.url).catch(() => toast.error(t("secondaryScheduleBoard.couldNotOpenLink"))); }} /> : null}
      </View>
    </View>
    {error ? <View style={{ gap: space.xs }}>
      <Banner theme={theme} tone="danger" message={error.summary} />
      {error.summary !== error.detail ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17, paddingHorizontal: space.xs }}>{t("secondaryScheduleBoard.originalError", { value1: error.detail })}</Text> : null}
    </View> : null}
    {run.source === "agent" ? <Banner theme={theme} tone="info" icon="History" message={t("secondaryScheduleBoard.thisScheduleWasDeletedBeforeObservatory")} /> : null}
    {unlisted ? <Banner theme={theme} tone="warning" icon="FolderX" message={t("secondaryScheduleBoard.theProjectForThisRunWas")} /> : null}
    <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme} icon="MessageSquareText" tone="success">{t("secondaryScheduleBoard.finalReply")}</PaneLabel>
      {detail.isPending ? <Skeleton theme={theme} rows={3} /> : output ? <OutputText theme={theme} text={output} />
        : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 20 }}>{detail.data?.note ?? (detail.isError ? t("secondaryScheduleBoard.thisRunSRecordIsTemporarily") : t("secondaryScheduleBoard.noFinalReplyWasRecorded"))}</Text>}
      {detail.data?.outputTruncated ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryScheduleBoard.theReplyExceedsCharactersOnlyThe")}</Text> : null}
      {!output && agentId && !detail.isPending && run.status !== "running" ? <View style={{ gap: space.sm, paddingTop: space.xs }}>
        {transcript.state === "ready" ? transcript.text ? <OutputText theme={theme} text={transcript.text} /> : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>{t("secondaryScheduleBoard.noReplyInTheSessionRecord")}</Text>
          : transcript.state === "error" ? <Banner theme={theme} tone="warning" message={t("secondaryScheduleBoard.readFailed2", { value1: describeRunError(transcript.error)?.summary ?? t("secondaryScheduleBoard.tryAgainLater") })} action={{ label: t("secondaryScheduleBoard.retry"), onPress: () => void loadTranscript() }} />
          : <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            <Button theme={theme} icon="FileText" label={t("secondaryScheduleBoard.readSessionRecord")} busy={transcript.state === "loading"} onPress={() => void loadTranscript()} />
            {run.agent?.archivedAt ? <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{t("secondaryScheduleBoard.temporarilyLoadsThisArchivedSessionOnly")}</Text> : null}
          </View>}
      </View> : null}
    </View>
    <View>
      <PaneLabel theme={theme} icon="Info">{t("secondaryScheduleBoard.runInformation")}</PaneLabel>
      {run.scheduledFor ? <KeyValue theme={theme} compact={compact} label={t("secondaryScheduleBoard.scheduledFor")} value={new Date(run.scheduledFor).toLocaleString(currentLanguage(), { hour12: false })} /> : null}
      <KeyValue theme={theme} compact={compact} label={t("secondaryScheduleBoard.started")} value={new Date(run.startedAt).toLocaleString(currentLanguage(), { hour12: false })} />
      <KeyValue theme={theme} compact={compact} label={t("secondaryScheduleBoard.ended2")} value={run.endedAt ? new Date(run.endedAt).toLocaleString(currentLanguage(), { hour12: false }) : run.status === "running" ? t("secondaryScheduleBoard.stillRunning") : t("secondaryScheduleBoard.unknown")} />
      {run.agent ? <KeyValue theme={theme} compact={compact} label={t("secondaryScheduleBoard.agent")} value={run.agent.known ? `${run.agent.title ?? t("secondaryScheduleBoard.unnamed")}${unlisted ? t("secondaryScheduleBoard.projectRemoved") : ""}` : fresh ? t("secondaryScheduleBoard.syncingName") : t("secondaryScheduleBoard.paseoNoLongerHasThisAgent")} /> : null}
      {run.workspace ? <KeyValue theme={theme} compact={compact} label={t("secondaryScheduleBoard.workspace")} value={[run.workspace.name, run.workspace.branch].filter(Boolean).join(" · ") || run.workspace.id} /> : null}
      <KeyValue theme={theme} compact={compact} label={t("secondaryScheduleBoard.recordSource")} value={run.source === "schedule" ? t("secondaryScheduleBoard.scheduleFile") : run.source === "ledger" ? t("secondaryScheduleBoard.observatoryLedgerScheduleDeleted") : t("secondaryScheduleBoard.agentLabelsScheduleDeleted")} />
      <KeyValue theme={theme} compact={compact} mono label={t("secondaryScheduleBoard.runId")} value={run.id} />
    </View>
    {detail.data?.prompt ? <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme} icon="ScrollText">{t("secondaryScheduleBoard.schedulePrompt")}</PaneLabel>
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{detail.data.prompt}</Text>
    </View> : null}
  </ScrollView>;
  if (!compact) return <View testID="schedule-run-detail" style={{ flex: 1, minHeight: 0 }}>{body}</View>;
  return <View testID="schedule-run-detail" style={{ flex: 1, minHeight: 0 }}>
    <Toolbar theme={theme}>
      <IconButton theme={theme} icon="ChevronLeft" label={t("secondaryScheduleBoard.backToList")} onPress={onClose} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: fontSize.small }}>{t("secondaryScheduleBoard.runDetails")}</Text>
      <IconButton theme={theme} icon="Copy" label={t("secondaryScheduleBoard.copyRunId")} onPress={copyId} />
    </Toolbar>
    {body}
  </View>;
}

/**
 * Paseo 0.11 opens this as a screen with `params` (`schedule`, optional `run`: see schedule-focus.ts), an older host as a
 * surface without them; there the focus comes from `focusScheduleRuns`. Opened from the sidebar, params are `{}`.
 */
export function ScheduleSurface({ theme, layout, host, navigation, params }: PluginSurfaceProps & { params?: PluginScreenParams }) {
  const { colors } = theme;
  const { compact, onLayout } = useCompactLayout(layout.compact);
  const zone = useMemo(deviceTimeZone, []);
  const now = useClock(30_000);
  // 「查看全部运行」 wins over the remembered view: the screen's params, or a request an older host left before opening the page.
  // Any param counts as a new request (an opener may add a nonce such as `t` so that tapping the same card again re-applies it).
  const paramFocus = focusFromParams(params), paramKey = paramFocus ? Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&") : "";
  const [initialFocus] = useState<ScheduleFocus | null>(() => paramFocus ?? peekScheduleFocus());
  const [view, setViewState] = useState<ViewChoice>(() => {
    const saved = remembered.get(host.id), base = saved ? { status: saved.status, scheduleId: saved.scheduleId, heartbeats: saved.heartbeats } : DEFAULT_VIEW;
    return initialFocus ? { ...base, scheduleId: initialFocus.scheduleId, status: "all" } : base;
  });
  const [window, setWindowState] = useState<RunWindow>(() => remembered.get(host.id)?.window ?? "recent");
  const [searchText, setSearchText] = useState("");
  // On a phone a selected run fills the page, so 「查看全部运行」 there shows the schedule's list instead of that one run.
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const [selectedId, setSelectedId] = useState<string | null>(() => initialFocus?.runId && !compact ? initialFocus.runId : null);
  const remember = (next: ViewChoice, nextWindow: RunWindow) => { remembered.set(host.id, { ...next, window: nextWindow }); };
  const setView = (next: ViewChoice) => { remember(next, window); setViewState(next); };
  const setWindow = (next: RunWindow) => { remember(view, next); setWindowState(next); };
  const applyFocus = useCallback((focus: ScheduleFocus) => {
    setViewState(previous => ({ ...previous, scheduleId: focus.scheduleId, status: "all" }));
    setSearchText("");
    setSelectedId(compactRef.current ? null : focus.runId ?? null);
  }, []);
  // A screen that is already open gets new params when another card asks for another schedule.
  const appliedParams = useRef(paramKey);
  useEffect(() => {
    if (paramKey === appliedParams.current) return;
    appliedParams.current = paramKey;
    const focus = focusFromParams(params);
    if (focus) applyFocus(focus);
  }, [paramKey]);
  useEffect(() => { clearScheduleFocus(initialFocus); }, [initialFocus]);
  useEffect(() => onScheduleFocus(focus => { clearScheduleFocus(focus); applyFocus(focus); }), [applyFocus]);
  // Searched on the server through every reply; the list on screen is narrowed locally until the server's answer arrives.
  const typed = normalizeRunQuery(searchText), settled = useSettled(typed, 300), search = typed ? settled : "";
  const query = useScheduleRuns(host.id, window, true, search);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const data = query.data;
  const runs = data?.runs ?? [];
  const schedules = data?.schedules ?? [];
  // Heartbeats stay out of the list unless asked for, except on a host whose only schedules are heartbeats: there the page
  // would otherwise always open empty. Hiding them is remembered like any other choice, and the empty page then says so.
  const onlyHeartbeats = schedules.length > 0 && schedules.every(schedule => schedule.kind === "heartbeat");
  const heartbeats = view.heartbeats ?? onlyHeartbeats;
  const setHeartbeats = (next: boolean) => setView({ ...view, heartbeats: next });
  const serverSearched = (data?.query ?? "") === typed;
  const filter: RunFilter = { status: view.status, scheduleId: view.scheduleId, heartbeats, query: serverSearched ? "" : typed };
  // A focused run older than the 30-day window: load everything once so it can be shown.
  useEffect(() => { if (selectedId && data && !search && window === "recent" && data.older + data.olderHeartbeats > 0 && !runs.some(run => run.id === selectedId)) setWindow("all"); }, [selectedId, data, window, search]);
  // Counts follow the schedule, heartbeat and search choices but not the status choice, so the chips never hide their own numbers.
  const scoped = useMemo(() => filterRuns(runs, { ...filter, status: "all" }), [runs, filter.scheduleId, filter.heartbeats, filter.query]);
  const counts = useMemo(() => { const result = { running: 0, succeeded: 0, failed: 0, unknown: 0, recentFailed: 0 }; for (const run of scoped) { result[run.status]++; if (run.status === "failed" && now - parseTime(run.startedAt) < DAY) result.recentFailed++; } return result; }, [scoped, now]);
  const heartbeatRuns = useMemo(() => filterRuns(runs, { status: "all", scheduleId: "all", heartbeats: true, query: filter.query }).filter(run => run.kind === "heartbeat").length, [runs, filter.query]);
  const heartbeatTotal = useMemo(() => schedules.reduce((sum, schedule) => schedule.kind === "heartbeat" ? sum + schedule.total : sum, 0), [schedules]);
  const visible = useMemo(() => filterRuns(runs, filter), [runs, filter.status, filter.scheduleId, filter.heartbeats, filter.query]);
  const filtered = view.status !== "all" || view.scheduleId !== "all" || !!typed;
  const scheduleOf = useCallback((id: string) => schedules.find(schedule => schedule.id === id), [schedules]);
  const focused = view.scheduleId !== "all" ? scheduleOf(view.scheduleId) : undefined;
  // Runs outside the window that this view would show: one schedule's own count, else the kinds on screen. The server counts a
  // search's older matches over every schedule, so for one schedule it can only tell whether there may be some.
  const olderAll = data ? data.older + (heartbeats ? data.olderHeartbeats : 0) : 0;
  const older = !data ? 0 : focused && !search ? Math.max(0, focused.total - runs.filter(run => run.scheduleId === focused.id).length) : focused ? 0 : olderAll;
  const olderMaybe = !!focused && !!search && data?.window === "recent" && data.older + data.olderHeartbeats > 0;
  const items = useMemo(() => {
    const result: FeedItem[] = [];
    for (const group of groupRunsByDay(visible, now)) {
      result.push({ kind: "group", key: `g:${group.key}`, today: group.key === `d${new Date(now).setHours(0, 0, 0, 0)}`, label: group.label, count: group.runs.length, failed: group.runs.filter(run => run.status === "failed").length });
      for (const run of group.runs) result.push({ kind: "run", key: run.id, run });
    }
    if ((older > 0 || olderMaybe) && visible.length) result.push({ kind: "more", key: "more" });
    return result;
  }, [visible, now, older, olderMaybe]);
  // The header sums the last 7 days: the server's count over every run, or the focused schedule's own runs.
  const week = useMemo(() => {
    if (!data) return null;
    if (!focused) return { total: data.week.runs + (heartbeats ? data.week.heartbeats : 0), failed: data.week.failed + (heartbeats ? data.week.heartbeatsFailed : 0) };
    let total = 0, failed = 0;
    for (const run of runs) if (run.scheduleId === focused.id && (parseTime(run.startedAt) || parseTime(run.scheduledFor)) >= now - 7 * DAY) { total++; if (run.status === "failed") failed++; }
    return { total, failed };
  }, [data, focused, runs, now, heartbeats]);
  const selected = selectedId ? runs.find(run => run.id === selectedId) : undefined;
  const select = useCallback((id: string) => setSelectedId(id), []);
  const toggle = (status: RunStatus) => setView({ ...view, status: view.status === status ? "all" : status });
  // Running and failing schedules first, deleted ones last.
  const shownSchedules = useMemo(() => schedules.filter(schedule => heartbeats || schedule.kind !== "heartbeat" || schedule.id === view.scheduleId)
    .map((schedule, index) => ({ schedule, index, rank: schedule.running ? 0 : schedule.recent.at(-1) === "failed" ? 1 : { active: 2, paused: 3, completed: 4, deleted: 5 }[schedule.status] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.schedule), [schedules, heartbeats, view.scheduleId]);
  const sync = query.isError && !data ? { state: "error" as const, label: t("secondaryScheduleBoard.readFailed") } : query.isFetching ? { state: "syncing" as const, label: typed ? t("secondaryScheduleBoard.searching") : t("secondaryScheduleBoard.syncing") } : { state: "live" as const, label: t("secondaryScheduleBoard.synced") };
  const clearFilters = () => { setView({ ...DEFAULT_VIEW, heartbeats: view.heartbeats }); setSearchText(""); };
  const menu: MenuAction[] = [
    { key: "heartbeats", label: heartbeats ? t("secondaryScheduleBoard.hideHeartbeats") : t("secondaryScheduleBoard.showHeartbeats"), icon: "HeartPulse", tone: "pink", hint: t("secondaryScheduleBoard.heartbeatsRemindAnExistingAgentOn"), onPress: () => setHeartbeats(!heartbeats) },
    ...(window === "recent" ? [{ key: "older", label: t("secondaryScheduleBoard.loadEarlierRuns"), icon: "History", hint: t("secondaryScheduleBoard.readsUpToRunsFromThe"), onPress: () => setWindow("all") }]
      : [{ key: "recent", label: t("secondaryScheduleBoard.showOnlyTheLastDays"), icon: "CalendarRange", onPress: () => setWindow("recent") }]),
    { key: "refresh", label: t("secondaryScheduleBoard.refresh"), icon: "RefreshCw", disabled: query.isFetching, onPress: () => void query.refetch() },
  ];
  const empty = query.isPending ? <Skeleton theme={theme} rows={6} />
    : query.isError && !data ? <EmptyState theme={theme} icon="WifiOff" tone="danger" title={t("secondaryScheduleBoard.scheduledRunsAreTemporarilyUnavailable")} message={query.error instanceof Error ? query.error.message : undefined} action={{ label: t("secondaryScheduleBoard.retry"), icon: "RefreshCw", onPress: () => void query.refetch() }} />
    : (older > 0 || olderMaybe) && data?.window === "recent" ? <EmptyState theme={theme} icon="History" tone="violet" title={filtered ? t("secondaryScheduleBoard.noMatchingRunsInTheLast") : t("secondaryScheduleBoard.noScheduledRunsInTheLast")}
      message={older > 0 ? t("secondaryScheduleBoard.earlierRunsAvailable", { value1: older }) : t("secondaryScheduleBoard.earlierRunsMayContainMatches")} action={{ label: query.isPlaceholderData ? t("secondaryScheduleBoard.loading") : t("secondaryScheduleBoard.loadEarlier"), icon: "History", onPress: () => setWindow("all") }} />
    : filtered ? <EmptyState theme={theme} icon="SearchX" title={t("secondaryScheduleBoard.noMatchingRuns")} message={!heartbeats && heartbeatTotal ? t("secondaryScheduleBoard.heartbeatRunsAreExcludedEnableThem") : undefined} action={{ label: t("secondaryScheduleBoard.clearFilters"), onPress: clearFilters }} />
    // Heartbeats were hidden on purpose and nothing else ever ran: say what is hidden instead of 「还没有定时运行」.
    : !heartbeats && heartbeatTotal > 0 ? <EmptyState theme={theme} icon="HeartPulse" tone="pink" title={t("secondaryScheduleBoard.onlyHeartbeatRuns", { value1: heartbeatTotal })} message={t("secondaryScheduleBoard.heartbeatsRemindAnExistingAgentOn2")}
      action={{ label: t("secondaryScheduleBoard.showHeartbeats"), icon: "HeartPulse", onPress: () => setHeartbeats(true) }} />
    : <EmptyState theme={theme} icon="CalendarClock" tone="violet" title={t("secondaryScheduleBoard.noScheduledRunsYet")} message={t("secondaryScheduleBoard.createAScheduleInSchedulesIn")} />;
  const more = older > 0 || olderMaybe ? <View style={{ alignItems: "center", gap: space.sm, paddingVertical: space.lg }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>{older > 0 ? data?.window === "recent" ? t("secondaryScheduleBoard.earlierAvailable", { value1: older, value2: search ? t("secondaryScheduleBoard.matches") : t("secondaryScheduleBoard.runs2") }) : t("secondaryScheduleBoard.earlierAreNotListed", { value1: older, value2: search ? t("secondaryScheduleBoard.matches") : t("secondaryScheduleBoard.runs2") }) : t("secondaryScheduleBoard.earlierRunsMayContainMoreMatches")}</Text>
    {data?.window === "recent" ? <Button theme={theme} size="sm" icon="History" label={t("secondaryScheduleBoard.loadEarlier")} busy={query.isPlaceholderData} onPress={() => setWindow("all")} /> : null}
  </View> : null;
  const strip = <ScheduleStrip theme={theme} compact={compact} schedules={shownSchedules} selectedId={view.scheduleId} now={now} zone={zone}
    onSelect={id => setView({ ...view, scheduleId: view.scheduleId === id ? "all" : id })} />;
  const banners = [
    data?.error ? <Banner key="error" theme={theme} tone="warning" message={data.error} /> : null,
    data?.notice ? <Banner key="notice" theme={theme} tone="warning" message={data.notice} /> : null,
    data?.reconstructed ? <Banner key="rebuilt" theme={theme} tone="info" icon="History" message={t("secondaryScheduleBoard.runsCameFromDeletedSchedulesAnd", { count: data.reconstructed })} /> : null,
    data?.searchLimited && serverSearched ? <Banner key="search" theme={theme} tone="info" icon="SearchSlash" message={t("secondaryScheduleBoard.thereWereTooManyRepliesSome")} /> : null,
  ].filter(Boolean);
  const list = <View style={{ flex: 1, minHeight: 0 }}>
    {banners.length ? <View style={{ gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm }}>{banners}</View> : null}
    <FlatList data={items} keyExtractor={item => item.key} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: space.xs, paddingBottom: space.xl }}
      initialNumToRender={16} maxToRenderPerBatch={20} windowSize={7} extraData={`${now}:${selectedId}:${window}:${query.isPlaceholderData}`} ListEmptyComponent={<View>{empty}</View>}
      renderItem={({ item }) => item.kind === "group" ? <GroupHeader theme={theme} today={item.today} label={item.label} count={item.count} failed={item.failed} />
        : item.kind === "more" ? more
        : <RunRow run={item.run} theme={theme} selected={item.run.id === selectedId} now={now} onSelect={select} />} />
  </View>;
  const detail = selected ? <RunDetail key={selected.id} run={selected} schedule={scheduleOf(selected.scheduleId)} theme={theme} compact={compact} navigation={navigation} onClose={() => setSelectedId(null)} now={now} zone={zone} />
    : <View style={{ flex: 1, justifyContent: "center" }}><EmptyState theme={theme} icon="PanelRight" tone="violet" title={t("secondaryScheduleBoard.selectARun")} message={t("secondaryScheduleBoard.itsReplyErrorAgentAndMerge")} /></View>;
  if (compact && selected) return <View onLayout={onLayout} style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>{detail}</View>;
  const searching = compact && (searchOpen || !!searchText);
  const rate = week && week.total ? Math.round(100 * (week.total - week.failed) / week.total) : null;
  return <View onLayout={onLayout} style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
    <FleetCoverageNotice theme={theme} methods={["observatory.schedules.list"]} />
    <Toolbar theme={theme}>
      <View style={{ flexShrink: 1, gap: 1 }}>
        {/* Focused on one schedule (its card, or 查看全部运行): the header names it and sums its own week. */}
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{focused ? focused.name : week ? t("secondaryScheduleBoard.runsInTheLastDays", { count: week.total }) : t("secondaryScheduleBoard.scheduledRuns")}</Text>
        <Text numberOfLines={1} style={{ color: week?.failed ? hueColor(theme, "fail", "text") : colors.foregroundMuted, fontSize: fontSize.meta }}>
          {!week ? t("secondaryScheduleBoard.reading") : [focused && week.total ? t("secondaryScheduleBoard.inTheLastDays", { value1: week.total }) : null, !week.total ? t("secondaryScheduleBoard.noRunsInTheseDays") : week.failed ? t("secondaryScheduleBoard.failedSuccessRate", { value1: week.failed, value2: rate }) : t("secondaryScheduleBoard.allSucceeded")].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Spacer />
      {!compact ? <View style={{ width: 260, flexShrink: 1 }}><SearchField theme={theme} value={searchText} onChangeText={setSearchText} placeholder={t("secondaryScheduleBoard.searchSchedulesRepliesErrorsOrBranches")} accessibilityLabel={t("secondaryScheduleBoard.searchScheduledRuns")} /></View>
        : <IconButton theme={theme} icon="Search" label={t("secondaryScheduleBoard.search")} active={searching} onPress={() => { if (searching) { setSearchText(""); setSearchOpen(false); } else setSearchOpen(true); }} />}
      <SyncStatus theme={theme} state={sync.state} label={compact ? undefined : sync.label} />
      <InfoButton theme={theme} title={t("secondaryScheduleBoard.aboutScheduledRuns")} lines={[t("secondaryScheduleBoard.scheduledRunsListsEveryRunOf"),
        t("secondaryScheduleBoard.dataComesFromPaseoSSchedule"),
        t("secondaryScheduleBoard.readsUpToRunsFromThe2"),
        t("secondaryScheduleBoard.oneTimeSchedulesShowTheirDate"),
        t("secondaryScheduleBoard.useSchedulesInTheSidebarTo")]} />
      <IconButton theme={theme} icon="Ellipsis" label={t("secondaryScheduleBoard.moreActions")} onPress={() => setMenuOpen(true)} />
    </Toolbar>
    {searching ? <View style={{ paddingHorizontal: space.md, paddingTop: space.sm }}><SearchField theme={theme} value={searchText} onChangeText={setSearchText} placeholder={t("secondaryScheduleBoard.searchSchedulesRepliesErrorsOrBranches")} accessibilityLabel={t("secondaryScheduleBoard.searchScheduledRuns")} autoFocus={!searchText} grow={false} /></View> : null}
    <ChipBar>
      {view.scheduleId !== "all" ? <Chip theme={theme} label={focused?.name ?? t("secondaryScheduleBoard.schedules")} icon="CalendarClock" tone="violet" selected onRemove={() => setView({ ...view, scheduleId: "all" })} /> : null}
      <StatusChip theme={theme} label={t("secondaryScheduleBoard.failed2")} count={data ? counts.failed : undefined} hue="fail" motion={counts.recentFailed ? "ping" : undefined} selected={view.status === "failed"} onPress={() => toggle("failed")} />
      <StatusChip theme={theme} label={t("secondaryScheduleBoard.running2")} count={data ? counts.running : undefined} hue="run" motion="spin" selected={view.status === "running"} onPress={() => toggle("running")} />
      <StatusChip theme={theme} label={t("secondaryScheduleBoard.succeeded")} count={data ? counts.succeeded : undefined} hue="ok" selected={view.status === "succeeded"} onPress={() => toggle("succeeded")} />
      <Chip theme={theme} label={t("secondaryScheduleBoard.heartbeat")} icon="HeartPulse" tone={heartbeats ? "pink" : undefined} count={heartbeatRuns || undefined} selected={heartbeats} onPress={() => setHeartbeats(!heartbeats)} />
    </ChipBar>
    {strip}
    <SplitView theme={theme} compact={compact} showDetail={false} list={list} detail={detail} listWidth={430} />
    <ActionMenu theme={theme} title={t("secondaryScheduleBoard.moreActions")} open={menuOpen} onClose={() => setMenuOpen(false)} actions={menu} />
  </View>;
}
