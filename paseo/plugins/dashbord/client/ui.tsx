import { t } from "../shared/text";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { completionReadState, stopShown, stopUnseen, waitingKind, type AgentRecord, type AgentStatus } from "../shared/model";
import { stopLabels } from "../shared/stop-reason";
import { IconButton, ProjectMark, Sheet, StatusDot, fontSize, hairline, hue, radius, space, toneColor, type Tone } from "./kit";
import { useForeground } from "./use-foreground";

/** Plugin-local building blocks on top of the shared kit (./kit.tsx stays a verbatim copy). */
export const statusNames: Record<AgentStatus, string> = {
  get running() { return t("secondaryUi.running"); }, get waiting() { return t("secondaryUi.waitingForApproval"); }, get idle() { return t("secondaryUi.waitingForReply"); }, get completed() { return t("secondaryUi.completed"); }, get quiet() { return t("secondaryUi.idle"); },
  get error() { return t("secondaryUi.error"); }, get initializing() { return t("secondaryUi.starting"); }, get closed() { return t("secondaryUi.closed"); }, get canceled() { return t("secondaryUi.canceled"); },
};
export const statusTones: Record<AgentStatus, Tone> = {
  running: "info", initializing: "info", waiting: "warning", error: "danger", completed: "success", idle: "violet", quiet: "neutral", closed: "neutral", canceled: "neutral",
};
export const monoFont = Platform.OS === "ios" ? "Menlo" : "monospace";

/** The state a row is announced with: a question or a plan is not an ordinary approval, a usage limit not an ordinary stop. */
export function stateName(agent: AgentRecord): string {
  const waiting = waitingKind(agent);
  if (waiting === "question") return t("secondaryUi.question");
  if (waiting === "plan") return t("secondaryUi.planNeedsApproval");
  // The row shows why the turn stopped (额度用尽 / 空轮 / 可能未收尾) wherever the stop applies; it is announced the same way.
  if (stopShown(agent)) return stopLabels[agent.stop!.kind];
  return statusNames[agent.status];
}
/** Screen-reader state of a session; completed ones say whether their result was read. */
export function readLabel(agent: AgentRecord): string {
  const state = completionReadState(agent), waiting = waitingKind(agent);
  if (waiting === "question") return t("secondaryUi.questionWaitingForYourAnswer");
  if (waiting === "plan") return t("secondaryUi.planNeedsApprovalWaitingForYou");
  if (stopShown(agent)) return agent.stop?.kind === "quota" ? t("secondaryUi.quotaExhaustedWaitingForReset")
    : t("secondaryUi.message", { value1: stateName(agent), value2: stopUnseen(agent) ? t("secondaryUi.notReadYet") : t("secondaryUi.read") });
  return state === "unread" ? t("secondaryUi.completedResultUnread") : state === "read" ? t("secondaryUi.completedRead") : agent.background && agent.status === "running" ? t("secondaryUi.runningBackgroundSubtasksActive") : statusNames[agent.status];
}
export function checkoutName(agent: AgentRecord): string {
  return agent.checkoutKind === "worktree" ? agent.worktreeName || t("secondaryUi.unnamedWorktree") : agent.checkoutKind === "main" ? t("secondaryUi.mainWorkspace") : agent.checkoutKind === "directory" ? t("secondaryUi.localFolder") : t("secondaryUi.unknownWorkspace");
}
export const providerLine = (agent: Pick<AgentRecord, "provider" | "model">) => agent.model ? `${agent.provider} · ${agent.model}` : agent.provider;

/** 42 秒 / 8 分 / 2 小时 5 分 — list-sized durations that change at most once a minute after the first. */
export function shortDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return t("secondaryUi.sec", { value1: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("secondaryUi.min", { value1: minutes });
  return minutes % 60 ? t("secondaryUi.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 }) : t("secondaryUi.hours", { hours: Math.floor(minutes / 60) });
}

/** A foreground-only clock; hidden views never re-render on a timer. */
export function useClock(intervalMs: number): number {
  const foreground = useForeground();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!foreground) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [foreground, intervalMs]);
  return now;
}

/** StatusDot, except in-progress work is a ring: Paseo light ships accent and success in the same green (kit request). */
export function StateDot({ theme, tone, size = 8 }: { theme: PluginTheme; tone: Tone; size?: number }) {
  if (tone !== "accent") return <StatusDot theme={theme} tone={tone} size={size} />;
  return <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: toneColor(theme, "accent", "mark") }} />;
}

/** project · worktree · branch on one line: the project's colour mark, git parts in violet; each part keeps its own accessible name. */
export function IdentityLine({ theme, agent, project = true, compact = false }: { theme: PluginTheme; agent: AgentRecord; project?: boolean; compact?: boolean }) {
  const muted = theme.colors.foregroundMuted, git = hue(theme, "violet");
  const parts: Array<{ key: string; label: string; text: string; icon?: string }> = [];
  if (project) parts.push({ key: "project", label: t("secondaryUi.project", { value1: agent.projectName }), text: agent.projectName });
  // Phones keep two parts: a worktree is usually named after its branch.
  if (agent.checkoutKind === "worktree" && !(compact && agent.branch)) parts.push({ key: "worktree", label: t("secondaryUi.worktree", { name: checkoutName(agent) }), text: checkoutName(agent), icon: "GitFork" });
  else if (!agent.branch) parts.push({ key: "checkout", label: t("secondaryUi.workspaceType", { value1: checkoutName(agent) }), text: checkoutName(agent) });
  if (agent.branch) parts.push({ key: "branch", label: t("secondaryUi.branch", { value1: agent.branch }), text: agent.branch, icon: "GitBranch" });
  return <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, minWidth: 0, gap: space.xs + 2 }}>
    {parts.map((part, index) => <Fragment key={part.key}>
      {index > 0 ? <Text style={{ color: muted, fontSize: fontSize.meta }}>·</Text> : null}
      <View accessibilityLabel={part.label} style={{ flexDirection: "row", alignItems: "center", gap: part.key === "project" ? 5 : 3, flexShrink: 1, minWidth: 0 }}>
        {part.key === "project" ? <ProjectMark theme={theme} name={part.text} size={14} /> : null}
        {part.icon ? <Icon name={part.icon} size={12} color={git} /> : null}
        <Text numberOfLines={1} style={{ flexShrink: 1, color: muted, fontSize: fontSize.meta, lineHeight: 17 }}>{part.text}</Text>
      </View>
    </Fragment>)}
  </View>;
}

/** Label / value pair for diagnostics. Values are selectable; long paths wrap instead of overflowing. */
export function KeyValue({ theme, label, value, mono = false, compact }: { theme: PluginTheme; label: string; value: string; mono?: boolean; compact: boolean }) {
  return <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 2 : space.md, paddingVertical: space.sm, borderBottomWidth: hairline, borderBottomColor: theme.colors.border }}>
    <Text style={{ width: compact ? undefined : 132, color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 20 }}>{label}</Text>
    <Text selectable style={{ flex: compact ? undefined : 1, minWidth: 0, color: theme.colors.foreground, fontSize: mono ? fontSize.meta : fontSize.small, lineHeight: 20, fontFamily: mono ? monoFont : undefined }}>{value}</Text>
  </View>;
}

export interface Stat { label: string; value: string; tone?: Tone }
/** A calm row of numbers: value above a muted label. `columns` gives an even grid on narrow panes. */
export function StatRow({ theme, stats, size = "md", columns }: { theme: PluginTheme; stats: readonly Stat[]; size?: "md" | "lg"; columns?: number }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: columns ? 0 : space.xl, rowGap: space.md }}>
    {stats.map(stat => <View key={stat.label} style={{ gap: 2, minWidth: 64, ...(columns ? { width: `${100 / columns}%` as const, paddingRight: space.sm } : {}) }}>
      <Text numberOfLines={1} style={{ color: stat.tone ? toneColor(theme, stat.tone) : theme.colors.foreground, fontSize: size === "lg" ? fontSize.heading : fontSize.title, fontWeight: "500" }}>{stat.value}</Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{stat.label}</Text>
    </View>)}
  </View>;
}

/** Small uppercase-free section label used inside detail panes. */
export function PaneLabel({ theme, children, trailing, icon, tone }: { theme: PluginTheme; children: string; trailing?: ReactNode; icon?: string; tone?: Tone }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 28 }}>
    {icon ? <Icon name={icon} size={13} color={tone ? toneColor(theme, tone, "mark") : theme.colors.foregroundMuted} /> : null}
    <Text style={{ flex: 1, color: tone ? toneColor(theme, tone) : theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: tone ? "600" : "500" }}>{children}</Text>
    {trailing}
  </View>;
}

/** ⓘ that opens caveats in a sheet instead of printing paragraphs in the main UI. */
export function InfoButton({ theme, title, lines }: { theme: PluginTheme; title: string; lines: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return <>
    <IconButton theme={theme} icon="Info" label={title} size="sm" onPress={() => setOpen(true)} />
    <Sheet title={title} open={open} onClose={() => setOpen(false)}>
      {lines.map(line => <Text key={line} style={{ color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{line}</Text>)}
    </Sheet>
  </>;
}

export interface ChoiceOption<Value extends string> { value: Value; label: string; count?: number; hint?: string; leading?: ReactNode }
/** Single-choice list for sheets: one row per option, a check on the selected one. */
export function ChoiceList<Value extends string>({ theme, options, value, onChange }: { theme: PluginTheme; options: readonly ChoiceOption<Value>[]; value: Value; onChange: (value: Value) => void }) {
  const { colors } = theme;
  return <View style={{ marginHorizontal: -space.sm }}>
    {options.map(option => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ selected }} onPress={() => onChange(option.value)}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.md, backgroundColor: selected ? colors.surface2 : (state as { hovered?: boolean }).hovered ? colors.surface1 : "transparent" })}>
        {option.leading ?? null}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: selected ? "500" : "400" }}>{option.label}</Text>
          {option.hint ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{option.hint}</Text> : null}
        </View>
        {option.count !== undefined ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{option.count}</Text> : null}
        <View style={{ width: 16 }}>{selected ? <Icon name="Check" size={16} color={colors.foreground} /> : null}</View>
      </Pressable>;
    })}
  </View>;
}

/** On/off switch (kit request: a shared Switch). Exposes role=switch with aria-checked for tests and screen readers. */
export function Switch({ theme, label, value, onChange, disabled = false }: { theme: PluginTheme; label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const { colors } = theme;
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} aria-checked={value} aria-disabled={disabled} disabled={disabled} onPress={() => onChange(!value)} hitSlop={8}
    style={state => ({ opacity: disabled ? 0.45 : state.pressed ? 0.8 : 1 })}>
    <View style={{ width: 36, height: 20, borderRadius: 10, padding: 2, alignItems: value ? "flex-end" : "flex-start", justifyContent: "center", backgroundColor: value ? colors.accent : colors.surface2, borderWidth: value ? 0 : hairline, borderColor: colors.border }}>
      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: value ? colors.accentForeground : colors.foregroundMuted }} />
    </View>
  </Pressable>;
}
