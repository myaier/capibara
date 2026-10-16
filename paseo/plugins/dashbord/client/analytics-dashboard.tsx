import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { analyticsZoneLabel, buildDailySeries, buildHourlyHeatmap, sumActivityMetrics, type ActivityMetrics, type AnalyticsSnapshot, type HourlyHeatmapCell, type UsageSample } from "../shared/analytics";
import { formatTokens, type AgentRecord } from "../shared/model";
import { Badge, Banner, Chip, Divider, EmptyState, MetaLine, ProjectMark, Row, Segmented, Sheet, Skeleton, Spacer, aria, fontSize, formatDuration, hairline, hue, hueFor, radius, relativeTime, space } from "./kit";
import { ChoiceList, InfoButton, StatRow } from "./ui";
import { useAnalytics } from "./use-analytics";
import { isForeground } from "./use-foreground";
import { Grow } from "./motion";

interface AnalyticsDashboardProps {
  theme: PluginTheme; hostId?: string; compact: boolean; agents: AgentRecord[]; analytics?: AnalyticsSnapshot; loading?: boolean; error?: string;
  onSelectAgent: (agentId: string) => void; onSelectProject: (projectId: string) => void;
}
type HeatMetric = "eventCount" | "outputTokens" | "failed";
const metricNames: Record<HeatMetric, string> = { get eventCount() { return t("coreAnalyticsDashboard.executionEvents"); }, get outputTokens() { return t("coreAnalyticsDashboard.outputSnapshots"); }, get failed() { return t("coreAnalyticsDashboard.failures"); } };
const readableDate = (iso: string) => iso.slice(5, 10).replace("-", "/");
const percent = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const valid = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const hour = (value: number) => String(value).padStart(2, "0");
/** 09:00–10:00, or 09:30–10:30 where the zone is off UTC by part of an hour (a cell is the UTC hour starting then). */
const hourRange = (cell: Pick<HourlyHeatmapCell, "hour" | "minute">) => `${hour(cell.hour)}:${hour(cell.minute)}–${hour((cell.hour + 1) % 24)}:${hour(cell.minute)}`;
/** Data marks only: one hue at an opacity step, over the surface. */
function alpha(color: string, opacity: number): string {
  const hex = /^#([0-9a-f]{3})$/i.test(color) ? `#${color.slice(1).split("").map(c => c + c).join("")}` : color;
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${Math.round(Math.min(1, Math.max(0, opacity)) * 255).toString(16).padStart(2, "0")}` : color;
}

function Section({ theme, title, trailing, children }: { theme: PluginTheme; title: string; trailing?: ReactNode; children: ReactNode }) {
  return <View style={{ gap: space.md }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{title}</Text>
      {trailing}
    </View>
    {children}
  </View>;
}
function Detail({ theme, title, lines }: { theme: PluginTheme; title: string; lines: readonly (string | null | false | undefined)[] }) {
  return <View accessibilityLiveRegion="polite" style={{ gap: 2, minHeight: 38 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{title}</Text>
    <MetaLine theme={theme} numberOfLines={2} parts={lines} />
  </View>;
}
/** A legend mark: filled, outlined (muted), or framed like the heatmap's daylight-saving cells (`frame`). */
function Swatch({ theme, color, label, outline = false, frame }: { theme: PluginTheme; color: string; label: string; outline?: boolean; frame?: { color: string; dashed?: boolean } }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 1 }}>
    <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: outline || frame ? "transparent" : color, borderWidth: frame ? 1 : outline ? hairline : 0,
      borderStyle: frame?.dashed ? "dashed" : "solid", borderColor: frame?.color ?? theme.colors.foregroundMuted }} />
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{label}</Text>
  </View>;
}

/**
 * 活跃时段: the last 7 local days × 24 local hours of the device's clock (opus-F40). The hour clocks go back holds two
 * hours (outlined, summed); the hour they skip does not exist (dashed, no value, not a zero).
 */
function Heatmap({ theme, analytics, compact, now, days = 7 }: { theme: PluginTheme; analytics: AnalyticsSnapshot; compact: boolean; now: number; days?: number }) {
  const { colors } = theme;
  const [metric, setMetric] = useState<HeatMetric>("eventCount");
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const cells = useMemo(() => buildHourlyHeatmap(analytics.hours, { now, startedAt: analytics.startedAt, metric, days, coverageIntervals: analytics.coverageIntervals ?? [],
    zone: analytics.zone ?? null, hourlyFrom: analytics.hourlyFrom }), [analytics, metric, now, days]);
  const maximum = Math.max(1, ...cells.map(cell => cell.value ?? 0));
  const peak = cells.reduce<HourlyHeatmapCell | null>((best, cell) => (cell.value ?? 0) > (best?.value ?? 0) ? cell : best, null);
  const active = cells.find(cell => cell.key === selected) ?? null;
  const doubledHour = cells.some(cell => cell.utcHours > 1), skippedHour = cells.some(cell => !cell.exists);
  // Activity is green, output violet, failures red — each metric keeps its own colour ramp.
  const mark = hue(theme, metric === "failed" ? "red" : metric === "outputTokens" ? "violet" : "green");
  const fill = (cell: HourlyHeatmapCell) => cell.value === null ? "transparent" : cell.value === 0 ? colors.surface2 : alpha(mark, 0.22 + Math.sqrt(cell.value / maximum) * 0.78);
  const gap = 3, labelWidth = 40;
  // Phones read the week like a calendar: days across, hours down, so nothing scrolls sideways.
  const columns = compact ? days : 24, rows = compact ? 24 : days;
  const cellWidth = Math.max(8, (width - labelWidth - (columns - 1) * gap) / columns);
  const cellHeight = compact ? 14 : Math.min(18, Math.max(12, cellWidth * 0.6));
  const cellAt = (row: number, column: number) => compact ? cells[column * 24 + row] : cells[row * 24 + column];
  const rowLabel = (row: number) => compact ? (row % 3 === 0 ? hour(row) : "") : readableDate(cells[row * 24]?.day ?? "");
  const columnLabel = (column: number) => compact ? readableDate(cells[column * 24]?.day ?? "") : column % 3 === 0 ? hour(column) : "";
  const shown = active ?? peak;
  return <Section theme={theme} title={t("coreAnalyticsDashboard.activeHours")} trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel={t("coreAnalyticsDashboard.heatmapMetric")} options={(Object.keys(metricNames) as HeatMetric[]).map(value => ({ value, label: metricNames[value] }))} />}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap }}>
      <View style={{ flexDirection: "row", gap, paddingLeft: labelWidth }}>
        {Array.from({ length: columns }, (_, column) => <Text key={column} numberOfLines={1} style={{ width: cellWidth, color: colors.foregroundMuted, fontSize: 11, textAlign: compact ? "center" : "left", fontVariant: ["tabular-nums"] }}>{columnLabel(column)}</Text>)}
      </View>
      {width > 0 ? Array.from({ length: rows }, (_, row) => <View key={row} style={{ flexDirection: "row", alignItems: "center", gap }}>
        <Text numberOfLines={1} style={{ width: labelWidth - gap, color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{rowLabel(row)}</Text>
        {Array.from({ length: columns }, (_, column) => {
          const cell = cellAt(row, column);
          if (!cell) return <View key={column} style={{ width: cellWidth, height: cellHeight }} />;
          const isSelected = selected === cell.key, doubled = cell.utcHours > 1;
          const label = t("coreAnalyticsDashboard.message", { value1: cell.day, value2: hourRange(cell), value3: !cell.exists ? t("coreAnalyticsDashboard.thisHourDoesNotExistBecauseThe") : t("coreAnalyticsDashboard.metricValue", { repeated: doubled ? t("coreAnalyticsDashboard.thisHourRepeatedWhenDaylightSavingTime") : "", metric: metricNames[metric], value: cell.value === null ? t("coreAnalyticsDashboard.noObservations") : cell.value }) });
          return <Pressable key={cell.key} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: isSelected }} {...aria({ pressed: isSelected })} onPress={() => setSelected(cell.key)}
            style={state => ({ width: cellWidth, height: cellHeight, borderRadius: 3, backgroundColor: cell.exists ? fill(cell) : "transparent",
              borderWidth: isSelected ? 1.5 : !cell.exists || doubled ? 1 : cell.value === null ? hairline : 0, borderStyle: cell.exists ? "solid" : "dashed",
              borderColor: isSelected ? colors.foreground : doubled ? hue(theme, "amber") : colors.border, opacity: state.pressed ? 0.7 : cell.coverage === "partial" ? 0.6 : 1 })} />;
        })}
      </View>) : <View style={{ height: rows * (cellHeight + gap) }} />}
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreAnalyticsDashboard.less")}</Text>
        {[0.22, 0.45, 0.7, 1].map(step => <View key={step} style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: alpha(mark, step) }} />)}
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreAnalyticsDashboard.more")}</Text>
      </View>
      <Swatch theme={theme} color={colors.border} label={t("coreAnalyticsDashboard.notCollected")} outline />
      {doubledHour ? <Swatch theme={theme} color={hue(theme, "amber")} label={t("coreAnalyticsDashboard.repeatedHourAfterClockRollbackCombined")} frame={{ color: hue(theme, "amber") }} /> : null}
      {skippedHour ? <Swatch theme={theme} color={colors.border} label={t("coreAnalyticsDashboard.skippedHourAfterClockAdvance")} frame={{ color: colors.foregroundMuted, dashed: true }} /> : null}
    </View>
    {shown ? <Detail theme={theme} title={t("coreAnalyticsDashboard.hourDetailTitle", { peak: active ? "" : t("coreAnalyticsDashboard.peak"), day: shown.day, hours: hourRange(shown) })}
      lines={!shown.exists ? [t("coreAnalyticsDashboard.daylightSavingTimeStartedAndTheClock")]
        : shown.value === null ? [shown.isFuture ? t("coreAnalyticsDashboard.thisTimePeriodHasNotArrivedYet") : analytics.hourlyFrom && shown.bucketStart && shown.bucketStart < analytics.hourlyFrom ? t("coreAnalyticsDashboard.beforeTheUpgradeOnly7DaysOf") : !shown.observed ? t("coreAnalyticsDashboard.noLiveObservationsCoverThisPeriodIt") : t("coreAnalyticsDashboard.noProviderUsageSnapshotsWereReceivedDuring")]
        : [shown.utcHours > 1 ? t("coreAnalyticsDashboard.daylightSavingTimeEndedAndThisHour") : null, t("coreAnalyticsDashboard.events", { value1: shown.metrics?.eventCount ?? 0 }), t("coreAnalyticsDashboard.completedFailed", { value1: shown.metrics?.completed ?? 0, value2: shown.metrics?.failed ?? 0 }), t("coreAnalyticsDashboard.peakOutput", { value1: formatTokens(shown.metrics?.outputTokens) }), shown.coveredMs === null ? null : t("coreAnalyticsDashboard.online", { value1: formatDuration(shown.coveredMs), value2: shown.coverage === "partial" ? t("coreAnalyticsDashboard.partial") : "" })]} /> : null}
    {metric === "outputTokens" ? <MetaLine theme={theme} numberOfLines={2} parts={[t("coreAnalyticsDashboard.colorShowsThePeakOutputTokenSnapshot")]} /> : null}
  </Section>;
}

/** 每日结果: the last 7 / 28 local days of the device's clock, each from its own local midnight (opus-F40). */
function DailyChart({ theme, analytics, now, dayCount = 28 }: { theme: PluginTheme; analytics: AnalyticsSnapshot; now: number; dayCount?: number }) {
  const { colors } = theme;
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const days = useMemo(() => buildDailySeries(analytics, { now, count: dayCount }), [analytics, now, dayCount]);
  const total = (bucket: { completed: number; failed: number; canceled: number } | null) => (bucket?.completed ?? 0) + (bucket?.failed ?? 0) + (bucket?.canceled ?? 0);
  const peak = Math.max(1, ...days.map(({ bucket }) => total(bucket)));
  const plot = 128, headroom = 20, columnWidth = width ? width / dayCount : 0, barWidth = Math.max(4, Math.min(16, columnWidth * 0.5));
  const success = hue(theme, "green"), danger = hue(theme, "red"), neutral = hue(theme, "gray");
  const active = days.find(day => day.day === selected) ?? days.at(-1)!;
  const labelEvery = dayCount <= 7 ? 1 : columnWidth >= 30 ? 2 : 7;
  return <Section theme={theme} title={t("coreAnalyticsDashboard.dailyOutcomes")} trailing={<View style={{ flexDirection: "row", gap: space.md }}><Swatch theme={theme} color={success} label={t("coreAnalyticsDashboard.completed")} /><Swatch theme={theme} color={danger} label={t("coreAnalyticsDashboard.failed")} /><Swatch theme={theme} color={neutral} label={t("coreAnalyticsDashboard.canceled")} /></View>}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: plot, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: headroom - 8, flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{peak}</Text>
          <View style={{ flex: 1, height: hairline, backgroundColor: colors.border }} />
        </View>
        {columnWidth ? days.map(({ day, observed, bucket, approximate }, dayIndex) => {
          const segments = [[bucket?.canceled ?? 0, neutral], [bucket?.failed ?? 0, danger], [bucket?.completed ?? 0, success]] as const;
          const visible = segments.filter(([value]) => value > 0);
          return <Pressable key={day} accessibilityRole="button" accessibilityLabel={t("coreAnalyticsDashboard.message2", { value1: day, value2: observed || bucket ? t("coreAnalyticsDashboard.completedFailedCanceled", { value1: bucket?.completed ?? 0, value2: bucket?.failed ?? 0, value3: bucket?.canceled ?? 0, value4: approximate ? t("coreAnalyticsDashboard.estimatedFromUtcDaysRecordedBeforeThe") : "" }) : t("coreAnalyticsDashboard.notObserved") })} accessibilityState={{ selected: active.day === day }} {...aria({ pressed: active.day === day })} onPress={() => setSelected(day)}
            style={state => ({ width: columnWidth, height: plot, alignItems: "center", justifyContent: "flex-end", borderRadius: radius.sm, backgroundColor: active.day === day ? colors.surface1 : state.pressed ? colors.surface1 : "transparent" })}>
            {visible.length ? <Grow delay={dayIndex * 14} style={{ alignItems: "center", opacity: approximate ? 0.55 : 1 }}>{visible.map(([value, color], index) => <View key={index} style={{ width: barWidth, height: Math.max(2, value / peak * (plot - headroom)), marginTop: index ? 2 : 0, backgroundColor: color, borderTopLeftRadius: index === 0 ? 4 : 0, borderTopRightRadius: index === 0 ? 4 : 0 }} />)}</Grow>
              : <View style={{ width: barWidth, height: 2, backgroundColor: observed ? colors.surface2 : "transparent" }} />}
          </Pressable>;
        }) : null}
      </View>
      <View style={{ flexDirection: "row", paddingTop: space.xs }}>
        {columnWidth ? days.map(({ day }, index) => <View key={day} style={{ width: columnWidth, alignItems: "center", overflow: "visible" }}>
          {(dayCount - 1 - index) % labelEvery === 0 ? <Text numberOfLines={1} style={{ width: 44, textAlign: "center", color: active.day === day ? colors.foreground : colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{readableDate(day)}</Text> : null}
        </View>) : null}
      </View>
    </View>
    <Detail theme={theme} title={active.day} lines={active.observed || active.bucket ? [t("coreAnalyticsDashboard.completed2", { value1: active.bucket?.completed ?? 0 }), t("coreAnalyticsDashboard.failed2", { value1: active.bucket?.failed ?? 0 }), t("coreAnalyticsDashboard.canceled2", { value1: active.bucket?.canceled ?? 0 }), t("coreAnalyticsDashboard.runtime", { value1: formatDuration(active.bucket?.runMs ?? 0) }), t("coreAnalyticsDashboard.online2", { value1: formatDuration(active.coveredMs) }),
      active.approximate ? t("coreAnalyticsDashboard.recordedByUtcCalendarDayBeforeThe") : null] : [t("coreAnalyticsDashboard.observationHadNotStartedThisDoesNot")]} />
  </Section>;
}

interface ProjectGroup { key: string; id: string | null; name: string; agentIds: Set<string>; worktrees: Set<string>; metrics: ActivityMetrics; samples: UsageSample[] }
function ProjectRanking({ theme, analytics, agents, onSelectProject }: { theme: PluginTheme; analytics: AnalyticsSnapshot; agents: AgentRecord[]; onSelectProject: (id: string) => void }) {
  const { colors } = theme;
  const [metric, setMetric] = useState<"activity" | "tokens">("activity");
  const groups = useMemo(() => {
    const known = new Map(agents.map(agent => [agent.id, agent]));
    const latest = new Map<string, UsageSample>();
    for (const sample of analytics.usage) { const previous = latest.get(sample.agentId); if (!previous || Date.parse(sample.at) > Date.parse(previous.at)) latest.set(sample.agentId, sample); }
    const result = new Map<string, ProjectGroup>();
    for (const agent of analytics.agents) {
      const record = known.get(agent.agentId);
      const id = record?.projectId ?? agent.projectId, name = record?.projectName ?? agent.projectName ?? t("coreAnalyticsDashboard.noLinkedProject");
      const key = id ?? agent.projectRootPath ?? `unknown:${name}`;
      const group = result.get(key) ?? { key, id, name, agentIds: new Set<string>(), worktrees: new Set<string>(), metrics: sumActivityMetrics([]), samples: [] };
      group.agentIds.add(agent.agentId);
      if (record?.checkoutKind === "worktree" && record.worktreePath) group.worktrees.add(record.worktreePath);
      group.metrics = sumActivityMetrics([group.metrics, agent]);
      const sample = latest.get(agent.agentId); if (sample) group.samples.push(sample);
      result.set(key, group);
    }
    return [...result.values()].map(group => {
      const inputs = group.samples.filter(sample => valid(sample.inputTokens)), outputs = group.samples.filter(sample => valid(sample.outputTokens));
      const pairs = group.samples.filter(sample => valid(sample.inputTokens) && valid(sample.cachedTokens) && sample.inputTokens > 0 && sample.cachedTokens <= sample.inputTokens);
      const pairedInput = pairs.reduce((sum, sample) => sum + sample.inputTokens!, 0);
      return { ...group, input: inputs.length ? inputs.reduce((sum, sample) => sum + sample.inputTokens!, 0) : null, output: outputs.length ? outputs.reduce((sum, sample) => sum + sample.outputTokens!, 0) : null,
        cacheRatio: pairedInput ? pairs.reduce((sum, sample) => sum + sample.cachedTokens!, 0) / pairedInput : null };
    }).sort((a, b) => (metric === "tokens" ? (b.output ?? -1) - (a.output ?? -1) : b.metrics.eventCount - a.metrics.eventCount) || a.name.localeCompare(b.name));
  }, [analytics, agents, metric]);
  const peak = Math.max(1, ...groups.map(group => metric === "tokens" ? group.output ?? 0 : group.metrics.eventCount));
  return <Section theme={theme} title={t("coreAnalyticsDashboard.projects")} trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel={t("coreAnalyticsDashboard.projectSort")} options={[{ value: "activity", label: t("coreAnalyticsDashboard.byEvents") }, { value: "tokens", label: t("coreAnalyticsDashboard.byOutput") }]} />}>
    {groups.length ? <View style={{ marginHorizontal: -space.md }}>{groups.slice(0, 12).map((group, rank) => {
      const value = metric === "tokens" ? group.output : group.metrics.eventCount;
      return <Pressable key={group.key} accessibilityRole="button" accessibilityLabel={t("coreAnalyticsDashboard.viewProject", { value1: group.name })} accessibilityState={{ disabled: !group.id }} disabled={!group.id} onPress={() => group.id && onSelectProject(group.id)}
        style={state => ({ gap: space.xs + 2, paddingVertical: 10, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface1 : "transparent" })}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <ProjectMark theme={theme} name={group.name} size={18} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{group.name}</Text>
          <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontVariant: ["tabular-nums"] }}>{metric === "tokens" ? formatTokens(value) : value?.toLocaleString() ?? "—"}</Text>
        </View>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}><Grow axis="x" delay={rank * 40} style={{ height: 4, width: `${Math.max(0, (value ?? 0) / peak * 100)}%`, borderRadius: 2, backgroundColor: hue(theme, hueFor(group.name)) }} /></View>
        <MetaLine theme={theme} parts={[t("coreAnalyticsDashboard.agents", { count: group.agentIds.size }), group.worktrees.size ? t("coreAnalyticsDashboard.worktrees", { count: group.worktrees.size }) : null, t("coreAnalyticsDashboard.completed2", { value1: group.metrics.completed }), group.metrics.failed ? t("coreAnalyticsDashboard.failed2", { value1: group.metrics.failed }) : null, t("coreAnalyticsDashboard.input", { value1: formatTokens(group.input) }), t("coreAnalyticsDashboard.output", { value1: formatTokens(group.output) }), group.cacheRatio !== null ? t("coreAnalyticsDashboard.cache", { value1: percent(group.cacheRatio) }) : null]} />
      </Pressable>;
    })}</View> : <MetaLine theme={theme} parts={[t("coreAnalyticsDashboard.executionOutcomesAndUsageWillBuildA")]} />}
    {groups.length > 12 ? <MetaLine theme={theme} parts={[t("coreAnalyticsDashboard.showingOnlyTheTop12Projects")]} /> : null}
  </Section>;
}

function UsageSnapshots({ theme, analytics, agents, onSelectAgent }: { theme: PluginTheme; analytics: AnalyticsSnapshot; agents: AgentRecord[]; onSelectAgent: (id: string) => void }) {
  const known = new Map(agents.map(agent => [agent.id, agent]));
  const latest = new Map<string, UsageSample>();
  for (const sample of analytics.usage) if (!latest.has(sample.agentId)) latest.set(sample.agentId, sample);
  return <Section theme={theme} title={t("coreAnalyticsDashboard.latestUsageSnapshots")}>
    {latest.size ? <View style={{ marginHorizontal: -space.md }}>{[...latest.values()].slice(0, 6).map(sample => {
      const record = known.get(sample.agentId);
      const ratio = valid(sample.inputTokens) && valid(sample.cachedTokens) && sample.inputTokens > 0 && sample.cachedTokens <= sample.inputTokens ? sample.cachedTokens / sample.inputTokens : null;
      return <Row key={sample.id} theme={theme} title={record?.title ?? sample.agentId} titleLines={1} accessibilityLabel={t("coreAnalyticsDashboard.viewUsageAgent", { value1: record?.title ?? sample.agentId })} onPress={() => onSelectAgent(sample.agentId)}
        trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{relativeTime(sample.at)}</Text>}
        subtitle={<MetaLine theme={theme} parts={[record?.projectName ?? t("coreAnalyticsDashboard.projectNotYetLinked"), sample.provider, t("coreAnalyticsDashboard.input", { value1: formatTokens(sample.inputTokens) }), t("coreAnalyticsDashboard.output", { value1: formatTokens(sample.outputTokens) }), ratio !== null ? t("coreAnalyticsDashboard.cache", { value1: percent(ratio) }) : null]} />} />;
    })}</View> : <MetaLine theme={theme} parts={[t("coreAnalyticsDashboard.noProviderUsageReportsYet")]} />}
  </Section>;
}

export function AnalyticsDashboard({ theme, hostId = "local", compact, agents, analytics: hostAnalytics, loading: hostLoading, error: hostError, onSelectAgent, onSelectProject }: AnalyticsDashboardProps) {
  const [now, setNow] = useState(Date.now());
  const [width, setWidth] = useState(0);
  const [projectId, setProjectId] = useState("all");
  const [projectSheet, setProjectSheet] = useState(false);
  const [period, setPeriod] = useState<"7" | "28">("28");
  const projectQuery = useAnalytics(hostId, projectId !== "all", projectId === "all" ? undefined : projectId);
  const analytics = projectId === "all" ? hostAnalytics : projectQuery.data;
  const loading = projectId === "all" ? hostLoading : projectQuery.isPending;
  const error = projectId === "all" ? hostError : projectQuery.error?.message;
  const projectOptions = useMemo(() => [...new Map([...agents.map(agent => [agent.projectId, agent.projectName] as const), ...(hostAnalytics?.agents ?? []).map(agent => [agent.projectId, agent.projectName ?? t("coreAnalyticsDashboard.noLinkedProject")] as const)].filter((entry): entry is readonly [string, string] => !!entry[0])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [agents, hostAnalytics]);
  useEffect(() => {
    const timer = setInterval(() => { if (isForeground(AppState.currentState)) setNow(Date.now()); }, 60_000);
    const listener = AppState.addEventListener("change", state => { if (state === "active") setNow(Date.now()); });
    return () => { clearInterval(timer); listener.remove(); };
  }, []);
  const days = Number(period);
  // The period is that many local days, each from the device's local midnight (the server cut them in its clock).
  const series = useMemo(() => analytics ? buildDailySeries(analytics, { now, count: days }) : [], [analytics, now, days]);
  const totals = useMemo(() => sumActivityMetrics(series.flatMap(day => day.bucket ? [day.bucket] : [])), [series]);
  const approximate = series.some(day => day.approximate);
  const zone = analytics?.zone ?? null, zoneLabel = analyticsZoneLabel(zone, now);
  const success = totals.completed + totals.failed > 0 ? totals.completed / (totals.completed + totals.failed) : null;
  const inset = compact ? space.lg : space.xl, twoColumns = !compact && width >= 900;
  const projectName = projectOptions.find(([id]) => id === projectId)?.[1] ?? t("coreAnalyticsDashboard.allProjects");
  const info = [
    zone ? t("coreAnalyticsDashboard.datesAndHoursUseEachHourIs", { value1: zone.name ? t("coreAnalyticsDashboard.localTimeZone", { value1: zone.name }) : zoneLabel }) : t("coreAnalyticsDashboard.theLocalTimeZoneWasUnavailableDates"),
    t("coreAnalyticsDashboard.countsOnlyLifecycleEventsObservedByThe"), t("coreAnalyticsDashboard.grayOutlinesMeanNoLiveObservationCoverage"),
    t("coreAnalyticsDashboard.tokensCacheAndCostsShowProviderSnapshots"), t("coreAnalyticsDashboard.projectSummariesCoverAllRetainedHistoryAnd"),
    ...(approximate ? [t("coreAnalyticsDashboard.earlierDaysUseUtcCalendarDataFrom")] : []),
  ];
  return <><ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingTop: space.md, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.xl, width: "100%", maxWidth: 1080, alignSelf: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <Chip theme={theme} label={projectName} icon="Folder" tone={projectId !== "all" ? hueFor(projectName) : undefined} selected={projectId !== "all"} onPress={() => setProjectSheet(true)} />
        <Segmented theme={theme} size="sm" value={period} onChange={setPeriod} accessibilityLabel={t("coreAnalyticsDashboard.timeRange")} options={[{ value: "7", label: t("coreAnalyticsDashboard.value7Days") }, { value: "28", label: t("coreAnalyticsDashboard.value28Days") }]} />
        {analytics && !zone ? <Badge theme={theme} label={t("coreAnalyticsDashboard.usingUtc")} tone="amber" icon="Globe" /> : null}
        <Spacer />
        <InfoButton theme={theme} title={t("coreAnalyticsDashboard.aboutDataInsights")} lines={info} />
      </View>
      {error ? <Banner theme={theme} tone="danger" message={t("coreAnalyticsDashboard.dataCannotSyncRightNow", { value1: error })} /> : null}
      {analytics?.persistenceError ? <Banner theme={theme} tone="warning" message={analytics.persistenceError} /> : null}
      {analytics?.agentsTruncated ? <Banner theme={theme} tone="warning" message={t("coreAnalyticsDashboard.agentStatisticsReachedTheRetentionLimitProject")} /> : null}
      {analytics?.projectHistoryTruncated ? <Banner theme={theme} tone="warning" message={t("coreAnalyticsDashboard.projectHistoryHasARetentionLimitAnd")} /> : null}
      {!analytics ? loading ? <Skeleton theme={theme} rows={5} /> : <EmptyState theme={theme} icon="ChartNoAxesCombined" title={t("coreAnalyticsDashboard.noExecutionDataYet")} message={t("coreAnalyticsDashboard.activeHoursDailyOutcomesAndProjectSummaries")} /> : <>
        <View style={{ gap: space.xs }}>
          <StatRow theme={theme} size="lg" columns={compact ? 2 : undefined} stats={[{ label: t("coreAnalyticsDashboard.completedTurns"), value: totals.completed.toLocaleString(), tone: "green" }, { label: t("coreAnalyticsDashboard.completionRate"), value: percent(success), tone: "blue" }, { label: t("coreAnalyticsDashboard.runtime2"), value: formatDuration(totals.runMs) || t("coreAnalyticsDashboard.value0Seconds"), tone: "violet" }, { label: t("coreAnalyticsDashboard.waitingForDecisions"), value: formatDuration(totals.waitMs) || t("coreAnalyticsDashboard.value0Seconds"), tone: "amber" }]} />
          <MetaLine theme={theme} parts={[t("coreAnalyticsDashboard.lastDays", { value1: days }), t("coreAnalyticsDashboard.failed2", { value1: totals.failed }), t("coreAnalyticsDashboard.canceled2", { value1: totals.canceled })]} />
        </View>
        <Divider theme={theme} />
        <Heatmap theme={theme} analytics={analytics} compact={compact} now={now} days={7} />
        <Divider theme={theme} />
        <DailyChart theme={theme} analytics={analytics} now={now} dayCount={days} />
        <Divider theme={theme} />
        <View style={{ flexDirection: twoColumns ? "row" : "column", alignItems: "flex-start", gap: twoColumns ? space.xxl : space.xl }}>
          <View style={{ flex: twoColumns ? 1 : undefined, width: twoColumns ? undefined : "100%", minWidth: 0 }}><ProjectRanking theme={theme} analytics={analytics} agents={projectId === "all" ? agents : agents.filter(agent => agent.projectId === projectId)} onSelectProject={onSelectProject} /></View>
          {!twoColumns ? <View style={{ width: "100%" }}><Divider theme={theme} /></View> : null}
          <View style={{ flex: twoColumns ? 1 : undefined, width: twoColumns ? undefined : "100%", minWidth: 0 }}><UsageSnapshots theme={theme} analytics={analytics} agents={agents} onSelectAgent={onSelectAgent} /></View>
        </View>
        <MetaLine theme={theme} numberOfLines={2} parts={[t("coreAnalyticsDashboard.observationStarted", { value1: new Date(analytics.startedAt).toLocaleDateString(currentLanguage()) }), t("coreAnalyticsDashboard.lastObserved", { value1: relativeTime(analytics.updatedAt, now) }), zone ? t("coreAnalyticsDashboard.using", { value1: zoneLabel }) : t("coreAnalyticsDashboard.usingUtcLocalTimeZoneUnavailable")]} />
      </>}
    </View>
  </ScrollView>
  <Sheet title={t("coreAnalyticsDashboard.projects")} open={projectSheet} onClose={() => setProjectSheet(false)}>
    <ChoiceList theme={theme} value={projectId} onChange={id => { setProjectId(id); setProjectSheet(false); }} options={[{ value: "all", label: t("coreAnalyticsDashboard.allProjects") }, ...projectOptions.map(([id, name]) => ({ value: id, label: name, leading: <ProjectMark theme={theme} name={name} size={20} /> }))]} />
  </Sheet></>;
}
