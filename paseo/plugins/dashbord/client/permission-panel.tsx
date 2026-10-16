import { TextParts } from "./core-text";
import { t } from "../shared/text";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "./fleet-client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { answerPermission, permissionView, type PermissionChoice, type PermissionPart, type PermissionView } from "../shared/permissions";
import { summarizeRequest } from "../shared/model";
import { aria, Badge, Banner, Button, MetaLine, Skeleton, fontSize, hairline, hue, radius, space, toneColor, type Tone } from "./kit";
import { Flash, Pop } from "./motion";
import { monoFont } from "./ui";
import { useForeground } from "./use-foreground";

type Phase =
  | { kind: "idle" }
  /** A lasting choice waits for its second tap. */
  | { kind: "arming"; choice: PermissionChoice }
  | { kind: "busy"; choice: PermissionChoice }
  | { kind: "done"; choice: PermissionChoice; stillRunning: boolean }
  | { kind: "elsewhere" }
  | { kind: "unconfirmed"; choice: PermissionChoice }
  | { kind: "error"; message: string };

/** Approve green, deny red, anything that outlasts this request amber. */
const toneOf = (choice: PermissionChoice): Tone => choice.lasting ? "amber" : choice.behavior === "allow" ? "green" : "red";
const iconOf = (choice: PermissionChoice) => choice.interrupt ? "OctagonX" : choice.lasting ? "Infinity" : choice.behavior === "allow" ? "Check" : "X";
const doneText = (choice: PermissionChoice) => choice.interrupt ? t("corePermissionPanel.deniedAndInterrupted") : choice.behavior === "allow" ? t("corePermissionPanel.approved") : t("corePermissionPanel.denied");
/** The answered request stays on screen this long before the caller reads the Agent again (and it disappears). */
const SETTLE_MS = 1200;

/**
 * 就地审批 (opus-B12): one tool request with everything it would do — title, command or parameters (long ones expand),
 * working directory — and the provider's own choices, answered exactly as chosen. The Agent is read before (is it still
 * waiting?) and after (did the host drop it?); `respondToPermission` itself has no receipt. Never batch, never automatic:
 * one tap answers one request, and a lasting choice (always allow, allow for the session) takes a second tap.
 */
export function PermissionPanel({ theme, agentId, agentCwd, request, compact = false, onSettled }: {
  theme: PluginTheme; agentId: string; agentCwd?: string | null; request: unknown; compact?: boolean;
  /** The request was answered here or elsewhere: read the Agent again. */ onSettled?: () => void;
}) {
  const paseo = usePaseo(), toast = useToast(), { colors } = theme;
  const view = useMemo(() => permissionView(request, agentCwd), [request, agentCwd]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" }), [expanded, setExpanded] = useState(false);
  // One answer at a time, even for two taps quicker than a render.
  const mounted = useRef(true), inFlight = useRef(false), settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { mounted.current = false; if (settle.current) clearTimeout(settle.current); }, []);
  if (!view) return null;
  const settleLater = () => { if (settle.current) clearTimeout(settle.current); settle.current = setTimeout(() => { if (mounted.current) onSettled?.(); }, SETTLE_MS); };
  const answer = async (choice: PermissionChoice) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: "busy", choice });
    try {
      const outcome = await answerPermission(paseo.agents.ref(agentId), view.id, choice);
      // The list around it may drop the request (the directory saw it go) before the check here ends: the toast still says so.
      if (outcome.kind === "answered") toast.show(t("corePermissionPanel.message2", { value1: doneText(choice), value2: choice.fromProvider ? t("corePermissionPanel.message", { value1: choice.label }) : "", value3: view.title }), { variant: "success" });
      if (outcome.kind === "elsewhere") toast.show(t("corePermissionPanel.thisRequestWasAlreadyHandledElsewhere"));
      if (!mounted.current) return;
      if (outcome.kind === "answered") { setPhase({ kind: "done", choice, stillRunning: outcome.stillRunning }); settleLater(); }
      else if (outcome.kind === "elsewhere") { setPhase({ kind: "elsewhere" }); settleLater(); }
      else if (outcome.kind === "unconfirmed") setPhase({ kind: "unconfirmed", choice });
      else setPhase({ kind: "error", message: t("corePermissionPanel.thisAgentSStateIsTemporarilyUnavailable") });
    } catch (error) {
      if (mounted.current) setPhase({ kind: "error", message: t("corePermissionPanel.responseNotSent", { value1: error instanceof Error ? error.message : t("corePermissionPanel.tryAgainLater") }) });
    } finally { inFlight.current = false; }
  };
  const busy = phase.kind === "busy", settled = phase.kind === "done" || phase.kind === "elsewhere";
  const amber = hue(theme, "amber");
  return <View testID="permission-panel" accessibilityLabel={t("corePermissionPanel.approvalRequest", { value1: view.title })}
    style={{ borderRadius: radius.lg, borderWidth: hairline, borderColor: settled ? colors.border : hue(theme, "amber", "line"), backgroundColor: colors.surface1, overflow: "hidden" }}>
    {phase.kind === "done" ? <Flash count={1} color={hue(theme, phase.choice.behavior === "allow" ? "green" : "red", "soft")} /> : null}
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: settled ? "transparent" : hue(theme, "amber", "soft") }}>
      <Badge theme={theme} label={view.kind === "mode" ? t("corePermissionPanel.switchMode") : t("corePermissionPanel.pendingApproval")} tone={view.kind === "mode" ? "sky" : "amber"} icon={view.kind === "mode" ? "ToggleRight" : "Hand"} solid={!settled} />
      <Text selectable numberOfLines={3} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, color: colors.foreground, fontSize: fontSize.small, fontWeight: "600", lineHeight: 19 }}>{view.title}</Text>
    </View>
    <View style={{ gap: space.sm, padding: space.md }}>
      <RequestBody theme={theme} view={view} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      {phase.kind === "done" ? <Outcome theme={theme} choice={phase.choice} stillRunning={phase.stillRunning} />
        : phase.kind === "elsewhere" ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Icon name="CircleCheck" size={16} color={colors.foregroundMuted} />
          <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.small }}>{t("corePermissionPanel.thisRequestWasAlreadyHandledElsewhere")}</Text>
        </View>
        : <>
          {phase.kind === "unconfirmed" ? <Banner theme={theme} tone="warning" message={t("corePermissionPanel.sentButPaseoHasNotConfirmedIt", { value1: phase.choice.label })} /> : null}
          {phase.kind === "error" ? <Banner theme={theme} tone="danger" message={phase.message} /> : null}
          {phase.kind === "arming" ? <View accessibilityRole="alert" style={{ gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: hairline, borderColor: hue(theme, "amber", "line"), backgroundColor: hue(theme, "amber", "soft") }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
              <Icon name="TriangleAlert" size={16} color={amber} />
              <Text style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.small, lineHeight: 19 }}>{t("corePermissionPanel.appliesBeyondThisRequestSimilarRequestsMay", { value1: phase.choice.label })}</Text>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
              <Button theme={theme} tone="amber" icon="Infinity" label={t("corePermissionPanel.confirm", { value1: phase.choice.label })} grow={compact} accessibilityLabel={t("corePermissionPanel.confirm2", { value1: phase.choice.label, value2: view.title })} onPress={() => void answer(phase.choice)} />
              <Button theme={theme} variant="ghost" label={t("corePermissionPanel.goBack")} onPress={() => setPhase({ kind: "idle" })} />
            </View>
          </View>
            : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: compact ? space.md : space.sm, paddingTop: space.xs }}>
              {view.choices.map(choice => <Button key={choice.key} theme={theme} label={choice.label} icon={iconOf(choice)} variant={choice.interrupt ? "danger" : "secondary"} tone={toneOf(choice)} grow={compact}
                busy={busy && phase.choice.key === choice.key} disabled={busy} accessibilityLabel={t("corePermissionPanel.message3", { value1: choice.label, value2: view.title })} testID={`permission-choice-${choice.key}`}
                onPress={() => choice.lasting ? setPhase({ kind: "arming", choice }) : void answer(choice)} />)}
            </View>}
        </>}
    </View>
  </View>;
}

/** Characters of a part drawn while collapsed (its first lines show anyway); expanded, all the request holds. */
const PREVIEW_CHARS = 2000;
/**
 * Command, target, parameters, working directory and the provider's note; long ones collapse to a few lines, and 展开完整内容
 * shows every part whole (codex-obs-send-ui-F1). Only the screen shortens them: a part the request itself made too long to
 * keep, or a diff the host cut, says so in amber where it stops.
 */
export function RequestBody({ theme, view, expanded, onToggle }: { theme: PluginTheme; view: PermissionView; expanded: boolean; onToggle: () => void }) {
  const { colors } = theme;
  const long = (value: string | null, lines: number, chars: number) => !!value && (value.length > chars || value.split("\n", lines + 1).length > lines);
  const collapsible = long(view.command, 6, 360) || long(view.args, 4, 240) || long(view.params, 3, 200) || long(view.description, 3, 200) || long(view.target, 2, 160) || long(view.cwd, 2, 160);
  const shown = (value: string) => expanded || value.length <= PREVIEW_CHARS ? value : value.slice(0, PREVIEW_CHARS);
  const code = (value: string, lines: number, prefix = "") => <View style={{ paddingHorizontal: space.sm + 2, paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: colors.surface0, borderWidth: hairline, borderColor: colors.border }}>
    <Text selectable numberOfLines={expanded ? undefined : lines} style={{ color: colors.foreground, fontFamily: monoFont, fontSize: fontSize.small, lineHeight: 19 }}>{`${prefix}${shown(value)}`}</Text>
  </View>;
  const note = (message: string) => <View testID="permission-cut" style={{ flexDirection: "row", alignItems: "flex-start", gap: space.xs + 2 }}>
    <Icon name="Scissors" size={13} color={hue(theme, "amber")} />
    <Text style={{ flexShrink: 1, color: hue(theme, "amber", "text"), fontSize: fontSize.meta, lineHeight: 17, fontWeight: "600" }}>{message}</Text>
  </View>;
  const cut = (part: PermissionPart, what: string) => {
    const found = view.cut[part];
    if (!found) return null;
    // A list of parameters says how many did not fit whole: approving it approves those too (codex-obs-send-ui-F1).
    const items = found.items ? t("corePermissionPanel.parametersTotalTheLastAreNotShown", { value1: found.items.total.toLocaleString(), value2: (found.items.total - found.items.whole).toLocaleString() }) : "";
    return note(t("corePermissionPanel.wasTooLongAndWasTruncatedTo", { value1: what, value2: found.kept.toLocaleString(), value3: found.total.toLocaleString(), value4: items }));
  };
  return <View style={{ gap: space.sm }}>
    {view.tool ? <MetaLine theme={theme} parts={[t("corePermissionPanel.tool", { value1: view.tool }), view.provider]} /> : view.provider ? <MetaLine theme={theme} parts={[view.provider]} /> : null}
    {view.command ? code(view.command, 6, "$ ") : null}
    {cut("command", t("corePermissionPanel.command"))}
    {view.target ? <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
      <Icon name="FileCode" size={14} color={hue(theme, "violet")} />
      <Text selectable numberOfLines={expanded ? undefined : 2} style={{ flexShrink: 1, color: colors.foreground, fontFamily: monoFont, fontSize: fontSize.meta, lineHeight: 17 }}>{shown(view.target)}</Text>
    </View> : null}
    {cut("target", t("corePermissionPanel.target"))}
    {view.description ? <Text selectable numberOfLines={expanded ? undefined : 3} style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{shown(view.description)}</Text> : null}
    {cut("description", t("corePermissionPanel.description"))}
    {view.args ? code(view.args, 4) : null}
    {cut("args", t("corePermissionPanel.content"))}
    {view.hostCut !== null ? note(t("corePermissionPanel.paseoSentOnlyTheBeginningOfThis", { value1: view.hostCut.toLocaleString(), value2: view.params ? t("corePermissionPanel.theParametersBelowContainTheCompleteChanges") : "" })) : null}
    {view.params ? code(view.params, 3) : null}
    {cut("params", t("corePermissionPanel.parameters"))}
    {view.cwd ? <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
      <Icon name="FolderOpen" size={14} color={hue(theme, "blue")} />
      <Text numberOfLines={expanded ? undefined : 2} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>
        <TextParts id={view.cwdIsAgent ? "corePermissionPanel.agentWorkingDirectory" : "corePermissionPanel.workingDirectory"} values={{ directory: <Text selectable style={{ color: colors.foreground, fontFamily: monoFont }}>{shown(view.cwd)}</Text> }} />
      </Text>
    </View> : null}
    {cut("cwd", t("corePermissionPanel.workingDirectory3"))}
    {collapsible ? <Pressable accessibilityRole="button" accessibilityLabel={expanded ? t("corePermissionPanel.collapseRequestContent") : t("corePermissionPanel.expandFullRequestContent")} accessibilityState={{ expanded }} {...aria({ expanded })} onPress={onToggle} hitSlop={8}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "flex-start", minHeight: 24, opacity: state.pressed ? 0.7 : 1 })}>
      <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={toneColor(theme, "info")} />
      <Text style={{ color: toneColor(theme, "info"), fontSize: fontSize.meta, fontWeight: "600" }}>{expanded ? t("corePermissionPanel.collapse") : t("corePermissionPanel.expandFullContent")}</Text>
    </Pressable> : null}
  </View>;
}

function Outcome({ theme, choice, stillRunning }: { theme: PluginTheme; choice: PermissionChoice; stillRunning: boolean }) {
  const color = hue(theme, choice.behavior === "allow" ? "green" : "red");
  return <View style={{ gap: space.sm }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Pop count={1} size={18}><Icon name={choice.behavior === "allow" ? "CircleCheck" : "CircleX"} size={18} color={color} /></Pop>
      <Text style={{ flexShrink: 1, color: hue(theme, choice.behavior === "allow" ? "green" : "red", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{t("corePermissionPanel.decisionSummary", { decision: doneText(choice), detail: choice.fromProvider ? t("corePermissionPanel.decisionDetail", { label: choice.label }) : "" })}</Text>
    </View>
    {stillRunning ? <Banner theme={theme} tone="warning" message={t("corePermissionPanel.deniedButTheAgentIsStillRunning")} /> : null}
  </View>;
}

/**
 * The requests one Agent waits on, read from the Agent itself (`refresh()` only reads: it never loads it). Tool requests
 * are answered in place; a question or a plan is answered in the conversation (`onOpen`).
 */
export function AgentApprovals({ theme, agentId, compact = false, onOpen, onSettled }: { theme: PluginTheme; agentId: string; compact?: boolean; onOpen: () => void; onSettled?: () => void }) {
  const paseo = usePaseo(), foreground = useForeground(), { colors } = theme;
  const query = useQuery({ queryKey: ["observatory-approvals", agentId], queryFn: () => paseo.agents.ref(agentId).refresh(), staleTime: 3000, refetchOnWindowFocus: false,
    refetchInterval: foreground ? 8000 : false, retry: 1 });
  if (query.isPending) return <Skeleton theme={theme} rows={2} />;
  if (query.error) return <Banner theme={theme} tone="danger" message={t("corePermissionPanel.cannotReadThisAgentSRequests", { value1: query.error.message })} action={{ label: t("corePermissionPanel.retry"), onPress: () => void query.refetch() }} />;
  const agent = query.data?.agent ?? null;
  const views = (agent?.archivedAt ? [] : agent?.pendingPermissions ?? []).flatMap(request => { const view = permissionView(request, agent?.cwd); return view ? [{ request, view }] : []; });
  if (!views.length) return <MetaLine theme={theme} parts={[t("corePermissionPanel.noRequestsWaitingForYou")]} />;
  return <View style={{ gap: space.sm }}>
    {views.map(({ request, view }) => {
      if (view.inline) return <PermissionPanel key={view.id} theme={theme} agentId={agentId} agentCwd={agent?.cwd} request={request} compact={compact} onSettled={() => { void query.refetch(); onSettled?.(); }} />;
      // The question itself (or the plan's first line) rather than the provider's generic title.
      const title = summarizeRequest(request).title ?? view.title;
      return <View key={view.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: hairline, borderColor: colors.border }}>
        <Icon name={view.kind === "question" ? "MessageCircleQuestion" : view.kind === "plan" ? "ClipboardList" : "CircleHelp"} size={16} color={hue(theme, view.kind === "question" ? "violet" : "amber")} />
        <Text numberOfLines={2} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, color: colors.foreground, fontSize: fontSize.small }}>{view.kind === "question" ? t("corePermissionPanel.question", { value1: title }) : view.kind === "plan" ? t("corePermissionPanel.planAwaitingApproval", { value1: title }) : title}</Text>
        <Button theme={theme} size="sm" variant="ghost" icon="ArrowUpRight" label={view.kind === "question" ? t("corePermissionPanel.answer") : view.kind === "plan" ? t("corePermissionPanel.viewPlan") : t("corePermissionPanel.handle")} accessibilityLabel={t("corePermissionPanel.message3", { value1: view.kind === "question" ? t("corePermissionPanel.answer") : view.kind === "plan" ? t("corePermissionPanel.viewPlan") : t("corePermissionPanel.handle"), value2: title })} onPress={onOpen} />
      </View>;
    })}
  </View>;
}
