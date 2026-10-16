import { useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useHosts } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { applyUpdate, dismissUpdate, estimateUpdateProgress, getUpdate, type UpdatePhase, type UpdateState } from "../shared/plugin-update";
import { t } from "../shared/text";
import { Banner, Button, Chip, IconButton, fontSize, hairline, radius, space, toneColor } from "./kit";
import { OutputText } from "./output-text";
import { useForeground } from "./use-foreground";

export const updateQueryKey = (hostId: string) => ["agent-observatory", hostId, "update"] as const;
const short = (commit: string | null | undefined) => commit ? commit.slice(0, 7) : "";
// Module scope, not component state: closing and reopening the sheet (or the panel) keeps following a running update.
const pendingUpdates = new Map<string, { commit: string; version: string; startedAt: number }>();
const announced = new Set<string>();

/**
 * The installation host's version and any newer revision on its source. Read every 30 minutes in the foreground, every 2–3 s
 * while the host checks or updates. Updating restarts the plugin, so reads fail for a while (the restart phase); the new
 * revision answering is the success signal. If the host reloads the panel meanwhile, the restarted server reports
 * `justUpdated` instead.
 */
export function usePluginUpdate(hostId: string) {
  const targetHost = useHosts().find(host => host.serverId === hostId)?.label ?? hostId;
  const get = useRpc(getUpdate), dismissRpc = useRpc(dismissUpdate), applyRpc = useRpc(applyUpdate);
  const cache = useQueryClient(), toast = useToast(), foreground = useForeground(), queryKey = updateQueryKey(hostId);
  const [finished, setFinished] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const pending = pendingUpdates.get(hostId);
  const query = useQuery({ queryKey, queryFn: () => get({}), enabled: foreground, retry: 0, staleTime: 60_000, refetchOnWindowFocus: false,
    refetchInterval: current => !foreground ? false : pendingUpdates.has(hostId) ? 2000 : current.state.data?.checking ? 3000 : 30 * 60_000 });
  const state = query.data;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    if (!state) return;
    if (pending && state.revision === pending.commit) {
      pendingUpdates.delete(hostId); announced.add(`${hostId}:${pending.commit}`); setFinished(state.version);
      toast.show(t("pluginUpdate.updated", { version: state.version }), { variant: "success" });
    } else if (pending && state.updating?.error) pendingUpdates.delete(hostId);
    const just = state.justUpdated;
    if (!pending && just && !announced.has(`${hostId}:${just.commit}`)) {
      announced.add(`${hostId}:${just.commit}`);
      toast.show(t("pluginUpdate.updatedFrom", { from: just.from, to: just.to }), { variant: "success" });
    }
  }, [state]);
  const save = (next: UpdateState) => { cache.setQueryData(queryKey, next); return next; };
  // A read failing while an update runs is the plugin restarting into the new revision.
  const phase: UpdatePhase | null = finished ? "done" : pending ? query.isError ? "restarting" : "building" : null;
  return {
    targetHost, state, error: pending ? null : query.error?.message ?? null, prompt: !!state?.available && !state.dismissed,
    progress: phase ? { phase, value: estimateUpdateProgress(pending ? now - pending.startedAt : 0, phase), seconds: pending ? Math.round((now - pending.startedAt) / 1000) : 0, version: finished } : null,
    acknowledge: () => setFinished(null),
    refresh: async () => save(await get({ refresh: true })),
    dismiss: async (commit: string) => save(await dismissRpc({ commit })),
    apply: async (commit: string) => {
      const next = save(await applyRpc({ commit }));
      pendingUpdates.set(hostId, { commit, version: next.available?.version ?? short(commit), startedAt: Date.now() });
      setFinished(null); setNow(Date.now());
      return next;
    },
  };
}
export type PluginUpdateControls = ReturnType<typeof usePluginUpdate>;

/** Top-right of the toolbar: the version, highlighted when a newer one waits or one is installing. Phones show it only then. */
export function PluginUpdateChip({ theme, compact, controls, onOpen }: { theme: PluginTheme; compact: boolean; controls: PluginUpdateControls; onOpen: () => void }) {
  const { state, prompt, progress } = controls;
  const installing = progress && progress.phase !== "done";
  if (!state || (compact && !prompt && !installing)) return null;
  const label = installing ? t("pluginUpdate.chipUpdating", { percent: Math.round(progress.value * 100) })
    : prompt ? compact ? t("pluginUpdate.chipShort") : t("pluginUpdate.chipAvailable", { version: state.version }) : `v${state.version}`;
  return <Chip theme={theme} label={label} icon={installing ? "LoaderCircle" : prompt ? "CircleArrowUp" : undefined} tone={installing ? "info" : prompt ? "success" : undefined} onPress={onOpen} testID="plugin-update-chip" />;
}

/** A centred card of its own width: the host's modal has no size option and is too wide for a short release note. */
function Dialog({ theme, title, onClose, children, footer }: { theme: PluginTheme; title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const { colors } = theme;
  useEffect(() => {
    const page = globalThis as unknown as { addEventListener?(type: string, listener: (event: { key: string }) => void): void; removeEventListener?(type: string, listener: (event: { key: string }) => void): void };
    if (Platform.OS !== "web" || !page.addEventListener) return;
    const key = (event: { key: string }) => { if (event.key === "Escape") onClose(); };
    page.addEventListener("keydown", key);
    return () => page.removeEventListener?.("keydown", key);
  }, [onClose]);
  return <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 1000, alignItems: "center", justifyContent: "center", padding: space.md }}>
    <Pressable focusable={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden onPress={onClose}
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "#00000080" }} />
    <View role="dialog" aria-modal aria-label={title} style={{ width: "100%", maxWidth: 440, maxHeight: "86%", borderRadius: radius.lg, overflow: "hidden",
      backgroundColor: colors.surface1, borderWidth: hairline, borderColor: colors.border, boxShadow: "0 12px 40px #0008" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
        <Text role="heading" style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{title}</Text>
        <IconButton theme={theme} icon="X" label={t("pluginUpdate.close")} onPress={onClose} />
      </View>
      <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: space.lg, gap: space.md }}>{children}</ScrollView>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm, padding: space.md, borderTopWidth: hairline, borderTopColor: colors.border }}>{footer}</View>
    </View>
  </View>;
}

function UpdateProgress({ theme, progress }: { theme: PluginTheme; progress: NonNullable<PluginUpdateControls["progress"]> }) {
  const { colors } = theme, percent = Math.round(progress.value * 100), done = progress.phase === "done";
  const label = done ? t("pluginUpdate.updated", { version: progress.version ?? "" }) : t(progress.phase === "restarting" ? "pluginUpdate.phaseRestarting" : "pluginUpdate.phaseBuilding");
  return <View role="progressbar" aria-label={t("pluginUpdate.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={{ gap: space.xs + 2 }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
      <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "500" }}>{label}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{percent}%</Text>
    </View>
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${percent}%`, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, done ? "success" : "info", "mark"), transitionProperty: "width", transitionDuration: "500ms" } as never} />
    </View>
    {done ? null : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("pluginUpdate.elapsed", { seconds: progress.seconds })}</Text>}
  </View>;
}

export function PluginUpdateSheet({ theme, open, onClose, controls }: { theme: PluginTheme; open: boolean; onClose: () => void; controls: PluginUpdateControls }) {
  const { colors } = theme, { state, progress } = controls;
  const [busy, setBusy] = useState<"apply" | "dismiss" | "check" | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setError(null); if (!progress) void controls.refresh().catch(() => {}); } }, [open]);
  if (!open) return null;
  const close = () => { if (progress?.phase === "done") controls.acknowledge(); onClose(); };
  const run = async (kind: "apply" | "dismiss" | "check", action: () => Promise<unknown>, closeAfter = false) => {
    setBusy(kind); setError(null);
    try { await action(); if (closeAfter) onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t("pluginUpdate.failed")); }
    finally { setBusy(null); }
  };
  const available = state?.available, failed = state?.updating?.error, installing = !!progress && progress.phase !== "done";
  const meta = { color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 };
  const footer = progress?.phase === "done" ? <Button theme={theme} variant="primary" label={t("pluginUpdate.done")} onPress={close} />
    : available ? <>
      <Button theme={theme} label={installing ? t("pluginUpdate.hide") : t("pluginUpdate.later")} disabled={!!busy}
        onPress={() => { if (installing) onClose(); else void run("dismiss", () => controls.dismiss(available.commit), true); }} />
      <Button theme={theme} variant="primary" icon="Download" label={failed ? t("pluginUpdate.retry") : t("pluginUpdate.update")}
        disabled={!!busy || installing} busy={busy === "apply" || installing} onPress={() => { void run("apply", () => controls.apply(available.commit)); }} />
    </> : <>
      <Button theme={theme} label={t("pluginUpdate.close")} onPress={close} />
      <Button theme={theme} icon="RefreshCw" label={t("pluginUpdate.check")} disabled={!!busy || !!state?.checking} busy={busy === "check" || !!state?.checking}
        onPress={() => { void run("check", controls.refresh); }} />
    </>;
  return <Dialog theme={theme} title={t("pluginUpdate.title")} onClose={close} footer={footer}>
    <Text style={meta}>{t("pluginUpdate.target", { host: controls.targetHost })}</Text>
    {state ? <Text style={{ color: colors.foreground, fontSize: fontSize.body }}>
      {t("pluginUpdate.current", { version: state.version, revision: short(state.revision) || "—" })}</Text> : null}
    {progress ? <UpdateProgress theme={theme} progress={progress} /> : null}
    {failed && !progress ? <Banner theme={theme} tone="danger" icon="TriangleAlert" message={t("pluginUpdate.updateFailed", { error: failed })} /> : null}
    {available && progress?.phase !== "done" ? <View style={{ gap: space.md }}>
      <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>
        {t("pluginUpdate.newVersion", { version: available.version ?? short(available.commit), revision: short(available.commit) })}</Text>
      {available.entries.length ? available.entries.map(entry => <View key={entry.heading} style={{ gap: space.xs }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{entry.heading}</Text>
        <OutputText theme={theme} text={entry.body} />
      </View>) : <Text style={meta}>{t(available.version ? "pluginUpdate.noNewNotes" : "pluginUpdate.noNotes")}</Text>}
      {available.truncated && available.entries.length ? <Text style={meta}>{t("pluginUpdate.truncated")}</Text> : null}
      {installing ? null : <Text style={meta}>{t("pluginUpdate.hint")}</Text>}
    </View> : state && !progress ? <Text style={meta}>{state.checking ? t("pluginUpdate.checking") : state.error ? null : t("pluginUpdate.latest")}</Text> : null}
    {state?.error && !progress ? <Banner theme={theme} tone="warning" message={t("pluginUpdate.checkFailed", { error: state.error })} /> : null}
    {error ?? controls.error ? <Banner theme={theme} tone="danger" message={(error ?? controls.error)!} /> : null}
  </Dialog>;
}
