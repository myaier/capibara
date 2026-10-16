import { t } from "../shared/text";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { StatsBreakdownRow, StatsSnapshot } from "../shared/stats";
import { averageTurnMs, bigNumber, hasContent, percent, shortHours, successRate } from "../shared/stats-view";
import { IconButton, Segmented, Sheet, fontSize, gradient, hue, isDarkTheme, radius, space, withAlpha, type Hue } from "./kit";
import { Card, Radar } from "./charts";
import { ChoiceList } from "./ui";
import { StatsGate, StatsHeader, trackFor, vendorLabel, type StatsViewProps } from "./stats-common";

export type CompareDimension = "models" | "providers" | "vendors";
const sides: readonly [Hue, Hue] = ["pink", "cyan"];
interface Metric { key: string; label: string; value: (row: StatsBreakdownRow) => number | null; format: (value: number) => string; better: "high" | "low" | "none" }
const per = (a: number, b: number) => b > 0 ? a / b : null;
/** Content-derived figures read "—" for rows whose turns all predate content counting (not "0"). */
const counted = (row: StatsBreakdownRow, value: number | null) => hasContent(row) ? value : null;
const groups: Array<{ key: string; title: string; icon: string; metrics: Metric[] }> = [
  { key: "output", get title() { return t("secondaryStatsCompare.output"); }, icon: "Rocket", metrics: [
    { key: "sessions", get label() { return t("secondaryStatsCompare.sessions"); }, value: row => row.sessions, format: bigNumber, better: "high" },
    { key: "turns", get label() { return t("secondaryStatsCompare.turns"); }, value: row => row.turns, format: bigNumber, better: "high" },
    { key: "lines", get label() { return t("secondaryStatsCompare.linesAdded"); }, value: row => counted(row, row.linesAdded), format: bigNumber, better: "high" },
    { key: "files", get label() { return t("secondaryStatsCompare.filesChanged"); }, value: row => counted(row, row.filesChanged), format: bigNumber, better: "high" },
  ] },
  { key: "efficiency", get title() { return t("secondaryStatsCompare.efficiency"); }, icon: "Zap", metrics: [
    { key: "avg", get label() { return t("secondaryStatsCompare.averagePerTurn"); }, value: row => averageTurnMs(row), format: shortHours, better: "low" },
    { key: "linesPerTurn", get label() { return t("secondaryStatsCompare.linesOfCodeTurn"); }, value: row => counted(row, per(row.linesAdded, row.turns)), format: value => value.toFixed(1), better: "high" },
    { key: "toolsPerTurn", get label() { return t("secondaryStatsCompare.toolCallsTurn"); }, value: row => counted(row, per(row.toolCalls, row.turns)), format: value => value.toFixed(1), better: "none" },
    { key: "userPerTurn", get label() { return t("secondaryStatsCompare.yourMessagesTurn"); }, value: row => counted(row, per(row.userMessages, row.turns)), format: value => value.toFixed(2), better: "low" },
  ] },
  { key: "quality", get title() { return t("secondaryStatsCompare.quality"); }, icon: "ShieldCheck", metrics: [
    { key: "success", get label() { return t("secondaryStatsCompare.successRate"); }, value: row => successRate(row), format: value => percent(value, 1), better: "high" },
    { key: "toolFail", get label() { return t("secondaryStatsCompare.toolFailureRate"); }, value: row => per(row.toolFailures, row.toolCalls), format: value => percent(value, 1), better: "low" },
    { key: "errors", get label() { return t("secondaryStatsCompare.errorsTurns"); }, value: row => counted(row, per(row.errors * 100, row.turns)), format: value => value.toFixed(1), better: "low" },
  ] },
  { key: "effort", get title() { return t("secondaryStatsCompare.effort"); }, icon: "Coins", metrics: [
    { key: "run", get label() { return t("secondaryStatsCompare.workingTime"); }, value: row => row.runMs, format: shortHours, better: "none" },
    { key: "approvals", get label() { return t("secondaryStatsCompare.approvalsTurns"); }, value: row => per(row.approvals * 100, row.turns), format: value => value.toFixed(1), better: "low" },
    { key: "wait", get label() { return t("secondaryStatsCompare.waitingForYourApproval"); }, value: row => row.waitMs, format: shortHours, better: "low" },
    { key: "days", get label() { return t("secondaryStatsCompare.activeDays"); }, value: row => row.activeDays, format: value => t("secondaryStatsCompare.days", { count: value }), better: "high" },
  ] },
];
const titles: Array<{ key: string; label: string; icon: string; metric: string }> = [
  { key: "steady", get label() { return t("secondaryStatsCompare.moreReliable"); }, icon: "ShieldCheck", metric: "success" }, { key: "fast", get label() { return t("secondaryStatsCompare.faster"); }, icon: "Zap", metric: "avg" },
  { key: "prolific", get label() { return t("secondaryStatsCompare.moreProductive"); }, icon: "FileCode2", metric: "linesPerTurn" }, { key: "tools", get label() { return t("secondaryStatsCompare.moreReliableTools"); }, icon: "Wrench", metric: "toolFail" },
  { key: "easy", get label() { return t("secondaryStatsCompare.lessOversight"); }, icon: "Smile", metric: "approvals" }, { key: "busy", get label() { return t("secondaryStatsCompare.moreActive"); }, icon: "Flame", metric: "turns" },
];
/** The better side, or null when the metric has no direction or both sides read the same once formatted. */
function winner(metric: Metric, a: StatsBreakdownRow, b: StatsBreakdownRow): 0 | 1 | null {
  const left = metric.value(a), right = metric.value(b);
  if (metric.better === "none" || left === null || right === null || metric.format(left) === metric.format(right)) return null;
  return (metric.better === "high") === (left > right) ? 0 : 1;
}
/** Radar axes; each side scores its value relative to the better one (square-rooted so gaps stay readable). */
const radarAxes: Array<{ label: string; better: "high" | "low"; value: (row: StatsBreakdownRow) => number | null }> = [
  { get label() { return t("secondaryStatsCompare.output"); }, better: "high", value: row => counted(row, per(row.linesAdded, row.turns)) },
  { get label() { return t("secondaryStatsCompare.speed"); }, better: "low", value: row => averageTurnMs(row) },
  { get label() { return t("secondaryStatsCompare.reliability"); }, better: "low", value: row => { const rate = successRate(row); return rate === null ? null : 1 - rate; } },
  { get label() { return t("secondaryStatsCompare.autonomy"); }, better: "high", value: row => counted(row, per(row.toolCalls, row.userMessages)) },
  { get label() { return t("secondaryStatsCompare.lowOversight"); }, better: "low", value: row => per(row.approvals, row.turns) },
  { get label() { return t("secondaryStatsCompare.activity"); }, better: "high", value: row => row.turns },
];
function radarScore(axis: (typeof radarAxes)[number], row: StatsBreakdownRow, other: StatsBreakdownRow): number {
  const mine = axis.value(row), theirs = axis.value(other);
  if (mine === null) return 0.1;
  if (theirs === null) return 1;
  const ratio = axis.better === "high" ? Math.max(mine, theirs) > 0 ? mine / Math.max(mine, theirs) : 1 : mine > 0 ? Math.min(mine, theirs) / mine : 1;
  return 0.1 + 0.9 * Math.sqrt(ratio);
}
const allMetrics = groups.flatMap(group => group.metrics);

function Fighter({ theme, row, side, onPress }: { theme: PluginTheme; row: StatsBreakdownRow; side: 0 | 1; onPress: () => void }) {
  const color = sides[side];
  return <Pressable accessibilityRole="button" accessibilityLabel={t("secondaryStatsCompare.selectCurrently", { value1: side === 0 ? t("secondaryStatsCompare.left") : t("secondaryStatsCompare.right"), value2: row.label })} onPress={onPress}
    style={state => [{ flex: 1, minWidth: 0, borderRadius: 18, padding: space.md, gap: 4, opacity: state.pressed ? 0.8 : 1 }, gradient(theme, side === 0 ? [color, "fuchsia"] : ["blue", color], { angle: side === 0 ? 135 : 225 })]}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Text style={{ color: withAlpha("#ffffff", 0.85), fontSize: 11, fontWeight: "800" }}>{side === 0 ? "A" : "B"} · {vendorLabel(row.vendor)}</Text>
      <View style={{ flex: 1 }} /><Icon name="ChevronsUpDown" size={14} color="#ffffff" />
    </View>
    <Text numberOfLines={2} style={{ color: "#ffffff", fontSize: fontSize.title, fontWeight: "900", lineHeight: 21 }}>{row.label}</Text>
    <Text style={{ color: withAlpha("#ffffff", 0.85), fontSize: fontSize.meta }}>{t("secondaryStatsCompare.sessionsTurns", { value1: bigNumber(row.sessions), value2: bigNumber(row.turns) })}</Text>
  </Pressable>;
}

function DuelRow({ theme, metric, a, b }: { theme: PluginTheme; metric: Metric; a: StatsBreakdownRow; b: StatsBreakdownRow }) {
  const left = metric.value(a), right = metric.value(b), win = winner(metric, a, b);
  const max = Math.max(left ?? 0, right ?? 0, 1e-9);
  const bar = (value: number | null, side: 0 | 1) => <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: trackFor(theme), overflow: "hidden", flexDirection: side === 0 ? "row-reverse" : "row" }}>
    <View style={[{ width: `${value === null ? 0 : Math.max(value > 0 ? 4 : 0, value / max * 100)}%`, height: 8, borderRadius: 4, opacity: win === null || win === side ? 1 : 0.45 }, gradient(theme, side === 0 ? ["fuchsia", sides[0]] : [sides[1], "blue"], { angle: 90 })]} />
  </View>;
  const text = (value: number | null, side: 0 | 1) => <Text numberOfLines={1} style={{ width: 70, textAlign: side === 0 ? "left" : "right", color: win === side ? hue(theme, sides[side], "text") : theme.colors.foreground, fontSize: fontSize.small, fontWeight: win === side ? "900" : "600", fontVariant: ["tabular-nums"] }}>{value === null ? "—" : metric.format(value)}{win === side ? " ★" : ""}</Text>;
  return <View style={{ gap: 4, paddingVertical: 6 }}>
    <Text style={{ textAlign: "center", color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{metric.label}</Text>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>{text(left, 0)}{bar(left, 0)}{bar(right, 1)}{text(right, 1)}</View>
  </View>;
}

function Picker({ theme, open, rows, value, onChange, onClose, title }: { theme: PluginTheme; open: boolean; rows: StatsBreakdownRow[]; value: string; onChange: (key: string) => void; onClose: () => void; title: string }) {
  return <Sheet title={title} open={open} onClose={onClose}>
    <ChoiceList theme={theme} value={value} onChange={key => { onChange(key); onClose(); }} options={rows.map(row => ({ value: row.key, label: row.label, hint: t("secondaryStatsCompare.turnsSuccessRate", { value1: vendorLabel(row.vendor), value2: bigNumber(row.turns), value3: percent(successRate(row), 1) }), count: row.sessions }))} />
  </Sheet>;
}

const sideGradient = (side: 0 | 1): readonly Hue[] => side === 0 ? [sides[0], "fuchsia"] : ["blue", sides[1]];
function SideMark({ theme, side, size = 18 }: { theme: PluginTheme; side: 0 | 1; size?: number }) {
  return <View style={[{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: withAlpha("#ffffff", 0.75) }, gradient(theme, sideGradient(side), { angle: 135 })]}>
    <Text style={{ color: "#ffffff", fontSize: size * 0.55, fontWeight: "900" }}>{side === 0 ? "A" : "B"}</Text>
  </View>;
}
type Earned = (typeof titles)[number] & { side: 0 | 1 };

function RadarCard({ theme, a, b, wide, earned }: { theme: PluginTheme; a: StatsBreakdownRow; b: StatsBreakdownRow; wide: boolean; earned: readonly Earned[] }) {
  const legend = (row: StatsBreakdownRow, side: 0 | 1) => <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
    <SideMark theme={theme} side={side} />
    <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{row.label}</Text>
  </View>;
  return <Card theme={theme} title={t("secondaryStatsCompare.capabilityRadar")} icon="Radar" color="fuchsia">
    <View style={{ flexDirection: wide ? "row" : "column", alignItems: "center", gap: space.lg }}>
      <Radar theme={theme} size={wide ? 260 : 240} axes={radarAxes.map(axis => axis.label)} series={[
        { key: "a", color: hue(theme, sides[0]), values: radarAxes.map(axis => radarScore(axis, a, b)) },
        { key: "b", color: hue(theme, sides[1]), values: radarAxes.map(axis => radarScore(axis, b, a)) },
      ]} />
      <View style={{ flex: wide ? 1 : undefined, alignSelf: wide ? "center" : "stretch", gap: space.sm, minWidth: 0 }}>
        {legend(a, 0)}{legend(b, 1)}
        {earned.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs }}>
          {earned.map(title => <View key={title.key} accessibilityLabel={t("secondaryStatsCompare.message", { value1: title.label, value2: title.side === 0 ? a.label : b.label })} style={[{ flexDirection: "row", alignItems: "center", gap: 5, height: 30, paddingLeft: 4, paddingRight: 11, borderRadius: radius.full }, gradient(theme, sideGradient(title.side), { angle: 120 })]}>
            <SideMark theme={theme} side={title.side} size={22} />
            <Icon name={title.icon} size={13} color="#ffffff" />
            <Text numberOfLines={1} style={{ color: "#ffffff", fontSize: fontSize.small, fontWeight: "800" }}>{title.label}</Text>
          </View>)}
        </View> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>{t("secondaryStatsCompare.fartherOutIsBetterOutputMeasures")}</Text>
      </View>
    </View>
  </Card>;
}

function Duel({ theme, stats, dimension, wide }: { theme: PluginTheme; stats: StatsSnapshot; dimension: CompareDimension; wide: boolean }) {
  const rows = useMemo(() => stats[dimension].filter(row => row.key !== "__other__" && row.key !== "unknown" && (row.turns > 0 || row.sessions > 0)).sort((x, y) => y.turns - x.turns || y.sessions - x.sessions), [stats, dimension]);
  const [pair, setPair] = useState<[string, string] | null>(null);
  const [picking, setPicking] = useState<0 | 1 | null>(null);
  useEffect(() => { setPair(null); }, [dimension]);
  const keys: [string, string] | null = pair && rows.some(row => row.key === pair[0]) && rows.some(row => row.key === pair[1]) ? pair : rows.length >= 2 ? [rows[0]!.key, rows[1]!.key] : null;
  if (!keys) return <Card theme={theme} title={t("secondaryStatsCompare.comparison")} icon="Swords" color="fuchsia"><Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{t("secondaryStatsCompare.atLeastTwoWithDataAre", { value1: dimension === "models" ? t("secondaryStatsCompare.models") : dimension === "providers" ? t("secondaryStatsCompare.harnessNoun") : t("secondaryStatsCompare.vendors") })}</Text></Card>;
  const a = rows.find(row => row.key === keys[0])!, b = rows.find(row => row.key === keys[1])!;
  const wins = allMetrics.reduce((score, metric) => { const w = winner(metric, a, b); if (w !== null) score[w]++; return score; }, [0, 0]);
  const earned = titles.map(title => ({ ...title, side: winner(allMetrics.find(metric => metric.key === title.metric)!, a, b) })).filter((title): title is Earned => title.side !== null);
  return <>
    <View style={{ flexDirection: "row", alignItems: "stretch", gap: space.sm }}>
      <Fighter theme={theme} row={a} side={0} onPress={() => setPicking(0)} />
      <View style={{ alignItems: "center", justifyContent: "center", gap: 6 }}>
        <View style={[{ width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" }, gradient(theme, ["amber", "orange"], { angle: 135 })]}><Text style={{ color: "#ffffff", fontSize: fontSize.title, fontWeight: "900", fontStyle: "italic" }}>{t("secondaryStatsCompare.vs")}</Text></View>
        <Text style={{ color: theme.colors.foreground, fontSize: fontSize.title, fontWeight: "900", fontVariant: ["tabular-nums"] }}><Text style={{ color: hue(theme, sides[0], "text") }}>{wins[0]}</Text> : <Text style={{ color: hue(theme, sides[1], "text") }}>{wins[1]}</Text></Text>
        <IconButton theme={theme} icon="ArrowLeftRight" label={t("secondaryStatsCompare.swapSides")} size="sm" onPress={() => setPair([keys[1], keys[0]])} />
      </View>
      <Fighter theme={theme} row={b} side={1} onPress={() => setPicking(1)} />
    </View>
    <RadarCard theme={theme} a={a} b={b} wide={wide} earned={earned} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
      {groups.map(group => <Card key={group.key} theme={theme} title={group.title} icon={group.icon} color={group.key === "quality" ? "green" : group.key === "efficiency" ? "amber" : group.key === "output" ? "violet" : "blue"} style={{ flexGrow: 1, flexBasis: wide ? 360 : "100%", minWidth: 0 }}>
        <View>{group.metrics.map(metric => <DuelRow key={metric.key} theme={theme} metric={metric} a={a} b={b} />)}</View>
      </Card>)}
    </View>
    <Picker theme={theme} open={picking !== null} title={picking === 0 ? t("secondaryStatsCompare.selectA") : t("secondaryStatsCompare.selectB")} rows={rows.filter(row => row.key !== keys[picking === 0 ? 1 : 0])} value={picking === null ? "" : keys[picking]}
      onChange={key => setPair(picking === 0 ? [key, keys[1]] : [keys[0], key])} onClose={() => setPicking(null)} />
  </>;
}

/** 横评: head-to-head comparison of two models / harnesses / vendors over the selected range. */
export function StatsCompare({ theme, compact, stats, loading, error, range, onRange, onRefresh }: StatsViewProps) {
  const [dimension, setDimension] = useState<CompareDimension>("models");
  const [width, setWidth] = useState(0);
  const inset = compact ? space.md : space.xl;
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingTop: space.md, paddingBottom: space.xxl }}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.lg, width: "100%", maxWidth: 1080, alignSelf: "center" }}>
      <StatsHeader theme={theme} compact={compact} stats={stats} range={range} onRange={onRange} extra={<Segmented theme={theme} size="sm" value={dimension} onChange={setDimension} accessibilityLabel={t("secondaryStatsCompare.comparisonDimension")}
        options={[{ value: "models", label: t("secondaryStatsCompare.models"), tone: "cyan" }, { value: "providers", label: t("secondaryStatsCompare.harness"), tone: "violet" }, { value: "vendors", label: t("secondaryStatsCompare.vendors"), tone: "orange" }]} />} />
      <StatsGate theme={theme} stats={stats} loading={loading} error={error} onRefresh={onRefresh}>{snapshot => <Duel theme={theme} stats={snapshot} dimension={dimension} wide={width >= 760} />}</StatsGate>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, textAlign: "center", opacity: isDarkTheme(theme) ? 0.8 : 1 }}>{t("secondaryStatsCompare.marksTheBetterResultWorkingTime")}</Text>
    </View>
  </ScrollView>;
}
