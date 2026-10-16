import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { STATS_RANGES, vendorNames, type StatsBreakdownRow, type StatsRange, type StatsSnapshot } from "../shared/stats";
import { Banner, EmptyState, Segmented, Skeleton, Spacer, fontSize, gradient, hue, hueFor, isDarkTheme, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { InfoButton } from "./ui";

export const rangeOptions = STATS_RANGES.map(value => ({ value, get label() { return value === "7d" ? t("secondaryStatsCommon.days") : value === "30d" ? t("secondaryStatsCommon.days2") : t("secondaryStatsCommon.days3"); } }));
export interface StatsViewProps {
  theme: PluginTheme; compact: boolean; stats?: StatsSnapshot; loading: boolean; error?: string;
  range: StatsRange; onRange: (range: StatsRange) => void; onRefresh: () => void;
}

/** Vendor brand-ish colours; a vendor's second and third models take neighbouring hues. */
const vendorHues: Record<string, readonly Hue[]> = {
  anthropic: ["orange", "amber", "red"], openai: ["green", "teal", "lime"], google: ["blue", "sky", "cyan"], xai: ["violet", "fuchsia", "indigo"],
  moonshot: ["indigo", "violet", "blue"], deepseek: ["sky", "blue", "cyan"], bytedance: ["cyan", "teal", "sky"], alibaba: ["amber", "orange", "lime"],
  zhipu: ["teal", "green", "cyan"], other: ["pink", "fuchsia", "gray"],
};
export const vendorHue = (vendor: string | null | undefined): Hue => (vendorHues[vendor ?? "other"] ?? vendorHues.other!)[0]!;
/** Colour per breakdown row: vendor families for models / harnesses / vendors, the shared project hue for projects. */
export function rowHues(rows: readonly StatsBreakdownRow[], kind: "model" | "provider" | "vendor" | "project"): Map<string, Hue> {
  const used = new Map<string, number>(), result = new Map<string, Hue>();
  for (const row of rows) {
    if (row.key === "__other__" || row.key === "unknown") { result.set(row.key, "gray"); continue; }
    if (kind === "project") { result.set(row.key, hueFor(row.label)); continue; }
    const family = vendorHues[row.vendor ?? "other"] ?? vendorHues.other!, index = used.get(row.vendor ?? "other") ?? 0;
    used.set(row.vendor ?? "other", index + 1);
    result.set(row.key, family[index % family.length]!);
  }
  return result;
}
export const vendorLabel = (vendor: string | null | undefined) => vendorNames[vendor ?? "other"] ?? vendor ?? t("secondaryStatsCommon.other");

/** A small filled disk with a white icon — the dashboards' marker for a metric or record. */
export function IconDisk({ theme, icon, colors, size = 28 }: { theme: PluginTheme; icon: string; colors: readonly [Hue, Hue] | readonly [Hue]; size?: number }) {
  return <View style={[{ width: size, height: size, borderRadius: size / 2.6, alignItems: "center", justifyContent: "center" }, gradient(theme, colors.length > 1 ? colors : [colors[0], colors[0]], { angle: 135 })]}>
    <Icon name={icon} size={Math.round(size * 0.55)} color="#ffffff" />
  </View>;
}

/** Range picker + freshness line + ⓘ, shared by 看板 / 明细 / 横评 / Token (`generatedAt` and `info` override the statistics defaults). */
export function StatsHeader({ theme, compact, stats, range, onRange, extra, generatedAt, info, infoTitle = t("secondaryStatsCommon.aboutStatistics") }: {
  theme: PluginTheme; compact: boolean; stats?: StatsSnapshot; range: StatsRange; onRange: (range: StatsRange) => void; extra?: ReactNode;
  generatedAt?: string; info?: readonly string[]; infoTitle?: string;
}) {
  const updated = generatedAt ?? stats?.generatedAt;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
    <Segmented theme={theme} size="sm" value={range} onChange={onRange} accessibilityLabel={t("secondaryStatsCommon.statisticsRange")} options={rangeOptions} />
    {extra}
    <Spacer />
    {updated && !compact ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryStatsCommon.updated", { value1: relativeTime(updated) })}</Text> : null}
    <InfoButton theme={theme} title={infoTitle} lines={info ?? [
      t("secondaryStatsCommon.sessionCountsIncludeAllPaseoSessions"),
      stats?.observedSince ? t("secondaryStatsCommon.thePluginHasTrackedTurnsDuration", { value1: new Date(stats.observedSince).toLocaleDateString(currentLanguage()) }) : t("secondaryStatsCommon.turnsDurationAndConcurrencyAccumulateFrom"),
      stats?.contentSince ? t("secondaryStatsCommon.messagesToolCallsAndLinesOf", { value1: new Date(stats.contentSince).toLocaleDateString(currentLanguage()) }) : t("secondaryStatsCommon.messageToolCallAndCodeLine"),
      t("secondaryStatsCommon.codeLineCountsAreEstimatedFrom"),
      t("secondaryStatsCommon.successRateCompletedCompletedFailedTurns"),
      t("secondaryStatsCommon.periodComparisonsUseTheImmediatelyPreceding"),
    ]} />
  </View>;
}

/** Loading / error / empty wrapper for statistics pages. */
export function StatsGate({ theme, stats, loading, error, onRefresh, children }: { theme: PluginTheme; stats?: StatsSnapshot; loading: boolean; error?: string; onRefresh: () => void; children: (stats: StatsSnapshot) => ReactNode }) {
  if (!stats) return loading ? <Skeleton theme={theme} rows={6} />
    : <EmptyState theme={theme} icon={error ? "WifiOff" : "ChartNoAxesCombined"} tone={error ? "danger" : "violet"} title={error ? t("secondaryStatsCommon.statisticsAreTemporarilyUnavailable") : t("secondaryStatsCommon.noStatisticsYet")} message={error ?? t("secondaryStatsCommon.sendOutAnAgentToStart")} action={{ label: t("secondaryStatsCommon.retry"), onPress: onRefresh, icon: "RefreshCw" }} />;
  return <>{error ? <Banner theme={theme} tone="warning" message={t("secondaryStatsCommon.statisticsSyncFailedShowingThePrevious", { value1: error })} action={{ label: t("secondaryStatsCommon.retry"), onPress: onRefresh }} /> : null}{stats.fleetDetails?.filtered ? <Banner theme={theme} message={t("fleet.filteredHistory")} /> : stats.fleetDetails?.concurrency === "host_lower_bound" ? <Banner theme={theme} message={t("fleet.historicalBasis")} /> : null}{children(stats)}</>;
}

/** Frosted pill used on gradient heroes. */
export function GlassPill({ label, value, icon, onPress, mark }: { label: string; value?: string | number; icon?: string; onPress?: () => void; mark?: ReactNode }) {
  const body = <>
    {mark ?? (icon ? <Icon name={icon} size={13} color="#ffffff" /> : null)}
    <Text style={{ color: "#ffffff", fontSize: fontSize.small, fontWeight: "600" }}>{label}</Text>
    {value !== undefined ? <Text style={{ color: "#ffffff", fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{value}</Text> : null}
  </>;
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, minHeight: 30, paddingHorizontal: 11, borderRadius: radius.full, backgroundColor: withAlpha("#ffffff", 0.18), borderWidth: 1, borderColor: withAlpha("#ffffff", 0.28) };
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={value === undefined ? label : `${label} ${value}`} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }} style={state => [style, { opacity: state.pressed ? 0.75 : 1 }]}>{body}</Pressable> : <View style={style}>{body}</View>;
}

export const surfaceFor = (theme: PluginTheme) => isDarkTheme(theme) ? theme.colors.surface1 : theme.colors.surface0;
export const trackFor = (theme: PluginTheme) => isDarkTheme(theme) ? withAlpha("#ffffff", 0.08) : withAlpha("#000000", 0.06);
export const hueText = (theme: PluginTheme, name: Hue) => hue(theme, name, "text");
