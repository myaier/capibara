import { joinList } from "../shared/i18n";
import { TextParts } from "./core-text";
import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { CheckKind, Digest, DigestLane, DigestSegment, DigestTurn, HighlightKind } from "../shared/digest";
import { buildTimeAxis, lanesIn, segmentsBetween, shareEntries, splitPath, turnSpan } from "../shared/digest-view";
import { bigNumber, percent } from "../shared/stats-view";
import { cacheHitRate, outputSpeed, tokenTotal } from "../shared/tokens";
import { Banner, Button, EmptyState, IconButton, Segmented, Skeleton, fontSize, formatDuration, gradient, hairline, hue, isDarkTheme, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { Card, CompositionBar, StackedColumns } from "./charts";
import { IconDisk, trackFor } from "./stats-common";
import { perSecond } from "./live-rate";
import { InfoButton, shortDuration, useClock } from "./ui";
import { Ping } from "./motion";

export const laneLooks: Record<DigestLane, { label: string; icon: string; hue: Hue }> = {
  model: { get label() { return t("coreAgentDigest.thinking"); }, icon: "Brain", hue: "violet" }, read: { get label() { return t("coreAgentDigest.readingFiles"); }, icon: "FileText", hue: "blue" },
  search: { get label() { return t("coreAgentDigest.searching"); }, icon: "Search", hue: "indigo" }, edit: { get label() { return t("coreAgentDigest.editingFiles"); }, icon: "FilePen", hue: "green" },
  shell: { get label() { return t("coreAgentDigest.commands"); }, icon: "SquareTerminal", hue: "orange" }, web: { get label() { return t("coreAgentDigest.network"); }, icon: "Globe", hue: "cyan" },
  agent: { get label() { return t("coreAgentDigest.subagents"); }, icon: "Bot", hue: "fuchsia" }, plan: { get label() { return t("coreAgentDigest.planning"); }, icon: "ListChecks", hue: "teal" },
  wait: { get label() { return t("coreAgentDigest.approvalWait"); }, icon: "Hand", hue: "amber" }, other: { get label() { return t("coreAgentDigest.other"); }, icon: "Puzzle", hue: "gray" },
};
const outcomeLooks: Record<DigestTurn["outcome"], { label: string; hue: Hue; icon: string }> = {
  completed: { get label() { return t("coreAgentDigest.completed"); }, hue: "green", icon: "Check" }, failed: { get label() { return t("coreAgentDigest.failed"); }, hue: "red", icon: "X" },
  canceled: { get label() { return t("coreAgentDigest.interrupted"); }, hue: "gray", icon: "CircleSlash" }, running: { get label() { return t("coreAgentDigest.inProgress"); }, hue: "blue", icon: "LoaderCircle" },
  unknown: { get label() { return t("coreAgentDigest.ended"); }, hue: "gray", icon: "Circle" },
};
const highlightIcons: Record<HighlightKind, string> = {
  turn_failed: "CircleX", interrupted: "CircleSlash", check_failed: "FlaskConical", check_fixed: "BadgeCheck", check_passed: "CircleCheckBig",
  fail_streak: "Repeat", error: "TriangleAlert", slow_tool: "Hourglass", long_think: "Brain", approval_wait: "Hand", big_edit: "FileDiff",
  many_files: "Files", git: "GitCommitHorizontal", subagent: "Bot", compaction: "Shrink", token_heavy: "Flame",
};
const severityHues: Record<"bad" | "warn" | "good" | "info", Hue> = { bad: "red", warn: "amber", good: "green", info: "blue" };
const checkNames: Record<CheckKind, string> = { get test() { return t("coreAgentDigest.tests"); }, get typecheck() { return t("coreAgentDigest.typeChecking"); }, get lint() { return t("coreAgentDigest.lint"); }, get build() { return t("coreAgentDigest.build"); }, get install() { return t("coreAgentDigest.dependencyInstallation"); } };
const clock = (at: number, seconds = false) => new Date(at).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
const duration = (ms: number) => ms < 1000 ? t("coreAgentDigest.lessThan1Second") : formatDuration(ms);
/** 45秒 / 12分 / 2时 / 2.5时 — for the narrow break marks. */
const tinyDuration = (ms: number) => ms < 60_000 ? t("coreAgentDigest.s", { value1: Math.round(ms / 1000) }) : ms < 3_600_000 ? t("coreAgentDigest.m", { value1: Math.round(ms / 60_000) }) : t("coreAgentDigest.h", { value1: (ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0).replace(/\.0$/, "") });
const share = (fraction: number) => fraction > 0 && fraction < 0.01 ? "<1%" : percent(fraction);
/** "子 Agent" + "上" reads "子 Agent 上"; Chinese labels join directly. */
const spaced = (label: string) => currentLanguage().startsWith("zh") && /[A-Za-z0-9]$/.test(label) ? `${label} ` : label;
/** Prompts and replies are excerpts of Markdown; drop the markers that read as noise on one line. */
const plain = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/(^|\s)(?:#{1,6}|-{3,}|>)(?=\s)/g, "$1").replace(/\s{2,}/g, " ").trim();
function highlightValue(kind: HighlightKind, value: number | null): string | null {
  if (value === null) return null;
  if (["slow_tool", "long_think", "approval_wait", "subagent"].includes(kind)) return duration(value);
  if (kind === "big_edit") return t("coreAgentDigest.lines", { count: bigNumber(value) });
  // Check, streak and token titles already carry their number ("测试失败 2 次后通过", "用掉 42% 的 Token").
  return null;
}
type OpenRef = (seq: number) => void;

/** Key numbers of the whole session. */
function Totals({ theme, digest, now, columns }: { theme: PluginTheme; digest: Digest; now: number; columns: number }) {
  const totals = digest.totals, span = digest.start !== null ? (digest.end ?? now) - digest.start : 0, tokens = digest.tokens;
  const items: Array<{ label: string; value: string; sub?: string; icon: string; colors: readonly [Hue, Hue] }> = [
    { label: t("coreAgentDigest.runtime"), value: shortDuration(digest.activeMs) || t("coreAgentDigest.value0Seconds"), sub: span > digest.activeMs + 60_000 ? t("coreAgentDigest.span", { value1: shortDuration(span) }) : undefined, icon: "Timer", colors: ["violet", "fuchsia"] },
    { label: t("coreAgentDigest.turns"), value: String(totals.turns), sub: totals.messages ? t("coreAgentDigest.messages", { count: totals.messages }) : undefined, icon: "MessagesSquare", colors: ["blue", "cyan"] },
    { label: t("coreAgentDigest.toolCalls"), value: bigNumber(totals.tools), sub: totals.failures ? t("coreAgentDigest.failedTimes", { value1: totals.failures }) : t("coreAgentDigest.noFailures"), icon: "Wrench", colors: totals.failures ? ["orange", "red"] : ["teal", "green"] },
    { label: t("coreAgentDigest.changes"), value: t("coreAgentDigest.files", { count: totals.files }), sub: totals.added || totals.removed ? `+${bigNumber(totals.added)} −${bigNumber(totals.removed)}` : undefined, icon: "FileDiff", colors: ["green", "lime"] },
    { label: t("coreAgentDigest.checks"), value: totals.checksPassed + totals.checksFailed ? `${totals.checksPassed} / ${totals.checksPassed + totals.checksFailed}` : "—", sub: totals.checksPassed + totals.checksFailed ? totals.checksFailed ? t("coreAgentDigest.failedTimes", { value1: totals.checksFailed }) : t("coreAgentDigest.allPassed") : t("coreAgentDigest.noTestsOrBuildsRun"), icon: "FlaskConical", colors: totals.checksFailed ? ["amber", "orange"] : ["green", "teal"] },
    ...(tokens ? [{ label: t("coreAgentDigest.tokens"), value: bigNumber(tokenTotal(tokens.totals)), sub: t("coreAgentDigest.outputCacheHits", { value1: bigNumber(tokens.totals.output), value2: percent(cacheHitRate(tokens.totals)) }), icon: "Coins", colors: ["amber", "pink"] as const },
      { label: t("coreAgentDigest.outputRate"), value: outputSpeed(tokens.totals) === null ? "—" : t("coreAgentDigest.outputPerSecond", { rate: perSecond(outputSpeed(tokens.totals)!) }), sub: t("coreAgentDigest.modelCalls", { count: bigNumber(tokens.totals.calls) }), icon: "Gauge", colors: ["cyan", "blue"] as const }] : []),
    ...(totals.waitMs ? [{ label: t("coreAgentDigest.waitingForYourApproval"), value: shortDuration(totals.waitMs), sub: t("coreAgentDigest.times", { count: totals.approvals }), icon: "Hand", colors: ["amber", "orange"] as const }] : []),
  ];
  return <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: space.md }}>
    {items.map(item => <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, width: `${100 / columns}%`, paddingRight: space.sm }}>
      <IconDisk theme={theme} icon={item.icon} colors={item.colors} size={30} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{item.label}</Text>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{item.value}</Text>
        {item.sub ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{item.sub}</Text> : null}
      </View>
    </View>)}
  </View>;
}

/** 时间都去哪了: where the active time went, largest share first. */
function TimeShare({ theme, digest }: { theme: PluginTheme; digest: Digest }) {
  const entries = shareEntries(digest.timeShare);
  if (!entries.length) return null;
  const model = entries.find(entry => entry.lane === "model"), top = entries[0]!;
  return <Card theme={theme} title={t("coreAgentDigest.whereTheTimeWent")} icon="PieChart" color="violet">
    <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>
      <TextParts id={top.lane === "model" ? "coreAgentDigest.modelTimeShare" : model ? "coreAgentDigest.otherTimeShareWithThinking" : "coreAgentDigest.otherTimeShare"} values={{ fraction: <Text style={{ color: hue(theme, laneLooks[top.lane].hue, "text"), fontWeight: "800" }}>{share(top.fraction)}</Text>, lane: spaced(laneLooks[top.lane].label), thinking: model ? share(model.fraction) : "" }} />
    </Text>
    <CompositionBar height={16} track={trackFor(theme)} segments={entries.map(entry => ({ key: entry.lane, value: entry.ms, color: hue(theme, laneLooks[entry.lane].hue) }))} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.lg, rowGap: 6 }}>
      {entries.map(entry => <View key={entry.lane} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <Icon name={laneLooks[entry.lane].icon} size={13} color={hue(theme, laneLooks[entry.lane].hue)} />
        <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{laneLooks[entry.lane].label}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{shortDuration(entry.ms) || t("coreAgentDigest.value1Second")} · {share(entry.fraction)}</Text>
      </View>)}
    </View>
  </Card>;
}

function segmentColor(theme: PluginTheme, segment: DigestSegment): string {
  if (segment.status === "failed") return hue(theme, "red");
  if (segment.status === "canceled") return hue(theme, "gray");
  return hue(theme, laneLooks[segment.lane].hue);
}

/** 执行时间轴: one row per kind of work; turns side by side with long idle gaps folded into breaks. */
function Gantt({ theme, digest, compact, now, zoom, onZoom, onOpenRef }: { theme: PluginTheme; digest: Digest; compact: boolean; now: number; zoom: number | null; onZoom: (turn: number | null) => void; onOpenRef?: OpenRef }) {
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<DigestSegment | null>(null);
  const labelWidth = compact ? 66 : 76, track = Math.max(0, width - labelWidth - space.sm);
  const zoomed = zoom !== null ? digest.turns.find(turn => turn.index === zoom) ?? null : null;
  const spans = useMemo(() => zoomed ? [turnSpan(zoomed, now)] : digest.turns.map(turn => turnSpan(turn, now)), [digest.turns, zoomed, now]);
  const axis = useMemo(() => buildTimeAxis(spans, track, { gapMs: zoomed ? Number.POSITIVE_INFINITY : 120_000 }), [spans, track, zoomed]);
  const visible = useMemo(() => zoomed ? segmentsBetween(digest.segments.filter(segment => segment.turn === zoomed.index), spans[0]!.start, spans[0]!.end) : digest.segments, [digest.segments, zoomed, spans]);
  const lanes = lanesIn(visible), rowHeight = 20, dark = isDarkTheme(theme);
  const turnsShown = zoomed ? [zoomed] : digest.turns;
  const ticks = zoomed ? [0, 0.25, 0.5, 0.75, 1].map(step => spans[0]!.start + (spans[0]!.end - spans[0]!.start) * step) : [];
  return <Card theme={theme} title={t("coreAgentDigest.executionTimeline")} icon="ChartGantt" color="blue" trailing={zoomed ? <Button theme={theme} size="sm" icon="Maximize2" label={t("coreAgentDigest.viewAll")} onPress={() => { onZoom(null); setPicked(null); }} /> : undefined}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
      {[null, ...digest.turns.map(turn => turn.index)].map(index => {
        const turn = index === null ? null : digest.turns.find(item => item.index === index)!, selected = zoom === index, look = turn ? outcomeLooks[turn.outcome] : null;
        return <Pressable key={index ?? "all"} accessibilityRole="button" accessibilityLabel={turn ? t("coreAgentDigest.turn", { value1: turn.index, value2: look!.label }) : t("coreAgentDigest.allTurns")} onPress={() => { onZoom(index); setPicked(null); }}
          style={state => [{ flexDirection: "row", alignItems: "center", gap: 4, height: 26, paddingHorizontal: 10, borderRadius: radius.full, borderWidth: 1, borderColor: selected ? "transparent" : theme.colors.border, opacity: state.pressed ? 0.75 : 1 },
            selected ? gradient(theme, turn ? [look!.hue === "gray" ? "violet" : look!.hue, "blue"] : ["violet", "blue"], { angle: 120 }) : null]}>
          {look ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: selected ? "#ffffff" : hue(theme, look.hue) }} /> : null}
          <Text style={{ color: selected ? "#ffffff" : theme.colors.foreground, fontSize: fontSize.small, fontWeight: selected ? "800" : "600" }}>{turn ? `#${turn.index}` : t("coreAgentDigest.all")}</Text>
        </Pressable>;
      })}
    </ScrollView>
    {zoomed ? <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>#{zoomed.index} {zoomed.prompt || t("coreAgentDigest.noQuestionFoundForThisTurn")}</Text> : null}
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))}>
      {width > 0 && lanes.length ? <View style={{ height: 16 + lanes.length * rowHeight }}>
        {turnsShown.map((turn, index) => { const span = turnSpan(turn, now), left = axis.x(span.start), right = axis.x(span.end);
          return <View key={turn.index} style={{ position: "absolute", left: labelWidth + space.sm + left, width: Math.max(2, right - left), top: 0, bottom: 0, borderRadius: 4, backgroundColor: index % 2 ? "transparent" : withAlpha(dark ? "#ffffff" : "#000000", 0.035) }}>
            {right - left >= 20 && !zoomed ? <Text numberOfLines={1} style={{ position: "absolute", left: 7, top: 1, color: hue(theme, outcomeLooks[turn.outcome].hue, "text"), fontSize: 10, fontWeight: "800" }}>#{turn.index}</Text> : null}
          </View>; })}
        {axis.breaks.map(gap => <View key={gap.x} style={{ position: "absolute", left: labelWidth + space.sm + gap.x, width: gap.width, top: 0, bottom: 0, alignItems: "center" }}>
          <View style={{ position: "absolute", top: 16, bottom: 0, left: gap.width / 2 - 3, width: 6, borderLeftWidth: 1, borderRightWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border }} />
          {/* RN-web caps one-line text at its parent's width, so the label gets its own wider box. */}
          <View style={{ position: "absolute", top: 2, width: 40, left: gap.width / 2 - 20, alignItems: "center" }}>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "700" }}>{tinyDuration(gap.ms)}</Text>
          </View>
        </View>)}
        {lanes.map((lane, row) => <View key={lane} style={{ position: "absolute", left: 0, right: 0, top: 16 + row * rowHeight, height: rowHeight, flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: labelWidth, flexDirection: "row", alignItems: "center", gap: compact ? 2 : 3 }}>
            <Icon name={laneLooks[lane].icon} size={compact ? 11 : 12} color={hue(theme, laneLooks[lane].hue)} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{laneLooks[lane].label}</Text>
          </View>
        </View>)}
        {visible.map((segment, index) => {
          const row = lanes.indexOf(segment.lane), left = axis.x(segment.start), size = Math.max(2, axis.x(segment.end) - left);
          const style = { position: "absolute" as const, left: labelWidth + space.sm + left, width: size, top: 16 + row * rowHeight + 5, height: 10, borderRadius: 3 };
          const color = segmentColor(theme, segment), selected = picked === segment;
          const bar = segment.status === "running" ? [style, gradient(theme, ["sky", "blue"], { angle: 90 })] : [style, { backgroundColor: color, opacity: segment.lane === "model" ? 0.6 : 1 }, selected ? { borderWidth: 1.5, borderColor: theme.colors.foreground } : null];
          return size >= 4 ? <Pressable key={index} accessibilityRole="button" accessibilityLabel={t("coreAgentDigest.message", { value1: laneLooks[segment.lane].label, value2: segment.label, value3: duration(segment.end - segment.start), value4: segment.status === "failed" ? t("coreAgentDigest.failed2") : "" })} onPress={() => setPicked(selected ? null : segment)} style={bar} />
            : <View key={index} style={bar} />;
        })}
        {visible.filter(segment => segment.status === "running").map((segment, index) => <View key={`ping-${index}`} style={{ position: "absolute", left: labelWidth + space.sm + axis.x(segment.end) - 5, top: 16 + lanes.indexOf(segment.lane) * rowHeight + 5, width: 10, height: 10, alignItems: "center", justifyContent: "center" }}>
          <Ping size={10} color={hue(theme, "blue")} /><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: hue(theme, "blue") }} />
        </View>)}
      </View> : width > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{t("coreAgentDigest.noToolCallsRecordedInThisSegment")}</Text> : null}
      {width > 0 && ticks.length ? <View style={{ height: 14, marginLeft: labelWidth + space.sm }}>
        {ticks.map((tick, index) => <Text key={index} numberOfLines={1} style={{ position: "absolute", left: Math.min(track - 44, Math.max(0, axis.x(tick) - 22)), width: 44, textAlign: index === 0 ? "left" : index === ticks.length - 1 ? "right" : "center", color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] }}>{clock(tick)}</Text>)}
      </View> : null}
    </View>
    {picked ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: hue(theme, laneLooks[picked.lane].hue, "soft") }}>
      <IconDisk theme={theme} icon={picked.status === "failed" ? "X" : laneLooks[picked.lane].icon} colors={[picked.status === "failed" ? "red" : laneLooks[picked.lane].hue]} size={26} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{picked.label}{picked.n > 1 ? t("coreAgentDigest.mergedCalls", { value1: picked.n }) : ""}</Text>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{[`#${picked.turn}`, `${clock(picked.start, true)}–${clock(picked.end, true)}`, duration(picked.end - picked.start), picked.status === "failed" ? t("coreAgentDigest.failed") : picked.status === "running" ? t("coreAgentDigest.inProgress") : null].filter(Boolean).join(" · ")}</Text>
      </View>
      {picked.seq !== null && onOpenRef ? <Button theme={theme} size="sm" icon="ListTree" label={t("coreAgentDigest.originalRecord")} onPress={() => onOpenRef(picked.seq!)} /> : null}
    </View> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{zoomed ? t("coreAgentDigest.tapAColoredBlockToSeeStep") : t("coreAgentDigest.tapATurnToZoomInIdle")}</Text>}
  </Card>;
}

/** 重点: what went wrong, what got fixed, milestones, slow spots. */
function Highlights({ theme, digest, onOpenRef }: { theme: PluginTheme; digest: Digest; onOpenRef?: OpenRef }) {
  const [expanded, setExpanded] = useState(false);
  if (!digest.highlights.length) return null;
  const shown = expanded ? digest.highlights : digest.highlights.slice(0, 8);
  return <Card theme={theme} title={t("coreAgentDigest.highlights")} icon="Sparkles" color="pink" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreAgentDigest.items", { count: digest.highlights.length })}</Text>}>
    <View style={{ gap: 2 }}>
      {shown.map((item, index) => {
        const color = severityHues[item.severity], value = highlightValue(item.kind, item.value);
        const body = <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 7 }}>
          <IconDisk theme={theme} icon={highlightIcons[item.kind]} colors={[color, color === "red" ? "pink" : color === "amber" ? "orange" : color === "green" ? "teal" : "violet"]} size={28} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text numberOfLines={1} style={{ flexShrink: 1, color: hue(theme, color, "text"), fontSize: fontSize.small, fontWeight: "800" }}>{item.title}</Text>
              {value ? <Text style={{ color: theme.colors.foreground, fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text> : null}
            </View>
            {item.detail ? <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.small }}>{plain(item.detail)}</Text> : null}
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("coreAgentDigest.turn2", { value1: item.turn, value2: clock(item.at) })}</Text>
          </View>
          {item.seq !== null && onOpenRef ? <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} /> : null}
        </View>;
        return item.seq !== null && onOpenRef ? <Pressable key={index} accessibilityRole="button" accessibilityLabel={t("coreAgentDigest.viewOriginalRecord", { value1: item.title, value2: item.detail })} onPress={() => onOpenRef(item.seq!)} style={state => ({ opacity: state.pressed ? 0.7 : 1 })}>{body}</Pressable> : <View key={index}>{body}</View>;
      })}
    </View>
    {digest.highlights.length > 8 ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 4, paddingHorizontal: 12 }}>
      <Text style={{ color: hue(theme, "pink", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? t("coreAgentDigest.collapse") : t("coreAgentDigest.expandAllMore", { value1: digest.highlights.length - 8 })}</Text>
    </Pressable> : null}
  </Card>;
}

/** A barcode of the turn: one block per step, width by duration. */
function PhaseStrip({ theme, segments }: { theme: PluginTheme; segments: readonly DigestSegment[] }) {
  return <View style={{ flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", gap: 1, backgroundColor: trackFor(theme) }}>
    {segments.map((segment, index) => <View key={index} style={{ flexGrow: Math.max(1, segment.end - segment.start), flexBasis: 0, minWidth: 2, backgroundColor: segmentColor(theme, segment), opacity: segment.lane === "model" ? 0.55 : 1 }} />)}
  </View>;
}

/** 按轮回顾: newest turn first. */
function Turns({ theme, digest, now, onZoom, onOpenRef }: { theme: PluginTheme; digest: Digest; now: number; onZoom: (turn: number) => void; onOpenRef?: OpenRef }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = [...digest.turns].reverse(), shown = expanded ? ordered : ordered.slice(0, 4);
  if (!ordered.length) return null;
  return <Card theme={theme} title={t("coreAgentDigest.reviewByTurn")} icon="Rows3" color="cyan" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreAgentDigest.turns2", { count: digest.turns.length })}</Text>}>
    <View style={{ gap: space.md }}>
      {shown.map(turn => {
        const look = outcomeLooks[turn.outcome], span = turnSpan(turn, now), segments = digest.segments.filter(segment => segment.turn === turn.index);
        const first = segments.find(segment => segment.seq !== null);
        const stats = [turn.tools ? t("coreAgentDigest.toolCalls2", { value1: turn.tools, value2: turn.failures ? t("coreAgentDigest.failed3", { value1: turn.failures }) : "" }) : null, turn.files ? t("coreAgentDigest.changedFiles", { value1: turn.files, value2: bigNumber(turn.added), value3: bigNumber(turn.removed) }) : null,
          turn.checksPassed + turn.checksFailed ? t("coreAgentDigest.checksPassed", { value1: turn.checksPassed, value2: turn.checksPassed + turn.checksFailed }) : null, turn.time.wait ? t("coreAgentDigest.approvalWait2", { value1: shortDuration(turn.time.wait) }) : null].filter(Boolean);
        return <View key={turn.index} style={{ gap: 6, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: hue(theme, look.hue, turn.outcome === "failed" || turn.outcome === "running" ? "line" : "soft"), backgroundColor: turn.outcome === "failed" ? hue(theme, "red", "soft") : "transparent" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            <View style={[{ flexDirection: "row", alignItems: "center", gap: 3, height: 22, paddingHorizontal: 8, borderRadius: radius.full }, gradient(theme, [look.hue === "gray" ? "gray" : look.hue, look.hue === "gray" ? "gray" : look.hue === "green" ? "teal" : look.hue === "red" ? "pink" : "sky"], { angle: 120 })]}>
              <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "900" }}>#{turn.index}</Text>
              <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "700" }}>{look.label}</Text>
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{clock(turn.start)} · {shortDuration(span.end - span.start) || t("coreAgentDigest.value1Second")}</Text>
            <View style={{ flex: 1 }} />
            {turn.tokens ? <Text style={{ color: hue(theme, "amber", "text"), fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{t("coreAgentDigest.tokenCount", { count: tokenTotal(turn.tokens), tokens: bigNumber(tokenTotal(turn.tokens)) })}</Text> : null}
          </View>
          <Text numberOfLines={3} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "700", lineHeight: 21 }}>{plain(turn.prompt) || t("coreAgentDigest.noQuestionFoundForThisTurn")}</Text>
          {segments.length ? <Pressable accessibilityRole="button" accessibilityLabel={t("coreAgentDigest.zoomInOnTurnInTheTimeline", { value1: turn.index })} onPress={() => onZoom(turn.index)}><PhaseStrip theme={theme} segments={segments} /></Pressable> : null}
          {stats.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>{stats.join(" · ")}</Text> : null}
          {turn.reply ? <Text numberOfLines={3} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>↳ {plain(turn.reply)}</Text> : null}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button theme={theme} size="sm" icon="ChartGantt" label={t("coreAgentDigest.zoomIn")} onPress={() => onZoom(turn.index)} />
            {first && onOpenRef ? <Button theme={theme} size="sm" variant="ghost" icon="ListTree" label={t("coreAgentDigest.originalRecord")} onPress={() => onOpenRef(first.seq!)} /> : null}
          </View>
        </View>;
      })}
    </View>
    {ordered.length > 4 ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 4, paddingHorizontal: 12 }}>
      <Text style={{ color: hue(theme, "cyan", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? t("coreAgentDigest.collapse") : t("coreAgentDigest.showEarlierTurns", { value1: ordered.length - 4 })}</Text>
    </Pressable> : null}
  </Card>;
}

function Files({ theme, digest }: { theme: PluginTheme; digest: Digest }) {
  const [expanded, setExpanded] = useState(false);
  if (!digest.files.length) return null;
  const shown = expanded ? digest.files : digest.files.slice(0, 8), max = Math.max(1, ...digest.files.map(file => file.reads + file.edits));
  return <Card theme={theme} title={t("coreAgentDigest.filesTouched")} icon="FolderGit2" color="green" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreAgentDigest.files2", { count: digest.files.length })}</Text>}>
    <View>
      {shown.map(file => { const { dir, name } = splitPath(file.path);
        return <View key={file.path} style={{ gap: 4, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name={file.edits ? "FilePen" : "FileText"} size={14} color={hue(theme, file.edits ? "green" : "blue")} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: fontSize.small }}><Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{name}</Text>{dir ? <Text style={{ color: theme.colors.foregroundMuted }}>  {dir.replace(/\/$/, "")}</Text> : null}</Text>
            {file.added || file.removed ? <Text style={{ fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}><Text style={{ color: hue(theme, "green", "text") }}>+{bigNumber(file.added)}</Text> <Text style={{ color: hue(theme, "red", "text") }}>−{bigNumber(file.removed)}</Text></Text> : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginLeft: 14 + space.sm }}>
            <View style={{ flexDirection: "row", width: `${Math.max(6, (file.reads + file.edits) / max * 60)}%`, height: 6, borderRadius: 3, overflow: "hidden", gap: 1 }}>
              {file.reads ? <View style={{ flexGrow: file.reads, backgroundColor: hue(theme, "blue") }} /> : null}
              {file.edits ? <View style={{ flexGrow: file.edits, backgroundColor: hue(theme, "green") }} /> : null}
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{[file.reads ? t("coreAgentDigest.read", { value1: file.reads }) : null, file.edits ? t("coreAgentDigest.edit", { value1: file.edits }) : null, t("coreAgentDigest.turn3", { value1: joinList(file.turns.map(String)) })].filter(Boolean).join(" · ")}</Text>
          </View>
        </View>; })}
    </View>
    {digest.files.length > 8 ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 4, paddingHorizontal: 12 }}>
      <Text style={{ color: hue(theme, "green", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? t("coreAgentDigest.collapse") : t("coreAgentDigest.expandAllMore2", { value1: digest.files.length - 8 })}</Text>
    </Pressable> : null}
  </Card>;
}

function Commands({ theme, digest, onOpenRef }: { theme: PluginTheme; digest: Digest; onOpenRef?: OpenRef }) {
  if (!digest.commands.length && !digest.checks.length) return null;
  const kinds = [...new Set(digest.checks.map(check => check.kind))], max = Math.max(1, ...digest.commands.map(command => command.runs));
  return <Card theme={theme} title={t("coreAgentDigest.commandsAndChecks")} icon="SquareTerminal" color="orange">
    {kinds.length ? <View style={{ gap: 8 }}>
      {kinds.map(kind => { const runs = digest.checks.filter(check => check.kind === kind), last = runs.filter(check => check.ok !== null).at(-1), failed = runs.filter(check => check.ok === false).length;
        return <View key={kind} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ width: 64, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{checkNames[kind]}</Text>
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {runs.map((check, index) => { const color = check.ok === null ? "blue" : check.ok ? "green" : "red";
              const mark = <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: hue(theme, color) }}>
                <Icon name={check.ok === null ? "LoaderCircle" : check.ok ? "Check" : "X"} size={12} color="#ffffff" />
              </View>;
              return check.seq !== null && onOpenRef ? <Pressable key={index} accessibilityRole="button" accessibilityLabel={t("coreAgentDigest.attempt", { value1: checkNames[kind], value2: index + 1, value3: check.ok === null ? t("coreAgentDigest.inProgress") : check.ok ? t("coreAgentDigest.passed") : t("coreAgentDigest.failed"), value4: check.command })} onPress={() => onOpenRef(check.seq!)}>{mark}</Pressable> : <View key={index}>{mark}</View>; })}
          </View>
          <Text style={{ color: last?.ok ? hue(theme, "green", "text") : failed ? hue(theme, "red", "text") : theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "700" }}>{last ? last.ok ? failed ? t("coreAgentDigest.passedAfterFailures", { value1: failed }) : t("coreAgentDigest.passed") : t("coreAgentDigest.notPassed") : t("coreAgentDigest.inProgress")}</Text>
        </View>; })}
    </View> : null}
    {digest.commands.length ? <View style={{ gap: 6, borderTopWidth: kinds.length ? hairline : 0, borderTopColor: theme.colors.border, paddingTop: kinds.length ? space.sm : 0 }}>
      {digest.commands.slice(0, 10).map(command => <View key={command.program} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text numberOfLines={1} style={{ width: 72, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700", fontFamily: "monospace" }}>{command.program}</Text>
        <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: trackFor(theme), overflow: "hidden", flexDirection: "row" }}>
          <View style={{ width: `${(command.runs - command.failures) / max * 100}%`, backgroundColor: hue(theme, "orange") }} />
          <View style={{ width: `${command.failures / max * 100}%`, backgroundColor: hue(theme, "red") }} />
        </View>
        <Text numberOfLines={1} style={{ minWidth: 96, flexShrink: 0, textAlign: "right", color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{t("coreAgentDigest.attempts", { value1: command.runs, value2: command.failures ? t("coreAgentDigest.failed4", { value1: command.failures }) : "", value3: shortDuration(command.ms) || t("coreAgentDigest.value1Second") })}</Text>
      </View>)}
    </View> : null}
  </Card>;
}

function Tokens({ theme, digest }: { theme: PluginTheme; digest: Digest }) {
  const [metric, setMetric] = useState<"output" | "input" | "speed">("output");
  const tokens = digest.tokens;
  if (!tokens?.calls.length) return null;
  const colors = { output: hue(theme, "pink"), input: hue(theme, "green"), speed: hue(theme, "cyan") };
  return <Card theme={theme} title={t("coreAgentDigest.eachModelCall")} icon="Coins" color="amber" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel={t("coreAgentDigest.callMetrics")} options={[{ value: "output", label: t("coreAgentDigest.output") }, { value: "input", label: t("coreAgentDigest.input") }, { value: "speed", label: t("coreAgentDigest.rate") }]} />}>
    <StackedColumns key={metric} theme={theme} height={110} colors={[colors[metric]]} names={[metric === "output" ? t("coreAgentDigest.output") : metric === "input" ? t("coreAgentDigest.contextRead") : "tok/s"]} format={metric === "speed" ? value => perSecond(value) : bigNumber}
      columns={tokens.calls.map(([at, output, input, speed]) => ({ label: clock(at), detail: clock(at, true), parts: [metric === "output" ? output : metric === "input" ? input : speed ?? 0] }))} />
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{metric === "input" ? t("coreAgentDigest.contextReadByEachCallIncludingCache") : metric === "speed" ? t("coreAgentDigest.outputRatePerCallBlankMeansThe") : t("coreAgentDigest.tokensWrittenByEachCallTallBars")}</Text>
  </Card>;
}

export interface AgentDigestProps {
  theme: PluginTheme; compact: boolean; digest?: Digest; loading: boolean; error?: string; onRefresh: () => void;
  /** Jump to the raw row in 时间线 (canonical seq in the digest's epoch). */
  onOpenSeq?: (epoch: string, seq: number) => void; header?: ReactNode; inset?: number;
}
/** 复盘: the agent's whole execution folded into where the time went, a timeline, key moments and per-turn summaries. */
export function AgentDigest({ theme, compact, digest, loading, error, onRefresh, onOpenSeq, header, inset = space.lg }: AgentDigestProps) {
  const now = useClock(digest?.running ? 5000 : 60_000);
  const [width, setWidth] = useState(0);
  const wide = width >= 820, columns = width >= 820 ? 4 : width >= 520 ? 3 : 2;
  const pair = (left: ReactNode, right: ReactNode) => wide ? <View style={{ flexDirection: "row", gap: space.lg, alignItems: "flex-start" }}><View style={{ flex: 1.15, minWidth: 0, gap: space.lg }}>{left}</View><View style={{ flex: 1, minWidth: 0, gap: space.lg }}>{right}</View></View> : <>{left}{right}</>;
  const [zoom, setZoom] = useState<number | null>(null);
  const scroll = useRef<{ scrollTo: (options: { y: number; animated?: boolean }) => void } | null>(null), ganttY = useRef(0);
  const openRef = digest?.epoch && onOpenSeq ? (seq: number) => onOpenSeq(digest.epoch!, seq) : undefined;
  const zoomTo = (turn: number | null) => { setZoom(turn); if (turn !== null) scroll.current?.scrollTo({ y: Math.max(0, ganttY.current - space.md), animated: true }); };
  let body: ReactNode;
  if (!digest) body = loading ? <Skeleton theme={theme} rows={6} /> : <EmptyState theme={theme} icon={error ? "WifiOff" : "ChartGantt"} tone={error ? "danger" : "info"} title={error ? t("coreAgentDigest.recapIsTemporarilyUnavailable") : t("coreAgentDigest.noRecapYet")} message={error ?? t("coreAgentDigest.aSummaryWillAppearHereAfterThe")} action={{ label: t("coreAgentDigest.retry"), onPress: onRefresh, icon: "RefreshCw" }} />;
  else if (!digest.turns.length) body = <EmptyState theme={theme} icon="ChartGantt" title={t("coreAgentDigest.noExecutionRecordsToRecapYet")} message={t("coreAgentDigest.thisSessionHasNoCompleteConversationTurns")} />;
  else body = <>
    {error ? <Banner theme={theme} tone="warning" message={t("coreAgentDigest.couldNotRefreshRecapShowingThePrevious", { value1: error })} action={{ label: t("coreAgentDigest.retry"), onPress: onRefresh }} /> : null}
    {digest.coverage.truncated ? <Banner theme={theme} tone="info" message={t("coreAgentDigest.thisSessionIsLongOnlyTheLatest", { value1: bigNumber(digest.coverage.rows) })} /> : null}
    <Totals theme={theme} digest={digest} now={now} columns={columns} />
    <View onLayout={event => { ganttY.current = event.nativeEvent.layout.y; }}><Gantt theme={theme} digest={digest} compact={compact} now={now} zoom={zoom} onZoom={zoomTo} onOpenRef={openRef} /></View>
    {pair(<Highlights theme={theme} digest={digest} onOpenRef={openRef} />, <><TimeShare theme={theme} digest={digest} /><Commands theme={theme} digest={digest} onOpenRef={openRef} /></>)}
    <Turns theme={theme} digest={digest} now={now} onZoom={zoomTo} onOpenRef={openRef} />
    {pair(<Files theme={theme} digest={digest} />, <Tokens theme={theme} digest={digest} />)}
  </>;
  return <ScrollView ref={scroll as never} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl, gap: space.lg }}>
    {header}
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ height: 0 }} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: header ? 0 : space.md }}>
      <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{digest ? t("coreAgentDigest.updated", { value1: digest.running ? t("coreAgentDigest.running") : "", value2: relativeTime(digest.generatedAt) }) : ""}</Text>
      <InfoButton theme={theme} title={t("coreAgentDigest.aboutRecaps")} lines={[
        t("coreAgentDigest.thePluginReadsThisSessionSFull"),
        t("coreAgentDigest.thinkingIsTimeInATurnWith"),
        t("coreAgentDigest.whenToolsOverlapTimeCountsOnceIn"),
        t("coreAgentDigest.checksIdentifyTestsTypeCheckingLintBuilds"),
        t("coreAgentDigest.tokensComeFromEachModelCallFor"),
      ]} />
      <IconButton theme={theme} icon="RefreshCw" label={t("coreAgentDigest.refreshRecap")} size="sm" onPress={onRefresh} />
    </View>
    {body}
  </ScrollView>;
}
