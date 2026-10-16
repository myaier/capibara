import { t } from "../shared/text";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { StatsBreakdownRow, StatsSnapshot, StatsTool, ToolKind } from "../shared/stats";
import { averageTurnMs, bigNumber, observedParallelism, percent, shortHours, successRate } from "../shared/stats-view";
import { ProjectMark, Segmented, fontSize, gradient, hue, radius, space, withAlpha, type Hue } from "./kit";
import { Card, CompositionBar, InlineBar } from "./charts";
import { IconDisk, StatsGate, StatsHeader, rowHues, trackFor, vendorLabel, type StatsViewProps } from "./stats-common";

export type BreakdownDimension = "models" | "vendors" | "providers" | "projects" | "tools" | "observed";
const dimensions: Array<{ value: BreakdownDimension; label: string; icon: string; tone: Hue }> = [
  { value: "models", get label() { return t("secondaryStatsBreakdown.model"); }, icon: "Cpu", tone: "cyan" }, { value: "vendors", get label() { return t("secondaryStatsBreakdown.vendor"); }, icon: "Building2", tone: "orange" },
  { value: "providers", get label() { return t("secondaryStatsBreakdown.harness"); }, icon: "SquareTerminal", tone: "violet" }, { value: "projects", get label() { return t("secondaryStatsBreakdown.project"); }, icon: "FolderGit2", tone: "blue" },
  { value: "tools", get label() { return t("secondaryStatsBreakdown.tools"); }, icon: "Wrench", tone: "teal" }, { value: "observed", get label() { return t("secondaryStatsBreakdown.observations"); }, icon: "Activity", tone: "pink" },
];
type RowMetric = "turns" | "sessions" | "runMs" | "toolCalls" | "linesAdded";
const rowMetrics: Record<RowMetric, { label: string; format: (value: number) => string }> = {
  turns: { get label() { return t("secondaryStatsBreakdown.turns"); }, format: bigNumber }, sessions: { get label() { return t("secondaryStatsBreakdown.sessions"); }, format: bigNumber }, runMs: { get label() { return t("secondaryStatsBreakdown.duration"); }, format: shortHours },
  toolCalls: { get label() { return t("secondaryStatsBreakdown.tools"); }, format: bigNumber }, linesAdded: { get label() { return t("secondaryStatsBreakdown.code"); }, format: value => `+${bigNumber(value)}` },
};
const kindLooks: Record<ToolKind, { label: string; icon: string; hue: Hue }> = {
  shell: { get label() { return t("secondaryStatsBreakdown.commandLine"); }, icon: "SquareTerminal", hue: "orange" }, read: { get label() { return t("secondaryStatsBreakdown.readFiles"); }, icon: "FileText", hue: "blue" }, edit: { get label() { return t("secondaryStatsBreakdown.editFiles"); }, icon: "FilePen", hue: "green" },
  search: { get label() { return t("secondaryStatsBreakdown.search"); }, icon: "Search", hue: "indigo" }, web: { get label() { return t("secondaryStatsBreakdown.web"); }, icon: "Globe", hue: "cyan" }, agent: { get label() { return t("secondaryStatsBreakdown.subagents"); }, icon: "Bot", hue: "fuchsia" },
  plan: { get label() { return t("secondaryStatsBreakdown.plan"); }, icon: "ListChecks", hue: "teal" }, other: { get label() { return t("secondaryStatsBreakdown.other"); }, icon: "Puzzle", hue: "gray" },
};

function Stat({ theme, label, value, color }: { theme: PluginTheme; label: string; value: string; color?: Hue }) {
  return <View style={{ gap: 1, minWidth: 64 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    <Text numberOfLines={1} style={{ color: color ? hue(theme, color, "text") : theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
  </View>;
}

const rateHue = (rate: number | null): Hue | undefined => rate === null ? undefined : rate >= 0.97 ? "green" : rate >= 0.9 ? "amber" : "red";
const code = (row: StatsBreakdownRow) => row.linesAdded || row.linesRemoved ? `+${bigNumber(row.linesAdded)} −${bigNumber(row.linesRemoved)}` : "—";
// Wide tables put every figure on one line: # · name · bar · value · share · 成功率 · 平均每轮 · 工具/轮 · 代码 · 上下文.
const columns = { rank: 20, value: 76, share: 52, rate: 64, avg: 64, tools: 56, code: 116, context: 56 } as const;

function RowMark({ theme, row, color, kind }: { theme: PluginTheme; row: StatsBreakdownRow; color: Hue; kind: BreakdownDimension }) {
  return kind === "projects" && row.key !== "__other__" ? <ProjectMark theme={theme} name={row.label} size={20} /> : <View style={{ width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: hue(theme, color, "soft") }}><View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: hue(theme, color) }} /></View>;
}
function TableHeader({ theme, metric, context }: { theme: PluginTheme; metric: RowMetric; context: boolean }) {
  const cell = (label: string, width: number | undefined, active = false, flex?: number) => <Text numberOfLines={1} style={{ width, flex, textAlign: flex ? "left" : "right", color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: active ? "800" : "600" }}>{label}</Text>;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
    <View style={{ width: columns.rank + 20 + space.sm }} />{cell(t("secondaryStatsBreakdown.name"), undefined, false, 1.6)}<View style={{ flex: 1 }} />
    {cell(rowMetrics[metric].label, columns.value, true)}{cell(t("secondaryStatsBreakdown.share"), columns.share)}{cell(t("secondaryStatsBreakdown.successRate"), columns.rate)}{cell(t("secondaryStatsBreakdown.averagePerTurn"), columns.avg)}{cell(t("secondaryStatsBreakdown.toolsTurn"), columns.tools)}{cell(t("secondaryStatsBreakdown.code2"), columns.code)}{context ? cell(t("secondaryStatsBreakdown.context"), columns.context) : null}
  </View>;
}
function WideRow({ theme, row, rank, color, metric, max, total, kind, context }: { theme: PluginTheme; row: StatsBreakdownRow; rank: number; color: Hue; metric: RowMetric; max: number; total: number; kind: BreakdownDimension; context: boolean }) {
  const { colors } = theme, value = row[metric], rate = successRate(row), avg = averageTurnMs(row);
  const sub = kind === "models" || kind === "providers" ? vendorLabel(row.vendor) : t("secondaryStatsBreakdown.activeDays", { value1: row.activeDays });
  const figure = (text: string, width: number, color?: string, weight: "600" | "800" = "600") => <Text numberOfLines={1} style={{ width, textAlign: "right", color: color ?? colors.foreground, fontSize: fontSize.small, fontWeight: weight, fontVariant: ["tabular-nums"] }}>{text}</Text>;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 50, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
    <Text style={{ width: columns.rank, color: rank <= 3 ? hue(theme, color, "text") : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"], textAlign: "center" }}>{rank}</Text>
    <RowMark theme={theme} row={row} color={color} kind={kind} />
    <View style={{ flex: 1.6, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{row.label}</Text>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{sub}{row.running ? t("secondaryStatsBreakdown.running", { value1: row.running }) : ""}</Text>
    </View>
    <View style={{ flex: 1, minWidth: 60 }}><InlineBar value={value} max={max} color={hue(theme, color)} track={trackFor(theme)} height={8} /></View>
    {figure(rowMetrics[metric].format(value), columns.value, undefined, "800")}
    {figure(percent(total ? value / total : 0, total && value / total < 0.1 ? 1 : 0), columns.share, colors.foregroundMuted)}
    {figure(percent(rate, 1), columns.rate, rateHue(rate) ? hue(theme, rateHue(rate)!, "text") : undefined, "800")}
    {figure(avg ? shortHours(avg) : "—", columns.avg)}
    {figure(row.turns && row.toolCalls ? (row.toolCalls / row.turns).toFixed(1) : "—", columns.tools)}
    {figure(code(row), columns.code)}
    {context ? figure(row.contextMax ? percent(row.contextUsed! / row.contextMax) : "—", columns.context, colors.foregroundMuted) : null}
  </View>;
}

const medals: ReadonlyArray<readonly [Hue, Hue]> = [["amber", "orange"], ["gray", "sky"], ["orange", "red"]];
/** Top three as gradient podium cards. */
function Podium({ theme, rows, colors, metric, total, compact }: { theme: PluginTheme; rows: readonly StatsBreakdownRow[]; colors: Map<string, Hue>; metric: RowMetric; total: number; compact: boolean }) {
  const top = rows.filter(row => row.key !== "__other__" && row.key !== "unknown" && row[metric] > 0).slice(0, 3);
  if (top.length < 2) return null;
  return <View style={{ flexDirection: "row", gap: space.sm }}>
    {top.map((row, index) => { const color = colors.get(row.key) ?? "violet", next: Hue = color === "gray" ? "violet" : color;
      return <View key={row.key} style={[{ flex: 1, minWidth: 0, borderRadius: 14, padding: compact ? space.sm + 2 : space.md, gap: 4 }, gradient(theme, [next, withAlpha(hue(theme, next), 0.55)], { angle: 150 })]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={[{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: withAlpha("#ffffff", 0.7) }, gradient(theme, medals[index]!, { angle: 135 })]}>
            <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "900" }}>{index + 1}</Text>
          </View>
          {compact ? null : <Text numberOfLines={1} style={{ flex: 1, color: withAlpha("#ffffff", 0.85), fontSize: 11, fontWeight: "700" }}>{row.vendor ? vendorLabel(row.vendor) : t("secondaryStatsBreakdown.activeDays", { value1: row.activeDays })}</Text>}
        </View>
        <Text numberOfLines={compact ? 2 : 1} style={{ color: "#ffffff", fontSize: compact ? fontSize.small : fontSize.body, fontWeight: "800", lineHeight: compact ? 17 : 20 }}>{row.label}</Text>
        <View style={{ flex: 1 }} />
        <Text numberOfLines={1} style={{ color: "#ffffff", fontSize: compact ? fontSize.title : 22, fontWeight: "900", fontVariant: ["tabular-nums"] }}>{rowMetrics[metric].format(row[metric])}</Text>
        <Text numberOfLines={1} style={{ color: withAlpha("#ffffff", 0.85), fontSize: 11, fontWeight: "700" }}>{t("secondaryStatsBreakdown.share2", { value1: percent(total ? row[metric] / total : 0) })}</Text>
      </View>; })}
  </View>;
}

function BreakdownRow({ theme, row, rank, color, metric, max, total, kind, compact }: { theme: PluginTheme; row: StatsBreakdownRow; rank: number; color: Hue; metric: RowMetric; max: number; total: number; kind: BreakdownDimension; compact: boolean }) {
  const { colors } = theme, value = row[metric], rate = successRate(row), avg = averageTurnMs(row);
  const mark = <RowMark theme={theme} row={row} color={color} kind={kind} />;
  const sub = kind === "models" || kind === "providers" ? vendorLabel(row.vendor) : t("secondaryStatsBreakdown.activeDays", { value1: row.activeDays });
  return <View style={{ paddingVertical: 10, gap: 6, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Text style={{ width: 20, color: rank <= 3 ? hue(theme, color, "text") : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"], textAlign: "center" }}>{rank}</Text>
      {mark}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{row.label}</Text>
        <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{sub}{row.running ? t("secondaryStatsBreakdown.running", { value1: row.running }) : ""}</Text>
      </View>
      {!compact ? <View style={{ width: "26%" }}><InlineBar value={value} max={max} color={hue(theme, color)} track={trackFor(theme)} height={7} /></View> : null}
      <Text style={{ width: compact ? undefined : 76, color: colors.foreground, fontSize: fontSize.body, fontWeight: "800", textAlign: "right", fontVariant: ["tabular-nums"] }}>{rowMetrics[metric].format(value)}</Text>
      <Text style={{ width: 48, color: colors.foregroundMuted, fontSize: fontSize.meta, textAlign: "right", fontVariant: ["tabular-nums"] }}>{percent(total ? value / total : 0, total && value / total < 0.1 ? 1 : 0)}</Text>
    </View>
    {compact ? <View style={{ marginLeft: 28 + space.sm * 2 }}><InlineBar value={value} max={max} color={hue(theme, color)} track={trackFor(theme)} height={6} /></View> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, marginLeft: 28 + space.sm * 2 }}>
      <Stat theme={theme} label={t("secondaryStatsBreakdown.successRate")} value={percent(rate, 1)} color={rateHue(rate)} />
      <Stat theme={theme} label={t("secondaryStatsBreakdown.averagePerTurn")} value={avg ? shortHours(avg) : "—"} />
      <Stat theme={theme} label={t("secondaryStatsBreakdown.toolsTurn")} value={row.turns && row.toolCalls ? (row.toolCalls / row.turns).toFixed(1) : "—"} />
      <Stat theme={theme} label={t("secondaryStatsBreakdown.code")} value={code(row)} />
      {kind !== "projects" && row.contextMax ? <Stat theme={theme} label={t("secondaryStatsBreakdown.context")} value={percent(row.contextUsed! / row.contextMax)} /> : null}
    </View>
  </View>;
}

function BreakdownTable({ theme, stats, kind, compact }: { theme: PluginTheme; stats: StatsSnapshot; kind: "models" | "vendors" | "providers" | "projects"; compact: boolean }) {
  const [metric, setMetric] = useState<RowMetric>("turns");
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(0);
  const source = stats[kind];
  // Rows only carry live counts when nothing happened in the range (a model idle this week); rank the active ones.
  const rows = useMemo(() => source.filter(row => row.sessions > 0 || row.turns > 0 || row.runMs > 0 || row.toolCalls > 0).sort((a, b) => b[metric] - a[metric] || b.sessions - a.sessions), [source, metric]);
  const colors = useMemo(() => rowHues(source, kind === "models" ? "model" : kind === "providers" ? "provider" : kind === "vendors" ? "vendor" : "project"), [source, kind]);
  const total = rows.reduce((sum, row) => sum + row[metric], 0), max = Math.max(1, ...rows.map(row => row[metric]));
  const look = dimensions.find(item => item.value === kind)!;
  const shown = expanded ? rows : rows.slice(0, 8);
  const wide = width >= 860, context = kind !== "projects" && rows.some(row => row.contextMax);
  return <Card theme={theme} title={t("secondaryStatsBreakdown.distribution", { value1: look.label })} icon={look.icon} color={look.tone} trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryStatsBreakdown.items", { value1: rows.filter(row => row.key !== "__other__").length })}</Text>}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.md }}>
      <Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel={t("secondaryStatsBreakdown.sortMetric")} options={(Object.keys(rowMetrics) as RowMetric[]).map(value => ({ value, label: rowMetrics[value].label }))} />
      <Podium theme={theme} rows={rows} colors={colors} metric={metric} total={total} compact={!wide && width < 560} />
      <CompositionBar track={trackFor(theme)} height={12} segments={rows.map(row => ({ key: row.key, value: row[metric], color: hue(theme, colors.get(row.key) ?? "gray") }))} />
    </View>
    {!rows.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{t("secondaryStatsBreakdown.noDataInThisRangeYet")}</Text>
      : wide ? <View><TableHeader theme={theme} metric={metric} context={context} />{shown.map((row, index) => <WideRow key={row.key} theme={theme} row={row} rank={index + 1} color={colors.get(row.key) ?? "gray"} metric={metric} max={max} total={total} kind={kind} context={context} />)}</View>
      : <View>{shown.map((row, index) => <BreakdownRow key={row.key} theme={theme} row={row} rank={index + 1} color={colors.get(row.key) ?? "gray"} metric={metric} max={max} total={total} kind={kind} compact={compact} />)}</View>}
    {rows.length > 8 ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.full }}>
      <Text style={{ color: hue(theme, look.tone, "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? t("secondaryStatsBreakdown.collapse") : t("secondaryStatsBreakdown.expandAllMore", { value1: rows.length - 8 })}</Text>
    </Pressable> : null}
  </Card>;
}

function ToolsView({ theme, stats, compact }: { theme: PluginTheme; stats: StatsSnapshot; compact: boolean }) {
  const kinds = stats.toolKinds, total = kinds.reduce((sum, kind) => sum + kind.calls, 0), max = Math.max(1, ...stats.tools.map(tool => tool.calls));
  const row = (tool: StatsTool, index: number) => { const look = kindLooks[tool.kind], rate = tool.calls ? tool.failures / tool.calls : 0;
    return <View key={`${tool.kind}:${tool.name}`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
      <Text style={{ width: 20, color: theme.colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "800", textAlign: "center" }}>{index + 1}</Text>
      <IconDisk theme={theme} icon={look.icon} colors={[look.hue]} size={22} />
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{tool.name}</Text>
      {!compact ? <View style={{ width: "30%" }}><InlineBar value={tool.calls} max={max} color={hue(theme, look.hue)} track={trackFor(theme)} /></View> : null}
      <Text style={{ width: 64, textAlign: "right", color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{bigNumber(tool.calls)}</Text>
      <Text style={{ width: 56, textAlign: "right", color: rate >= 0.05 ? hue(theme, "red", "text") : theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{tool.failures ? `✕ ${percent(rate, 1)}` : "—"}</Text>
    </View>; };
  return <>
    <Card theme={theme} title={t("secondaryStatsBreakdown.toolTypes")} icon="Shapes" color="teal" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryStatsBreakdown.calls", { count: bigNumber(total) })}</Text>}>
      <CompositionBar track={trackFor(theme)} height={12} segments={kinds.map(kind => ({ key: kind.kind, value: kind.calls, color: hue(theme, kindLooks[kind.kind].hue) }))} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        {kinds.map(kind => <View key={kind.kind} style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: compact ? "45%" : 150 }}>
          <IconDisk theme={theme} icon={kindLooks[kind.kind].icon} colors={[kindLooks[kind.kind].hue]} size={24} />
          <View><Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{kindLooks[kind.kind].label} <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "400" }}>{percent(total ? kind.calls / total : 0)}</Text></Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("secondaryStatsBreakdown.calls2", { count: bigNumber(kind.calls), value2: kind.failures ? t("secondaryStatsBreakdown.failed", { value1: bigNumber(kind.failures) }) : "" })}</Text></View>
        </View>)}
      </View>
    </Card>
    <Card theme={theme} title={t("secondaryStatsBreakdown.topTools")} icon="Wrench" color="cyan" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryStatsBreakdown.top", { value1: stats.tools.length })}</Text>}>
      {stats.tools.length ? <View>{stats.tools.map(row)}</View> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{t("secondaryStatsBreakdown.toolCallTrackingStartsAfterThe")}</Text>}
    </Card>
  </>;
}

function Summary({ theme, stats, compact }: { theme: PluginTheme; stats: StatsSnapshot; compact: boolean }) {
  const totals = stats.totals, avg = averageTurnMs(totals), par = stats.fleetDetails && stats.fleetDetails.concurrency !== "host" ? null : observedParallelism(stats.daily, totals.peakParallel);
  const items: Array<{ label: string; value: string; icon: string; colors: readonly [Hue, Hue] }> = [
    { label: t("secondaryStatsBreakdown.workingTime"), value: shortHours(totals.runMs), icon: "Timer", colors: ["pink", "orange"] },
    { label: t(stats.fleetDetails?.concurrency === "host_lower_bound" ? "fleet.hostTime" : "secondaryStatsBreakdown.parallelTime"), value: shortHours(totals.busyMs), icon: "Layers", colors: ["orange", "amber"] },
    { label: t("secondaryStatsBreakdown.averageConcurrency"), value: par ? `${par.toFixed(1)}×` : "—", icon: "Network", colors: ["violet", "fuchsia"] },
    { label: t("secondaryStatsBreakdown.averagePerTurn"), value: avg ? shortHours(avg) : "—", icon: "Hourglass", colors: ["blue", "cyan"] },
    { label: t("secondaryStatsBreakdown.messagesSession"), value: totals.sessions ? ((totals.userMessages + totals.assistantMessages) / totals.sessions).toFixed(1) : "—", icon: "MessagesSquare", colors: ["cyan", "teal"] },
    { label: t("secondaryStatsBreakdown.yourMessages"), value: bigNumber(totals.userMessages), icon: "User", colors: ["indigo", "violet"] },
    { label: t("secondaryStatsBreakdown.codeAddedRemoved"), value: `+${bigNumber(totals.linesAdded)} / −${bigNumber(totals.linesRemoved)}`, icon: "FileDiff", colors: ["green", "lime"] },
    { label: t("secondaryStatsBreakdown.approvalWait"), value: shortHours(totals.waitMs), icon: "Hand", colors: ["amber", "orange"] },
  ];
  return <Card theme={theme} title={t("secondaryStatsBreakdown.timeAndOutput")} icon="Gauge" color="pink">
    <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: space.md }}>
      {items.map(item => <View key={item.label} style={{ width: compact ? "50%" : "25%", flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.sm }}>
        <IconDisk theme={theme} icon={item.icon} colors={item.colors} size={30} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{item.label}</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{item.value}</Text>
        </View>
      </View>)}
    </View>
  </Card>;
}

/** 明细: ranked breakdown tables; 观测 keeps the original observation charts. */
export function StatsBreakdown({ theme, compact, stats, loading, error, range, onRange, onRefresh, dimension, onDimension, observed }: StatsViewProps & {
  dimension: BreakdownDimension; onDimension: (dimension: BreakdownDimension) => void; observed: ReactNode;
}) {
  const picker = <Segmented theme={theme} size="sm" value={dimension} onChange={onDimension} accessibilityLabel={t("secondaryStatsBreakdown.breakdownDimension")} options={dimensions.map(item => ({ value: item.value, label: item.label, icon: compact ? undefined : item.icon, tone: item.tone }))} />;
  if (dimension === "observed") return <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ paddingHorizontal: compact ? space.md : space.xl, paddingTop: space.md }}><ScrollView horizontal showsHorizontalScrollIndicator={false}>{picker}</ScrollView></View>
    {observed}
  </View>;
  const inset = compact ? space.md : space.xl;
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingTop: space.md, paddingBottom: space.xxl }}>
    <View style={{ gap: space.lg, width: "100%", maxWidth: 1180, alignSelf: "center" }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>{picker}</ScrollView>
      <StatsHeader theme={theme} compact={compact} stats={stats} range={range} onRange={onRange} />
      <StatsGate theme={theme} stats={stats} loading={loading} error={error} onRefresh={onRefresh}>{snapshot => <>
        {dimension === "tools" ? <ToolsView theme={theme} stats={snapshot} compact={compact} /> : <BreakdownTable key={dimension} theme={theme} stats={snapshot} kind={dimension} compact={compact} />}
        <Summary theme={theme} stats={snapshot} compact={compact} />
      </>}</StatsGate>
    </View>
  </ScrollView>;
}
