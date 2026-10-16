import { t } from "../shared/text";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ownTurnRunning, summarizeRequest, waitingKind, type AgentRecord, type PendingRequest } from "../shared/model";
import type { AgentResult } from "../shared/results";
import { object, string } from "../shared/timeline";
import { Badge, Banner, Button, EmptyState, MetaLine, Row, Skeleton, Spacer, fontSize, hairline, hue, radius, relativeTime, space, toneColor } from "./kit";
import { PaneLabel, monoFont } from "./ui";
import { OutputText } from "./output-text";
export { OutputText } from "./output-text";
import { permissionView } from "../shared/permissions";
import { PermissionPanel } from "./permission-panel";
import { QuickReplies } from "./quick-replies";
export interface ResultMessage { text: string; ref: string; at: string | null; completeOrigin?: boolean }
export type ResultData = AgentResult;

/** The first question stays pinned above the result while it scrolls; tap to read it in full. */
export function PinnedInput({ theme, message, confirmed, loading, inset }: { theme: PluginTheme; message: ResultMessage | null; confirmed: boolean; loading?: boolean; inset: number }) {
  const [expanded, setExpanded] = useState(false);
  const { colors } = theme;
  return <View style={{ paddingHorizontal: inset, paddingVertical: space.sm, gap: space.xs, backgroundColor: colors.surface0, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
    <Pressable accessibilityRole="button" accessibilityLabel={expanded ? t("secondaryResultView.collapseInitialInput") : t("secondaryResultView.expandInitialInput")} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} hitSlop={{ top: 6, bottom: 4 }}
      style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 24 }}>
      <Icon name="Pin" size={12} color={toneColor(theme, "amber", "mark")} />
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{t("secondaryResultView.initialInput")}</Text>
      {!confirmed && !loading ? <Badge theme={theme} label={t("secondaryResultView.startingPointUnconfirmed")} tone="warning" /> : null}
      <Spacer />
      <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
    </Pressable>
    <ScrollView style={{ maxHeight: expanded ? 180 : 44 }} nestedScrollEnabled scrollEnabled={expanded}>
      <Text selectable numberOfLines={expanded ? undefined : 2} style={{ color: colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{message?.text || (loading ? t("secondaryResultView.reading") : t("secondaryResultView.paseoDidNotRetainAConfirmed"))}</Text>
    </ScrollView>
  </View>;
}

const outcomeBadge = { passed: { get label() { return t("secondaryResultView.passed"); }, tone: "success", icon: "CircleCheck" }, failed: { get label() { return t("secondaryResultView.failed"); }, tone: "danger", icon: "CircleX" }, unknown: { get label() { return t("secondaryResultView.unconfirmed"); }, tone: "neutral", icon: "CircleHelp" } } as const;
export function ResultView({ theme, agent, data, loading, error, header, lead, inset, compact = inset < space.xl, pending = 0, permissions = [], onResolvePermissions, onPermissionsChanged, onReplied, onOpenEvidence, onRefresh }: {
  theme: PluginTheme; agent: AgentRecord; data?: ResultData; loading: boolean; error?: string | null; header?: ReactNode; inset: number; compact?: boolean; pending?: number; permissions?: readonly Record<string, unknown>[];
  /** Shown before the reply, e.g. the 定时任务 card of an Agent a schedule created. */ lead?: ReactNode;
  onResolvePermissions?: () => void;
  /** A request was answered here (or found answered elsewhere): read the Agent's pending requests again. */ onPermissionsChanged?: () => void;
  /** A quick reply went out. */ onReplied?: () => void;
  onOpenEvidence: (ref: string) => void; onRefresh: () => void;
}) {
  const { colors } = theme;
  const toast = useToast();
  const reply = data?.latestReply;
  const state = ownTurnRunning(agent) || data?.isRunning ? t("secondaryResultView.running") : data?.isFinal ? t("secondaryResultView.turnResult") : null;
  // 快捷回复 (opus-B26): only under the reply the category was read from, never for subagents (their parent answers them); they
  // answer this turn only (P1-1), and with the whole reply right above them they need no quote.
  const nudge = agent.replyNudge && !agent.parentAgentId && !agent.archivedAt && pending === 0 && !ownTurnRunning(agent) && !data?.isRunning ? agent.replyNudge : null;
  const copy = () => { if (!reply) return; void copyText(reply.text).then(() => toast.show(t("secondaryResultView.latestReplyCopied"), { variant: "success" })).catch(() => toast.error(t("secondaryResultView.copyFailedTouchAndHoldTo"))); };
  // The header slot is always rendered: web counts null children when indexing sticky headers, native drops them.
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: space.xxl }} stickyHeaderIndices={[1]}>
    <View style={{ paddingHorizontal: inset }}>{header}</View>
    <PinnedInput theme={theme} message={data?.firstInput ?? null} confirmed={data?.coverage.firstInputConfirmed === true} loading={loading} inset={inset} />
    <View style={{ paddingHorizontal: inset, paddingTop: space.lg, gap: space.xl }}>
      {lead}
      {pending > 0 ? <PendingRequests theme={theme} agent={agent} pending={pending} permissions={permissions} compact={compact} onResolve={onResolvePermissions} onChanged={onPermissionsChanged} /> : null}
      {error ? <Banner theme={theme} tone="danger" message={error} action={{ label: t("secondaryResultView.retry"), onPress: onRefresh }} /> : null}
      <View style={{ gap: space.sm }}>
        <PaneLabel theme={theme} icon="MessageSquareText" tone="info" trailing={<MetaLine theme={theme} parts={[reply?.at ? relativeTime(reply.at) : null, state]} />}>{t("secondaryResultView.latestReply")}</PaneLabel>
        {reply ? <>
          <OutputText theme={theme} text={reply.text} agentId={agent.id} replyRef={reply.ref} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginLeft: -space.md + 2 }}>
            <Button theme={theme} label={t("secondaryResultView.copy")} icon="Copy" variant="ghost" size="sm" accessibilityLabel={t("secondaryResultView.copyLatestReply")} onPress={copy} />
            <Button theme={theme} label={t("secondaryResultView.viewInTimeline")} icon="ListTree" variant="ghost" size="sm" accessibilityLabel={t("secondaryResultView.viewReplyContext")} onPress={() => onOpenEvidence(reply.ref)} />
          </View>
          {nudge ? <View style={{ padding: space.md, borderRadius: radius.lg, borderWidth: hairline, borderColor: hue(theme, "violet", "line"), backgroundColor: hue(theme, "violet", "soft") }}>
            <QuickReplies key={`${agent.id}:${agent.lastUserMessageAt ?? ""}:${agent.observedTurnStartedAt ?? ""}:${nudge}`} theme={theme} agentId={agent.id} agentTitle={agent.title || t("secondaryResultView.unnamedAgent")} nudge={nudge} expectPrompt={agent.lastUserMessageAt} expectRound={agent.observedTurnStartedAt ?? null} compact={compact} onSent={onReplied} />
          </View> : null}
        </> : loading ? <Skeleton theme={theme} rows={3} /> : <EmptyState theme={theme} icon="MessageSquare" title={t("secondaryResultView.noRepliesYet")} message={t("secondaryResultView.newRepliesAppearAutomaticallyViewProgress")} />}
      </View>
      {data?.testEvidence.length ? <View>
        <PaneLabel theme={theme} icon="ShieldCheck" tone="success">{t("secondaryResultView.verificationEvidence")}</PaneLabel>
        <View style={{ marginHorizontal: -space.md }}>{data.testEvidence.map((item, index) => {
          const badge = outcomeBadge[item.outcome];
          return <Row key={`${item.ref}:${index}`} theme={theme} title={item.command} titleLines={2} onPress={() => onOpenEvidence(item.ref)} accessibilityLabel={t("secondaryResultView.viewVerification", { value1: item.command })}
            leading={<Icon name={badge.icon} size={16} color={toneColor(theme, badge.tone)} />} trailing={<Badge theme={theme} label={badge.label} tone={badge.tone} />}
            subtitle={<MetaLine theme={theme} numberOfLines={2} parts={[item.text.split("\n").find(line => line.trim())?.slice(0, 240)]} />} />;
        })}</View>
      </View> : null}
      {data?.artifacts.length ? <View>
        <PaneLabel theme={theme} icon="FileCode" tone="violet">{t("secondaryResultView.filesAndArtifacts")}</PaneLabel>
        <View style={{ marginHorizontal: -space.md }}>{data.artifacts.map((item, index) => <Row key={`${item.ref}:${index}`} theme={theme} title={item.path} titleLines={2} onPress={() => onOpenEvidence(item.ref)} accessibilityLabel={t("secondaryResultView.viewArtifact", { value1: item.path })}
          leading={<Icon name={item.kind === "url" ? "Link" : "FileCode"} size={16} color={toneColor(theme, item.kind === "url" ? "cyan" : "violet", "mark")} />} trailing={<Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />} />)}</View>
      </View> : null}
      {data?.latestUserInput && data.latestUserInput.ref !== data.firstInput?.ref ? <View style={{ gap: space.xs }}>
        <PaneLabel theme={theme} icon="CornerDownRight" tone="amber">{t("secondaryResultView.latestAdditionalInput")}</PaneLabel>
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 20 }}>{data.latestUserInput.text}</Text>
      </View> : null}
      {data?.coverage.truncated ? <MetaLine theme={theme} numberOfLines={2} parts={[t("secondaryResultView.onlyContentRetainedByPaseoIs")]} /> : null}
    </View>
  </ScrollView>;
}
const requestKinds: Record<PendingRequest["kind"], { label: string; tone: "amber" | "violet" | "sky" | "gray"; icon: string }> = {
  tool: { get label() { return t("secondaryResultView.permission"); }, tone: "amber", icon: "Hand" }, plan: { get label() { return t("secondaryResultView.plan"); }, tone: "amber", icon: "ClipboardList" }, question: { get label() { return t("secondaryResultView.question"); }, tone: "violet", icon: "MessageCircleQuestion" },
  mode: { get label() { return t("secondaryResultView.switchMode"); }, tone: "sky", icon: "ToggleRight" }, other: { get label() { return t("secondaryResultView.request"); }, tone: "gray", icon: "CircleHelp" },
};
/**
 * What the Agent waits on (opus-F12): a question with its choices or a plan to approve, both answered in the conversation
 * (it has the full request), or a tool to allow, answered right here with the provider's own choices (opus-B12).
 */
function PendingRequests({ theme, agent, pending, permissions, compact, onResolve, onChanged }: { theme: PluginTheme; agent: AgentRecord; pending: number; permissions: readonly Record<string, unknown>[]; compact: boolean;
  onResolve?: () => void; onChanged?: () => void }) {
  const { colors } = theme, waiting = waitingKind(agent);
  const requests = permissions.map(request => ({ request, id: string(request.id), inline: !agent.archivedAt && !!permissionView(request, agent.cwd)?.inline, ...summarizeRequest(request) }));
  const message = waiting === "question" ? pending > 1 ? t("secondaryResultView.theAgentHasQuestionsForYou", { count: pending }) : t("secondaryResultView.theAgentHasAQuestionFor") : waiting === "plan" ? t("secondaryResultView.theAgentHasAPlanReady") : t("secondaryResultView.waitingForYouToApproveRequests", { count: pending });
  return <View style={{ gap: space.sm }}>
    <Banner theme={theme} tone={waiting === "question" ? "violet" : "warning"} icon={waiting === "question" ? "MessageCircleQuestion" : waiting === "plan" ? "ClipboardList" : undefined} message={message}
      action={onResolve ? { label: waiting === "question" ? t("secondaryResultView.answer") : waiting === "plan" ? t("secondaryResultView.viewPlan") : t("secondaryResultView.review"), onPress: onResolve } : undefined} />
    {requests.map((request, index) => { const look = requestKinds[request.kind];
      if (request.inline) return <PermissionPanel key={request.id || index} theme={theme} agentId={agent.id} agentCwd={agent.cwd} request={request.request} compact={compact} onSettled={onChanged} />;
      return <View key={request.id || index} style={{ gap: 4, paddingHorizontal: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Badge theme={theme} label={look.label} tone={look.tone} icon={look.icon} />
          <Text numberOfLines={3} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "600", lineHeight: 19 }}>{request.title || t("secondaryResultView.pendingRequest")}</Text>
        </View>
        {request.options.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>{request.options.map(option => <Badge key={option} theme={theme} label={option} tone="violet" />)}</View> : null}
        {request.detail ? <Text selectable numberOfLines={3} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17, fontFamily: request.kind === "tool" ? monoFont : undefined }}>{request.detail}</Text> : null}
      </View>; })}
  </View>;
}
export const permissionRequests = (snapshot: unknown) => { const value = object(snapshot); return Array.isArray(value.pendingPermissions) ? value.pendingPermissions.map(object) : []; };
