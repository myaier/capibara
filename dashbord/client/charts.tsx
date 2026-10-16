import { onTextChange } from "../shared/i18n";
import { t } from "../shared/text";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type LayoutChangeEvent, type TextStyle, type ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { fontSize, gradient, hairline, hue, isDarkTheme, radius, space, withAlpha, type Hue } from "./kit";
import { Grow } from "./motion";

/**
 * View-only charts (no SVG in plugins): bars, rotated line segments, CSS-free rings and grids. They work the same on
 * native and web, animate in once with `Grow`, and never re-render on a timer.
 */
const useWidth = () => { const [width, setWidth] = useState(0); return { width, onLayout: (event: LayoutChangeEvent) => setWidth(Math.round(event.nativeEvent.layout.width)) }; };
const axisText = (theme: PluginTheme): TextStyle => ({ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] });

/** Up/down change against the previous period; `invert` for metrics where less is better (failures, waiting). */
export function DeltaChip({ theme, current, previous, invert = false, size = "sm" }: { theme: PluginTheme; current: number; previous: number; invert?: boolean; size?: "sm" | "md" }) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || (current === 0 && previous === 0)) return null;
  const up = current >= previous, good = invert ? !up : up;
  const change = previous === 0 ? null : Math.abs(current - previous) / previous;
  const label = change === null ? t("coreCharts.new") : change < 0.001 ? t("coreCharts.unchanged") : `${(change * 100).toFixed(change >= 0.1 ? 0 : 1)}%`;
  const color = change !== null && change < 0.001 ? theme.colors.foregroundMuted : hue(theme, good ? "green" : "red", "text");
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", paddingHorizontal: 5, height: size === "sm" ? 18 : 22, borderRadius: radius.full, backgroundColor: withAlpha(color, 0.14) }}>
    {change === null || change >= 0.001 ? <Icon name={up ? "TrendingUp" : "TrendingDown"} size={size === "sm" ? 11 : 13} color={color} /> : null}
    <Text style={{ color, fontSize: size === "sm" ? 11 : fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{label}</Text>
  </View>;
}

/** Mini column chart for KPI tiles; the last (current) column is emphasised. */
export const Sparkline = memo(function Sparkline({ values, color, height = 26, muted }: { values: readonly number[]; color: string; height?: number; muted: string }) {
  const peak = Math.max(1, ...values);
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height }}>
    {values.map((value, index) => <View key={index} style={{ flex: 1, height: value > 0 ? Math.max(3, value / peak * height) : 2, borderRadius: 2, backgroundColor: value > 0 ? color : muted, opacity: value > 0 ? index === values.length - 1 ? 1 : 0.55 : 0.35 }} />)}
  </View>;
});

/** Donut ring from rotated half-rings clipped to half planes; `segments` sweep clockwise from 12 o'clock. */
export function Donut({ size, stroke, segments, track, gap = 0, children }: { size: number; stroke: number; segments: readonly { value: number; color: string }[]; track: string; gap?: number; children?: ReactNode }) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const arcs: Array<{ start: number; sweep: number; color: string }> = [];
  let angle = 0;
  for (const segment of segments) {
    const sweep = total > 0 ? Math.max(0, segment.value) / total * 360 : 0;
    const visible = Math.max(0, sweep - (segments.length > 1 ? gap : 0));
    for (let offset = 0; offset < visible - 0.01; offset += 180) arcs.push({ start: angle + offset, sweep: Math.min(180, visible - offset), color: segment.color });
    angle += sweep;
  }
  const ring: ViewStyle = { position: "absolute", left: 0, top: 0, width: size, height: size, borderRadius: size / 2, borderWidth: stroke };
  return <View style={{ width: size, height: size }}>
    <View style={[ring, { borderColor: track }]} />
    {arcs.map((arc, index) => <View key={index} style={{ position: "absolute", left: 0, top: 0, width: size, height: size, transform: [{ rotate: `${arc.start}deg` }] }}>
      <View style={{ position: "absolute", left: size / 2, top: 0, width: size / 2, height: size, overflow: "hidden" }}>
        <View style={[ring, { left: -size / 2, borderTopColor: arc.color, borderRightColor: arc.color, borderBottomColor: "transparent", borderLeftColor: "transparent", transform: [{ rotate: `${45 + arc.sweep - 180}deg` }] }]} />
      </View>
    </View>)}
    {children ? <View style={{ position: "absolute", left: 0, top: 0, width: size, height: size, alignItems: "center", justifyContent: "center" }}>{children}</View> : null}
  </View>;
}
export function Ring({ size, stroke, progress, color, track, children }: { size: number; stroke: number; progress: number; color: string; track: string; children?: ReactNode }) {
  const value = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return <Donut size={size} stroke={stroke} track={track} segments={[{ value, color }, { value: 1 - value, color: "transparent" }]}>{children}</Donut>;
}

/** Stacked horizontal share bar. */
export function CompositionBar({ segments, height = 10, track }: { segments: readonly { key: string; value: number; color: string }[]; height?: number; track: string }) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  return <View style={{ flexDirection: "row", height, borderRadius: height / 2, overflow: "hidden", backgroundColor: track, gap: total ? 2 : 0 }}>
    {total ? segments.filter(segment => segment.value > 0).map(segment => <Grow key={segment.key} axis="x" style={{ flexGrow: segment.value / total, flexBasis: 0, minWidth: 3, backgroundColor: segment.color }} />) : null}
  </View>;
}

/** A thin value bar used in breakdown rows. */
export function InlineBar({ value, max, color, track, height = 6 }: { value: number; max: number; color: string; track: string; height?: number }) {
  return <View style={{ height, borderRadius: height / 2, backgroundColor: track, overflow: "hidden" }}>
    <Grow axis="x" style={{ height, width: `${Math.max(value > 0 ? 3 : 0, Math.min(100, max > 0 ? value / max * 100 : 0))}%`, borderRadius: height / 2, backgroundColor: color }} />
  </View>;
}

/** Straight segment between two points, drawn as a rotated View centred on its midpoint. */
function Segment({ x1, y1, x2, y2, color, width = 2, dashed = false }: { x1: number; y1: number; x2: number; y2: number; color: string; width?: number; dashed?: boolean }) {
  const length = Math.hypot(x2 - x1, y2 - y1), angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
  if (dashed) {
    const dots = Math.max(1, Math.floor(length / 6));
    return <>{Array.from({ length: dots }, (_, index) => { const t = (index + 0.5) / dots; return <View key={index} style={{ position: "absolute", left: x1 + (x2 - x1) * t - 1.5, top: y1 + (y2 - y1) * t - 1.5, width: 3, height: 3, borderRadius: 1.5, backgroundColor: color }} />; })}</>;
  }
  return <View style={{ position: "absolute", left: (x1 + x2) / 2 - length / 2, top: (y1 + y2) / 2 - width / 2, width: length, height: width, borderRadius: width / 2, backgroundColor: color, transform: [{ rotate: `${angle}deg` }] }} />;
}

export interface TrendPoint { label: string; value: number; detail?: string }
/**
 * Daily trend: gradient bars, a 7-day moving-average line and an optional dotted forecast. Tap a column
 * for its value. `format` renders axis and detail values.
 */
export function TrendChart({ theme, points, color, lineColor, forecast = [], height = 168, format, average = true }: {
  theme: PluginTheme; points: readonly TrendPoint[]; color: Hue; lineColor?: string; forecast?: readonly TrendPoint[]; height?: number; format: (value: number) => string; average?: boolean;
}) {
  const { width, onLayout } = useWidth();
  const [selected, setSelected] = useState<number | null>(null);
  const all = [...points, ...forecast], n = all.length;
  const averages = useMemo(() => points.map((_, index) => { const window = points.slice(Math.max(0, index - 6), index + 1); return window.reduce((sum, point) => sum + point.value, 0) / window.length; }), [points]);
  const peak = Math.max(1, ...all.map(point => point.value), ...averages);
  const top = 18, plot = height - top - 20, axisWidth = 40, chartWidth = Math.max(0, width - axisWidth), column = n ? chartWidth / n : 0;
  const barWidth = Math.max(3, Math.min(18, column * 0.58));
  const y = (value: number) => top + plot - value / peak * plot;
  const x = (index: number) => axisWidth + column * index + column / 2;
  const line = lineColor ?? hue(theme, color === "pink" ? "violet" : "pink");
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(chartWidth / 52))));
  const shown = selected ?? points.length - 1, active = all[shown];
  return <View onLayout={onLayout} style={{ gap: space.xs }}>
    <View style={{ height }}>
      {[0, 0.5, 1].map(step => <View key={step} style={{ position: "absolute", left: axisWidth, right: 0, top: y(peak * step), height: hairline, backgroundColor: theme.colors.border, opacity: step === 0 ? 1 : 0.6 }} />)}
      {[0, 0.5, 1].filter(step => step === 0 || format(peak * step) !== format(peak * (step - 0.5))).map(step => <Text key={step} style={[axisText(theme), { position: "absolute", left: 0, width: axisWidth - 6, textAlign: "right", top: y(peak * step) - 7 }]}>{format(peak * step)}</Text>)}
      {width > 0 ? all.map((point, index) => {
        const future = index >= points.length, barHeight = point.value > 0 ? Math.max(3, point.value / peak * plot) : 0;
        return <Pressable key={index} accessibilityRole="button" accessibilityLabel={t("coreCharts.pointDescription", { label: point.label, value: format(point.value), projection: future ? t("coreCharts.projected") : "" })} onPress={() => setSelected(index)}
          style={{ position: "absolute", left: axisWidth + column * index, width: column, top, height: plot, alignItems: "center", justifyContent: "flex-end", backgroundColor: index === shown ? withAlpha(hue(theme, color), 0.08) : "transparent", borderRadius: radius.sm }}>
          {barHeight ? <Grow delay={Math.min(index, 40) * 12} style={[{ width: barWidth, height: barHeight, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
            future ? { borderWidth: 1, borderStyle: "dashed", borderColor: hue(theme, color), backgroundColor: withAlpha(hue(theme, color), 0.12) } : gradient(theme, [hue(theme, color), withAlpha(hue(theme, color), 0.35)], { angle: 180 })]} /> : null}
        </Pressable>;
      }) : null}
      {width > 0 && average && points.length > 1 ? averages.slice(1).map((value, index) => <Segment key={index} x1={x(index)} y1={y(averages[index]!)} x2={x(index + 1)} y2={y(value)} color={line} width={2.5} />) : null}
      {width > 0 && forecast.length ? forecast.map((point, index) => { const from = index === 0 ? { x: x(points.length - 1), y: y(averages.at(-1) ?? 0) } : { x: x(points.length + index - 1), y: y(forecast[index - 1]!.value) }; return <Segment key={index} x1={from.x} y1={from.y} x2={x(points.length + index)} y2={y(point.value)} color={line} dashed />; }) : null}
      {width > 0 && average ? averages.map((value, index) => index === shown ? <View key={index} style={{ position: "absolute", left: x(index) - 4, top: y(value) - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.surface0, borderWidth: 2, borderColor: line }} /> : null) : null}
      {width > 0 ? all.map((point, index) => index % labelEvery === (n - 1) % labelEvery ? <Text key={index} numberOfLines={1} style={[axisText(theme), { position: "absolute", top: top + plot + 4, left: x(index) - 26, width: 52, textAlign: "center", color: index === shown ? theme.colors.foreground : theme.colors.foregroundMuted }]}>{point.label}</Text> : null) : null}
    </View>
    {active ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: hue(theme, color) }} />
      <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{active.label}{shown >= points.length ? t("coreCharts.projected") : ""}</Text>
      <Text style={{ color: hue(theme, color, "text"), fontSize: fontSize.small, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{format(active.value)}</Text>
      {active.detail ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{active.detail}</Text> : null}
      {average && shown < points.length ? <><View style={{ width: 10, height: 2.5, borderRadius: 2, backgroundColor: line }} /><Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreCharts.value7DayAverage", { value1: format(averages[shown] ?? 0) })}</Text></> : null}
    </View> : null}
  </View>;
}

export interface StackedColumn { label: string; parts: readonly number[]; detail?: string }
/**
 * Stacked columns (bottom part first) with a value axis; tap a column for its breakdown. `highlight` marks one column
 * (the peak hour, today …); the default selection is the last column.
 */
export function StackedColumns({ theme, columns, colors, names, height = 150, format, highlight, labelEvery }: {
  theme: PluginTheme; columns: readonly StackedColumn[]; colors: readonly string[]; names: readonly string[]; height?: number; format: (value: number) => string; highlight?: number; labelEvery?: number;
}) {
  const { width, onLayout } = useWidth();
  const [selected, setSelected] = useState<number | null>(null);
  const totals = columns.map(column => column.parts.reduce((sum, part) => sum + part, 0)), peak = Math.max(1, ...totals);
  const axisWidth = 44, plot = Math.max(0, width - axisWidth), slot = columns.length ? plot / columns.length : 0;
  const barWidth = Math.max(2, Math.min(22, slot * 0.66)), every = labelEvery ?? Math.max(1, Math.ceil(columns.length / Math.max(2, Math.floor(plot / 46))));
  const shown = selected ?? columns.length - 1, active = columns[shown];
  return <View onLayout={onLayout} style={{ gap: space.xs }}>
    <View style={{ height: height + 18 }}>
      {[0, 0.5, 1].map(step => <View key={step} style={{ position: "absolute", left: axisWidth, right: 0, bottom: 18 + step * height, height: hairline, backgroundColor: theme.colors.border, opacity: step ? 0.6 : 1 }} />)}
      {[0.5, 1].map(step => <Text key={step} style={[axisText(theme), { position: "absolute", left: 0, width: axisWidth - 6, textAlign: "right", bottom: 18 + step * height - 7 }]}>{format(peak * step)}</Text>)}
      {width > 0 ? columns.map((column, index) => {
        let base = 0;
        return <Pressable key={index} accessibilityRole="button" accessibilityLabel={t("coreCharts.columnDescription", { label: column.label, value: format(totals[index]!) })} onPress={() => setSelected(index)}
          style={{ position: "absolute", left: axisWidth + index * slot, width: slot, bottom: 18, height, alignItems: "center", backgroundColor: index === shown ? withAlpha(theme.colors.foreground, 0.05) : "transparent", borderRadius: radius.sm }}>
          <Grow delay={Math.min(index, 40) * 10} style={{ position: "absolute", bottom: 0, width: barWidth, height: totals[index]! > 0 ? Math.max(2, totals[index]! / peak * height) : 0, borderTopLeftRadius: 3, borderTopRightRadius: 3, overflow: "hidden",
            ...(index === highlight ? { borderWidth: 1.5, borderColor: theme.colors.foreground } : {}) }}>
            {column.parts.map((part, partIndex) => { const h = totals[index]! > 0 ? part / totals[index]! * 100 : 0; const view = <View key={partIndex} style={{ position: "absolute", left: 0, right: 0, bottom: `${base}%`, height: `${h}%`, backgroundColor: colors[partIndex] }} />; base += h; return view; })}
          </Grow>
        </Pressable>;
      }) : null}
      {width > 0 ? columns.map((column, index) => (columns.length - 1 - index) % every === 0 ? <Text key={index} numberOfLines={1} style={[axisText(theme), { position: "absolute", bottom: 0, left: axisWidth + index * slot + slot / 2 - 24, width: 48, textAlign: "center", color: index === shown ? theme.colors.foreground : theme.colors.foregroundMuted }]}>{column.label}</Text> : null) : null}
    </View>
    {active ? <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: space.md, rowGap: 2 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{active.detail ?? active.label} <Text style={{ fontVariant: ["tabular-nums"] }}>{format(totals[shown]!)}</Text></Text>
      {active.parts.map((part, partIndex) => part > 0 ? <View key={partIndex} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colors[partIndex] }} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{names[partIndex]} {format(part)}</Text>
      </View> : null)}
    </View> : null}
  </View>;
}

let weekdayNames = [t("coreCharts.mon"), t("coreCharts.tue"), t("coreCharts.wed"), t("coreCharts.thu"), t("coreCharts.fri"), t("coreCharts.sat"), t("coreCharts.sun")];
const dayMs = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * dayMs).toISOString().slice(0, 10);
/** Four intensity tiers from the non-zero values (quartiles), so a single busy day does not wash out the rest. */
function tiers(values: readonly number[]): number[] {
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b);
  if (!sorted.length) return [1, 1, 1];
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return [at(0.25), at(0.5), at(0.75)];
}
const tierOf = (value: number, limits: readonly number[]) => value <= 0 ? 0 : value <= limits[0]! ? 1 : value <= limits[1]! ? 2 : value <= limits[2]! ? 3 : 4;
const tierAlpha = [0, 0.3, 0.52, 0.76, 1];

/** GitHub-style contribution calendar: Monday-first columns of weeks, the newest week on the right. */
export function CalendarHeatmap({ theme, start, values, secondary, color, maxWeeks = 53, onSelect, selected, describe }: {
  theme: PluginTheme; start: string; values: readonly number[]; secondary?: readonly number[]; color: Hue; maxWeeks?: number;
  onSelect?: (day: string) => void; selected?: string | null; describe: (day: string, value: number, extra?: number) => string;
}) {
  const { width, onLayout } = useWidth();
  const labelWidth = 18, gap = 3;
  const totalWeeks = Math.ceil(values.length / 7);
  const fit = width ? Math.max(8, Math.floor((width - labelWidth + gap) / 14)) : maxWeeks;
  const weeks = Math.min(totalWeeks, maxWeeks, fit);
  const firstWeek = totalWeeks - weeks;
  const cell = width ? Math.min(15, Math.floor((width - labelWidth - (weeks - 1) * gap) / weeks)) : 11;
  const limits = useMemo(() => tiers(values), [values]);
  const base = hue(theme, color), empty = isDarkTheme(theme) ? withAlpha("#ffffff", 0.06) : withAlpha("#000000", 0.05);
  const today = values.length - 1;
  const months: Array<{ week: number; label: string }> = [];
  for (let week = firstWeek; week < totalWeeks; week++) {
    const day = addDays(start, week * 7), month = Number(day.slice(5, 7));
    if (week !== firstWeek && Number(addDays(start, (week - 1) * 7).slice(5, 7)) === month) continue;
    // A month that starts right after the first column would overlap the partial first month's label.
    if (months.length && week - firstWeek - months.at(-1)!.week < 3) months.pop();
    months.push({ week: week - firstWeek, label: t("coreCharts.month", { value1: month }) });
  }
  return <View onLayout={onLayout} style={{ gap: 4 }}>
    <View style={{ height: 14, marginLeft: labelWidth }}>
      {width ? months.map(month => <Text key={month.week} numberOfLines={1} style={[axisText(theme), { position: "absolute", left: month.week * (cell + gap), width: 40 }]}>{month.label}</Text>) : null}
    </View>
    <View style={{ flexDirection: "row", gap }}>
      <View style={{ width: labelWidth - gap, gap }}>{weekdayNames.map((name, index) => <Text key={name} style={[axisText(theme), { height: cell, lineHeight: cell, fontSize: 10, opacity: index % 2 === 0 ? 1 : 0 }]}>{name}</Text>)}</View>
      {width ? Array.from({ length: weeks }, (_, offset) => { const week = firstWeek + offset; return <View key={week} style={{ gap }}>
        {Array.from({ length: 7 }, (_, weekday) => {
          const index = week * 7 + weekday;
          if (index > today) return <View key={weekday} style={{ width: cell, height: cell }} />;
          const value = values[index] ?? 0, tier = tierOf(value, limits), day = addDays(start, index), isSelected = selected === day;
          return <Pressable key={weekday} accessibilityRole="button" accessibilityLabel={describe(day, value, secondary?.[index])} onPress={() => onSelect?.(day)}
            style={{ width: cell, height: cell, borderRadius: Math.max(2, cell / 4), backgroundColor: tier ? withAlpha(base, tierAlpha[tier]!) : empty, borderWidth: isSelected || index === today ? 1.5 : 0, borderColor: isSelected ? theme.colors.foreground : base }} />;
        })}
      </View>; }) : null}
    </View>
  </View>;
}
export function HeatLegend({ theme, color, low = t("coreCharts.less"), high = t("coreCharts.more") }: { theme: PluginTheme; color: Hue; low?: string; high?: string }) {
  const base = hue(theme, color);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
    <Text style={[axisText(theme), { marginRight: 2 }]}>{low}</Text>
    {tierAlpha.map((alpha, index) => <View key={index} style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: index ? withAlpha(base, alpha) : isDarkTheme(theme) ? withAlpha("#ffffff", 0.06) : withAlpha("#000000", 0.05) }} />)}
    <Text style={[axisText(theme), { marginLeft: 2 }]}>{high}</Text>
  </View>;
}

/** Weekday × hour activity grid (index = weekday * 24 + hour), the busiest cell ringed. */
export function Punchcard({ theme, values, color, describe }: { theme: PluginTheme; values: readonly number[]; color: Hue; describe: (weekday: number, hour: number, value: number) => string }) {
  const { width, onLayout } = useWidth();
  const labelWidth = 18, gap = 2;
  const cell = width ? Math.max(6, Math.min(22, Math.floor((width - labelWidth - 23 * gap) / 24))) : 10;
  const limits = useMemo(() => tiers(values), [values]);
  const peak = values.reduce((best, value, index) => value > (values[best] ?? 0) ? index : best, 0);
  const base = hue(theme, color), empty = isDarkTheme(theme) ? withAlpha("#ffffff", 0.06) : withAlpha("#000000", 0.05);
  return <View onLayout={onLayout} style={{ gap: 3 }}>
    {width ? Array.from({ length: 7 }, (_, weekday) => <View key={weekday} style={{ flexDirection: "row", alignItems: "center", gap }}>
      <Text style={[axisText(theme), { width: labelWidth - gap, fontSize: 10 }]}>{weekdayNames[weekday]}</Text>
      {Array.from({ length: 24 }, (_, hour) => { const index = weekday * 24 + hour, value = values[index] ?? 0, tier = tierOf(value, limits);
        return <View key={hour} accessibilityLabel={describe(weekday, hour, value)} style={{ width: cell, height: cell, borderRadius: Math.max(2, cell / 4), backgroundColor: tier ? withAlpha(base, tierAlpha[tier]!) : empty, borderWidth: index === peak && value > 0 ? 1.5 : 0, borderColor: theme.colors.foreground }} />; })}
    </View>) : <View style={{ height: 7 * 13 }} />}
    <View style={{ flexDirection: "row", marginLeft: labelWidth }}>
      {[0, 6, 12, 18].map(hour => <Text key={hour} style={[axisText(theme), { position: "absolute", left: hour * (cell + gap) }]}>{String(hour).padStart(2, "0")}</Text>)}
    </View>
  </View>;
}

type Point = { x: number; y: number };
/**
 * Filled triangle from CSS borders: the longest side becomes a horizontal base (its altitude foot always lies on it),
 * then the box is rotated about the base start so the apex lands on the third vertex.
 */
function Triangle({ a, b, c, color }: { a: Point; b: Point; c: Point; color: string }) {
  const sides: Array<[Point, Point, Point]> = [[a, b, c], [b, c, a], [c, a, b]];
  let [p, q, apex] = sides.reduce((best, side) => Math.hypot(side[1].x - side[0].x, side[1].y - side[0].y) > Math.hypot(best[1].x - best[0].x, best[1].y - best[0].y) ? side : best);
  let angle = Math.atan2(q.y - p.y, q.x - p.x);
  // The apex must sit on the rotated "up" side of the base (−y before rotation); otherwise walk the base backwards.
  if ((apex.x - p.x) * Math.sin(angle) - (apex.y - p.y) * Math.cos(angle) < 0) { [p, q] = [q, p]; angle = Math.atan2(q.y - p.y, q.x - p.x); }
  const base = Math.hypot(q.x - p.x, q.y - p.y);
  if (base < 0.5) return null;
  const along = ((apex.x - p.x) * (q.x - p.x) + (apex.y - p.y) * (q.y - p.y)) / base, height = Math.abs(((q.x - p.x) * (apex.y - p.y) - (q.y - p.y) * (apex.x - p.x)) / base);
  if (height < 0.5) return null;
  return <View style={{ position: "absolute", left: p.x, top: p.y - height, width: 0, height: 0, borderStyle: "solid", borderLeftWidth: Math.max(0, along), borderRightWidth: Math.max(0, base - along), borderBottomWidth: height,
    borderLeftColor: "transparent", borderRightColor: "transparent", borderBottomColor: color, transformOrigin: "0% 100%", transform: [{ rotate: `${angle * 180 / Math.PI}deg` }] } as ViewStyle} />;
}

/** Radar (spider) chart; each series gives one 0–1 value per axis, drawn as a translucent polygon with a bright outline. */
export function Radar({ theme, axes, series, size = 240 }: { theme: PluginTheme; axes: readonly string[]; series: readonly { key: string; color: string; values: readonly number[] }[]; size?: number }) {
  const n = axes.length, pad = 36, radiusMax = size / 2 - pad, center = { x: size / 2, y: size / 2 };
  const at = (index: number, value: number): Point => { const angle = -Math.PI / 2 + index * 2 * Math.PI / n, r = radiusMax * Math.min(1, Math.max(0, value)); return { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r }; };
  const grid = isDarkTheme(theme) ? withAlpha("#ffffff", 0.12) : withAlpha("#000000", 0.1), dot = isDarkTheme(theme) ? theme.colors.surface1 : theme.colors.surface0;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
    {[0.25, 0.5, 0.75, 1].map(level => axes.map((_, index) => { const from = at(index, level), to = at((index + 1) % n, level); return <Segment key={`${level}:${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} color={grid} width={1} />; }))}
    {series.map(item => item.values.map((value, index) => <Triangle key={`${item.key}:fill:${index}`} a={center} b={at(index, value)} c={at((index + 1) % n, item.values[(index + 1) % n] ?? 0)} color={withAlpha(item.color, 0.2)} />))}
    {axes.map((_, index) => { const end = at(index, 1); return <Segment key={`spoke:${index}`} x1={center.x} y1={center.y} x2={end.x} y2={end.y} color={grid} width={1} />; })}
    {series.map(item => item.values.map((value, index) => { const from = at(index, value), to = at((index + 1) % n, item.values[(index + 1) % n] ?? 0); return <Segment key={`${item.key}:edge:${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} color={item.color} width={2.5} />; }))}
    {series.map(item => item.values.map((value, index) => { const point = at(index, value); return <View key={`${item.key}:dot:${index}`} style={{ position: "absolute", left: point.x - 4.5, top: point.y - 4.5, width: 9, height: 9, borderRadius: 4.5, backgroundColor: item.color, borderWidth: 2, borderColor: dot }} />; }))}
    {axes.map((label, index) => { const point = at(index, 1), angle = -Math.PI / 2 + index * 2 * Math.PI / n, x = point.x + Math.cos(angle) * 18, y = point.y + Math.sin(angle) * 14;
      return <Text key={`label:${index}`} numberOfLines={1} style={{ position: "absolute", left: x - 34, top: y - 8, width: 68, textAlign: "center", color: theme.colors.foreground, fontSize: 11, fontWeight: "700" }}>{label}</Text>; })}
  </View>;
}

/** Gradient-edged card used by the dashboards. */
export function Card({ theme, title, icon, color, trailing, children, padded = true, style }: {
  theme: PluginTheme; title?: string; icon?: string; color?: Hue; trailing?: ReactNode; children: ReactNode; padded?: boolean; style?: ViewStyle;
}) {
  const { colors } = theme, dark = isDarkTheme(theme);
  return <View style={[{ borderRadius: 16, borderWidth: hairline, borderColor: color ? withAlpha(hue(theme, color), dark ? 0.28 : 0.22) : colors.border, backgroundColor: dark ? colors.surface1 : colors.surface0, overflow: "hidden" }, style]}>
    {color ? <View style={[{ height: 3 }, gradient(theme, [color, color === "pink" ? "violet" : color === "violet" ? "blue" : color === "blue" ? "cyan" : color === "green" ? "lime" : color === "amber" ? "orange" : "pink"], { angle: 90 })]} /> : null}
    <View style={{ padding: padded ? space.lg : 0, gap: space.md }}>
      {/* The trailing control wraps under the title when both do not fit (320 px phones). */}
      {title ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, minHeight: 24, paddingHorizontal: padded ? 0 : space.lg, paddingTop: padded ? 0 : space.lg }}>
        {icon ? <View style={[{ width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" }, color ? { backgroundColor: hue(theme, color, "soft") } : { backgroundColor: colors.surface2 }]}><Icon name={icon} size={14} color={color ? hue(theme, color) : colors.foregroundMuted} /></View> : null}
        <Text numberOfLines={1} style={{ flexGrow: 1, flexShrink: 1, flexBasis: "auto", color: colors.foreground, fontSize: fontSize.title, fontWeight: "700" }}>{title}</Text>
        {trailing}
      </View> : null}
      {children}
    </View>
  </View>;
}

// Refresh the shared label array when a catalog is first bound or its language changes.
onTextChange(() => { weekdayNames = [t("coreCharts.mon"), t("coreCharts.tue"), t("coreCharts.wed"), t("coreCharts.thu"), t("coreCharts.fri"), t("coreCharts.sat"), t("coreCharts.sun")]; });
