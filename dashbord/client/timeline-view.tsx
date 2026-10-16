import { currentLanguage, onTextChange } from "../shared/i18n";
import { t } from "../shared/text";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View, type FlatList as NativeFlatList, type TextStyle } from "react-native";
import { FlatList, Icon, copyText } from "@getpaseo/plugin/client/react-native";
import { usePaseo } from "./fleet-client";
import type { PluginTheme } from "@getpaseo/plugin";
import { object, prettyValue, projectTimelineRows, string, timelineSummary, type TimelineRow } from "../shared/timeline";
import { FIND_MAX_HITS, createHitJumper, createTimelineFind, findTerms, highlightParts, hitKey, hitLineOffset, hitLineSplit, rowLayout, toolDetails, type FindHit, type FindRange, type FindSnapshot, type HitScroll, type TimelineFind } from "../shared/timeline-find";
import { Badge, Banner, Button, EmptyState, IconButton, MetaLine, SearchField, Segmented, Skeleton, Spacer, SyncStatus, aria, fontSize, hairline, hue, isDarkTheme, radius, relativeTime, space, toneColor, withAlpha } from "./kit";
import { Enter, Flash } from "./motion";
import { monoFont } from "./ui";
import { Spinner, hueColor } from "./status";
import { useTimeline } from "./use-timeline";
import { readingMemory } from "./reading-cache";
import { TimelineArrival } from "./timeline-arrival";

type FindLooks = { hit: TextStyle; current: TextStyle };
/** 查找 marks: every hit on a vivid amber ground, the current one solid amber and underlined in blue (its row gets a blue frame). */
function findLooks(theme: PluginTheme): FindLooks {
  const amber = hue(theme, "amber");
  return { hit: { backgroundColor: withAlpha(amber, isDarkTheme(theme) ? 0.42 : 0.3), color: theme.colors.foreground },
    current: { backgroundColor: amber, color: "#1c1917", textDecorationLine: "underline", textDecorationColor: hue(theme, "blue") } };
}
/**
 * A text with its find hits marked as nested Text (phones have no DOM ranges); the plain text when it has none. `offset`: where
 * `text` starts in the text the hits were found in (the part of a split block from the current hit's line on).
 */
function marked(text: string, hits: readonly FindHit[] | undefined, current: FindRange | null | undefined, looks: FindLooks, offset = 0): ReactNode {
  if (!hits?.length) return text;
  const ranges = offset ? hits.map(hit => ({ start: hit.start - offset, end: hit.end - offset })) : hits;
  return highlightParts(text, ranges).map((part, index) => part.hit === null ? part.text
    : <Text key={index} testID={hits[part.hit] === current ? "find-current" : undefined} style={hits[part.hit] === current ? looks.current : looks.hit}>{part.text}</Text>);
}
/** Something the row can measure against itself (a View or Text host instance, on phones and on the web). */
type Measurable = Pick<View, "measureLayout">;
/** Measures the current hit's line: the block it starts and how far below that block's top the hit is drawn. */
export type HitLayout = (node: Measurable | null, extra: number) => void;
/** Code text: monospace, 18 px lines; a character about 0.6 em wide (the long-line estimate in hitLineOffset). */
const CODE_LINE = 18, CODE_CHAR = fontSize.meta * 0.6;

/**
 * The current hit's text, split at its line (codex-obs-send-ui-F2): the part before and, as a block of its own, the part from
 * that line on, which reports where it is drawn. Keyed by the hit, so every new current hit is laid out (and measured) afresh.
 */
function SplitText({ text, hit, hits, looks, style, lineHeight, charWidth, onHitLayout }: { text: string; hit: FindHit; hits: readonly FindHit[] | undefined; looks: FindLooks;
  style: TextStyle; lineHeight: number; charWidth: number; onHitLayout: HitLayout }) {
  const anchor = useRef<Text>(null), split = hitLineSplit(text, hit.start)!;
  return <View>
    {split.before ? <Text selectable style={style}>{marked(split.before, hits, hit, looks)}</Text> : null}
    <Text key={hitKey(hit)} ref={anchor} selectable style={style} onLayout={event => onHitLayout(anchor.current, hitLineOffset(split, event.nativeEvent.layout.width, charWidth, lineHeight))}>
      {marked(split.after, hits, hit, looks, split.at)}
    </Text>
  </View>;
}

export function CodeBlock({ theme, label, value, hits, current, onHitLayout }: { theme: PluginTheme; label: string; value: unknown;
  /** Find hits in this block (offsets in its full text) and the current one when it is here. */ hits?: readonly FindHit[]; current?: FindHit | null;
  /** Measures the current hit's line, so the list can scroll to it (the timeline's find). */ onHitLayout?: HitLayout }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const { colors } = theme;
  const fullText = prettyValue(value);
  const long = fullText.length > 1600 || fullText.split("\n").length > 18;
  const cut = long ? fullText.slice(0, 1600).split("\n").slice(0, 18).join("\n") : fullText;
  // The current hit past the cut opens the block (收起 still works afterwards); other hits there are counted on the button.
  const beyond = !!current && long && current.end > cut.length;
  useEffect(() => { if (beyond) setExpanded(true); }, [beyond, current]);
  const looks = useMemo(() => findLooks(theme), [theme]);
  if (!fullText) return null;
  const shown = expanded || !long ? fullText : cut;
  const later = !expanded && long && hits ? hits.filter(hit => hit.end > cut.length).length : 0;
  const code: TextStyle = { color: colors.foreground, fontFamily: monoFont, fontSize: fontSize.meta, lineHeight: CODE_LINE };
  return <View style={{ borderRadius: radius.md, borderWidth: hairline, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 32, paddingLeft: 10, paddingRight: 2, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{label}</Text>
      <IconButton theme={theme} size="sm" icon={copied ? "Check" : copyError ? "CircleAlert" : "Copy"} tone={copied ? "success" : copyError ? "danger" : undefined} label={t("secondaryTimelineView.copy", { value1: label })}
        onPress={() => { void copyText(fullText).then(() => { setCopied(true); setCopyError(false); }).catch(() => setCopyError(true)); }} />
    </View>
    {current && onHitLayout && current.end <= shown.length ? <View style={{ paddingHorizontal: 10, paddingVertical: space.sm }}>
      <SplitText text={shown} hit={current} hits={hits} looks={looks} style={code} lineHeight={CODE_LINE} charWidth={CODE_CHAR} onHitLayout={onHitLayout} />
    </View> : <Text selectable style={{ paddingHorizontal: 10, paddingVertical: space.sm, ...code }}>{marked(shown, hits, current, looks)}</Text>}
    {copyError ? <Text style={{ paddingHorizontal: 10, paddingBottom: space.sm, color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryTimelineView.copyFailedTouchAndHoldTo")}</Text> : null}
    {long ? <Pressable accessibilityRole="button" accessibilityLabel={expanded ? t("secondaryTimelineView.collapseContent") : t("secondaryTimelineView.expandFullContent")} onPress={() => setExpanded(!expanded)}
      style={state => ({ minHeight: 34, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: space.sm, borderTopWidth: hairline, borderTopColor: colors.border, backgroundColor: (state as { hovered?: boolean }).hovered ? colors.surface2 : "transparent" })}>
      <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.meta }}>{expanded ? t("secondaryTimelineView.collapse") : t("secondaryTimelineView.expandAllCharacters", { value1: fullText.length.toLocaleString() })}</Text>
      {later ? <Badge theme={theme} tone="amber" icon="Search" label={t("secondaryTimelineView.moreMatchesBelow", { value1: later })} /> : null}
    </Pressable> : null}
  </View>;
}
const toolLabel: Record<string, string> = { get running() { return t("secondaryTimelineView.running"); }, get completed() { return t("secondaryTimelineView.succeeded"); }, get failed() { return t("secondaryTimelineView.failed"); }, get canceled() { return t("secondaryTimelineView.canceled"); }, get loading() { return t("secondaryTimelineView.processing"); } };
export const TimelineEntry = memo(function TimelineEntry({ row, theme, memory, focused = false, hits, current, flash, onHitLine }: { row: TimelineRow; theme: PluginTheme; memory?: ReturnType<typeof readingMemory>; focused?: boolean;
  /** This row's find hits (shared/timeline-find) and the current hit when it is in this row. */ hits?: readonly FindHit[]; current?: FindHit | null;
  /** Bumps each time the current hit is brought to this row: the row flashes blue once. */ flash?: number;
  /** Where the current hit's line is drawn, in px below this row's top, once laid out (codex-obs-send-ui-F2). */ onHitLine?: (hit: FindHit, y: number) => void }) {
  const [expanded, setExpandedLocal] = useState(memory?.expanded.has(row.key) ?? false);
  const setExpanded = (value: boolean) => { setExpandedLocal(value); if (memory) { if (value) memory.expanded.add(row.key); else memory.expanded.delete(row.key); } };
  const rowRef = useRef<View>(null);
  // The current hit's line, measured against this row as it is drawn now. Offsets summed from onLayout would go stale on the
  // web, which reports layout only when a view resizes, not when a block above it grows and moves it.
  const measureHit: HitLayout = (node, extra) => {
    const hit = current, rowNode = rowRef.current;
    if (hit && node && rowNode && onHitLine) node.measureLayout(rowNode, (_x, y) => onHitLine(hit, y + extra), () => {});
  };
  const onHitLayout = onHitLine ? measureHit : undefined;
  const { colors } = theme;
  const looks = useMemo(() => findLooks(theme), [theme]);
  const item = row.item;
  const detail = object(item.detail);
  const tool = item.type === "tool_call";
  const failed = item.type === "error" || item.status === "failed" || item.level === "error";
  const reasoning = item.type === "reasoning";
  const human = item.type === "user_message";
  const icon = failed ? "CircleAlert" : tool && detail.type === "sub_agent" ? "GitBranch" : tool ? "Terminal" : reasoning ? "Brain" : human ? "User" : item.type === "todo" ? "ListChecks" : "Sparkles";
  const iconColor = failed ? colors.statusDanger : tool ? toneColor(theme, "accent", "mark") : human || reasoning ? colors.foregroundMuted : colors.foreground;
  const title = tool ? string(item.name) || t("secondaryTimelineView.toolCall") : reasoning ? t("secondaryTimelineView.reasoningSummary") : human ? t("secondaryTimelineView.userInstruction") : item.type === "assistant_message" ? t("secondaryTimelineView.agentReply")
    : item.type === "todo" ? t("secondaryTimelineView.taskPlan") : item.type === "error" ? t("secondaryTimelineView.executionError") : item.type === "compaction" ? t("secondaryTimelineView.contextCompaction") : item.type === "notification" ? t("secondaryTimelineView.executionNotice") : item.type === "plugin" ? t("secondaryTimelineView.pluginRecord", { value1: string(item.kind) }) : item.type;
  const clock = row.timestamp ? new Date(row.timestamp).toLocaleTimeString(currentLanguage(), { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const text = timelineSummary(item);
  const { expandable, lines } = rowLayout(item);
  const state = string(item.status);
  // A tool that is still working spins in the running blue; results take their status colour.
  const working = state === "running" || state === "loading";
  const stateColor = working ? hueColor(theme, "run", "text") : state === "failed" ? hueColor(theme, "fail", "text") : state === "completed" ? hueColor(theme, "ok", "text") : colors.foregroundMuted;
  const of = (field: string) => hits?.filter(hit => hit.field === field);
  const here = (field: string) => current?.field === field ? current : null;
  // Hits a collapsed row does not show (blocks behind 展开, text past its first lines) are counted beside its title.
  const hiddenHits = expandable && !expanded && hits ? hits.filter(hit => hit.hidden).length : 0;
  const blue = hue(theme, "blue");
  const summaryStyle: TextStyle = { color: failed ? colors.statusDanger : reasoning || human ? colors.foregroundMuted : colors.foreground, fontSize: tool ? fontSize.meta : fontSize.small, lineHeight: tool ? 18 : 20, ...(tool ? { fontFamily: monoFont } : {}) };
  // A long reply shown in full splits at the current hit's line too; a collapsed one shows that hit in its first lines already.
  const summaryHit = here("summary"), clipped = expandable && !expanded;
  return <View ref={rowRef} collapsable={false} {...aria({ current: current ? "true" : undefined })} style={{ flexDirection: "row", gap: space.md, paddingHorizontal: space.sm, marginHorizontal: -space.sm, borderRadius: radius.md, backgroundColor: focused ? colors.surface2 : "transparent" }}>
    {current ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", top: -space.xs, bottom: space.sm, left: 0, right: 0, borderRadius: radius.md, borderWidth: 2, borderColor: blue, backgroundColor: withAlpha(blue, 0.06) }} /> : null}
    <View style={{ width: 20, alignItems: "center", paddingTop: 4 }}>
      {working ? <Spinner size={14} color={stateColor} /> : <Icon name={icon} size={14} color={iconColor} />}
      <View style={{ width: hairline, flex: 1, minHeight: 8, marginTop: 6, backgroundColor: colors.border }} />
    </View>
    <View style={{ flex: 1, minWidth: 0, paddingBottom: space.lg, gap: space.xs }}>
      <Pressable disabled={!expandable} accessibilityRole={expandable ? "button" : undefined} accessibilityState={expandable ? { expanded } : undefined} accessibilityLabel={expandable ? `${expanded ? t("secondaryTimelineView.collapse") : t("secondaryTimelineView.expand")}${title}` : title}
        onPress={() => setExpanded(!expanded)} hitSlop={{ top: 6, bottom: 6 }} style={state => ({ minHeight: 22, flexDirection: "row", gap: space.sm, alignItems: "center", opacity: state.pressed ? 0.7 : 1 })}>
        <Text numberOfLines={1} style={{ flex: 1, color: failed ? colors.statusDanger : colors.foreground, fontSize: fontSize.small, fontWeight: "500", fontFamily: tool ? monoFont : undefined }}>{tool ? marked(title, of("name"), current, looks) : title}</Text>
        {hiddenHits ? <Badge theme={theme} tone="amber" icon="Search" label={t("secondaryTimelineView.matches", { count: hiddenHits })} /> : null}
        {state ? <Text style={{ color: stateColor, fontSize: fontSize.meta }}>{toolLabel[state] ?? state}</Text> : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{clock}</Text>
        {expandable ? <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={12} color={colors.foregroundMuted} /> : null}
      </Pressable>
      {item.type === "todo" ? <View style={{ gap: space.xs + 2 }}>{(Array.isArray(item.items) ? item.items : []).map((task, index) => {
        const todo = object(task); const done = todo.completed === true || todo.status === "completed";
        return <View key={string(todo.id) || index} style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
          <View style={{ paddingTop: 3 }}><Icon name={done ? "CircleCheck" : todo.status === "in_progress" ? "CircleDot" : "Circle"} size={14} color={done ? colors.statusSuccess : colors.foregroundMuted} /></View>
          <Text style={{ flex: 1, color: done ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.small, lineHeight: 20, textDecorationLine: done ? "line-through" : "none" }}>{marked(string(todo.text) || string(todo.activeForm), of(`todo:${index}`), current, looks)}</Text>
        </View>;
      })}</View> : summaryHit && !clipped && onHitLayout && summaryHit.end <= text.length
        ? <SplitText text={text} hit={summaryHit} hits={of("summary")} looks={looks} style={summaryStyle} lineHeight={tool ? 18 : 20} charWidth={tool ? CODE_CHAR : fontSize.small * 0.55} onHitLayout={onHitLayout} />
        : <Text selectable numberOfLines={clipped ? lines : undefined} style={summaryStyle}>{marked(text, of("summary"), current, looks)}</Text>}
      {expanded && tool ? <View style={{ gap: space.sm, paddingTop: space.xs }}>{toolDetails(item).map(({ label, value }) => <CodeBlock key={label} theme={theme} label={label} value={value} hits={of(`detail:${label}`)} current={here(`detail:${label}`)} onHitLayout={onHitLayout} />)}</View> : null}
      {expanded && item.type === "plugin" ? <CodeBlock theme={theme} label={t("secondaryTimelineView.pluginData")} value={item.data} hits={of("plugin")} current={here("plugin")} onHitLayout={onHitLayout} /> : null}
    </View>
    {current && flash ? <Flash count={flash} color={withAlpha(blue, 0.22)} radius={radius.md} /> : null}
  </View>;
});

/**
 * 查找 (codex-B1): pinned above the list while open, so 上一处 / 下一处 stay at hand however far the list scrolls. It only ever
 * looks at the rows already loaded, says how many, and offers to load older ones instead of calling the rest 没有找到.
 */
export function FindBar({ theme, find, finder, inset, loaded, searched, filterLabel, hasOlder, truncated, loadingOlder, onLoadOlder }: { theme: PluginTheme; find: FindSnapshot; finder: TimelineFind; inset: number;
  loaded: number; searched: number; filterLabel: string | null; hasOlder: boolean; truncated: boolean; loadingOlder: boolean; onLoadOlder: () => void }) {
  const { colors } = theme;
  const asked = findTerms(find.input).length > 0, result = find.result, total = result?.hits.length ?? 0, more = result?.capped ? "+" : "";
  const counter = !asked ? "" : !result ? "…" : total ? `${find.current + 1} / ${total}${more}` : t("secondaryTimelineView.matches2");
  const spoken = !asked ? "" : !result ? t("secondaryTimelineView.searching") : total ? t("secondaryTimelineView.matchOf", { value1: find.current + 1, value2: total, value3: more ? t("secondaryTimelineView.message") : "" }) : t("secondaryTimelineView.noMatches");
  const scope = asked && result && !total ? t("secondaryTimelineView.noMatchesInLoadedRecords", { value1: loaded }) : t("secondaryTimelineView.recordsLoaded", { count: loaded });
  const parts = [filterLabel ? t("secondaryTimelineView.searchingOnlyRecords", { value1: scope, value2: filterLabel, value3: searched }) : scope, result?.capped ? t("secondaryTimelineView.onlyTheFirstMatchesAreListed", { count: FIND_MAX_HITS }) : null,
    hasOlder ? t("secondaryTimelineView.earlierRecordsHaveNotBeenLoaded") : truncated ? t("secondaryTimelineView.onlyTheRecentWindowIsRetained") : null];
  return <Enter active>
    <View style={{ gap: space.xs, paddingHorizontal: inset, paddingVertical: space.sm, borderBottomWidth: hairline, borderBottomColor: colors.border, backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <SearchField theme={theme} value={find.input} onChangeText={finder.setInput} onSubmit={finder.next} placeholder={t("secondaryTimelineView.searchLoadedRecords")} accessibilityLabel={t("secondaryTimelineView.findInTimeline")} autoFocus />
        {counter ? <Text accessibilityLabel={spoken} accessibilityLiveRegion="polite" {...aria({ live: "polite" })}
          style={{ minWidth: 40, textAlign: "center", color: total ? hue(theme, "amber", "text") : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: total ? "600" : "400", fontVariant: ["tabular-nums"] }}>{counter}</Text> : null}
        <IconButton theme={theme} icon="ChevronUp" label={t("secondaryTimelineView.previousMatch")} disabled={!total} onPress={finder.previous} />
        <IconButton theme={theme} icon="ChevronDown" label={t("secondaryTimelineView.nextMatch")} disabled={!total} onPress={finder.next} />
        <IconButton theme={theme} icon="X" label={t("secondaryTimelineView.closeSearch")} onPress={finder.close} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}><MetaLine theme={theme} parts={parts} numberOfLines={2} /></View>
        {hasOlder ? <Button theme={theme} size="sm" variant="ghost" icon="History" label={loadingOlder ? t("secondaryTimelineView.reading") : t("secondaryTimelineView.readEarlier")} accessibilityLabel={t("secondaryTimelineView.readEarlierRecordsToContinueSearching")} busy={loadingOlder} onPress={onLoadOlder} /> : null}
      </View>
    </View>
  </Enter>;
}

const filters = [{ value: "all" as const, get label() { return t("secondaryTimelineView.all"); } }, { value: "tools" as const, get label() { return t("secondaryTimelineView.tools"); } }, { value: "messages" as const, get label() { return t("secondaryTimelineView.conversation"); } }, { value: "errors" as const, get label() { return t("secondaryTimelineView.errors"); } }];
type TimelineFilter = typeof filters[number]["value"];
// The last find text per timeline, on this device for this app session only (like the session list's search): switching detail tabs
// keeps it for the next 查找, which opens with it. At most 40 timelines are remembered.
const findTexts = new Map<string, string>();
onTextChange(() => findTexts.clear());
export function TimelineContent({ timeline, theme, header, inset = space.lg, cacheKey = "default", focusRef }: { timeline: ReturnType<typeof useTimeline>; theme: PluginTheme; header?: ReactNode; inset?: number; cacheKey?: string; focusRef?: string | null }) {
  const paseo = usePaseo();
  const memory = useMemo(() => readingMemory(paseo, `timeline:${cacheKey}`), [paseo, cacheKey]);
  const [filter, setFilterLocal] = useState(memory.filter as TimelineFilter);
  const setFilter = (value: TimelineFilter) => { memory.filter = value; setFilterLocal(value); };
  const list = useRef<NativeFlatList<TimelineRow>>(null);
  const restoredScroll = useRef(false), focusedToken = useRef<string | null>(null), lastEpoch = useRef<string | null>(null), retryCount = useRef(0), mounted = useRef(true), retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (retryTimer.current) clearTimeout(retryTimer.current); }; }, []);
  useEffect(() => { if (timeline.page?.epoch && lastEpoch.current && lastEpoch.current !== timeline.page.epoch) { memory.scroll = 0; memory.expanded.clear(); } if (timeline.page?.epoch) lastEpoch.current = timeline.page.epoch; restoredScroll.current = false; }, [timeline.page?.epoch, cacheKey]);
  // Merge streaming fragments in source order before reversing the presentation.
  const presentedRows = useMemo(() => projectTimelineRows(timeline.page?.rows ?? []).reverse(), [timeline.page?.rows]);
  const rows = useMemo(() => presentedRows.filter(row => filter === "all" || filter === "tools" && row.item.type === "tool_call" || filter === "messages" && ["assistant_message", "user_message"].includes(row.item.type) || filter === "errors" && (row.item.type === "error" || row.item.status === "failed" || row.item.level === "error")), [presentedRows, filter]);
  const arrivalScope = JSON.stringify([cacheKey, filter, timeline.page?.epoch]);
  const previous = useRef<{ scope: string; newest: number } | null>(null);
  const newest = Math.max(-1, ...presentedRows.map(row => row.seqEnd));
  const arrivals = useMemo(() => {
    const prior = previous.current;
    if (!prior || prior.scope !== arrivalScope || timeline.page?.reset) return new Map<string, number>();
    const now = Date.now();
    return new Map(rows.filter(row => row.seqStart > prior.newest).map(row => [row.key, now]));
  }, [rows, arrivalScope, timeline.page?.reset]);
  useLayoutEffect(() => {
    // Keep the high-water mark when paging back. Older pages, filters and reloads never enter as live news.
    previous.current = timeline.page ? { scope: arrivalScope, newest: previous.current?.scope === arrivalScope ? Math.max(previous.current.newest, newest) : newest } : null;
  }, [timeline.page, arrivalScope, newest]);
  // 查找 (codex-B1) over the rows this view shows: only what is loaded, in its order and filter, keyed by the rows' stable keys.
  const finder = useMemo(() => { const created = createTimelineFind(); created.setInput(findTexts.get(cacheKey) ?? ""); return created; }, [cacheKey]);
  useEffect(() => () => finder.dispose(), [finder]);
  const find = useSyncExternalStore(finder.subscribe, finder.getSnapshot, finder.getSnapshot);
  useEffect(() => {
    findTexts.delete(cacheKey);
    if (find.input) { findTexts.set(cacheKey, find.input); for (const old of findTexts.keys()) { if (findTexts.size <= 40) break; findTexts.delete(old); } }
  }, [find.input, cacheKey]);
  const epoch = timeline.page?.epoch ?? null;
  useEffect(() => { finder.setRows(rows, epoch); }, [finder, rows, epoch]);
  const currentHit = find.result && find.result.epoch === epoch ? find.result.hits[find.current] ?? null : null;
  const [, setExpandTick] = useState(0);
  // Every scroll to a row goes through here, so a retry after `onScrollToIndexFailed` repeats it with its offset into the row.
  const lastScroll = useRef<HitScroll | null>(null), listHeight = useRef(0), shownRows = useRef(rows);
  shownRows.current = rows;
  const scrollTo = (params: HitScroll) => { lastScroll.current = params; list.current?.scrollToIndex(params); };
  // 上一处 / 下一处 within one long row reach the hit itself, not just its row (codex-obs-send-ui-F2): see createHitJumper.
  const jumper = useMemo(() => createHitJumper({ scroll: params => { if (mounted.current) scrollTo(params); }, indexOf: key => shownRows.current.findIndex(row => row.key === key), visible: () => listHeight.current }), []);
  const onHitLine = useCallback((hit: FindHit, y: number) => jumper.measured(hit, y), [jumper]);
  // A new query, 上一处 / 下一处 or a new epoch brings the current hit into view, opening its row when a collapsed row would hide it.
  useEffect(() => {
    if (!find.jump || !currentHit || !rows.some(row => row.key === currentHit.row)) return;
    if (currentHit.hidden && !memory.expanded.has(currentHit.row)) { memory.expanded.add(currentHit.row); setExpandTick(tick => tick + 1); }
    retryCount.current = 0;
    if (!jumper.jump(currentHit)) return;
    const timer = setTimeout(() => { if (mounted.current) jumper.toRow(currentHit); }, 60);
    return () => clearTimeout(timer);
  }, [find.jump]);
  const [focusMissing, setFocusMissing] = useState(false), [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusAttempts = useRef(0);
  useEffect(() => { focusAttempts.current = 0; focusedToken.current = null; retryCount.current = 0; setFocusMissing(false); setFocusedKey(null); if (focusRef) setFilter("all"); }, [focusRef]);
  // A ref names a row by its first seq; merged tool rows can span other rows' seqs, so an exact start wins over containment.
  useEffect(() => { if (!focusRef || timeline.loading || focusedToken.current === focusRef) return; const parts = focusRef.split(":"); const range = parts.at(-1)?.split("-"); const seq = Number(range?.[0]); const epoch = parts.at(-2); const exact = rows.findIndex(row => row.epoch === epoch && row.seqStart === seq); const index = exact >= 0 ? exact : rows.findIndex(row => row.epoch === epoch && row.seqStart <= seq && row.seqEnd >= seq); if (index >= 0) { focusedToken.current = focusRef; setFocusMissing(false); setFocusedKey(rows[index]!.key); memory.expanded.add(rows[index]!.key); setTimeout(() => scrollTo({ index, animated: false, viewPosition: 0.1 }), 100); } else if (timeline.page?.hasOlder && focusAttempts.current < 12 && !timeline.loadingOlder) { focusAttempts.current++; timeline.loadOlder(); } else if (!timeline.loadingOlder) setFocusMissing(true); }, [focusRef, timeline.page, timeline.loading, timeline.loadingOlder]);
  const sync = timeline.error ? "error" : timeline.refreshing ? "syncing" : "live";
  return <View style={{ flex: 1, minHeight: 0 }}>
    {find.open ? <FindBar theme={theme} find={find} finder={finder} inset={inset} loaded={presentedRows.length} searched={rows.length} filterLabel={filter === "all" ? null : filters.find(option => option.value === filter)!.label}
      hasOlder={!!timeline.page?.hasOlder} truncated={!!timeline.page?.truncated} loadingOlder={timeline.loadingOlder} onLoadOlder={timeline.loadOlder} /> : null}
    <FlatList ref={list} testID="timeline-list" data={rows} extraData={find} keyExtractor={row => row.key} style={{ flex: 1, minHeight: 0 }} initialNumToRender={12} maxToRenderPerBatch={12} windowSize={5} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl }}
      onScroll={event => { memory.scroll = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100}
      onLayout={event => { listHeight.current = event.nativeEvent.layout.height; if (!restoredScroll.current && !focusRef && memory.scroll > 0) { restoredScroll.current = true; list.current?.scrollToOffset({ offset: memory.scroll, animated: false }); } }}
      onScrollToIndexFailed={({ index, averageItemLength }) => { if (retryCount.current++ >= 3) return; list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false }); if (retryTimer.current) clearTimeout(retryTimer.current); retryTimer.current = setTimeout(() => { if (mounted.current) list.current?.scrollToIndex({ ...(lastScroll.current?.index === index ? lastScroll.current : { index, viewPosition: 0.1 }), animated: false }); }, 200); }}
      ListHeaderComponent={<View style={{ gap: space.md, paddingBottom: space.lg }}>{header}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: header ? 0 : space.md }}>
          <Segmented theme={theme} value={filter} onChange={setFilter} size="sm" options={filters} accessibilityLabel={t("secondaryTimelineView.timelineFilter")} />
          <Spacer />
          <SyncStatus theme={theme} state={sync} label={timeline.live ? t("secondaryTimelineView.live") : timeline.lastSyncedAt ? relativeTime(timeline.lastSyncedAt) : t("secondaryTimelineView.periodicSync")} />
          <IconButton theme={theme} icon="Search" label={t("secondaryTimelineView.find")} size="sm" active={find.open} tone={find.open ? "amber" : undefined} onPress={() => { if (find.open) finder.close(); else finder.open(); }} />
          <IconButton theme={theme} icon="RefreshCw" label={t("secondaryTimelineView.refreshExecutionTimeline")} size="sm" onPress={timeline.refresh} disabled={timeline.refreshing} />
        </View>
        {timeline.error ? <Banner theme={theme} tone="danger" message={t("secondaryTimelineView.loadedRecordsAreRetained", { value1: timeline.error })} action={{ label: t("secondaryTimelineView.retry"), onPress: timeline.refresh }} /> : null}
        {timeline.page?.gap ? <Banner theme={theme} tone="warning" message={t("secondaryTimelineView.someHistoryIsNoLongerRetained")} /> : null}
        {focusMissing ? <Banner theme={theme} tone="warning" message={t("secondaryTimelineView.thisReferenceIsOutsideTheRetained")} /> : null}
      </View>}
      ListEmptyComponent={timeline.loading ? <Skeleton theme={theme} rows={4} /> : <EmptyState theme={theme} icon="ListTree" title={filter === "errors" ? t("secondaryTimelineView.noErrorsInTheCurrentWindow") : t("secondaryTimelineView.noMatchingRecords")} message={t("secondaryTimelineView.changeTheFilterOrReadEarlier")} />}
      renderItem={({ item }) => <TimelineArrival arrivedAt={arrivals.get(item.key)}><TimelineEntry key={`${item.key}:${memory.expanded.has(item.key)}`} row={item} theme={theme} memory={memory} focused={item.key === focusedKey}
        hits={find.result?.epoch === epoch ? find.result.byRow.get(item.key) : undefined} current={currentHit?.row === item.key ? currentHit : null} flash={currentHit?.row === item.key ? find.jump : undefined} onHitLine={onHitLine} /></TimelineArrival>}
      ListFooterComponent={<View style={{ alignItems: "center", paddingTop: space.sm, gap: space.md }}>
        {timeline.page?.hasOlder ? <Button theme={theme} icon="History" size="sm" label={timeline.loadingOlder ? t("secondaryTimelineView.reading") : t("secondaryTimelineView.readEarlierRecords")} accessibilityLabel={t("secondaryTimelineView.readEarlierRecords")} busy={timeline.loadingOlder} onPress={timeline.loadOlder} /> : null}
        {rows.length ? <MetaLine theme={theme} parts={[t("secondaryTimelineView.records", { count: rows.length }), t("secondaryTimelineView.newestFirst"), timeline.page?.truncated ? t("secondaryTimelineView.onlyTheRecentWindowIsLoaded") : null]} /> : null}
      </View>} />
  </View>;
}
