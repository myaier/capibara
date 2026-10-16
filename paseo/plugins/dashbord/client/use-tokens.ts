import type { FleetFilters } from "../shared/fleet-scope";
import { useRpc } from "./fleet-client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StatsRange } from "../shared/stats";
import { getTokenLive, getTokens, mergeTokens, type TokenState } from "../shared/tokens";
import { useForeground } from "./use-foreground";
import { localTimeZone, localUtcOffset } from "./use-stats";

export const tokensQueryKey = (hostId: string, range: StatsRange) => ["agent-observatory", hostId, "tokens", range] as const;
/** The device's clock for the server's local days (2.14): its offset now and, when the runtime tells, its IANA zone. */
const deviceClock = () => { const timeZone = localTimeZone(); return { utcOffsetMinutes: localUtcOffset(), ...(timeZone ? { timeZone } : {}) }; };

/** Token ledger snapshot while the Token view is visible; polls faster while the first import of old logs runs. */
export function useTokens(hostId: string, range: StatsRange, visible = true, filters?: FleetFilters) {
  const rpc = useRpc(getTokens), cache = useQueryClient(), active = useForeground();
  const queryKey = [...tokensQueryKey(hostId, range), filters ?? null, deviceClock()], enabled = active && visible;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<TokenState>(queryKey);
    // A revision from another zone (travel, a changed device setting) never matches: the server answers in full.
    return mergeTokens(previous, await rpc({ range, filters, ...deviceClock(), ...(previous?.revision ? { revision: previous.revision } : {}) }));
  }, enabled, refetchInterval: query => enabled ? query.state.data?.coverage.backfill.done === false ? 5000 : 30_000 : false, staleTime: 5000, refetchOnWindowFocus: false, retry: 1 });
}

/**
 * Live token speed. "full" (the Token view) polls every 5 s; "agents" (running rows elsewhere) every 10 s and carries
 * only the per-session rates. Replies are answered from the server's memory.
 */
export function useTokenLive(hostId: string, visible: boolean, detail: "full" | "agents" = "full", windowMinutes: 30 | 60 = 30, filters?: FleetFilters) {
  const rpc = useRpc(getTokenLive), active = useForeground(), enabled = active && visible;
  return useQuery({ queryKey: ["agent-observatory", hostId, "tokens-live", detail, windowMinutes, filters ?? null, deviceClock()], queryFn: () => rpc({ filters, windowMinutes, ...deviceClock(), detail }),
    enabled, refetchInterval: enabled ? detail === "full" ? 5000 : 10_000 : false, staleTime: 2000, refetchOnWindowFocus: false, retry: 1, placeholderData: keepPreviousData });
}
