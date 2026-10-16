import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { getPaseoClient, useHosts, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { applyUpdate, dismissUpdate, estimateUpdateProgress, getUpdate, OBSERVATORY_VERSION, type UpdateState } from "../shared/plugin-update";
import { displayCommand, hostCommand, hostRow, hostSummary, planSync, syncTarget, type HostCommandKind, type HostFacts, type HostRow } from "../shared/hosts";
import { t, type MessageId } from "../shared/text";
import { createStore, hostJobs, runHostCommand, setEntry, type CommandHost } from "./host-commands";
import { hostRegistry } from "./host-registry";
import { Badge, Banner, Button, Chip, IconButton, StatusDot, fontSize, hairline, radius, space, toneColor, type Tone } from "./kit";
import { OutputText } from "./output-text";
import { useForeground } from "./use-foreground";

export const updateQueryKey = (hostId: string) => ["agent-observatory", hostId, "update"] as const;
const short = (commit: string | null | undefined) => commit ? commit.slice(0, 7) : "";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
/**
 * A host online this long without registering an installation has none running. Calling it early costs little: on a host where
 * the plugin turns out to be configured, the install command enables and updates it instead.
 */
const SETTLE_MS = 10_000;

// Module scope, not component state: closing the dialog or the panel keeps following updates it started.
type Pending = { commit: string; startedAt: number; label: string };
const pendingUpdates = createStore<ReadonlyMap<string, Pending>>(new Map());
const onlineSince = new Map<string, number>();
const announced = new Set<string>();

function waitForRegistration(serverId: string, timeoutMs: number): Promise<boolean> {
  const present = () => hostRegistry.getSnapshot().some(peer => peer.identity.serverId === serverId);
  if (present()) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
    const unsubscribe = hostRegistry.subscribe(() => { if (present()) { clearTimeout(timer); unsubscribe(); resolve(true); } });
  });
}
const commandDeps = { acquire: (serverId: string) => getPaseoClient(serverId) as unknown as CommandHost, registered: waitForRegistration,
  now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };

/**
 * Every host Paseo is connected to and this plugin's state there. Installed hosts answer through their own update RPC (this
 * page's installation natively, the others through the host registry). A host without a running installation is only known
 * by its absence: the device never reads a daemon config. Updates and commands keep running when the dialog closes.
 */
export function useHostsPanel({ pageHostId, pageHostLabel, ignored, onIgnoredChange }: {
  pageHostId: string; pageHostLabel: string; ignored: readonly string[]; onIgnoredChange: (next: string[]) => void;
}) {
  const listed = useHosts(), foreground = useForeground(), cache = useQueryClient(), toast = useToast();
  const peers = useSyncExternalStore(hostRegistry.subscribe, hostRegistry.getSnapshot, hostRegistry.getSnapshot);
  const jobs = useSyncExternalStore(hostJobs.subscribe, hostJobs.get, hostJobs.get);
  const pending = useSyncExternalStore(pendingUpdates.subscribe, pendingUpdates.get, pendingUpdates.get);
  const nativeGet = useRpc(getUpdate), nativeApply = useRpc(applyUpdate), nativeDismiss = useRpc(dismissUpdate);
  const [, setTick] = useState(0);
  const hosts = useMemo(() => {
    const all = listed.some(host => host.serverId === pageHostId) ? [...listed] : [{ serverId: pageHostId, label: pageHostLabel, status: "online" as const }, ...listed];
    return all.sort((a, b) => Number(b.serverId === pageHostId) - Number(a.serverId === pageHostId) || a.label.localeCompare(b.label));
  }, [listed, pageHostId, pageHostLabel]);
  const registered = useMemo(() => new Map(peers.map(peer => [peer.identity.serverId, peer.identity.version])), [peers]);
  const isRegistered = (serverId: string) => serverId === pageHostId || registered.has(serverId);
  const getState = useCallback((serverId: string, refresh: boolean) =>
    serverId === pageHostId ? nativeGet({ refresh }) : hostRegistry.invoke(serverId, getUpdate, { refresh }), [pageHostId, nativeGet]);
  const updateIds = hosts.filter(host => host.status === "online" && isRegistered(host.serverId)).map(host => host.serverId);
  const updates = useQueries({ queries: updateIds.map(serverId => ({
    queryKey: updateQueryKey(serverId), queryFn: () => getState(serverId, false), enabled: foreground, retry: 0, staleTime: 60_000, refetchOnWindowFocus: false,
    refetchInterval: (query: { state: { data?: UpdateState } }) => !foreground ? false
      : pendingUpdates.get().has(serverId) || query.state.data?.updating ? 2_000 : query.state.data?.checking ? 3_000 : 30 * 60_000,
  })) });

  // A host that just connected may still be starting its installation; give it time before calling it not running.
  const onlineKey = hosts.map(host => `${host.serverId}:${host.status}:${isRegistered(host.serverId)}`).join("|");
  useEffect(() => {
    const now = Date.now();
    for (const host of hosts) {
      if (host.status !== "online") onlineSince.delete(host.serverId);
      else if (!onlineSince.has(host.serverId)) onlineSince.set(host.serverId, now);
    }
    const waits = hosts.filter(host => host.status === "online" && !isRegistered(host.serverId))
      .map(host => onlineSince.get(host.serverId)! + SETTLE_MS - now).filter(wait => wait > 0);
    setTick(value => value + 1);
    if (!waits.length) return;
    const timer = setTimeout(() => setTick(value => value + 1), Math.min(...waits) + 50);
    return () => clearTimeout(timer);
  }, [onlineKey]);

  const facts: HostFacts[] = hosts.map(host => {
    const update = updates[updateIds.indexOf(host.serverId)], since = onlineSince.get(host.serverId);
    return { host, page: host.serverId === pageHostId,
      registered: registered.has(host.serverId) ? { version: registered.get(host.serverId)! } : host.serverId === pageHostId ? { version: OBSERVATORY_VERSION } : null,
      update: { state: update?.data ?? null, error: update?.error ? message(update.error) : null },
      job: jobs.get(host.serverId) ?? null, pending: pending.get(host.serverId) ?? null, ignored: ignored.includes(host.serverId),
      settled: since !== undefined && Date.now() - since >= SETTLE_MS };
  });
  const target = syncTarget(facts), rows = facts.map(fact => hostRow(fact, target));
  const states = new Map(facts.map(fact => [fact.host.serverId, fact.update.state]));
  const page = states.get(pageHostId) ?? null, source = page?.source ?? null;

  // An update this client started is done when its host runs the revision; the page announces its own restart once.
  const stateKey = facts.map(fact => `${fact.host.serverId}:${fact.update.state?.revision}:${fact.update.state?.updating?.error ?? ""}:${fact.update.state?.justUpdated?.commit ?? ""}`).join("|");
  useEffect(() => {
    for (const [serverId, entry] of pendingUpdates.get()) {
      const state = states.get(serverId);
      if (state?.revision === entry.commit) {
        setEntry(pendingUpdates, serverId, null); announced.add(`${serverId}:${entry.commit}`);
        toast.show(t("hosts.updated", { host: entry.label, version: state.version }), { variant: "success" });
      } else if (state?.updating?.error) setEntry(pendingUpdates, serverId, null);
    }
    const just = page?.justUpdated;
    if (just && !announced.has(`${pageHostId}:${just.commit}`)) {
      announced.add(`${pageHostId}:${just.commit}`);
      toast.show(t("hosts.updatedFrom", { from: just.from, to: just.to }), { variant: "success" });
    }
  }, [stateKey, pending]);

  const label = (serverId: string) => hosts.find(host => host.serverId === serverId)?.label ?? serverId;
  const save = (serverId: string, next: UpdateState) => { cache.setQueryData(updateQueryKey(serverId), next); return next; };
  const applyOn = async (serverId: string, commit: string) => {
    setEntry(pendingUpdates, serverId, { commit, startedAt: Date.now(), label: label(serverId) });
    try { save(serverId, await (serverId === pageHostId ? nativeApply({ commit }) : hostRegistry.invoke(serverId, applyUpdate, { commit }))); }
    catch (error) { setEntry(pendingUpdates, serverId, null); throw error; }
  };
  const commitFor = (serverId: string) => target?.commit ?? states.get(serverId)?.available?.commit ?? null;
  const startCommand = (serverId: string, kind: HostCommandKind) => {
    const name = label(serverId);
    void runHostCommand(serverId, kind, source, commandDeps).then(result => {
      if (result === "ok") toast.show(t(kind === "install" ? "hosts.installed" : "hosts.repaired", { host: name }), { variant: "success" });
    });
  };
  return {
    rows, target, summary: hostSummary(rows), plan: planSync(rows), page, source, pageVersion: page?.version ?? OBSERVATORY_VERSION,
    pageError: updates[updateIds.indexOf(pageHostId)]?.error ? message(updates[updateIds.indexOf(pageHostId)]!.error) : null,
    checking: facts.some(fact => fact.update.state?.checking),
    label,
    /** What the confirmation shows: the install, and what runs instead when the plugin is already configured there. */
    commandLines() { const command = hostCommand(source); return command ? { add: displayCommand(command.add), fallback: command.fallback.map(displayCommand) } : null; },
    async refresh() {
      await Promise.all(updateIds.map(async serverId => { try { save(serverId, await getState(serverId, true)); } catch { /* the row shows the read error */ } }));
    },
    /** Commands start at once; updates go out one by one with the page's own last, since applying it restarts this panel. */
    async sync(request: { updates: readonly string[]; commands: ReadonlyArray<{ serverId: string; kind: HostCommandKind }> }): Promise<string[]> {
      for (const command of request.commands) startCommand(command.serverId, command.kind);
      const errors: string[] = [];
      for (const serverId of [...request.updates].sort((a, b) => Number(a === pageHostId) - Number(b === pageHostId))) {
        const commit = commitFor(serverId);
        if (!commit) continue;
        try { await applyOn(serverId, commit); } catch (error) { errors.push(t("hosts.applyFailed", { host: label(serverId), error: message(error) })); }
      }
      return errors;
    },
    async dismiss() {
      await Promise.all(rows.filter(row => row.state === "outdated" && !row.ignored).map(async row => {
        const commit = states.get(row.serverId)?.available?.commit;
        if (commit) save(row.serverId, await (row.serverId === pageHostId ? nativeDismiss({ commit }) : hostRegistry.invoke(row.serverId, dismissUpdate, { commit })));
      }));
    },
    setIgnored(serverId: string, value: boolean) {
      onIgnoredChange(value ? [...new Set([...ignored, serverId])] : ignored.filter(id => id !== serverId));
    },
  };
}
export type HostsPanel = ReturnType<typeof useHostsPanel>;

/** Top right of the toolbar: the version when every host is fine, otherwise what needs you. Phones show it only then. */
export function HostsChip({ theme, compact, panel, onOpen }: { theme: PluginTheme; compact: boolean; panel: HostsPanel; onOpen: () => void }) {
  const { busy, failed, attention } = panel.summary;
  if (!busy && !attention && compact) return null;
  const updatesOnly = attention > 0 && panel.rows.every(row => row.ignored || !["missing", "update-failed", "job-failed"].includes(row.state));
  const [label, icon, tone]: [string, string, Tone | undefined] = busy ? [t(compact ? "hosts.chipBusyShort" : "hosts.chipBusy", { count: busy }), "LoaderCircle", "info"]
    : failed ? [t(compact ? "hosts.chipFailedShort" : "hosts.chipFailed", { count: failed }), "TriangleAlert", "danger"]
    : attention ? updatesOnly ? [compact ? t("hosts.chipUpdatesShort") : t("hosts.chipUpdates", { count: attention }), "CircleArrowUp", "success"]
      : [t(compact ? "hosts.chipShort" : "hosts.chipAttention", { count: attention }), "Server", "warning"]
    : [`v${panel.pageVersion}`, "Server", undefined];
  return <Chip theme={theme} label={label} icon={icon} tone={tone} onPress={onOpen} testID="hosts-chip" />;
}

/** A centred card of its own width: the host's modal has no size option and is too wide for a list of hosts. */
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
    <View role="dialog" aria-modal aria-label={title} style={{ width: "100%", maxWidth: 520, maxHeight: "88%", borderRadius: radius.lg, overflow: "hidden",
      backgroundColor: colors.surface1, borderWidth: hairline, borderColor: colors.border, boxShadow: "0 12px 40px #0008" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
        <Text role="heading" style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{title}</Text>
        <IconButton theme={theme} icon="X" label={t("hosts.close")} onPress={onClose} />
      </View>
      <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: space.lg, gap: space.md }}>{children}</ScrollView>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm, padding: space.md, borderTopWidth: hairline, borderTopColor: colors.border }}>{footer}</View>
    </View>
  </View>;
}

function Mono({ theme, lines, label }: { theme: PluginTheme; lines: readonly string[]; label?: string }) {
  const { colors } = theme;
  return <View accessibilityLabel={label} style={{ borderRadius: radius.md, backgroundColor: colors.surface2, paddingHorizontal: space.sm, paddingVertical: space.xs + 2 }}>
    {lines.map((line, index) => <Text key={index} selectable style={{ color: colors.foreground, fontSize: fontSize.meta, lineHeight: 17, fontFamily: Platform.OS === "web" ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "Menlo" }}>{line}</Text>)}
  </View>;
}

/** The install command, then what runs instead on a host where the plugin is already configured. */
function CommandLines({ theme, lines }: { theme: PluginTheme; lines: { add: string; fallback: string[] } }) {
  return <View style={{ gap: space.xs + 2 }}>
    <Mono theme={theme} lines={[lines.add]} />
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{t("hosts.fallbackIntro")}</Text>
    <Mono theme={theme} lines={lines.fallback} />
  </View>;
}

function RowProgress({ theme, since, phase, now }: { theme: PluginTheme; since: number; phase: "building" | "restarting"; now: number }) {
  const { colors } = theme, value = estimateUpdateProgress(now - since, phase), percent = Math.round(value * 100);
  return <View role="progressbar" aria-label={t("hosts.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={{ gap: space.xs }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
      <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t(phase === "restarting" ? "hosts.phaseRestarting" : "hosts.phaseBuilding")}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{percent}%</Text>
    </View>
    <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${percent}%`, height: 4, borderRadius: 2, backgroundColor: toneColor(theme, "info", "mark"), transitionProperty: "width", transitionDuration: "500ms" } as never} />
    </View>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("hosts.elapsed", { seconds: Math.max(0, Math.round((now - since) / 1000)) })}</Text>
  </View>;
}

const failedLabel: Record<HostCommandKind, MessageId> = { install: "hosts.jobFailedInstall", repair: "hosts.jobFailedRepair" };
const runningLabel: Record<HostCommandKind, MessageId> = { install: "hosts.stateInstalling", repair: "hosts.stateRepairing" };
const confirmLabel: Record<HostCommandKind, MessageId> = { install: "hosts.confirmInstall", repair: "hosts.confirmRepair" };
const actionLabel: Record<HostCommandKind, MessageId> = { install: "hosts.install", repair: "hosts.repair" };
function rowStatus(row: HostRow, now: number): string {
  const version = row.version ?? "?";
  switch (row.state) {
    case "offline": return t("hosts.stateOffline");
    case "connecting": return t("hosts.stateConnecting");
    case "checking": return t("hosts.stateChecking");
    case "missing": return t("hosts.stateMissing");
    case "job-running": return t(runningLabel[row.job!.kind], { seconds: Math.max(0, Math.round((now - row.job!.startedAt) / 1000)) });
    case "job-waiting": return t("hosts.stateWaiting");
    case "job-failed": return t(failedLabel[row.job!.kind], { reason: row.error ?? "" });
    case "updating": return t("hosts.stateUpdating");
    case "update-failed": return t("hosts.stateUpdateFailed", { error: row.error ?? "" });
    case "outdated": return t(row.dismissed ? "hosts.stateDismissed" : "hosts.stateOutdated", { version });
    case "diverged": return t("hosts.stateDiverged", { version });
    case "check-failed": return t("hosts.stateCheckFailed", { error: row.error ?? "" });
    case "current": return t("hosts.stateCurrent", { version });
  }
}
function rowTone(row: HostRow): Tone {
  switch (row.state) {
    case "current": return "success";
    case "offline": return "neutral";
    case "connecting": case "checking": case "updating": case "job-running": case "job-waiting": return "info";
    case "job-failed": case "update-failed": case "check-failed": return "danger";
    default: return "warning";
  }
}
const IGNORABLE: readonly HostRow["state"][] = ["missing", "job-failed", "diverged", "check-failed"];

function HostRowView({ theme, row, now, onCommand, onRetryUpdate, onIgnore, onOpenTerminal, busy }: {
  theme: PluginTheme; row: HostRow; now: number; busy: boolean;
  onCommand: (kind: HostCommandKind) => void; onRetryUpdate: () => void; onIgnore: (value: boolean) => void; onOpenTerminal?: () => void;
}) {
  const { colors } = theme, status = rowStatus(row, now);
  const kind: HostCommandKind | null = row.action === "install" || row.action === "repair" ? row.action : row.action === "retry-job" ? row.job?.kind ?? null : null;
  return <View testID={`host-row-${row.serverId}`} style={{ gap: space.xs + 2, paddingVertical: space.sm, borderTopWidth: hairline, borderTopColor: colors.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <StatusDot theme={theme} tone={rowTone(row)} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{row.label}</Text>
          {row.page ? <Badge theme={theme} label={t("hosts.pageHost")} /> : null}
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{status}</Text>
      </View>
      {row.ignored ? <Button theme={theme} size="sm" label={t("hosts.unignore")} onPress={() => onIgnore(false)} />
        : <>
          {kind ? <Button theme={theme} size="sm" variant="secondary" label={t(row.action === "retry-job" ? "hosts.retry" : actionLabel[kind])} disabled={busy} onPress={() => onCommand(kind)} /> : null}
          {row.action === "retry-update" ? <Button theme={theme} size="sm" label={t("hosts.retry")} disabled={busy} onPress={onRetryUpdate} /> : null}
          {IGNORABLE.includes(row.state) ? <IconButton theme={theme} size="sm" icon="EyeOff" label={t("hosts.ignore")} onPress={() => onIgnore(true)} /> : null}
        </>}
    </View>
    {row.state === "updating" && row.updatingSince !== null ? <RowProgress theme={theme} since={row.updatingSince} phase={row.phase ?? "building"} now={now} /> : null}
    {row.state === "job-failed" && row.job?.output.length ? <Mono theme={theme} lines={row.job.output} /> : null}
    {row.state === "job-failed" && onOpenTerminal ? <View style={{ flexDirection: "row" }}><Button theme={theme} size="sm" variant="ghost" icon="SquareTerminal" label={t("hosts.openTerminal")} onPress={onOpenTerminal} /></View> : null}
  </View>;
}

type Request = { updates: string[]; commands: Array<{ serverId: string; kind: HostCommandKind }> };

export function HostsDialog({ theme, open, onClose, panel, navigation }: { theme: PluginTheme; open: boolean; onClose: () => void; panel: HostsPanel; navigation?: PluginSurfaceProps["navigation"] }) {
  const { colors } = theme, toast = useToast();
  const [confirming, setConfirming] = useState<Request | null>(null), [busy, setBusy] = useState(false), [errors, setErrors] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (open) { setConfirming(null); setErrors([]); void panel.refresh(); } }, [open]);
  const ticking = open && panel.summary.busy > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (!open) return null;
  const run = async (request: Request) => {
    setBusy(true); setErrors([]);
    try { setErrors(await panel.sync(request)); setConfirming(null); }
    finally { setBusy(false); }
  };
  const meta = { color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 };
  const { target, plan, rows } = panel;
  const version = target?.version ?? short(target?.commit);

  const lines = panel.commandLines();
  if (confirming) {
    const footer = <>
      <Button theme={theme} label={t("hosts.back")} disabled={busy} onPress={() => setConfirming(null)} />
      <Button theme={theme} variant="primary" icon="Play" label={t("hosts.confirm")} busy={busy} disabled={busy} onPress={() => { void run(confirming); }} />
    </>;
    return <Dialog theme={theme} title={t("hosts.title")} onClose={onClose} footer={footer}>
      <Text style={{ color: colors.foreground, fontSize: fontSize.body }}>{t("hosts.confirmIntro")}</Text>
      {confirming.commands.map(command => <View key={command.serverId} style={{ gap: space.xs + 2 }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{t(confirmLabel[command.kind], { host: panel.label(command.serverId) })}</Text>
        {lines ? <CommandLines theme={theme} lines={lines} /> : <Banner theme={theme} tone="warning" message={t("hosts.noSource")} />}
      </View>)}
      {confirming.updates.length ? <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>
        {t("hosts.confirmUpdate", { hosts: confirming.updates.map(panel.label).join(", "), version })}</Text> : null}
      {confirming.commands.length ? <Text style={meta}>{t("hosts.confirmTerminal")}</Text> : null}
    </Dialog>;
  }

  const active = rows.filter(row => !row.ignored), ignored = rows.filter(row => row.ignored);
  const anyOutdated = active.some(row => row.state === "outdated" || row.state === "update-failed");
  const onlyUpdates = plan.commands.length === 0 && plan.updates.length > 0;
  const manual = active.some(row => row.state === "job-failed" && row.job && (row.job.result === "no-cli" || row.job.result === "no-workspace" || row.job.result === "error"));
  const footer = plan.updates.length || plan.commands.length ? <>
    {onlyUpdates ? <Button theme={theme} label={t("hosts.later")} disabled={busy} onPress={() => { void panel.dismiss().catch(() => {}).finally(onClose); }} />
      : <Button theme={theme} label={t("hosts.close")} onPress={onClose} />}
    <Button theme={theme} variant="primary" icon={onlyUpdates ? "Download" : "RefreshCw"} label={t(onlyUpdates ? "hosts.updateAll" : "hosts.syncAll")} busy={busy} disabled={busy}
      onPress={() => { if (onlyUpdates) void run(plan); else setConfirming(plan); }} />
  </> : panel.summary.busy ? <Button theme={theme} variant="primary" label={t("hosts.hide")} onPress={onClose} />
    : <>
      <Button theme={theme} label={t("hosts.close")} onPress={onClose} />
      <Button theme={theme} icon="RefreshCw" label={t("hosts.check")} busy={panel.checking} disabled={panel.checking} onPress={() => { void panel.refresh(); }} />
    </>;
  const rowView = (row: HostRow) => <HostRowView key={row.serverId} theme={theme} row={row} now={now} busy={busy}
    onCommand={kind => setConfirming({ updates: [], commands: [{ serverId: row.serverId, kind }] })}
    onRetryUpdate={() => { void run({ updates: [row.serverId], commands: [] }); }}
    onIgnore={value => panel.setIgnored(row.serverId, value)}
    onOpenTerminal={navigation && row.job?.workspaceId ? () => { navigation.openWorkspace({ workspaceId: row.job!.workspaceId!, serverId: row.serverId }); onClose(); } : undefined} />;
  return <Dialog theme={theme} title={t("hosts.title")} onClose={onClose} footer={footer}>
    {target && anyOutdated ? <View style={{ gap: space.sm }}>
      <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{t("hosts.latest", { version, revision: short(target.commit) })}</Text>
      {target.entries.length ? target.entries.map(entry => <View key={entry.heading} style={{ gap: space.xs }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{entry.heading}</Text>
        <OutputText theme={theme} text={entry.body} />
      </View>) : <Text style={meta}>{t(target.version ? "hosts.noNewNotes" : "hosts.noNotes")}</Text>}
      {target.truncated && target.entries.length ? <Text style={meta}>{t("hosts.truncated")}</Text> : null}
    </View> : !panel.summary.attention && !panel.summary.busy && !panel.checking && rows.every(row => row.state === "current" || row.ignored || row.state === "offline")
      ? <Text style={meta}>{t("hosts.allCurrent")}</Text> : null}
    {panel.pageError || panel.page?.error ? <Banner theme={theme} tone="warning" message={t("hosts.checkFailed", { error: panel.pageError ?? panel.page?.error ?? "" })} /> : null}
    <View>{active.map(rowView)}</View>
    {ignored.length ? <View style={{ gap: space.xs }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{t("hosts.ignoredSection")}</Text>
      <View>{ignored.map(rowView)}</View>
    </View> : null}
    {manual && lines ? <View style={{ gap: space.xs + 2 }}>
      <Text style={meta}>{t("hosts.manual")}</Text>
      <CommandLines theme={theme} lines={lines} />
      <View style={{ flexDirection: "row" }}><Button theme={theme} size="sm" variant="ghost" icon="Copy" label={t("hosts.copy")}
        onPress={() => { void copyText(lines.add).then(() => toast.show(t("hosts.copied"))).catch(() => {}); }} /></View>
    </View> : null}
    {errors.length ? <Banner theme={theme} tone="danger" message={errors.join("\n")} /> : null}
  </Dialog>;
}
