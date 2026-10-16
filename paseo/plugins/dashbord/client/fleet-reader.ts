import type { PluginRpcContract } from "@getpaseo/plugin";
import { readFleetPart, readFleetSnapshot, type FleetCoverage, type FLEET_READS } from "../shared/fleet-rpc";
import { mergeFleetRead, type FleetSlice } from "../shared/fleet-merge";
import { mergeTelemetry } from "../shared/telemetry";
import { mergeAnalytics } from "../shared/analytics";
import { canonicalQuery, createHostQueryCache } from "./host-query-cache";
import { hostRegistry } from "./host-registry";
import type { ObservatoryHost } from "../shared/multi-host";
import { filtersForHost, normalizeFleetScope } from "../shared/fleet-scope";
import { copyFingerprint, prepareTokenExclusion, sameTokenCall, type CopyCounter } from "../shared/token-copies";
import { t } from "../shared/text";

type Method = typeof FLEET_READS[number];
const bounded = <T>(promise: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Machine did not respond in time")), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

export async function readHostSnapshot(hostId: string, method: Method | "observatory.tokens.copies" | "observatory.agents.list", input: Record<string, unknown>, registry = hostRegistry) {
    const first = await registry.invoke(hostId, readFleetSnapshot, { method, input, maxPartBytes: 40_000 });
    const parts = [first.json]; let cursor = 1;
    await Promise.all(Array.from({ length: Math.min(8, first.parts - 1) }, async () => {
      while (cursor < first.parts) { const index = cursor++;
        const next = await registry.invoke(hostId, readFleetPart, { snapshotId: first.snapshotId, index });
        if (next.snapshotId !== first.snapshotId || next.index !== index || next.parts !== first.parts) throw new Error("Fleet snapshot changed during transfer");
        parts[index] = next.json;
      }
    }));
    return JSON.parse(parts.join(""));
  }

export function createFleetReader(registry = hostRegistry, onResult?: (method: string, sources: FleetSlice[], coverage: FleetCoverage, result: any, reporterId?: string) => void) {
  const cache = createHostQueryCache<any>();
  const readSnapshot = (hostId: string, method: Method | "observatory.tokens.copies", input: Record<string, unknown>) => readHostSnapshot(hostId, method, input, registry);
  return {
    clear: cache.clear,
    async read(method: Method, value: Record<string, unknown>, hosts: readonly ObservatoryHost[], onCoverage?: (coverage: FleetCoverage) => void, reporterId?: string) {
      const { revision: _revision, ...input } = value;
      const scope = input.filters ? normalizeFleetScope(input.filters as any) : null;
      const coverage: FleetCoverage = { hosts: [] }, slices: FleetSlice[] = [];
      await Promise.all(hosts.map(async host => {
        const scopeForHost = scope ? filtersForHost(scope, host.serverId) : null;
        if (scopeForHost && !scopeForHost.included) return;
        const request = { ...input, ...(scopeForHost ? { filters: scopeForHost.filters } : {}),
          ...(["observatory.stats.get", "observatory.tokens.get", "observatory.tokens.live"].includes(method) ? { complete: true } : {}) };
        const key = canonicalQuery([host.serverId, method, request]);
        const peer = registry.getSnapshot().find(peer => peer.identity.serverId === host.serverId);
        try {
          if (host.status !== "online") throw new Error("Machine is offline");
          if (!peer?.identity.capabilities.includes("fleet-read-v1")) throw new Error("Update this machine's observatory plugin");
          const data = await bounded(cache.read(key, peer.generation, async previous => {
            const result = await readSnapshot(host.serverId, method, { ...request, ...(previous?.revision !== undefined ? { revision: previous.revision } : {}) });
            if (method === "observatory.telemetry.get") return mergeTelemetry(previous, result);
            if (method === "observatory.analytics.get") return mergeAnalytics(previous, result);
            return result.unchanged && previous ? { ...previous, ...result, mode: "full", unchanged: false } : result;
          }), 15_000);
          slices.push({ hostId: host.serverId, label: host.label, data });
          coverage.hosts.push({ id: host.serverId, label: host.label, state: "live", collectedAt: cache.peek(key)!.collectedAt });
        } catch (error) {
          const cached = cache.peek(key);
          // Historical snapshots may be retained. Current states, live rates and write guards must never look live from a cache.
          const historical = ["observatory.stats.get", "observatory.tokens.get", "observatory.analytics.get", "observatory.schedules.list"].includes(method);
          if (cached && historical) slices.push({ hostId: host.serverId, label: host.label, data: cached.value });
          coverage.hosts.push({ id: host.serverId, label: host.label, state: cached && historical ? "cached" : "missing", collectedAt: cached?.collectedAt ?? null, error: error instanceof Error ? error.message : String(error) });
        }
      }));
      // A disconnected machine's yesterday window cannot be added to today's identically named 7d window.
      const reference = [...slices].sort((a, b) => String(b.data.generatedAt ?? "").localeCompare(String(a.data.generatedAt ?? "")))[0]?.data;
      if (reference?.from && reference?.to) for (let i = slices.length - 1; i >= 0; i--) {
        const slice = slices[i];
        if (slice.data.from !== reference.from || slice.data.to !== reference.to) {
          const entry = coverage.hosts.find(host => host.id === slice.hostId)!; entry.state = "missing"; entry.error = "Cached calendar window differs from the current window"; slices.splice(i, 1);
        }
      }
      coverage.hosts.sort((a, b) => a.id.localeCompare(b.id)); slices.sort((a, b) => a.hostId.localeCompare(b.hostId));
      if (method === "observatory.tokens.get" && slices.length > 1) {
        const owners = new Map<string, string[]>(), copies = new Map<string, Map<string, CopyCounter>>();
        let uncertain = slices.some(slice => slice.data.fleetDetails?.dedupeLimited || !slice.data.fleetDetails?.dedupeKeys);
        for (const slice of slices) for (const key of slice.data.fleetDetails?.dedupeKeys ?? []) owners.set(key, [...owners.get(key) ?? [], slice.hostId]);
        const overlapping = [...owners].filter(([, ids]) => ids.length > 1);
        const selected = overlapping.slice(0, 50_000); if (selected.length < overlapping.length) uncertain = true;
        for (const slice of slices) {
          const keys = selected.filter(([, ids]) => ids.includes(slice.hostId)).map(([key]) => key), found = new Map<string, CopyCounter>();
          try {
            for (let start = 0; start < keys.length; start += 2048) {
              const result = await bounded(readSnapshot(slice.hostId, "observatory.tokens.copies", { keys: keys.slice(start, start + 2048) }), 30_000);
              for (const call of result.calls as CopyCounter[]) found.set(call.key, call);
              if (result.missing.length) uncertain = true;
            }
          } catch { uncertain = true; }
          copies.set(slice.hostId, found);
        }
        const exclusions = new Map<string, CopyCounter[]>();
        for (const [key, ids] of selected) {
          const first = copies.get(ids[0])?.get(key);
          if (!first) { uncertain = true; continue; }
          for (const id of ids.slice(1)) { const call = copies.get(id)?.get(key);
            if (call && sameTokenCall(first, call)) exclusions.set(id, [...exclusions.get(id) ?? [], call]); else uncertain = true;
          }
        }
        for (const slice of slices) {
          const calls = exclusions.get(slice.hostId); if (!calls?.length) continue;
          try {
            let id: string | undefined;
            for (let start = 0; start < calls.length; start += 200) {
              const batch = calls.slice(start, start + 200), result = await registry.invoke(slice.hostId, prepareTokenExclusion, {
                id, keys: batch.map(call => call.key), expected: Object.fromEntries(batch.map(call => [call.key, copyFingerprint(call)])),
              });
              id = result.id; if (result.missing.length) uncertain = true;
            }
            slice.data = await readSnapshot(slice.hostId, "observatory.tokens.get", { ...input, complete: true, exclusionId: id,
              ...(scope ? { filters: filtersForHost(scope, slice.hostId).filters } : {}) });
          } catch { uncertain = true; }
        }
        if (uncertain) coverage.notes = [t("fleet.dedupeLimited")];
      }
      onCoverage?.(coverage);
      const result = mergeFleetRead(method, slices, coverage);
      onResult?.(method, slices, coverage, result, reporterId);
      return result;
    },
  };
}
