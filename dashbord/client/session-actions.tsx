import { isInternalAgent } from "../shared/internal-agents";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "./fleet-client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { nameSessions, renameSession, sessionTitle, TITLE_SOURCE, SESSION_TITLE_MAX } from "../shared/session-actions";
import type { AgentRecord } from "../shared/model";
import { t } from "../shared/text";
import { Banner, Button, Sheet, fontSize, radius, space } from "./kit";
import { useForeground } from "./use-foreground";

export interface MenuPoint { x: number; y: number }
type PaseoApi = ReturnType<typeof usePaseo>;
export interface SessionActionTarget { serverId: string; agentId: string; title: string; archived: boolean }
export type OpenSessionActions = (id: string, point?: MenuPoint) => void;
export function useSessionActions(options: { hostId: string; target: (id: string) => SessionActionTarget | undefined;
  online: (serverId: string) => boolean; acquire: (serverId: string) => PaseoApi; refresh: () => unknown }) {
  const rename = useRpc(renameSession), toast = useToast();
  const [state, setState] = useState<{ target: SessionActionTarget; point?: MenuPoint; stage: "menu" | "rename" | "archive" } | null>(null);
  const [title, setTitle] = useState(""), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const currentOptions = useRef(options); currentOptions.current = options;
  const open: OpenSessionActions = useCallback((id, point) => {
    if (pending.current) return;
    const target = currentOptions.current.target(id); if (!target) return;
    setTitle(target.title); setError(null); setState({ target, point, stage: "menu" });
  }, []);
  const close = () => { if (!pending.current) { setState(null); setError(null); } };
  const save = async () => {
    if (!state || pending.current) return;
    const { target, stage } = state;
    if (!options.online(target.serverId)) { setError(t("sessionActions.offline")); return; }
    if (stage === "rename" && !sessionTitle.safeParse(title).success) { setError(t("sessionActions.invalidTitle")); return; }
    pending.current = true; setBusy(true); setError(null);
    try {
      if (stage === "rename") {
        await rename({ serverId: target.serverId, agentId: target.agentId, title, expectedTitle: target.title });
      } else {
        const handle = options.acquire(target.serverId).agents.ref(target.agentId);
        const current = (await handle.refresh())?.agent;
        if (!current) throw new Error(t("sessionActions.unavailable"));
        if (!current.archivedAt) await handle.archive();
        if (!(await handle.refresh())?.agent.archivedAt) throw new Error(t("sessionActions.archiveUnconfirmed"));
      }
      setState(null);
      toast.show(t(stage === "rename" ? "sessionActions.renamed" : "sessionActions.archived"), { variant: "success" });
      void options.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : t("sessionActions.failed")); }
    finally { pending.current = false; setBusy(false); }
  };
  return { state, title, setTitle, error, busy, close, save, open,
    online: !!state && options.online(state.target.serverId),
    canRename: !!state && options.online(state.target.serverId),
    choose(stage: "rename" | "archive") { setError(null); setState(previous => previous ? { ...previous, stage } : null); } };
}

/** Desktop uses the pointer position; phones and keyboard activation use the host's action sheet. */
function PointerMenu({ theme, point, actions, close }: { theme: PluginTheme; point: MenuPoint; close: () => void;
  actions: { key: string; label: string; icon: string; disabled: boolean; onPress: () => void; hint?: string }[] }) {
  const root = useRef<View>(null), buttons = useRef<Array<View | null>>([]), focused = useRef(0);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const place = () => root.current?.measureInWindow((x, y, width, height) => {
    setPosition({ left: Math.max(4, Math.min(point.x - x, width - 264)), top: Math.max(4, Math.min(point.y - y, height - 150)) });
  });
  const focus = (index: number) => { focused.current = index; (buttons.current[index] as unknown as { focus?: () => void })?.focus?.(); };
  useEffect(() => { place(); focus(Math.max(0, actions.findIndex(action => !action.disabled))); }, [point.x, point.y]);
  const keyboard = { onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const available = actions.flatMap((action, index) => action.disabled ? [] : [index]);
      if (!available.length) return;
      const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1
        : (available.indexOf(focused.current) + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
      focus(available[next]);
    }
  } };
  return <View ref={root} onLayout={place} {...keyboard} style={{ position: "absolute", inset: 0, zIndex: 1000 }}>
    <Pressable accessibilityLabel={t("sessionActions.closeMenu")} onPress={close} style={{ position: "absolute", inset: 0 }} />
    <View accessibilityRole="menu" accessibilityLabel={t("sessionActions.menu")} style={{ position: "absolute", ...position, width: 260, padding: 4,
      borderRadius: radius.md, backgroundColor: theme.colors.surface2, borderWidth: 1, borderColor: theme.colors.border, boxShadow: "0 6px 24px #0006" }}>
      {actions.map((action, i) => <Pressable key={action.key} ref={node => { buttons.current[i] = node; }} accessibilityRole="menuitem" accessibilityLabel={action.label}
        accessibilityState={{ disabled: action.disabled }} disabled={action.disabled} onPress={action.onPress}
        style={state => ({ padding: 10, gap: 8, flexDirection: "row", borderRadius: radius.sm, opacity: action.disabled ? 0.45 : 1,
          backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? theme.colors.surface1 : "transparent" })}>
        <Icon name={action.icon} size={16} color={theme.colors.foregroundMuted} />
        <View style={{ flex: 1, gap: 3 }}><Text style={{ color: theme.colors.foreground, fontSize: fontSize.body }}>{action.label}</Text>
          {action.hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{action.hint}</Text> : null}</View>
      </Pressable>)}
    </View>
  </View>;
}
export function SessionActions({ theme, controls }: { theme: PluginTheme; controls: ReturnType<typeof useSessionActions> }) {
  const { state, close } = controls;
  if (!state) return null;
  const actions = [
    { key: "rename", label: t("sessionActions.rename"), icon: "Pencil", disabled: !controls.online || !controls.canRename,
      hint: !controls.online ? t("sessionActions.offline") : !controls.canRename ? t("sessionActions.remoteRename") : undefined, onPress: () => controls.choose("rename") },
    { key: "archive", label: t("sessionActions.archive"), icon: "Archive", disabled: !controls.online || state.target.archived, onPress: () => controls.choose("archive") },
  ];
  if (state.stage === "menu") return state.point && Platform.OS === "web"
    ? <PointerMenu theme={theme} point={state.point} actions={actions} close={close} />
    : <Sheet title={state.target.title} open onClose={close}>
      {actions.map(action => <View key={action.key} style={{ gap: 4 }}><Button theme={theme} label={action.label} icon={action.icon} disabled={action.disabled} onPress={action.onPress} />
        {action.hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{action.hint}</Text> : null}</View>)}
    </Sheet>;
  const renaming = state.stage === "rename";
  return <Sheet title={t(renaming ? "sessionActions.rename" : "sessionActions.archive")} open onClose={close}>
    {renaming ? <>
      <TextInput autoFocus accessibilityLabel={t("sessionActions.title")} value={controls.title} onChangeText={controls.setTitle} maxLength={SESSION_TITLE_MAX}
        editable={!controls.busy} onSubmitEditing={() => { void controls.save(); }} style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface2,
          borderRadius: radius.md, padding: space.md, fontSize: fontSize.body }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("sessionActions.manualHint")}</Text>
    </> : <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{t("sessionActions.archiveHint", { title: state.target.title })}</Text>}
    {controls.error ? <Banner theme={theme} tone="danger" message={controls.error} /> : null}
    <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
      <Button theme={theme} label={t("sessionActions.cancel")} disabled={controls.busy} onPress={close} />
      <Button theme={theme} label={t(renaming ? "sessionActions.save" : "sessionActions.confirmArchive")} busy={controls.busy}
        disabled={renaming && !sessionTitle.safeParse(controls.title).success} onPress={() => { void controls.save(); }} />
    </View>
  </Sheet>;
}

/** Requests run on the installation host. Naming never blocks a row. */
export function useAutomaticSessionNames(hostId: string, agents: readonly AgentRecord[], enabled: boolean) {
  const enqueue = useRpc(nameSessions), foreground = useForeground(), seen = useRef(new Set<string>());
  const latest = useRef(agents); latest.current = agents;
  const ids = agents.map(agent => `${agent.id}:${agent.lastUserMessageAt}:${agent.labels[TITLE_SOURCE] ?? ""}`).join("|");
  useEffect(() => {
    if (!enabled || !foreground) return;
    let busy = false, stopped = false;
    const check = async () => {
      if (busy || stopped) return;
      const eligible = latest.current.filter(agent => agent.lastUserMessageAt && !agent.archivedAt && !agent.labels[TITLE_SOURCE] && !isInternalAgent(agent)
        && !seen.current.has(agent.id)).slice(0, 20);
      if (!eligible.length) return;
      busy = true;
      try {
        const groups = new Map<string, AgentRecord[]>();
        for (const agent of eligible) { if (agent.hostOnline === false) continue; const owner = agent.hostId ?? hostId; groups.set(owner, [...groups.get(owner) ?? [], agent]); }
        for (const [owner, agents] of groups) { const result = await enqueue({ serverId: owner, agentIds: agents.map(agent => agent.id) }); result.handledIds.forEach(id => seen.current.add(id)); }
      }
      catch { /* Retain the original title and retry later. */ }
      finally { busy = false; }
    };
    void check(); const timer = setInterval(() => { void check(); }, 60_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [hostId, enabled, foreground, ids, enqueue]);
}
