import { screenLocationForHost } from "../shared/screen-routing";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { input, output, ZodType } from "zod";
import { getHostIdentity, HOST_DATA_PROTOCOL, reportHostDiagnostics, type HostIdentity } from "../shared/host-data";

type Rpc = PluginClientContext["rpc"];
interface Peer { identity: HostIdentity; rpc: Rpc; token: object; generation: number; openScreen?: PluginClientContext["openScreen"] }
export interface HostPeerSummary { identity: HostIdentity; generation: number }
interface RegistryData { peers: Map<string, Peer>; listeners: Set<() => void>; snapshot: readonly HostPeerSummary[]; generation: number }
const newData = (): RegistryData => ({ peers: new Map(), listeners: new Set(), snapshot: [], generation: 0 });

/** Only live installation-owned RPC closures are shared. No credentials, connection URLs or daemon sockets are copied. */
export function createHostRegistry(data = newData()) {
  const publish = () => {
    data.snapshot = [...data.peers.values()].map(peer => ({ identity: peer.identity, generation: peer.generation })).sort((a, b) => a.identity.serverId.localeCompare(b.identity.serverId));
    for (const listener of data.listeners) listener();
  };
  return {
    getSnapshot: () => data.snapshot,
    subscribe(listener: () => void) { data.listeners.add(listener); return () => { data.listeners.delete(listener); }; },
    register(identity: HostIdentity, rpc: Rpc, openScreen?: PluginClientContext["openScreen"]) {
      if (identity.protocol !== HOST_DATA_PROTOCOL) throw new Error("Incompatible observatory host protocol");
      const token = {}, generation = ++data.generation;
      data.peers.set(identity.serverId, { identity, rpc, token, generation, openScreen }); publish();
      return () => { if (data.peers.get(identity.serverId)?.token === token) { data.peers.delete(identity.serverId); publish(); } };
    },
    openScreen(location: Parameters<PluginClientContext["openScreen"]>[0], preferredHost?: string) {
      const peer = (preferredHost ? data.peers.get(preferredHost) : undefined) ?? [...data.peers.values()].sort((a, b) => a.generation - b.generation)[0];
      if (!peer?.openScreen) return false;
      peer.openScreen(location); return true;
    },
    async invoke<I extends ZodType, O extends ZodType>(serverId: string, contract: PluginRpcContract<I, O>, value: input<I>): Promise<output<O>> {
      const peer = data.peers.get(serverId);
      if (!peer) throw new Error(`Observatory plugin is unavailable on host ${serverId}`);
      const answer = await peer.rpc(contract, value);
      if (data.peers.get(serverId)?.token !== peer.token) throw new Error(`Observatory connection changed on host ${serverId}`);
      return answer;
    },
  };
}

// Paseo evaluates each connected installation in the same client JS realm. Keep data, not implementation functions,
// across bundle reloads; cleanup is tied to the originating installation and cannot delete its replacement.
const registryKey = "__capibaraObservatoryHostRegistryV1";
const globals = globalThis as unknown as Record<string, RegistryData | undefined>;
export const hostRegistry = createHostRegistry(globals[registryKey] ?? (globals[registryKey] = newData()));

export function primaryHostId(peers: readonly HostPeerSummary[]): string | null {
  return [...peers].sort((a, b) => a.generation - b.generation)[0]?.identity.serverId ?? null;
}

export function registerClientHost(client: PluginClientContext, registry = hostRegistry, onIdentity?: (id: string) => void) {
  let disposed = false, identity: HostIdentity | null = null, release: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null, reportTimer: ReturnType<typeof setTimeout> | null = null;
  let reporting = false, again = false;
  const rpc: Rpc = (contract, value) => client.rpc(contract, value);
  const report = async () => {
    if (disposed || !identity) return;
    if (reporting) { again = true; return; }
    reporting = true;
    const reporterId = identity.serverId;
    try {
      const peers = await Promise.all(registry.getSnapshot().slice(0, 64).map(async peer => {
        const serverId = peer.identity.serverId, nonce = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
        try {
          const result = await registry.invoke(serverId, getHostIdentity, { nonce });
          if (result.serverId !== serverId || result.nonce !== nonce) throw new Error("Host identity response mismatch");
          return { serverId, version: result.version, ok: true, error: null };
        } catch (error) { return { serverId, version: null, ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 240) }; }
      }));
      if (!disposed) await rpc(reportHostDiagnostics, { reporterId, peers });
    } catch { /* Diagnostic transport failure must not take down the normal plugin UI. */ }
    finally { reporting = false; if (again && !disposed) { again = false; scheduleReport(); } }
  };
  const scheduleReport = () => {
    if (disposed || reportTimer !== null) return;
    reportTimer = setTimeout(() => { reportTimer = null; void report(); }, 100);
  };
  const unsubscribe = registry.subscribe(scheduleReport);
  const connect = async () => {
    try {
      const result = await rpc(getHostIdentity, { nonce: "registration" });
      if (disposed) return;
      if (result.nonce !== "registration" || result.protocol !== HOST_DATA_PROTOCOL) throw new Error("Host identity handshake failed");
      identity = result; onIdentity?.(result.serverId); release = registry.register(result, rpc, location => client.openScreen(screenLocationForHost(location, result.serverId)));
    } catch {
      if (!disposed) retry = setTimeout(() => { retry = null; void connect(); }, 5_000);
    }
  };
  void connect();
  return () => {
    disposed = true;
    if (retry !== null) clearTimeout(retry);
    if (reportTimer !== null) clearTimeout(reportTimer);
    unsubscribe(); release?.();
  };
}
