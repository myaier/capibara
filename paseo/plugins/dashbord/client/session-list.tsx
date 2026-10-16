import { hostEntityId } from "../shared/fleet-scope";
import { joinList } from "../shared/i18n";
import { t } from "../shared/text";
import { memo, useCallback, useMemo, useRef, type ReactNode, type Ref } from "react";
import { Pressable, Text, View, type FlatList as NativeFlatList, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { contextPressure, type AgentRecord, type AgentTodo, type AgentTreeNode } from "../shared/model";
import type { DashboardGroup, DashboardRow } from "../shared/dashboard-model";
import { reasonLine, type AttentionPhase, type ReasonLine } from "../shared/attention";
import type { HeartbeatSummary } from "../shared/schedules";
import { harnessOf, type Harness } from "../shared/harness";
import type { ProviderBases } from "../shared/provider-bases";
import { MetaLine, ProjectMark, aria, fontSize, hairline, hue as paletteHue, hueFor, radius, relativeTime, space } from "./kit";
import { agentProjectRef, useProjectIdentityResolver } from "./project-identity";
import { providerLine, readLabel, shortDuration, stateName } from "./ui";
import { Flash, Pop, motionKey, useChangeCount, useReorderMotion } from "./motion";
import { LiveTimer, PhasePill, PhaseTag, Spinner, StatusGlyph, activePhases, hueColor, loudPhases, phaseOf, phases, tint, tintAlpha, type Hue, type Phase } from "./status";
import { ScheduleBadge } from "./schedule-looks";
import { HeartbeatBadge } from "./heartbeat-card";
import { openExternalUrl } from "./open-url";
import type { OpenSessionActions } from "./session-actions";
import { IconButton } from "./kit";

export const groupTitles: Record<DashboardGroup, string> = { get attention() { return t("secondarySessionList.needsYou"); }, get running() { return t("secondarySessionList.running"); },
  get waiting() { return t("secondarySessionList.awaitingReply"); }, get done() { return t("secondarySessionList.completed"); }, get quiet() { return t("secondarySessionList.idle"); }, get closed() { return t("secondarySessionList.closed"); }, get recent() { return t("secondarySessionList.recent"); } };
export type SessionItem =
  | { kind: "section"; key: string; group: DashboardGroup; title: string; count: number }
  /**
   * `childAttention`: descendants that need you, with the most urgent one's phase (`childPhase`), so a collapsed thread pulled
   * into 需要处理 says why; `childUnread`: the unread ones not among them (shared/attention.ts `threadAttention`).
   */
  | { kind: "row"; key: string; row: DashboardRow; hostLabel?: string; serverId?: string; childUnread: number; childAttention: number; childPhase: AttentionPhase | null; childRunning: number; snoozed: boolean };

/** Running turns show elapsed time; everything else the latest activity. */
export function agentTimeLabel(agent: AgentRecord, now: number): string {
  return agent.activeTurnStartedAt ? shortDuration(Math.max(0, now - Date.parse(agent.activeTurnStartedAt))) : relativeTime(agent.lastActivityAt || agent.updatedAt || agent.createdAt, now);
}
function countDescendants(row: DashboardRow, match: (agent: AgentRecord) => boolean): number {
  let count = 0;
  const stack: AgentTreeNode[] = [...row.node.children];
  while (stack.length) { const child = stack.pop()!; if (match(child.agent)) count++; stack.push(...child.children); }
  return count;
}
export const countRunningDescendants = (row: DashboardRow) => countDescendants(row, agent => agent.status === "running" || agent.status === "initializing");

/** What sits at the end of the title line: a ticking timer for live work, otherwise the state's own coloured tag. */
function trailingFor(agent: AgentRecord, phase: Phase, signal: string | undefined, theme: PluginTheme, timeLabel: string): { node: ReactNode; pill: boolean } {
  const pill = (hue: Hue, label: string, icon?: string, solid = false) => ({ node: <PhasePill theme={theme} hue={hue} label={label} icon={icon} solid={solid} />, pill: true });
  if (phase === "approval") return { node: <PhaseTag theme={theme} phase={phase} count={agent.pendingPermissionCount} />, pill: true };
  if (signal?.startsWith(t("secondarySessionList.failed"))) return pill("red", signal, undefined, true);
  if (signal && phase === "running") return pill("amber", signal, "Clock3");
  if (phase === "running" && agent.activeTurnStartedAt) return { node: <LiveTimer since={agent.activeTurnStartedAt} color={hueColor(theme, "blue", "text")} />, pill: false };
  // Its own turn is over and subagents still work: 「后台」 with their run time when known.
  if (phase === "running" && agent.background) return { node: agent.background.since ? <LiveTimer since={agent.background.since} prefix={t("secondarySessionList.background")} color={hueColor(theme, "blue", "text")} />
    : <Text style={{ color: hueColor(theme, "blue", "text"), fontSize: fontSize.meta, fontWeight: "600" }}>{t("secondarySessionList.runningInBackground")}</Text>, pill: false };
  if (phase === "running" || phase === "starting") return { node: <Text style={{ color: hueColor(theme, phases[phase].hue, "text"), fontSize: fontSize.meta, fontWeight: "600" }}>{phases[phase].label}</Text>, pill: false };
  if (phase === "closed" || phase === "canceled") return { node: <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{timeLabel}</Text>, pill: false };
  if (signal) return pill("amber", signal, "Clock3");
  return { node: <PhaseTag theme={theme} phase={phase} />, pill: true };
}

/** The one-line reason under a row that needs you (opus-B3); a plain 未读 / 待回复 without the host's note says nothing new. */
function rowReason(agent: AgentRecord, phase: Phase, now: number): ReasonLine | null {
  if (!activePhases.has(phase) || phase === "running" || phase === "starting") return null;
  if ((phase === "unread" || phase === "idle") && !agent.note) return null;
  return reasonLine(agent, now);
}

/** Memoized: a clock tick re-renders only rows whose time label or signal changed; running timers tick on their own. */
export const SessionRow = memo(function SessionRow({ item, theme, compact, selected, expanded, timeLabel, signal, rate, harness, heartbeats, day, marked = false, onToggle, onSelect, onActions }: {
  item: Extract<SessionItem, { kind: "row" }>; theme: PluginTheme; compact: boolean; selected: boolean; expanded: boolean; timeLabel: string; signal?: string;
  /** Output tokens per second of a running agent (from the local provider logs), when it is writing. */
  rate?: number;
  /** The harness the agent runs on, marked at the front of the row's second line. */
  harness: Harness;
  /** Heartbeats that wake this Agent (opus-B8). */
  heartbeats?: readonly HeartbeatSummary[];
  /** The device's day (a limit's row: the clock): reasons say 明天 / 今天 relative to it. */
  day: number;
  /** Picked for 归档已读完成 and waiting for the confirmation (opus-B18). */
  marked?: boolean;
  onToggle: (agentId: string) => void; onSelect: (agentId: string) => void; onActions?: OpenSessionActions;
}) {
  const { colors } = theme;
  const { row, childUnread, childAttention, childPhase, childRunning, snoozed } = item;
  const agent = row.node.agent, children = row.node.children.length;
  const phase = phaseOf(agent, snoozed), active = activePhases.has(phase), color = hueColor(theme, phases[phase].hue), muted = phases[phase].hue === "muted";
  const reason = useMemo(() => rowReason(agent, phase, day), [agent, phase, day]);
  // A closed session's context matters only once it is loaded again, also when its row shows the turn the host cut off.
  const pressure = agent.archivedAt || agent.status === "closed" ? null : contextPressure(agent.usage);
  const link = agent.changeRequest ?? null;
  // Room the 「!128」 chip takes at the row's bottom right, so the meta or reason line never runs under it.
  const reserve = link ? 36 + 7 * link.label.length : 0;
  // Loud states tint the whole row a little; every coloured state keeps an edge in its colour.
  const marking = hueColor(theme, "red");
  const wash = marked ? tint(marking, tintAlpha(theme)) : !selected && loudPhases.has(phase) ? tint(color, tintAlpha(theme) * 0.45) : undefined;
  // A state change seen live flashes the row in the new state's color and pops its mark.
  const changes = useChangeCount(phase);
  const trailing = trailingFor(agent, phase, signal, theme, timeLabel);
  const speed = rate && phase === "running" ? rate : 0;
  const depth = Math.min(row.depth, compact ? 3 : 6);
  const checkout = agent.branch ?? (agent.checkoutKind === "worktree" ? agent.worktreeName : null);
  // Time outranks provider/model: when the line truncates, the model goes first.
  const time = trailing.pill ? timeLabel : null;
  const hostLabel = agent.hostOnline === false ? t("fleet.hostOffline", { host: agent.hostLabel ?? "" }) : item.hostLabel ?? agent.hostLabel;
  const meta = depth === 0 ? [hostLabel, agent.projectName, checkout, time, providerLine(agent)] : [hostLabel, time, providerLine(agent)];
  // The project wears Paseo's own color and icon (its key when placement metadata has one, else its host-local id).
  const projectRef = agentProjectRef(agent.projectId, item.serverId ?? null);
  const projectIdentity = useProjectIdentityResolver()(projectRef.serverId, projectRef.ref);
  const settled = phase === "closed" || phase === "canceled" || phase === "snoozed";
  const menuEvents = onActions ? {
    onContextMenu: (event: { preventDefault(): void; stopPropagation(): void; nativeEvent: { pageX?: number; pageY?: number } }) => {
      event.preventDefault(); event.stopPropagation(); const { pageX, pageY } = event.nativeEvent;
      onActions(agent.id, pageX === undefined || pageY === undefined ? undefined : { x: pageX, y: pageY });
    },
    onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); onActions(agent.id); }
    },
  } : {};
  return <View style={depth ? { marginLeft: 16 + (depth - 1) * 22, paddingLeft: 6, borderLeftWidth: hairline, borderLeftColor: colors.border } : undefined}>
    {/* The row and its chip share a box of their own, so the chip sits on the row's last line, never on the 子 Agent toggle. */}
    <View>
      <Pressable {...menuEvents} onLongPress={onActions ? () => onActions(agent.id) : undefined} accessibilityRole="button" accessibilityLabel={t("secondarySessionList.view", { value1: agent.title, value2: stateName(agent), value3: marked ? t("secondarySessionList.awaitingArchive") : "" })} accessibilityState={{ selected }} {...aria({ selected })} onPress={() => onSelect(agent.id)}
        style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, paddingLeft: space.md, paddingRight: onActions ? 38 : space.md, borderRadius: radius.md, opacity: row.context ? 0.62 : 1,
          backgroundColor: selected && !marked ? colors.surface2 : state.pressed || (state as { hovered?: boolean }).hovered ? colors.surface1 : wash ?? "transparent" })}>
        <Flash count={changes} color={tint(color, tintAlpha(theme) + 0.1)} radius={radius.md} />
        {marked ? <View style={{ position: "absolute", left: 0, top: 11, bottom: 11, width: 3, borderRadius: 2, backgroundColor: marking }} />
          : !muted ? <View style={{ position: "absolute", left: 0, top: 11, bottom: 11, width: 3, borderRadius: 2, backgroundColor: color, opacity: active ? 1 : 0.7 }} /> : null}
        <View accessibilityLabel={readLabel(agent)} style={{ minHeight: 20, justifyContent: "center" }}>
          <Pop count={changes} size={16}><StatusGlyph theme={theme} phase={phase} /></Pop>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
            <Text numberOfLines={2} style={{ flex: 1, color: settled ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.body, lineHeight: 20, fontWeight: active ? "600" : "500" }}>{agent.title || t("secondarySessionList.unnamedAgent")}</Text>
            <View style={{ minHeight: 20, justifyContent: "center", alignItems: "flex-end" }}>{trailing.node}</View>
          </View>
          {/* Chips first; when they leave too little room the project and time wrap to their own line instead of vanishing. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 5, rowGap: 3, paddingRight: link && !reason ? reserve : 0 }}>
            {/* Every row leads with its harness's mark, apart from any chip. */}
            <HarnessMark theme={theme} harness={harness} />
            {agent.background && phase === "running" ? <BackgroundChip theme={theme} agent={agent} /> : null}
            {agent.todo && phase === "running" ? <TodoChip theme={theme} todo={agent.todo} /> : null}
            {speed ? <View accessibilityLabel={t("secondarySessionList.harnessOutputtingTokensPerSecond", { harness: harness.name, value1: speed.toFixed(1) })} style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 5, height: 18, borderRadius: radius.full, backgroundColor: tint(hueColor(theme, "orange"), tintAlpha(theme)) }}>
              <Icon name="Zap" size={10} color={hueColor(theme, "orange")} />
              <Text style={{ color: hueColor(theme, "orange", "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{speed >= 100 ? Math.round(speed) : speed.toFixed(1).replace(/\.0$/, "")}{t("secondarySessionList.tokS")}</Text>
            </View> : null}
            {pressure ? <ContextChip theme={theme} percent={pressure.percent} critical={pressure.level === "critical"} /> : null}
            {heartbeats?.length ? <HeartbeatBadge theme={theme} heartbeats={heartbeats} /> : null}
            {agent.labels["paseo.schedule-id"] ? <ScheduleBadge theme={theme} /> : null}
            <View style={{ flex: 1, minWidth: 120, flexDirection: "row", alignItems: "center", gap: 5 }}>
              {depth === 0 ? <ProjectMark theme={theme} name={agent.projectName} size={14} color={projectIdentity?.color} icon={projectIdentity?.icon} /> : null}
              <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} parts={[...meta, row.node.cycleBroken ? t("secondarySessionList.aCycleInTheParentRelationship") : null]} /></View>
            </View>
          </View>
          {reason ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0, paddingRight: reserve }}>
            <Icon name={reason.icon} size={12} color={hueColor(theme, reason.hue)} />
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: hueColor(theme, reason.hue, "text"), fontSize: fontSize.meta, lineHeight: 17, fontWeight: "600" }}>{reason.text}</Text>
          </View> : null}
        </View>
      </Pressable>
      {onActions ? <View style={{ position: "absolute", top: 6, right: 2 }}><IconButton theme={theme} icon="Ellipsis" label={t("sessionActions.forSession", { title: agent.title })} onPress={() => onActions(agent.id)} /></View> : null}
      {/* A sibling of the row, not inside it: web must not nest buttons. */}
      {/* Chinese accessibility contract before catalog extraction: accessibilityLabel={`${expanded ? "收起" : "展开"} ${agent.title} 的子 agent`} */}
      {link ? <ChangeRequestChip theme={theme} link={link} /> : null}
    </View>
    {children > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={expanded ? t("secondarySessionList.collapseSubagents", { name: agent.title }) : t("secondarySessionList.expandSubagents", { name: agent.title })} accessibilityState={{ expanded }} {...aria({ expanded })} onPress={() => onToggle(agent.id)} hitSlop={{ top: 6, bottom: 8, left: 6, right: 6 }}
      style={state => ({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", alignSelf: "flex-start", gap: space.xs, marginLeft: 32, marginRight: space.sm, marginTop: -6, marginBottom: space.xs, minHeight: 24, paddingHorizontal: 6, borderRadius: radius.sm, backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface1 : "transparent" })}>
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondarySessionList.subagents", { count: children })}</Text>
      {childAttention > 0 && childPhase ? <ChildAttention theme={theme} count={childAttention} phase={childPhase} /> : null}
      {childRunning > 0 ? <><Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>·</Text><Spinner size={10} color={hueColor(theme, "run")} /><Text style={{ color: hueColor(theme, "run", "text"), fontSize: fontSize.meta }}>{t("secondarySessionList.running2", { value1: childRunning })}</Text></> : null}
      {childUnread > 0 ? <Text style={{ color: hueColor(theme, "pink", "text"), fontSize: fontSize.meta, fontWeight: "600" }}>{t("secondarySessionList.unread", { value1: childUnread })}</Text> : null}
    </Pressable> : null}
  </View>;
});

/** Chinese count contract before catalog extraction: {count} 个需要处理. Uses the most urgent child's color and mark (P3-3). */
function ChildAttention({ theme, count, phase }: { theme: PluginTheme; count: number; phase: AttentionPhase }) {
  const look = phases[phase];
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>·</Text>
    <Icon name={look.icon} size={11} color={hueColor(theme, look.hue)} />
    <Text style={{ color: hueColor(theme, look.hue, "text"), fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{t("secondarySessionList.needYou", { count: count })}</Text>
  </View>;
}

/** The harness's tile: brand colour with its glyph; ids without a known brand get a stable palette hue and their initial. */
export function HarnessMark({ theme, harness, size = 13 }: { theme: PluginTheme; harness: Harness; size?: number }) {
  const background = harness.color ?? paletteHue(theme, hueFor(harness.id));
  return <View testID={`harness-${harness.id}`} accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), alignItems: "center", justifyContent: "center", backgroundColor: background, borderWidth: hairline, borderColor: "rgba(255,255,255,0.22)" }}>
    {harness.icon ? <Icon name={harness.icon} size={size - 4} color="#ffffff" />
      : <Text style={{ color: "#ffffff", fontSize: harness.text && harness.text.length > 1 ? size * 0.5 : size * 0.66, lineHeight: size - 1, fontWeight: "800", textAlign: "center" }}>{harness.text}</Text>}
  </View>;
}

/** 「3/7 · 正在跑测试」: the running turn's todo list, how far it got and the step it is on (opus-B12). */
function TodoChip({ theme, todo }: { theme: PluginTheme; todo: AgentTodo }) {
  const color = hueColor(theme, "cyan"), text = hueColor(theme, "cyan", "text"), share = todo.total ? todo.done / todo.total : 0;
  return <View accessibilityLabel={t("secondarySessionList.taskProgress", { value1: todo.done, value2: todo.total, value3: todo.current ? t("secondarySessionList.workingOn", { value1: todo.current }) : "" })}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0, maxWidth: 240, paddingHorizontal: 6, height: 18, borderRadius: radius.full, backgroundColor: tint(color, tintAlpha(theme)) }}>
    <View style={{ width: 18, height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: tint(color, 0.3) }}><View style={{ width: `${Math.round(share * 100)}%`, height: 4, backgroundColor: color }} /></View>
    <Text style={{ color: text, fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{todo.done}/{todo.total}</Text>
    {todo.current ? <Text numberOfLines={1} style={{ flexShrink: 1, color: text, fontSize: 11, fontWeight: "600" }}>· {todo.current}</Text> : null}
  </View>;
}

/** 「上下文 87%」 amber from 85 %, red from 95 % (opus-B13): the Agent is about to compact or run out of room. */
function ContextChip({ theme, percent, critical }: { theme: PluginTheme; percent: number; critical: boolean }) {
  const hue: Hue = critical ? "red" : "amber", color = hueColor(theme, hue);
  return <View accessibilityLabel={t("secondarySessionList.contextUsed", { value1: percent, value2: critical ? t("secondarySessionList.almostFull") : "" })} style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 18, paddingHorizontal: 6, borderRadius: radius.full, backgroundColor: critical ? color : tint(color, tintAlpha(theme)) }}>
    <Icon name="Gauge" size={10} color={critical ? "#ffffff" : color} />
    <Text style={{ color: critical ? "#ffffff" : hueColor(theme, hue, "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{t("secondarySessionList.context", { value1: percent })}</Text>
  </View>;
}

/** 「!42」 / 「#17」: the merge or pull request a reply linked to (opus-B16); opens in the browser. */
function ChangeRequestChip({ theme, link }: { theme: PluginTheme; link: NonNullable<AgentRecord["changeRequest"]> }) {
  const toast = useToast(), hue: Hue = link.kind === "mr" ? "indigo" : "blue", color = hueColor(theme, hue);
  const open = () => { void openExternalUrl(link.url).catch(() => toast.error(t("secondarySessionList.couldNotOpenLinkYouCan"))); };
  return <Pressable accessibilityRole="link" accessibilityLabel={t("secondarySessionList.open", { value1: link.kind === "mr" ? t("secondarySessionList.mergeRequest") : t("secondarySessionList.pullRequest"), value2: link.label })} onPress={open} hitSlop={6}
    style={state => ({ position: "absolute", right: space.md, bottom: 10, flexDirection: "row", alignItems: "center", gap: 3, height: 20, paddingHorizontal: 7, borderRadius: radius.full,
      backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? tint(color, tintAlpha(theme) + 0.12) : tint(color, tintAlpha(theme)), borderWidth: hairline, borderColor: tint(color, 0.45) })}>
    <Icon name={link.kind === "mr" ? "GitMerge" : "GitPullRequest"} size={11} color={color} />
    <Text style={{ color: hueColor(theme, hue, "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{link.label}</Text>
  </Pressable>;
}

/** 「后台 · 实现折叠」: what the subagents still running after the Agent's own turn work on. */
function BackgroundChip({ theme, agent }: { theme: PluginTheme; agent: AgentRecord }) {
  const background = agent.background!, color = hueColor(theme, "blue");
  const label = background.running > 1 ? t("secondarySessionList.backgroundSubtasks", { value1: background.running }) : t("secondarySessionList.background2", { value1: background.labels[0] ?? t("secondarySessionList.subtasks") });
  return <View accessibilityLabel={t("secondarySessionList.backgroundSubtasksRunning", { value1: background.running, value2: background.labels.length ? t("secondarySessionList.message", { value1: joinList(background.labels) }) : "" })}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0, maxWidth: 220, paddingHorizontal: 6, height: 18, borderRadius: radius.full, backgroundColor: tint(color, tintAlpha(theme)) }}>
    <Spinner size={10} color={color} />
    <Text numberOfLines={1} style={{ flexShrink: 1, color: hueColor(theme, "blue", "text"), fontSize: 11, fontWeight: "700" }}>{label}</Text>
  </View>;
}

/** Group header with the group's own mark and colour: a waiting hand, a spinner for work in progress, then the settled states. */
const groupLooks: Record<Exclude<DashboardGroup, "running">, { icon: string; hue: Hue }> = {
  attention: { icon: "BellRing", hue: "warn" }, waiting: { icon: phases.idle.icon, hue: phases.idle.hue }, done: { icon: phases.done.icon, hue: phases.done.hue },
  quiet: { icon: phases.quiet.icon, hue: "muted" }, closed: { icon: phases.closed.icon, hue: "muted" }, recent: { icon: "History", hue: "muted" },
};
function GroupHeader({ theme, group, title, count }: { theme: PluginTheme; group: DashboardGroup; title: string; count: number }) {
  const { colors } = theme;
  const hue: Hue = group === "running" ? "run" : groupLooks[group].hue;
  return <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 32, paddingHorizontal: space.md, paddingTop: space.sm }}>
    {group === "running" ? <Spinner size={12} color={hueColor(theme, hue)} active={count > 0} /> : <Icon name={groupLooks[group].icon} size={12} color={hueColor(theme, hue)} />}
    <Text style={{ color: hueColor(theme, hue, "text"), fontSize: fontSize.meta, fontWeight: "600" }}>{title}</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{count}</Text>
  </View>;
}

export function SessionList({ items, theme, compact, selectedId, expanded, forceExpanded = false, now, signals, rates, bases, heartbeats, marked, empty, listRef, onScrollEnd, onToggle, onSelect, onActions }: {
  items: readonly SessionItem[]; theme: PluginTheme; compact: boolean; selectedId: string | null; expanded: ReadonlySet<string>; forceExpanded?: boolean; now: number; signals: ReadonlyMap<string, string>;
  rates?: ReadonlyMap<string, number>;
  /** Custom provider → the provider it extends, so `my-claude` shows Claude Code's mark. */
  bases?: ProviderBases;
  heartbeats?: ReadonlyMap<string, HeartbeatSummary[]>;
  /** Rows waiting for the 归档 confirmation. */
  marked?: ReadonlySet<string>;
  empty: ReactNode; listRef?: Ref<NativeFlatList<SessionItem>>; onScrollEnd?: (offset: number) => void;
  onToggle: (agentId: string) => void; onSelect: (agentId: string) => void; onActions?: OpenSessionActions;
}) {
  // Rows re-render only when a shown rate changes (rounded to 0.1 tok/s).
  const ratesKey = useMemo(() => [...(rates ?? [])].map(([id, rate]) => `${id}:${rate.toFixed(1)}`).join(","), [rates]);
  const scrollEnd = onScrollEnd ? (event: NativeSyntheticEvent<NativeScrollEvent>) => onScrollEnd(event.nativeEvent.contentOffset.y) : undefined;
  // Reordering glides instead of jumping (motion.tsx `useReorderMotion`); the list keeps its own handle beside the caller's.
  const own = useRef<NativeFlatList<SessionItem> | null>(null);
  const setList = useCallback((list: NativeFlatList<SessionItem> | null) => {
    own.current = list;
    if (typeof listRef === "function") listRef(list); else if (listRef) (listRef as { current: NativeFlatList<SessionItem> | null }).current = list;
  }, [listRef]);
  const keys = useMemo(() => items.map(item => item.key), [items]);
  useReorderMotion(keys, () => own.current?.getScrollableNode?.());
  return <FlatList ref={setList} data={items as SessionItem[]} keyExtractor={item => item.key} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: space.xs, paddingBottom: space.xl }}
    onScrollEndDrag={scrollEnd} onMomentumScrollEnd={scrollEnd}
    initialNumToRender={18} maxToRenderPerBatch={20} windowSize={7} keyboardShouldPersistTaps="handled" extraData={`${now}:${selectedId}:${expanded.size}:${forceExpanded}:${signals.size}:${ratesKey}:${heartbeats?.size ?? 0}:${marked?.size ?? 0}:${bases ? Object.keys(bases).length : -1}`}
    ListEmptyComponent={<View>{empty}</View>}
    renderItem={({ item }) => {
      if (item.kind === "section") return <View {...motionKey(item.key)}><GroupHeader theme={theme} group={item.group} title={item.title} count={item.count} /></View>;
      const agent = item.row.node.agent, id = agent.id, beats = heartbeats?.get(id);
      return <View {...motionKey(item.key)}><SessionRow item={item} theme={theme} compact={compact} selected={id === selectedId} expanded={forceExpanded || expanded.has(id)} timeLabel={agentTimeLabel(item.row.node.agent, now)}
        signal={signals.get(id)} rate={rates?.get(id)} harness={harnessOf(agent.provider, agent.hostId ? { [agent.provider]: bases?.[hostEntityId(agent.hostId, agent.provider)] ?? agent.provider } : bases)} heartbeats={beats} day={item.row.node.agent.stop ? now : dayOf(now)} marked={marked?.has(id) ?? false} onToggle={onToggle} onSelect={onSelect} onActions={onActions} /></View>;
    }} />;
}
/** Midnight of the device's day: rows without a live clock re-render once a day for 明天 / 今天. */
const dayOf = (now: number) => { const date = new Date(now); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
