import { t } from "../shared/text";
import { defineRpc } from "@getpaseo/plugin";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { z } from "zod";
import type { AttentionResponse, AttentionState } from "../shared/attention-rpc";
import { TIME_ZONE } from "../shared/time-zone";
import { hostRegistry } from "./host-registry";
import { qualifyFleetResult } from "../shared/fleet-entities";

// The server validates the full detail schema; the resident badge reuses its typed reply without shipping it twice. The
// input names `timeZone` so the device's zone is passed on, not stripped (grok-F2).
const getAttention = defineRpc({ name: "observatory.attention.get", input: z.object({ revision: z.string().optional(), timeZone: z.string().optional() }), output: z.custom<AttentionResponse>() });
/** `at`: when the shown state was read (an old one is not shown as a number); `now` and `foreground` as of the last publish. */
export interface AttentionView { state: AttentionState | null; error: string | null; at: number | null; now?: number; foreground?: boolean }
type Read = (input: { revision?: string; timeZone?: string }) => Promise<AttentionResponse>;
/**
 * The host's 需要处理 summary for the sidebar badge and its popover (opus-B1). The popover renders outside the sidebar item (and
 * comes from the UI chunk), so both read this store instead of a query cache. `invalidate` reads again now, after a change
 * the directory alone does not show (知道了 on a stop is the plugin's own record).
 */
export interface AttentionStore { read: Read | null; getSnapshot(): AttentionView; subscribe(listener: () => void): () => void; refresh(): Promise<void>; invalidate(): void }
export const ATTENTION_POLL_MS = 20_000;
/** A count older than this (a stalled or failed read) is hidden rather than shown out of date. */
export const ATTENTION_STALE_MS = 90_000;
const active = () => AppState.currentState !== "background" && AppState.currentState !== "inactive";

/** The device's IANA zone in the form the RPC accepts, or null (the server keeps the zone a client reported last). */
export function deviceTimeZone(): string | null {
  try { const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; return zone && zone.length <= 64 && TIME_ZONE.test(zone) ? zone : null; } catch { return null; }
}
/**
 * A read that reports the device's zone with every call, so the server reads a limit notice without one in the user's time
 * (grok-F2). A zone the RPC would reject is left out rather than failing the read.
 */
export function withDeviceZone(read: Read, zone: () => string | null = deviceTimeZone): Read {
  return input => { const timeZone = zone(); return read(timeZone ? { ...input, timeZone } : input); };
}

/**
 * One foreground listener and clock per host, including the popover; subscribers own its lifetime. It reads only while
 * someone shows it and the app is in the foreground; the server answers an unchanged revision with a few bytes. A change
 * that arrives while a read is in flight (`invalidate`) gets one more read after it: that read may predate the change.
 */
export function createAttentionStore(intervalMs = ATTENTION_POLL_MS, now: () => number = Date.now): AttentionStore {
  let view: AttentionView = { state: null, error: null, at: null, now: now(), foreground: active() };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined, appState: { remove(): void } | undefined, pending: Promise<void> | undefined, again = false;
  const store: AttentionStore = { read: null, getSnapshot: () => view, refresh, invalidate, subscribe(listener) {
    listeners.add(listener);
    if (listeners.size === 1) { appState = AppState.addEventListener("change", sync); sync(); }
    return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; appState?.remove(); appState = undefined; } };
  } };
  function publish(next: AttentionView) { view = { ...next, now: now(), foreground: active() }; listeners.forEach(listener => listener()); }
  function tick() { publish(view); void refresh(); }
  function sync() { clearInterval(timer); timer = undefined; publish(view); if (active()) { tick(); timer = setInterval(tick, intervalMs); } }
  function refresh(): Promise<void> {
    if (pending || !store.read) return pending ?? Promise.resolve();
    const read = store.read, previous = view.state;
    pending = (async () => {
      try {
        let reply: AttentionResponse;
        try { reply = await read(previous ? { revision: previous.revision } : {}); }
        // The server restarted or the cache was dropped: read in full once.
        catch (error) { if (!previous) throw error; reply = await read({}); }
        if (reply.mode !== "full" && !previous) throw new Error(t("boot.secondaryAttentionCacheExpired"));
        const state = reply.mode === "full" ? reply : previous!;
        publish({ state, error: null, at: now() });
      } catch (error) { publish({ ...view, error: error instanceof Error ? error.message : t("boot.secondaryAttentionIsTemporarilyUnavailable") }); }
      finally {
        pending = undefined;
        if (again) { again = false; void refresh(); }
      }
    })();
    return pending;
  }
  function invalidate() { if (pending) again = true; else void refresh(); }
  return store;
}
/** A read failed here or on the server, or the last good one is old: what is shown may be wrong. */
export function attentionUnreliable(view: AttentionView, now = view.now ?? Date.now()): boolean {
  return !!view.error || !!view.state?.failed || view.at === null || now - view.at > ATTENTION_STALE_MS;
}
/** The count to show: none until the server has read the directory, after a failed read, or when the last read is old. */
export function attentionCount(view: AttentionView, now = view.now ?? Date.now()): { value: number; label: string } | null {
  const state = view.state;
  return !state?.ready || attentionUnreliable(view, now) ? null : { value: state.count, label: state.truncated ? `${state.count}+` : String(state.count) };
}
/**
 * The stub's 需要处理 stores, one per host, made once per registration: the badge, the schedule count and (as the
 * `attentionStores` prop) every UI chunk surface share them, so 知道了 / 标记已读 in the chunk's detail re-reads the badge's own
 * store; the chunk is a separate bundle whose module state is its own. Not a global: a reconnect evaluates a fresh stub, and
 * a store holding the old connection's RPC binding must not outlive it.
 */
export interface AttentionStores { get(hostId: string): AttentionStore; invalidate(hostId: string): void }
export function createAttentionStores(): AttentionStores {
  const stores = new Map<string, AttentionStore>();
  return {
    get(hostId) { let store = stores.get(hostId); if (!store) { store = createAttentionStore(); stores.set(hostId, store); } return store; },
    // No badge shown for this host yet: nothing to read again.
    invalidate(hostId) { (stores.get("fleet") ?? stores.get(hostId))?.invalidate(); },
  };
}
/** A host's store from the stub's set; the RPC binding of the latest render is used for reads, and reports the device's zone. */
export function useAttentionStore(stores: AttentionStores, hostId: string): AttentionStore {
  const nativeRead = useRpc(getAttention), store = stores.get(hostRegistry.getSnapshot().length ? "fleet" : hostId), hosts = useHosts();
  const current = useRef(hosts); current.current = hosts;
  const peers = useSyncExternalStore(hostRegistry.subscribe, hostRegistry.getSnapshot, hostRegistry.getSnapshot);
  const signature = JSON.stringify([hosts.map(host => [host.serverId, host.status]), peers.map(peer => peer.generation)]);
  const read: Read = useCallback(async input => {
    if (!hostRegistry.getSnapshot().length) return nativeRead(input);
    const { timeZone } = input;
    const results = await Promise.allSettled(current.current.filter(host => host.status === "online").map(async host => {
      const response = await hostRegistry.invoke(host.serverId, getAttention, { timeZone });
      if (response.mode !== "full") throw new Error("Attention snapshot is incomplete");
      return { ...response, entries: qualifyFleetResult(response.entries, host.serverId).map(entry => ({ ...entry, projectName: `${entry.projectName} · ${host.label}` })) };
    }));
    const rows = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    if (!rows.length) throw new Error("No machines supplied attention status");
    const sum = (key: "count" | "blocking" | "loud" | "scheduleFailures") => rows.reduce((n, row) => n + (row[key] ?? 0), 0);
    return { ...rows[0], revision: `fleet:${Date.now()}`, count: sum("count"), blocking: sum("blocking"), loud: sum("loud"),
      scheduleFailures: rows.every(row => row.scheduleFailures === null) ? null : sum("scheduleFailures"),
      truncated: rows.length < current.current.length || rows.some(row => row.truncated), ready: rows.some(row => row.ready), failed: rows.every(row => row.failed),
      entries: rows.flatMap(row => row.entries).sort((a, b) => (a.since ?? "").localeCompare(b.since ?? "")).slice(0, 8) };
  }, [nativeRead]);
  store.read = withDeviceZone(read);
  useEffect(() => { store.invalidate(); }, [store, signature]);
  return store;
}
/** Subscribes to a store; the store reads while anyone is subscribed and the app is in the foreground. */
export function useAttentionView(store: AttentionStore): AttentionView { return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot); }
