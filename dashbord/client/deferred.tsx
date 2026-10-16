import { deferredSourceLabel } from "./deferred-state";
import { t } from "../shared/text";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "./fleet-client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { deferredBadge, isOnItsWay, type DeferredSendResult, type DeferredView } from "../shared/deferred-rpc";
import { observatoryDeferred } from "../shared/steer";
import { deferredPollInterval, visibleDeferred } from "./deferred-state";
import { Badge, Button, aria, fontSize, hairline, radius, relativeTime, space, toneColor, withAlpha } from "./kit";
import { Breathe, Flash, useChangeCount } from "./motion";
import type { Consent } from "./send-plan";
import type { LedgerInput } from "./send-check";
import { useForeground } from "./use-foreground";

export const deferredQueryKey = (agentId: string) => ["agent-observatory", "deferred", agentId] as const;

/**
 * This Agent's messages in the plugin's ledger, sent now or queued for 「等这一轮结束再发」. Read once when an entry shows,
 * then every 5 s only while one is on its way and the app is in front. `send`, `enqueue`, `cancel` and `resume` put the
 * server's answer straight into the list, so a row changes on the tap; a call without an answer reads the list again,
 * which shows whether the server took it.
 */
export function useDeferredQueue(agentId: string, enabled = true) {
  const list = useRpc(observatoryDeferred.list), sendRpc = useRpc(observatoryDeferred.send), enqueueRpc = useRpc(observatoryDeferred.enqueue);
  const cancelRpc = useRpc(observatoryDeferred.cancel), resumeRpc = useRpc(observatoryDeferred.resume);
  const queryClient = useQueryClient(), foreground = useForeground();
  const key = useMemo(() => deferredQueryKey(agentId), [agentId]);
  const query = useQuery({ queryKey: key, queryFn: () => list({ agentId }), enabled, retry: false, staleTime: 2_000, refetchOnWindowFocus: false,
    refetchInterval: current => deferredPollInterval(current.state.data, foreground) });
  const put = useCallback((view: DeferredView | null) => {
    if (view) queryClient.setQueryData<DeferredView[]>(key, (previous = []) => [view, ...previous.filter(entry => entry.messageId !== view.messageId)]);
    void queryClient.invalidateQueries({ queryKey: key });
  }, [key, queryClient]);
  // An outcome disappears on its own after a while: draw again when the next one is due.
  const [, setTick] = useState(0);
  const shown = visibleDeferred(query.data ?? []);
  useEffect(() => {
    if (shown.until === null) return;
    const timer = setTimeout(() => setTick(value => value + 1), Math.max(0, shown.until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [shown.until]);
  const [acting, setActing] = useState<string | null>(null), actingRef = useRef(false);
  const act = useCallback(async (messageId: string, call: () => Promise<DeferredView | null>) => {
    if (actingRef.current) return;
    actingRef.current = true; setActing(messageId);
    try { put(await call()); } finally { actingRef.current = false; setActing(null); }
  }, [put]);
  const send = useCallback(async (input: LedgerInput & { what: string; consent: Consent | null }): Promise<DeferredSendResult> => {
    try { const result = await sendRpc({ agentId, ...input }); put("view" in result ? result.view : null); return result; }
    catch (error) { put(null); throw error; }
  }, [agentId, put, sendRpc]);
  const enqueue = useCallback(async (input: LedgerInput): Promise<DeferredView> => {
    try { const view = await enqueueRpc({ agentId, ...input }); put(view); return view; }
    catch (error) { put(null); throw error; }
  }, [agentId, enqueueRpc, put]);
  return {
    /** What the entries draw: messages on their way and fresh outcomes, newest first. */
    views: shown.views,
    /** Everything the server listed for this Agent (the last half hour), for 在途 checks and receipts. */
    all: query.data ?? [],
    acting, send, enqueue,
    cancel: (messageId: string) => act(messageId, () => cancelRpc({ messageId })),
    resume: (messageId: string) => act(messageId, () => resumeRpc({ messageId })),
  };
}
export type DeferredQueue = ReturnType<typeof useDeferredQueue>;

const ICONS: Record<DeferredView["state"], string> = { queued: "Hourglass", held: "CircleHelp", sending: "Send", sent: "CircleCheck", "maybe-sent": "CircleAlert", canceled: "Ban", discarded: "CircleX", expired: "TimerOff" };

/**
 * The ledger's rows next to a send entry (`only` picks this entry's messages): amber and breathing while one waits or is
 * being sent, orange with 仍然发送 / 取消 when it needs the user, a green flash once it went out. Rows are not pressable
 * themselves, so their buttons never nest.
 */
export function DeferredList({ theme, queue, only, compact = false }: { theme: PluginTheme; queue: DeferredQueue; only?: (view: DeferredView) => boolean; compact?: boolean }) {
  const toast = useToast();
  const rows = only ? queue.views.filter(only) : queue.views;
  if (!rows.length) return null;
  const run = (work: Promise<void>) => void work.catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  return <View testID="deferred-list" style={{ gap: space.xs + 2 }}>
    {rows.map(view => <DeferredRow key={view.messageId} theme={theme} view={view} busy={queue.acting === view.messageId} compact={compact}
      onCancel={() => run(queue.cancel(view.messageId))} onResume={() => run(queue.resume(view.messageId))} />)}
  </View>;
}

/** `compact` (the popover, whose height the host fixes): the buttons share the badge's line, and only a note that asks shows. */
function DeferredRow({ theme, view, busy, compact, onCancel, onResume }: { theme: PluginTheme; view: DeferredView; busy: boolean; compact: boolean; onCancel: () => void; onResume: () => void }) {
  const { colors } = theme;
  const badge = deferredBadge(view), changed = useChangeCount(view.state), waiting = isOnItsWay(view);
  const mark = <Badge theme={theme} label={badge.label} tone={badge.tone} icon={ICONS[view.state]} />;
  const name = deferredSourceLabel(view.source) || view.preview;
  // One being sent right now cannot be taken back: it has no buttons.
  const actions = view.state === "queued" || view.state === "held" ? <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm, marginLeft: "auto" }}>
    {view.state === "held" ? <Button theme={theme} size="sm" label={t("coreDeferred.sendAnyway")} icon="Send" tone="orange" busy={busy} accessibilityLabel={t("coreDeferred.sendAnyway2", { value1: name })} onPress={onResume} /> : null}
    <Button theme={theme} size="sm" label={view.state === "queued" ? t("coreDeferred.cancelQueue") : t("coreDeferred.cancel")} icon="X" variant="ghost" disabled={busy} accessibilityLabel={t("coreDeferred.message", { value1: view.state === "queued" ? t("coreDeferred.cancelQueue") : t("coreDeferred.cancel"), value2: name })} onPress={onCancel} />
  </View> : null;
  // 已送达 says it all; a note is worth a line when it explains or asks.
  const note = view.note && view.note !== badge.label && !(compact && view.state === "queued") ? view.note : null;
  return <View accessibilityLabel={t("coreDeferred.message", { value1: badge.label, value2: name })} {...aria({ live: "polite" })}
    style={{ overflow: "hidden", gap: space.xs + 2, padding: compact ? space.sm : space.sm + 2, borderRadius: radius.md, borderWidth: hairline, borderColor: toneColor(theme, badge.tone, "line"), backgroundColor: toneColor(theme, badge.tone, "soft") }}>
    <Flash count={changed} color={withAlpha(toneColor(theme, badge.tone, "mark"), 0.35)} radius={radius.md} />
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
      {view.state === "queued" || view.state === "sending" ? <Breathe>{mark}</Breathe> : mark}
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "500" }}>{name}</Text>
      <Text style={{ flexShrink: 0, color: colors.foregroundMuted, fontSize: fontSize.meta }}>{relativeTime(waiting ? view.createdAt : view.at)}</Text>
      {compact ? actions : null}
    </View>
    {note ? <Text style={{ color: colors.foreground, fontSize: fontSize.meta, lineHeight: 17 }}>{note}</Text> : null}
    {compact ? null : actions}
  </View>;
}
