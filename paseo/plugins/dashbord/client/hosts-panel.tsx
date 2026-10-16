import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { getPaseoClient, useHosts, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyUpdate, dismissUpdate, estimateUpdateProgress, getUpdate, OBSERVATORY_VERSION, type UpdateState } from "../shared/plugin-update";
import { displayCommand, getHostMemory, hostCommand, hostRow, hostSummary, planSync, pluginConfigState, rememberHosts, syncTarget,
  type HostCommandKind, type HostFacts, type HostMemory, type HostPluginConfig, type HostRow } from "../shared/hosts";
import { t, type MessageId } from "../shared/text";
import { createStore, hostJobs, runHostCommand, setEntry, type CommandHost } from "./host-commands";
import { hostRegistry } from "./host-registry";
import { Badge, Banner, Button, Chip, IconButton, StatusDot, fontSize, hairline, radius, relativeTime, space, toneColor, type Tone } from "./kit";
import { OutputText } from "./output-text";
import { useForeground } from "./use-foreground";

export const updateQueryKey = (hostId: string) => ["agent-observatory", hostId, "update"] as const;
const configQueryKey = (hostId: string) => ["agent-observatory", hostId, "host-plugin-config"] as const;
const short = (commit: string | null | undefined) => commit ? commit.slice(0, 7) : "";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
/** A host online this long without registering its installed, enabled plugin has none running. */
const SETTLE_MS = 10_000;
/** A host already remembered at the same version is written again at most this often. */
const REMEMBER_MS = 10 * 60_000;

// Module scope, not component state: closing the dialog or the panel keeps following updates it started.
type Pending = { commit: string; startedAt: number; label: string; queued?: boolean };
const pendingUpdates = createStore<ReadonlyMap<string, Pending>>(new Map());
const onlineSince = new Map<string, number>();
const announced = new Set<string>();

/**
 * Whether this plugin is installed and enabled on a host without a running installation, and whether plugins are on there.
 * The daemon config also carries provider credentials: it is reduced to those three facts at once, never kept, cached or sent on.
 */
async function readPluginState(serverId: string): Promise<HostPluginConfig> {
  const { config } = await getPaseoClient(serverId).config.get();
  return pluginConfigState(config);
}
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
 * page's installation natively, the others through the host registry); a host without a running installation is read from its
 * daemon config. This page's installation remembers when each host was last seen. Updates and commands keep running when the
 * dialog closes.
 */
export function useHostsPanel({ pageHostId, pageHostLabel, ignored, onIgnoredChange }: {
  pageHostId: string; pageHostLabel: string; ignored: readonly string[]; onIgnoredChange: (next: string[]) => void;
}) {
  const listed = useHosts(), foreground = useForeground(), cache = useQueryClient(), toast = useToast();
  const peers = useSyncExternalStore(hostRegistry.subscribe, hostRegistry.getSnapshot, hostRegistry.getSnapshot);
  const jobs = useSyncExternalStore(hostJobs.subscribe, hostJobs.get, hostJobs.get);
  const pending = useSyncExternalStore(pendingUpdates.subscribe, pendingUpdates.get, pendingUpdates.get);
  const nativeGet = useRpc(getUpdate), nativeApply = useRpc(applyUpdate), nativeDismiss = useRpc(dismissUpdate);
  const readMemory = useRpc(getHostMemory), writeMemory = useRpc(rememberHosts);
  const [, setTick] = useState(0);
  const memory = useQuery({ queryKey: ["agent-observatory", pageHostId, "host-memory"], queryFn: () => readMemory({}), enabled: foreground, retry: 0, staleTime: Infinity });
  const hosts = useMemo(() => {
    const all = listed.some(host => host.serverId === pageHostId) ? [...listed] : [{ serverId: pageHostId, label: pageHostLabel, status: "online" as const }, ...listed];
    // A client that only knows a host by its pairing offer labels it with the server ID; the installation and memory know its name.
    const names = new Map([...(memory.data?.hosts ?? []).map(entry => [entry.serverId, entry.label] as const), ...peers.map(peer => [peer.identity.serverId, peer.identity.hostname] as const)]);
    return all.map(host => host.label && host.label !== host.serverId ? host : { ...host, label: names.get(host.serverId) || host.label })
      .sort((a, b) => Number(b.serverId === pageHostId) - Number(a.serverId === pageHostId) || a.label.localeCompare(b.label));
  }, [listed, pageHostId, pageHostLabel, peers, memory.data]);
  const registered = useMemo(() => new Map(peers.map(peer => [peer.identity.serverId, peer.identity.version])), [peers]);
  const isRegistered = (serverId: string) => serverId === pageHostId || registered.has(serverId);
  const getState = useCallback((serverId: string, refresh: boolean) =>
    serverId === pageHostId ? nativeGet({ refresh }) : hostRegistry.invoke(serverId, getUpdate, { refresh }), [pageHostId, nativeGet]);
  const updateIds = hosts.filter(host => host.status === "online" && isRegistered(host.serverId)).map(host => host.serverId);
  const configIds = hosts.filter(host => host.status === "online" && !isRegistered(host.serverId)).map(host => host.serverId);
  const updates = useQueries({ queries: updateIds.map(serverId => ({
    queryKey: updateQueryKey(serverId), queryFn: () => getState(serverId, false), enabled: foreground, retry: 0, staleTime: 60_000, refetchOnWindowFocus: false,
    refetchInterval: (query: { state: { data?: UpdateState } }) => !foreground ? false
      : pendingUpdates.get().has(serverId) || query.state.data?.updating ? 2_000 : query.state.data?.checking ? 3_000 : 30 * 60_000,
  })) });
  const configs = useQueries({ queries: configIds.map(serverId => ({
    queryKey: configQueryKey(serverId), queryFn: () => readPluginState(serverId), enabled: foreground, retry: 0, staleTime: 15_000,
    refetchOnWindowFocus: false, refetchInterval: foreground ? 60_000 : false as const,
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

  const remembered = useMemo(() => new Map((memory.data?.hosts ?? []).map(entry => [entry.serverId, entry])), [memory.data]);
  // Another host's answer counts only once it checked its source after this page did (see refresh below).
  const pageCheckedAt = Date.parse(updates[updateIds.indexOf(pageHostId)]?.data?.checkedAt ?? "") || 0;
  const facts: HostFacts[] = hosts.map(host => {
    const update = updates[updateIds.indexOf(host.serverId)], config = configs[configIds.indexOf(host.serverId)], since = onlineSince.get(host.serverId);
    return { host, page: host.serverId === pageHostId,
      registered: registered.has(host.serverId) ? { version: registered.get(host.serverId)! } : host.serverId === pageHostId ? { version: OBSERVATORY_VERSION } : null,
      update: { state: update?.data ?? null, error: update?.error ? message(update.error) : null },
      config: { value: config?.data ?? null, error: config?.error ? message(config.error) : null },
      memory: remembered.get(host.serverId) ?? null,
      job: jobs.get(host.serverId) ?? null, pending: pending.get(host.serverId) ?? null, ignored: ignored.includes(host.serverId),
      settled: since !== undefined && Date.now() - since >= SETTLE_MS,
      stale: host.serverId !== pageHostId && !!update?.data && (!update.data.checkedAt || Date.parse(update.data.checkedAt) < pageCheckedAt) };
  });
  const target = syncTarget(facts), rows = facts.map(fact => hostRow(fact, target));
  const states = new Map(facts.map(fact => [fact.host.serverId, fact.update.state]));
  const page = states.get(pageHostId) ?? null, source = page?.source ?? null;

  // Remember every online host with what it runs now, so it can be shown, and judged, while it is offline.
  const seenKey = facts.filter(fact => fact.host.status === "online").map(fact => `${fact.host.serverId}:${fact.host.label}:${fact.update.state?.version ?? fact.registered?.version ?? ""}:${fact.update.state?.revision ?? ""}`).join("|");
  const writing = useRef(false);
  // While hosts stay online their sighting is renewed every REMEMBER_MS, so one that drops off shows roughly when it left.
  const epoch = Math.floor(Date.now() / REMEMBER_MS);
  useEffect(() => {
    const timer = setInterval(() => setTick(value => value + 1), REMEMBER_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!memory.data || writing.current) return;
    const now = Date.now();
    const seen: HostMemory[] = facts
      // A running installation is written once its update state has answered (or failed), so its revision is not lost.
      .filter(fact => fact.host.status === "online" && (!fact.registered || fact.update.state || fact.update.error))
      .map(fact => ({ serverId: fact.host.serverId, label: fact.host.label, version: fact.update.state?.version ?? fact.registered?.version ?? null,
        revision: fact.update.state?.revision ?? null, seenAt: new Date(now).toISOString() }))
      .filter(entry => {
        const known = remembered.get(entry.serverId);
        return !known || known.label !== entry.label || known.version !== entry.version || known.revision !== entry.revision || now - Date.parse(known.seenAt) >= REMEMBER_MS;
      });
    if (!seen.length) return;
    writing.current = true;
    void writeMemory({ hosts: seen }).then(next => cache.setQueryData(["agent-observatory", pageHostId, "host-memory"], next)).catch(() => {}).finally(() => { writing.current = false; });
  }, [seenKey, memory.data, epoch]);

  // A host whose last check predates the page's (it was offline, or just connected) is asked to check again, once per target.
  const refreshed = useRef(new Set<string>());
  const staleKey = facts.filter(fact => fact.stale && !fact.update.state?.checking).map(fact => fact.host.serverId).join("|") + `@${target?.commit ?? ""}`;
  useEffect(() => {
    for (const fact of facts) {
      const key = `${fact.host.serverId}@${target?.commit ?? ""}`;
      if (!fact.stale || fact.update.state?.checking || refreshed.current.has(key)) continue;
      refreshed.current.add(key);
      void getState(fact.host.serverId, true).then(next => save(fact.host.serverId, next)).catch(() => {});
    }
  }, [staleKey]);

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
  const done: Record<HostCommandKind, MessageId> = { install: "hosts.installed", enable: "hosts.enabled", upgrade: "hosts.upgraded" };
  const startCommand = (serverId: string, kind: HostCommandKind) => {
    const name = label(serverId);
    return runHostCommand(serverId, kind, source, commandDeps).then(result => {
      if (result === "ok") toast.show(t(done[kind], { host: name }), { variant: "success" });
      void cache.invalidateQueries({ queryKey: configQueryKey(serverId) });
    });
  };
  /** Overall progress of the updates and commands running now, for the toolbar entry. */
  const progress = (() => {
    const now = Date.now(), parts = rows.flatMap(row => row.state === "updating" && row.updatingSince !== null ? [estimateUpdateProgress(now - row.updatingSince, row.phase ?? "building")]
      : row.state === "job-running" && row.job ? [estimateUpdateProgress(now - row.job.startedAt, "building")] : row.state === "job-waiting" ? [0.9]
      : row.state === "updating" || row.state === "queued" ? [0.04] : []);
    return parts.length ? parts.reduce((sum, part) => sum + part, 0) / parts.length : null;
  })();
  return {
    rows, target, summary: hostSummary(rows), plan: planSync(rows), page, source, progress, pageVersion: page?.version ?? OBSERVATORY_VERSION,
    pageError: updates[updateIds.indexOf(pageHostId)]?.error ? message(updates[updateIds.indexOf(pageHostId)]!.error) : null,
    checking: facts.some(fact => fact.update.state?.checking),
    label,
    /** The `paseo` invocations a command runs on its host, as the confirmation shows them; null when the source cannot be used. */
    commandLines(kind: HostCommandKind) { const steps = hostCommand(kind, source); return steps ? steps.map(displayCommand) : null; },
    async refresh() {
      await Promise.all([
        ...updateIds.map(async serverId => { try { save(serverId, await getState(serverId, true)); } catch { /* the row shows the read error */ } }),
        ...configIds.map(serverId => cache.invalidateQueries({ queryKey: configQueryKey(serverId) })),
      ]);
    },
    /**
     * Commands start at once; updates go out one by one with the page's own last, since applying it restarts this panel. The
     * restart would also end this client's follow-up of commands still running elsewhere (their result, toast and terminal
     * cleanup), so the page's own update waits for them and runs in the background.
     */
    async sync(request: { updates: readonly string[]; commands: ReadonlyArray<{ serverId: string; kind: HostCommandKind }> }): Promise<string[]> {
      const commands = request.commands.map(command => startCommand(command.serverId, command.kind));
      const errors: string[] = [];
      for (const serverId of [...request.updates].sort((a, b) => Number(a === pageHostId) - Number(b === pageHostId))) {
        const commit = commitFor(serverId);
        if (!commit) continue;
        if (serverId === pageHostId && commands.length) {
          setEntry(pendingUpdates, serverId, { commit, startedAt: Date.now(), label: label(serverId), queued: true });
          void Promise.allSettled(commands).then(() => applyOn(serverId, commit))
            .catch(error => toast.error(t("hosts.applyFailed", { host: label(serverId), error: message(error) })));
          continue;
        }
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

/** Top right of the toolbar: the version when every host is fine, progress while updating, otherwise how many hosts need you. */
export function HostsChip({ theme, compact, panel, onOpen }: { theme: PluginTheme; compact: boolean; panel: HostsPanel; onOpen: () => void }) {
  const { busy, failed, attention } = panel.summary;
  if (!busy && !attention && compact) return null;
  const [label, icon, tone]: [string, string, Tone | undefined] = busy ? [t("hosts.chipProgress", { percent: Math.round((panel.progress ?? 0) * 100) }), "LoaderCircle", "info"]
    : attention ? [t("hosts.chipAttention", { count: attention }), failed ? "TriangleAlert" : "Server", failed ? "danger" : "warning"]
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

function Mono({ theme, lines }: { theme: PluginTheme; lines: readonly string[] }) {
  const { colors } = theme;
  return <View style={{ borderRadius: radius.md, backgroundColor: colors.surface2, paddingHorizontal: space.sm, paddingVertical: space.xs + 2 }}>
    {lines.map((line, index) => <Text key={index} selectable style={{ color: colors.foreground, fontSize: fontSize.meta, lineHeight: 17, fontFamily: Platform.OS === "web" ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "Menlo" }}>{line}</Text>)}
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

const failedLabel: Record<HostCommandKind, MessageId> = { install: "hosts.jobFailedInstall", enable: "hosts.jobFailedEnable", upgrade: "hosts.jobFailedUpgrade" };
const runningLabel: Record<HostCommandKind, MessageId> = { install: "hosts.stateInstalling", enable: "hosts.stateEnabling", upgrade: "hosts.stateUpgrading" };
const confirmLabel: Record<HostCommandKind, MessageId> = { install: "hosts.confirmInstall", enable: "hosts.confirmEnable", upgrade: "hosts.confirmUpgrade" };
const actionLabel: Record<HostCommandKind, MessageId> = { install: "hosts.install", enable: "hosts.enable", upgrade: "hosts.upgrade" };
/** 「3 天前」 past a day, like the toolbar's other relative times within one. */
function since(seenAt: string, now: number): string {
  const days = Math.floor((now - Date.parse(seenAt)) / 86_400_000);
  return days >= 1 ? t("hosts.daysAgo", { count: days }) : relativeTime(seenAt, now);
}
function rowStatus(row: HostRow, now: number): string {
  const version = row.version ?? "?";
  switch (row.state) {
    case "offline": {
      const away = row.lastSeen ? t(row.version ? "hosts.stateOfflineVersion" : "hosts.stateOfflineSeen", { version, ago: since(row.lastSeen, now) }) : t("hosts.stateOffline");
      return row.pendingSync ? `${away} · ${t("hosts.pendingSync")}` : away;
    }
    case "connecting": return t("hosts.stateConnecting");
    case "checking": return t("hosts.stateChecking");
    case "plugins-off": return t("hosts.statePluginsOff");
    case "missing": return t("hosts.stateMissing");
    case "disabled": return t("hosts.stateDisabled");
    case "too-old": return row.version ? t("hosts.stateTooOld", { version }) : t("hosts.stateNotRunning");
    case "job-running": return t(runningLabel[row.job!.kind], { seconds: Math.max(0, Math.round((now - row.job!.startedAt) / 1000)) });
    case "job-waiting": return t("hosts.stateWaiting");
    case "job-failed": return t(failedLabel[row.job!.kind], { reason: row.error ?? "" });
    case "queued": return t("hosts.stateQueued");
    case "updating": return t("hosts.stateUpdating");
    case "update-failed": return t("hosts.stateUpdateFailed", { error: row.error ?? "" });
    case "outdated": return t(row.dismissed ? "hosts.stateDismissed" : "hosts.stateOutdated", { version });
    case "diverged": return t("hosts.stateDiverged", { version });
    case "check-failed": return row.action === "install" ? t("hosts.stateUnknown", { error: row.error ?? "" }) : t("hosts.stateCheckFailed", { error: row.error ?? "" });
    case "current": return t("hosts.stateCurrent", { version });
  }
}
function rowTone(row: HostRow): Tone {
  switch (row.state) {
    case "current": return "success";
    case "offline": return row.pendingSync ? "warning" : "neutral";
    case "connecting": case "checking": case "queued": case "updating": case "job-running": case "job-waiting": return "info";
    case "job-failed": case "update-failed": case "check-failed": return "danger";
    default: return "warning";
  }
}
const IGNORABLE: readonly HostRow["state"][] = ["missing", "disabled", "too-old", "plugins-off", "job-failed", "diverged", "check-failed"];

function HostRowView({ theme, row, now, onCommand, onUpdate, onIgnore, onOpenTerminal, busy }: {
  theme: PluginTheme; row: HostRow; now: number; busy: boolean;
  onCommand: (kind: HostCommandKind) => void; onUpdate: () => void; onIgnore: (value: boolean) => void; onOpenTerminal?: () => void;
}) {
  const { colors } = theme, status = rowStatus(row, now);
  const kind: HostCommandKind | null = row.action === "install" || row.action === "enable" || row.action === "upgrade" ? row.action
    : row.action === "retry-job" ? row.job?.kind ?? null : null;
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
          {kind ? <Button theme={theme} size="sm" label={t(row.action === "retry-job" ? "hosts.retry" : actionLabel[kind])} disabled={busy} onPress={() => onCommand(kind)} /> : null}
          {row.action === "update" || row.action === "retry-update" ? <Button theme={theme} size="sm" label={t(row.action === "update" ? "hosts.update" : "hosts.retry")} disabled={busy} onPress={onUpdate} /> : null}
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
  const [notesOpen, setNotesOpen] = useState(false), [now, setNow] = useState(Date.now());
  useEffect(() => { if (open) { setConfirming(null); setErrors([]); setNotesOpen(false); setNow(Date.now()); void panel.refresh(); } }, [open]);
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

  if (confirming) {
    const footer = <>
      <Button theme={theme} label={t("hosts.back")} disabled={busy} onPress={() => setConfirming(null)} />
      <Button theme={theme} variant="primary" icon="Play" label={t("hosts.confirm")} busy={busy} disabled={busy} onPress={() => { void run(confirming); }} />
    </>;
    return <Dialog theme={theme} title={t("hosts.title")} onClose={onClose} footer={footer}>
      <Text style={{ color: colors.foreground, fontSize: fontSize.body }}>{t("hosts.confirmIntro")}</Text>
      {confirming.commands.map(command => {
        const lines = panel.commandLines(command.kind);
        return <View key={command.serverId} style={{ gap: space.xs + 2 }}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{t(confirmLabel[command.kind], { host: panel.label(command.serverId) })}</Text>
          {lines ? <Mono theme={theme} lines={lines} /> : <Banner theme={theme} tone="warning" message={t("hosts.noSource")} />}
        </View>;
      })}
      {confirming.updates.length ? <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>
        {t("hosts.confirmUpdate", { hosts: confirming.updates.map(panel.label).join(", "), version })}</Text> : null}
      {confirming.commands.length ? <Text style={meta}>{t("hosts.confirmTerminal")}</Text> : null}
    </Dialog>;
  }

  const active = rows.filter(row => !row.ignored), ignored = rows.filter(row => row.ignored);
  const outdated = active.some(row => row.state === "outdated");
  const manual = active.find(row => row.state === "job-failed" && row.job && (row.job.result === "no-cli" || row.job.result === "no-workspace" || row.job.result === "error"));
  const manualLines = manual?.job ? panel.commandLines(manual.job.kind) : null;
  const footer = plan.updates.length || plan.commands.length ? <>
    {outdated ? <Button theme={theme} label={t("hosts.later")} disabled={busy} onPress={() => { void panel.dismiss().catch(() => {}).finally(onClose); }} />
      : <Button theme={theme} label={t("hosts.close")} onPress={onClose} />}
    <Button theme={theme} variant="primary" icon="RefreshCw" label={t("hosts.syncAll")} busy={busy} disabled={busy} onPress={() => setConfirming(plan)} />
  </> : panel.summary.busy ? <Button theme={theme} variant="primary" label={t("hosts.hide")} onPress={onClose} />
    : <>
      <Button theme={theme} label={t("hosts.close")} onPress={onClose} />
      <Button theme={theme} icon="RefreshCw" label={t("hosts.check")} busy={panel.checking} disabled={panel.checking} onPress={() => { void panel.refresh(); }} />
    </>;
  const rowView = (row: HostRow) => <HostRowView key={row.serverId} theme={theme} row={row} now={now} busy={busy}
    onCommand={kind => setConfirming({ updates: [], commands: [{ serverId: row.serverId, kind }] })}
    onUpdate={() => { void run({ updates: [row.serverId], commands: [] }); }}
    onIgnore={value => panel.setIgnored(row.serverId, value)}
    onOpenTerminal={navigation && row.job?.workspaceId ? () => { navigation.openWorkspace({ workspaceId: row.job!.workspaceId!, serverId: row.serverId }); onClose(); } : undefined} />;
  return <Dialog theme={theme} title={t("hosts.title")} onClose={onClose} footer={footer}>
    {target ? <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{t("hosts.latest", { version, revision: short(target.commit) })}</Text>
        <Pressable role="button" aria-expanded={notesOpen} accessibilityLabel={t("hosts.notes")} onPress={() => setNotesOpen(value => !value)}
          style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 2 }}>
          <Text style={{ color: toneColor(theme, "info"), fontSize: fontSize.small }}>{`${t("hosts.notes")} ${notesOpen ? "▾" : "▸"}`}</Text>
        </Pressable>
      </View>
      {notesOpen ? target.entries.length ? <>
        {target.entries.map(entry => <View key={entry.heading} style={{ gap: space.xs }}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{entry.heading}</Text>
          <OutputText theme={theme} text={entry.body} />
        </View>)}
        {target.truncated ? <Text style={meta}>{t("hosts.truncated")}</Text> : null}
      </> : <Text style={meta}>{t(target.version ? "hosts.noNewNotes" : "hosts.noNotes")}</Text> : null}
    </View> : null}
    {!panel.summary.attention && !panel.summary.busy && !panel.checking && rows.every(row => row.state === "current" || row.ignored || (row.state === "offline" && !row.pendingSync))
      ? <Text style={meta}>{t("hosts.allCurrent")}</Text> : null}
    {panel.pageError || panel.page?.error ? <Banner theme={theme} tone="warning" message={t("hosts.checkFailed", { error: panel.pageError ?? panel.page?.error ?? "" })} /> : null}
    <View>{active.map(rowView)}</View>
    {ignored.length ? <View style={{ gap: space.xs }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{t("hosts.ignoredSection")}</Text>
      <View>{ignored.map(rowView)}</View>
    </View> : null}
    {manualLines ? <View style={{ gap: space.xs + 2 }}>
      <Text style={meta}>{t("hosts.manual")}</Text>
      <Mono theme={theme} lines={manualLines} />
      <View style={{ flexDirection: "row" }}><Button theme={theme} size="sm" variant="ghost" icon="Copy" label={t("hosts.copy")}
        onPress={() => { void copyText(manualLines.join("\n")).then(() => toast.show(t("hosts.copied"))).catch(() => {}); }} /></View>
    </View> : null}
    {errors.length ? <Banner theme={theme} tone="danger" message={errors.join("\n")} /> : null}
  </Dialog>;
}
