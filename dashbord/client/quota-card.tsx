import { onTextChange } from "../shared/i18n";
import { t } from "../shared/text";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { QUOTA_ERRORS, quotaAccountCurrent, quotaChipSummary, quotaForecastText, quotaWhen, quotaWindowReset, tightestQuota, type QuotaAccount, type QuotaSnapshot, type QuotaTone, type QuotaWindow } from "../shared/quota";
import { vendorOf } from "../shared/stats";
import { Badge, SyncStatus, aria, fontSize, gradient, hue, isDarkTheme, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { Card } from "./charts";
import { Breathe, Ping } from "./motion";
import { trackFor, vendorHue } from "./stats-common";
import { useClock } from "./ui";

export { quotaForecastText, quotaWhen };

/** Lines for the Token page's ⓘ sheet. */
export let quotaInfo = [
  t("coreQuotaCard.quotaComesFromPaseoSUsageInterface"),
  t("coreQuotaCard.whileAPageIsViewingQuotaObservatory"),
  t("coreQuotaCard.ifAReadFailsAnAccountIs"),
  t("coreQuotaCard.theVerticalLineOnTheProgressBar"),
  t("coreQuotaCard.accountNamesMayBeEmailAddressesOnly"),
];

const toneHues: Record<QuotaTone, Hue> = { ok: "green", warning: "amber", danger: "red", neutral: "gray" };
const toneStops: Record<QuotaTone, readonly [Hue, Hue]> = { ok: ["teal", "green"], warning: ["amber", "orange"], danger: ["orange", "red"], neutral: ["gray", "gray"] };
const errorText: Record<typeof QUOTA_ERRORS[number], string> = {
  get disconnected() { return t("coreQuotaCard.thePluginSSessionWithPaseoDisconnected"); },
  get timeout() { return t("coreQuotaCard.paseoTimedOutReadingQuota"); },
  get unsupported() { return t("coreQuotaCard.thisPaseoVersionHasNoQuotaInterface"); },
  get failed() { return t("coreQuotaCard.couldNotReadQuota"); },
};
const errorBadge: Record<typeof QUOTA_ERRORS[number], string> = { get disconnected() { return t("coreQuotaCard.sessionDisconnected"); }, get timeout() { return t("coreQuotaCard.readTimedOut"); }, get unsupported() { return t("coreQuotaCard.unsupported"); }, get failed() { return t("coreQuotaCard.readFailed"); } };

/** 12 分钟 · 2 小时 5 分 · 3 天 4 小时 */
function untilText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000)), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (minutes < 60) return t("coreQuotaCard.minutes", { count: minutes });
  if (hours < 24) return t("coreQuotaCard.h", { value1: hours, value2: minutes % 60 ? t("coreQuotaCard.m", { value1: minutes % 60 }) : "" });
  return t("coreQuotaCard.d", { value1: days, value2: hours % 24 ? t("coreQuotaCard.h2", { value1: hours % 24 }) : "" });
}

/**
 * Used share with the pace marker: where even use would stand now; red, with a breathing halo, when use is ahead of it.
 * An older reading keeps its marker but never pulses: the use it shows may have moved since.
 */
function QuotaBar({ theme, window, reset, stale }: { theme: PluginTheme; window: QuotaWindow; reset: boolean; stale: boolean }) {
  const used = Math.min(100, Math.max(0, window.usedPct ?? 0)), tone: QuotaTone = reset ? "neutral" : window.tone;
  const pace = reset ? null : window.pace, ahead = pace !== null && window.ahead && !stale;
  // The marker itself never fades (it must stay readable on any fill); only its halo pulses.
  const marker = <View style={{ width: 4, height: 18, alignItems: "center" }}>
    {ahead ? <View style={{ position: "absolute", top: -2, width: 10, height: 22 }}><Breathe><View style={{ width: 10, height: 22, borderRadius: 5, backgroundColor: withAlpha(hue(theme, "red"), 0.45) }} /></Breathe></View> : null}
    <View style={{ width: 4, height: 18, borderRadius: 2, borderWidth: 1, borderColor: isDarkTheme(theme) ? theme.colors.surface1 : theme.colors.surface0, backgroundColor: ahead ? hue(theme, "red") : theme.colors.foreground }} />
  </View>;
  const label = t("coreQuotaCard.used", { value1: Math.round(used), value2: pace !== null ? t("coreQuotaCard.paceMarker", { value1: Math.round(pace * 100), value2: ahead ? t("coreQuotaCard.aheadOfPace") : "" }) : "" });
  return <View accessibilityRole="progressbar" accessibilityLabel={label} {...aria({ valuenow: String(Math.round(used)), valuemin: "0", valuemax: "100" })} style={{ height: 18, justifyContent: "center" }}>
    <View style={{ height: 10, borderRadius: 5, backgroundColor: trackFor(theme), overflow: "hidden" }}>
      {used > 0 ? <View style={[{ width: `${Math.max(2, used)}%`, height: 10, borderRadius: 5, opacity: reset ? 0.35 : 1 }, gradient(theme, toneStops[tone], { angle: 90 })]} /> : null}
    </View>
    {pace !== null ? <View style={{ position: "absolute", top: 0, left: `${pace * 100}%`, marginLeft: -2 }}>{marker}</View> : null}
  </View>;
}

function Dots({ from, to, color, size = 2.5, spacing = 6 }: { from: [number, number]; to: [number, number]; color: string; size?: number; spacing?: number }) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]), count = Math.max(2, Math.floor(length / spacing));
  return <>{Array.from({ length: count }, (_, index) => { const t = index / (count - 1); return <View key={index} style={{ position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: color,
    left: from[0] + (to[0] - from[0]) * t - size / 2, bottom: from[1] + (to[1] - from[1]) * t - size / 2 }} />; })}</>;
}
/**
 * This window's readings as a step area (a value holds until the next stored reading), the even-pace diagonal, now, and
 * the forecast dotted out to its exhaustion or reset. Gaps of over 15 minutes stay empty. Views only, no SVG. The
 * forecast of an older reading is drawn muted and never pings.
 */
function QuotaSpark({ theme, window, now, width, live, stale, height = 54 }: { theme: PluginTheme; window: QuotaWindow; now: number; width: number; live: boolean; stale: boolean; height?: number }) {
  const [from, to] = window.span, range = Math.max(1, to - from), plot = height - 4;
  const tone: QuotaTone = live ? window.tone : "neutral", color = hue(theme, toneHues[tone]), alarm = live && !stale && window.alarm, red = hue(theme, "red");
  const x = (at: number) => Math.min(width, Math.max(0, (at - from) / range * width)), y = (pct: number) => Math.min(1, Math.max(0, pct / 100)) * plot;
  const points = window.history, last = points.at(-1);
  const ends = points.map(([at], index) => { const next = points[index + 1]; return next && !next[2] ? x(next[0]) : index === points.length - 1 && live ? Math.max(x(at) + 2, x(Math.min(now, to))) : x(at) + 2; });
  const tip: [number, number] | null = last ? [ends.at(-1)!, y(last[1])] : null, forecast = live ? window.forecast : null;
  const target: [number, number] | null = !tip || !forecast ? null : forecast.kind === "exhaust" && Date.parse(forecast.at) <= to ? [x(Date.parse(forecast.at)), y(100)]
    : forecast.kind === "projected" ? [width, y(forecast.pct)] : null;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width, height }}>
    <View style={{ position: "absolute", left: 0, top: 0, width, height, borderRadius: radius.md, backgroundColor: withAlpha(color, isDarkTheme(theme) ? 0.1 : 0.06), overflow: "hidden" }}>
      {window.durationMs !== null && live ? <Dots from={[0, 0]} to={[width, plot]} color={withAlpha(theme.colors.foregroundMuted, 0.45)} size={2} spacing={7} /> : null}
      {points.map(([at, pct], index) => <View key={at} style={{ position: "absolute", bottom: 0, left: x(at), width: Math.max(2, ends[index]! - x(at)), height: Math.max(2, y(pct)),
        backgroundColor: withAlpha(color, 0.2), borderTopWidth: 2, borderTopColor: color }} />)}
      {live && now >= from && now <= to ? <View style={{ position: "absolute", top: 0, bottom: 0, left: x(now), width: 1, backgroundColor: withAlpha(theme.colors.foregroundMuted, 0.5) }} /> : null}
      {tip && target ? <Dots from={tip} to={target} color={alarm ? red : stale ? withAlpha(theme.colors.foregroundMuted, 0.6) : color} /> : null}
    </View>
    {tip ? <View style={{ position: "absolute", left: tip[0] - 5, bottom: tip[1] - 5, width: 10, height: 10, alignItems: "center", justifyContent: "center" }}>
      <Ping size={10} color={red} active={alarm} /><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: alarm ? red : color }} />
    </View> : null}
  </View>;
}

/** One window. `readingAt` / `current` come from its account: a forecast says which reading it was made from (codex-F8). */
function WindowTile({ theme, window, now, compact, readingAt, current }: { theme: PluginTheme; window: QuotaWindow; now: number; compact: boolean; readingAt: number | null; current: boolean }) {
  const reset = quotaWindowReset(window, now), tone: QuotaTone = reset ? "neutral" : window.tone, main = toneHues[tone], dark = isDarkTheme(theme);
  const forecast = quotaForecastText(window, now, { at: readingAt, current }), resetAt = window.resetsAt ? Date.parse(window.resetsAt) : null, alarm = window.alarm && !reset && current;
  // A current forecast names its reading quietly; an older one says it in its own text.
  const source = forecast && current && readingAt !== null && !reset && forecast.kind !== "muted" ? t("coreQuotaCard.basedOnTheReadingAt", { value1: quotaWhen(readingAt, now) }) : null;
  const forecastColor = !forecast ? undefined : forecast.kind === "alarm" ? hue(theme, "red", "text") : forecast.kind === "warning" ? hue(theme, "amber", "text") : forecast.kind === "calm" ? hue(theme, main, "text") : theme.colors.foregroundMuted;
  const resetLine = reset ? t("coreQuotaCard.resetTimeHasPassed", { value1: resetAt ? quotaWhen(resetAt, now) : "" }).trim() : resetAt ? t("coreQuotaCard.resetsLeft", { value1: quotaWhen(resetAt, now), value2: untilText(resetAt - now) }) : t("coreQuotaCard.resetTimeUnknown");
  return <View style={[{ flexBasis: compact ? "100%" : 330, flexGrow: 1, flexShrink: 1, minWidth: 0, padding: space.md, borderRadius: 14, borderWidth: 1,
      borderColor: alarm ? hue(theme, "red", "line") : withAlpha(hue(theme, main), dark ? 0.32 : 0.24) },
    gradient(theme, [withAlpha(hue(theme, main), dark ? 0.18 : 0.09), withAlpha(hue(theme, main), dark ? 0.04 : 0.02)], { angle: 150 })]}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
      <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, gap: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {alarm ? <View style={{ width: 10, height: 10, alignItems: "center", justifyContent: "center" }}><Ping size={10} color={hue(theme, "red")} /><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hue(theme, "red") }} /></View> : null}
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "700" }}>{window.label}</Text>
          <View style={{ flexGrow: 1 }} />
          <Text style={{ color: reset ? theme.colors.foregroundMuted : hue(theme, main, "text"), fontSize: 22, lineHeight: 26, fontWeight: "900", fontVariant: ["tabular-nums"], letterSpacing: -0.4 }}>
            {window.usedPct === null ? "—" : `${Math.round(window.usedPct)}%`}</Text>
        </View>
        <QuotaBar theme={theme} window={window} reset={reset} stale={!current} />
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{resetLine}</Text>
        {forecast ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}><Ping size={12} color={hue(theme, "red")} active={forecast.kind === "alarm"} /><Icon name={forecast.icon} size={13} color={forecastColor} /></View>
          <Text numberOfLines={2} style={{ flexShrink: 1, color: forecastColor, fontSize: fontSize.meta, lineHeight: 17, fontWeight: forecast.kind === "alarm" ? "800" : "600" }}>
            {forecast.text}{source ? <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "500" }}>{` · ${source}`}</Text> : null}</Text>
        </View> : null}
      </View>
      <QuotaSpark theme={theme} window={window} now={now} width={compact ? 92 : 116} live={!reset} stale={!current} />
    </View>
  </View>;
}

function AccountBlock({ theme, account, now, compact }: { theme: PluginTheme; account: QuotaAccount; now: number; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const current = quotaAccountCurrent(account, now), readingAt = account.readingAt ? Date.parse(account.readingAt) : null;
  // Phones show the provider's summary windows (5-hour and weekly); per-model and other windows fold under a toggle.
  const summary = account.windows.filter(window => window.summary || window.alarm && current), foldable = compact && summary.length > 0 && summary.length < account.windows.length;
  const shown = foldable && !open ? summary : account.windows, color = vendorHue(vendorOf(null, account.provider));
  const initial = Array.from(account.name.trim())[0]?.toUpperCase() ?? "#";
  const status = account.status === "error" ? t("coreQuotaCard.readFailed") : account.status === "unavailable" ? t("coreQuotaCard.temporarilyUnavailable") : null;
  return <View style={{ gap: space.sm }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
      <View style={[{ width: 22, height: 22, borderRadius: 7, alignItems: "center", justifyContent: "center" }, gradient(theme, [color, color === "orange" ? "amber" : color === "green" ? "teal" : "violet"], { angle: 135 })]}>
        <Text style={{ color: "#ffffff", fontSize: 12, lineHeight: 22, fontWeight: "800" }}>{initial}</Text>
      </View>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "700" }}>{account.name}</Text>
      {account.hint ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{account.hint}</Text> : null}
      {account.plan ? <Badge theme={theme} label={account.plan} tone={color} /> : null}
      {status ? <Badge theme={theme} label={status} tone="warning" icon="CircleAlert" /> : null}
      {!current && account.windows.length ? <Badge theme={theme} label={readingAt !== null ? t("coreQuotaCard.reading", { value1: quotaWhen(readingAt, now) }) : t("coreQuotaCard.readingExpired")} tone="amber" icon="History" /> : null}
    </View>
    {account.windows.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{shown.map(window => <WindowTile key={window.id} theme={theme} window={window} now={now} compact={compact} readingAt={readingAt} current={current} />)}</View>
      : <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{status ? t("coreQuotaCard.noReadingsYet", { value1: status }) : t("coreQuotaCard.noReadingsYet2")}</Text>}
    {foldable ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} {...aria({ expanded: open })} onPress={() => setOpen(!open)} hitSlop={6} style={{ alignSelf: "flex-start", paddingVertical: 2 }}>
      <Text style={{ color: hue(theme, "amber", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{open ? t("coreQuotaCard.collapse") : t("coreQuotaCard.moreWindows", { count: account.windows.length - summary.length })}</Text>
    </Pressable> : null}
  </View>;
}

function Note({ theme, icon, text, tone = "muted", action }: { theme: PluginTheme; icon: string; text: string; tone?: "muted" | "warning"; action?: { label: string; onPress: () => void } }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
    <Icon name={icon} size={15} color={tone === "warning" ? hue(theme, "amber") : theme.colors.foregroundMuted} />
    <Text style={{ flexShrink: 1, color: tone === "warning" ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{text}</Text>
    {action ? <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={8}><Text style={{ color: hue(theme, "amber", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{action.label}</Text></Pressable> : null}
  </View>;
}

export interface QuotaCardProps {
  theme: PluginTheme; compact?: boolean;
  /** From useQuota (client/use-quota). */
  data?: QuotaSnapshot; loading: boolean; error?: string; onRefresh?: () => void;
}
/** 额度: every account's usage windows with pace markers, forecasts and this window's history; a quiet line when there is nothing. */
export function QuotaCard({ theme, compact = false, data, loading, error, onRefresh }: QuotaCardProps) {
  const now = useClock(60_000), accounts = data?.accounts ?? [];
  // Red only for a current reading; older readings (kept through a failure) make the card amber at most.
  const live = accounts.filter(account => quotaAccountCurrent(account, now)).flatMap(account => account.windows).filter(window => !quotaWindowReset(window, now));
  const kept = accounts.filter(account => !quotaAccountCurrent(account, now) && account.windows.length);
  const color: Hue = live.some(window => window.alarm || window.tone === "danger") ? "red" : live.some(window => window.tone === "warning") || kept.length || data?.error || (!data && error) ? "amber" : live.length ? "green" : "blue";
  const retry = onRefresh && data?.error?.kind !== "unsupported" ? { label: t("coreQuotaCard.retry"), onPress: onRefresh } : undefined;
  const readAt = data?.readAt ? Date.parse(data.readAt) : null, oldest = accounts.reduce<number | null>((min, account) => account.readingAt ? Math.min(min ?? Infinity, Date.parse(account.readingAt)) : min, null);
  const trailing: ReactNode = data?.refreshing ? <SyncStatus theme={theme} state="syncing" label={t("coreQuotaCard.reading2")} />
    : data?.error ? <Badge theme={theme} label={errorBadge[data.error.kind]} tone="warning" icon="CircleAlert" />
    : readAt !== null ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreQuotaCard.updated", { value1: relativeTime(readAt, now) })}</Text> : null;
  let body: ReactNode;
  if (!data) body = loading ? <Note theme={theme} icon="Gauge" text={t("coreQuotaCard.readingQuota")} /> : <Note theme={theme} icon="Gauge" text={error ? t("coreQuotaCard.quotaIsTemporarilyUnavailable", { value1: error }) : t("coreQuotaCard.quotaIsTemporarilyUnavailable2")} action={onRefresh ? { label: t("coreQuotaCard.retry"), onPress: onRefresh } : undefined} />;
  else if (!accounts.length) body = <Note theme={theme} icon={data.error ? "CircleAlert" : "Gauge"} tone={data.error ? "warning" : "muted"} action={data.error ? retry : undefined}
    text={data.error ? t("coreQuotaCard.errorSentence", { error: errorText[data.error.kind] }) : data.refreshing || data.readAt === null ? t("coreQuotaCard.readingQuota") : t("coreQuotaCard.noReadableQuotaOnThisHostYet")} />;
  else body = <>
    {data.error ? <Note theme={theme} icon="CircleAlert" tone="warning" text={oldest !== null ? t("coreQuotaCard.errorWithReading", { error: errorText[data.error.kind], reading: quotaWhen(oldest, now) }) : t("coreQuotaCard.errorSentence", { error: errorText[data.error.kind] })} action={retry} /> : null}
    {error && !data.error ? <Note theme={theme} icon="WifiOff" text={t("coreQuotaCard.quotaSyncFailedShowingThePreviousResult", { value1: error })} /> : null}
    {accounts.map(account => <AccountBlock key={account.key} theme={theme} account={account} now={now} compact={compact} />)}
  </>;
  return <Card theme={theme} title={t("coreQuotaCard.quota")} icon="Gauge" color={color} trailing={trailing}><View style={{ gap: space.lg }}>{body}</View></Card>;
}

/**
 * The tightest window as one pill (out or forecast to run out first, then red, amber, green; shorter windows first), for
 * the 看板 hero, from the accounts with a current reading. When only older readings are left (a failed read, an
 * unavailable account, a cache from before the app slept) it shows the best of them with 「读数 08:30」, amber or neutral
 * and without the pulse (codex-F8). Renders nothing without any value. `glass` matches the hero's frosted pills;
 * `plain` suits a regular surface.
 */
export function QuotaChip({ theme, quota, onPress, variant = "glass" }: { theme: PluginTheme; quota?: Pick<QuotaSnapshot, "accounts">; onPress?: () => void; variant?: "glass" | "plain" }) {
  const now = useClock(60_000), pick = tightestQuota(quota, now);
  if (!pick) return null;
  const view = quotaChipSummary(pick, quota?.accounts.length ?? 0, now), glass = variant === "glass", color = hue(theme, toneHues[view.tone]), alarm = view.alarm;
  const text = glass ? "#ffffff" : theme.colors.foreground, stale = view.stale;
  const tailColor = glass ? withAlpha("#ffffff", stale ? 0.85 : 1) : hue(theme, stale ? "amber" : "red", "text");
  const body = <>
    <View style={{ width: 10, height: 10, alignItems: "center", justifyContent: "center" }}>
      <Ping size={10} color={glass ? "#ffffff" : hue(theme, "red")} active={alarm} />
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, borderWidth: glass ? 1.5 : 0, borderColor: "#ffffff" }} />
    </View>
    <Text numberOfLines={1} style={{ flexShrink: 1, color: text, fontSize: fontSize.small, fontWeight: "600" }}>{view.label}</Text>
    <Text style={{ color: glass ? withAlpha("#ffffff", stale ? 0.85 : 1) : hue(theme, toneHues[view.tone], "text"), fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{view.value}</Text>
    {view.tail ? <View style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1 }}>
      {stale ? <Icon name="History" size={12} color={tailColor} /> : null}
      <Text numberOfLines={1} style={{ flexShrink: 1, color: tailColor, fontSize: fontSize.small, fontWeight: "700" }}>{stale ? view.tail.text : `· ${view.tail.text}`}</Text>
    </View> : null}
  </>;
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, minHeight: 30, maxWidth: "100%" as const, paddingHorizontal: 11, borderRadius: radius.full, borderWidth: 1,
    backgroundColor: glass ? withAlpha("#ffffff", alarm ? 0.26 : 0.18) : alarm ? hue(theme, "red", "soft") : theme.colors.surface1,
    borderColor: glass ? withAlpha("#ffffff", alarm ? 0.6 : 0.28) : alarm ? hue(theme, "red", "line") : withAlpha(color, 0.45), borderStyle: stale ? "dashed" as const : "solid" as const };
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={view.accessibilityLabel} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }} style={state => [style, { opacity: state.pressed ? 0.75 : 1 }]}>{body}</Pressable>
    : <View accessibilityLabel={view.accessibilityLabel} style={style}>{body}</View>;
}

// Refresh the shared label array when a catalog is first bound or its language changes.
onTextChange(() => { quotaInfo = [
  t("coreQuotaCard.quotaComesFromPaseoSUsageInterface"),
  t("coreQuotaCard.whileAPageIsViewingQuotaObservatory"),
  t("coreQuotaCard.ifAReadFailsAnAccountIs"),
  t("coreQuotaCard.theVerticalLineOnTheProgressBar"),
  t("coreQuotaCard.accountNamesMayBeEmailAddressesOnly"),
]; });
