import { t } from "../shared/text";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Banner, Button, MetaLine, Skeleton, Spacer, fontSize, hairline, radius, space } from "./kit";
import { PhasePill, hueColor, tint, tintAlpha } from "./status";
import { PaneLabel } from "./ui";
import { OutputText } from "./result-view";
import { runDurationLabel, runLooks, runMoment } from "./schedule-looks";
import { useScheduleRun } from "./use-schedules";
import { cadenceText, describeRunError, deviceTimeZone } from "../shared/schedules";

/**
 * Agent 详情 → 结果, for an Agent a schedule created: which schedule, how this run went, and a way to all its runs.
 * Labels alone identify the run; the card fills in from the 定时运行 index (one small read, cached for the session).
 */
export function ScheduleRunCard({ theme, runId, scheduleId, running, onOpenAll }: { theme: PluginTheme; runId: string; scheduleId: string; running: boolean; onOpenAll?: () => void }) {
  const { colors } = theme;
  const detail = useScheduleRun(runId, running);
  const row = detail.data?.row ?? null, schedule = detail.data?.schedule ?? null;
  const look = row ? runLooks[row.status] : null, violet = hueColor(theme, "violet");
  const error = describeRunError(row?.error)?.summary;
  return <View testID="schedule-run-card" style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: hairline, borderColor: tint(violet, 0.45), backgroundColor: tint(violet, tintAlpha(theme) * 0.6) }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Icon name="CalendarClock" size={15} color={violet} />
      <Text style={{ color: hueColor(theme, "violet", "text"), fontSize: fontSize.meta, fontWeight: "700" }}>{t("secondaryScheduleRunCard.schedule")}</Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{row?.scheduleName || schedule?.name || t("secondaryScheduleRunCard.schedule2", { value1: scheduleId })}</Text>
      <Spacer />
      {look && row ? <PhasePill theme={theme} hue={look.hue} icon={row.status === "running" ? undefined : look.icon} label={look.label} solid={row.status === "failed"} /> : null}
    </View>
    {/* Non-breaking spaces keep 「耗时 14 分」 on one line; the meta wraps only between parts. */}
    {detail.isPending ? <Skeleton theme={theme} rows={1} /> : <MetaLine theme={theme} numberOfLines={2} parts={[schedule ? cadenceText(schedule, deviceTimeZone()) : null, row ? t("secondaryScheduleRunCard.thisRun", { value1: runMoment(row.startedAt) }) : null,
      row ? runDurationLabel(row) && t("secondaryScheduleRunCard.took", { value1: runDurationLabel(row) }) : null, schedule?.status === "deleted" ? t("secondaryScheduleRunCard.scheduleDeleted") : schedule?.status === "paused" ? t("secondaryScheduleRunCard.paused") : null, detail.isError ? t("secondaryScheduleRunCard.runRecordTemporarilyUnavailable") : null]
      .map(part => typeof part === "string" ? part.replace(/ /g, "\u00a0") : part)} />}
    {error ? <Text numberOfLines={2} style={{ color: hueColor(theme, "fail", "text"), fontSize: fontSize.small, lineHeight: 19 }}>{error}</Text> : null}
    {onOpenAll ? <View style={{ alignItems: "flex-start" }}><Button theme={theme} size="sm" tone="violet" icon="CalendarRange" label={t("secondaryScheduleRunCard.viewAllRuns")} onPress={onOpenAll} /></View> : null}
  </View>;
}

/**
 * An archived schedule Agent's result: the reply the schedule recorded, without loading the session. Reading the full
 * result (first input, artifacts, tests) loads the archived session in the host, so it waits for a tap.
 * Also the fallback when a schedule Agent's session cannot be read (`notice` says why, the button retries).
 */
export function RecordedRunResult({ theme, runId, header, lead, inset, onLoadFull, notice = null, loadLabel = t("secondaryScheduleRunCard.readFullResult"), loadHint = t("secondaryScheduleRunCard.temporarilyLoadsThisArchivedSessionTo"), loading = false }: {
  theme: PluginTheme; runId: string; header?: ReactNode; lead?: ReactNode; inset: number; onLoadFull: () => void; notice?: string | null; loadLabel?: string; loadHint?: string | null; loading?: boolean }) {
  const { colors } = theme;
  const detail = useScheduleRun(runId, false);
  const output = detail.data?.output ?? null;
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: space.xxl }}>
    <View style={{ paddingHorizontal: inset }}>{header}</View>
    <View style={{ paddingHorizontal: inset, paddingTop: space.lg, gap: space.xl }}>
      {notice ? <Banner theme={theme} tone="warning" message={notice} /> : null}
      {lead}
      <View style={{ gap: space.sm }}>
        <PaneLabel theme={theme} icon="MessageSquareText" tone="success" trailing={<MetaLine theme={theme} parts={[t("secondaryScheduleRunCard.scheduleRecord")]} />}>{t("secondaryScheduleRunCard.finalReply")}</PaneLabel>
        {detail.isPending ? <Skeleton theme={theme} rows={3} /> : output ? <OutputText theme={theme} text={output} />
          : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 20 }}>{detail.data?.note ?? t("secondaryScheduleRunCard.thisRunSRecordIsTemporarily")}</Text>}
        {detail.data?.outputTruncated ? <MetaLine theme={theme} parts={[t("secondaryScheduleRunCard.theReplyExceedsCharactersOnlyThe")]} /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingTop: space.xs }}>
          <Button theme={theme} icon={loadHint ? "FileSearch" : "RefreshCw"} label={loadLabel} busy={loading} onPress={onLoadFull} />
          {loadHint ? <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{loadHint}</Text> : null}
        </View>
      </View>
    </View>
  </ScrollView>;
}
