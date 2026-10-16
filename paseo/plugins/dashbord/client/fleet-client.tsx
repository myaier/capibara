import { createFleetPaseo } from "./fleet-paseo";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { getPaseoClient, useHosts, usePaseo as useNativePaseo, useRpc as useNativeRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { input, output, ZodType } from "zod";
import { FLEET_READS, type FleetCoverage } from "../shared/fleet-rpc";
import { hostEntityId, parseHostEntityId, routeEntityInput } from "../shared/fleet-scope";
import { qualifyFleetResult } from "../shared/fleet-entities";
import type { ObservatoryHost } from "../shared/multi-host";
import { hostRegistry } from "./host-registry";
import { reportFleetDiagnostic, fleetCounters } from "../shared/fleet-diagnostics";
import { createFleetReader } from "./fleet-reader";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Paseo = ReturnType<typeof useNativePaseo>;
interface FleetContextValue {
  anchor: string; owner?: string; generationKey: string; hosts: readonly ObservatoryHost[];
  reader: ReturnType<typeof createFleetReader>; report(method: string, coverage: FleetCoverage): void;
  coverage: Record<string, FleetCoverage>;
}
const sharedFleetReader = createFleetReader(hostRegistry, (method, sources, coverage, result, primary) => {
  if (!primary) return;
  void hostRegistry.invoke(primary, reportFleetDiagnostic, { method, at: new Date().toISOString(), complete: coverage.hosts.every(host => host.state === "live"),
    sources: sources.map(source => ({ serverId: source.hostId, generatedAt: source.data.generatedAt ?? null, counters: fleetCounters(method, source.data) })), counters: fleetCounters(method, result),
  }).catch(() => {});
});
const FleetContext = createContext<FleetContextValue | null>(null);
export const useFleet = () => useContext(FleetContext);
export const useRpcScope = () => { const fleet = useFleet(); return fleet?.owner ?? (fleet ? "fleet" : "local"); };
// Paseo's installation cache is also used by local workspace panels. Their one-machine answers must never replace a fleet result.
const fleetQueryClient = new QueryClient();

export function FleetProvider({ host, children }: { host: PluginSurfaceProps["host"]; children: ReactNode }) {
  const hosts = useHosts(), cache = fleetQueryClient;
  const peers = useSyncExternalStore(hostRegistry.subscribe, hostRegistry.getSnapshot, hostRegistry.getSnapshot);
  const [coverage, setCoverage] = useState<Record<string, FleetCoverage>>({});
  const reader = useMemo(() => sharedFleetReader, []);
  const report = useCallback((method: string, next: FleetCoverage) => setCoverage(previous => ({ ...previous, [method]: next })), []);
  const signature = JSON.stringify([hosts.map(host => [host.serverId, host.status]), peers.map(peer => [peer.identity.serverId, peer.generation])]);
  useEffect(() => { void cache.invalidateQueries({ predicate: query => query.queryKey[0] === "agent-observatory" || String(query.queryKey[0]).startsWith("observatory-") }); }, [signature, cache]);
  const value = useMemo(() => ({ anchor: host.id, generationKey: signature, hosts, reader, report, coverage }), [host.id, signature, hosts, reader, report, coverage]);
  return <QueryClientProvider client={cache}><FleetContext.Provider value={value}>{children}</FleetContext.Provider></QueryClientProvider>;
}
export function EntityHost({ id, children }: { id: string; children: ReactNode }) {
  const fleet = useFleet(), owner = parseHostEntityId(id)?.hostId;
  const value = useMemo(() => fleet ? { ...fleet, owner: owner ?? fleet.owner } : null, [fleet, owner]);
  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

/** Existing hooks keep their contracts. Global reads fan out; every entity operation resolves exactly one source. */
export function useRpc<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>): (value: input<I>) => Promise<output<O>> {
  const native = useNativeRpc(contract), fleet = useFleet(), latest = useRef(fleet); latest.current = fleet;
  return useCallback(async value => {
    const current = latest.current; if (!current) return native(value);
    const record = value as Record<string, unknown>;
    const entity = ["agentId", "workspaceId", "projectId", "runId", "jobId", "scheduleId"].some(key => typeof record[key] === "string");
    if (!entity && !current.owner && (FLEET_READS as readonly string[]).includes(contract.name)) {
      return current.reader.read(contract.name as typeof FLEET_READS[number], record, current.hosts, coverage => current.report(contract.name, coverage), current.anchor);
    }
    const route = routeEntityInput(record, current.owner ?? current.anchor);
    if (!current.hosts.some(host => host.serverId === route.hostId && host.status === "online")) throw new Error("The source machine is offline");
    const request = { ...route.input, ...("serverId" in route.input ? { serverId: route.hostId } : {}) };
    const result = await hostRegistry.invoke(route.hostId, contract, request as input<I>);
    const container = /^observatory\.insights\.(start|cancel|feedback|suggest|suggest-cancel|action-feedback)$/.test(contract.name) ? "job" : "";
    return qualifyFleetResult(result, route.hostId, container);
  }, [contract, native]);
}

export function usePaseo(): Paseo {
  const native = useNativePaseo(), fleet = useFleet();
  const hostSignature = JSON.stringify(fleet?.hosts.map(host => [host.serverId, host.status]) ?? []);
  return useMemo(() => fleet ? createFleetPaseo(fleet.owner ?? fleet.anchor, fleet.hosts, getPaseoClient) : native, [native, fleet?.owner, fleet?.anchor, fleet?.generationKey, hostSignature]);
}

export function fleetNavigation(navigation: PluginSurfaceProps["navigation"], fallbackHost: string): PluginSurfaceProps["navigation"] {
  if (!navigation) return navigation;
  const route = (value: any, key: string) => { const ref = typeof value[key] === "string" ? parseHostEntityId(value[key]) : null; return { ...value, [key]: ref?.id ?? value[key], serverId: ref?.hostId ?? value.serverId ?? fallbackHost }; };
  return { ...navigation, openAgent: value => navigation.openAgent(route(value, "agentId")), openWorkspace: value => navigation.openWorkspace(route(value, "workspaceId")),
    ...(navigation.openBrowser ? { openBrowser: (value: any) => navigation.openBrowser!(route(value, "workspaceId")) } : {}) };
}
