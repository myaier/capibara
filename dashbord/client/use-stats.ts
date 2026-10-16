import type { FleetFilters } from "../shared/fleet-scope";
import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getStats, mergeStats, statsTimeZoneSchema, type StatsRange, type StatsState } from "../shared/stats";
import { useForeground } from "./use-foreground";

export const statsQueryKey = (hostId: string, range: StatsRange) => ["agent-observatory", hostId, "stats", range] as const;
/** Local offset from UTC in minutes (UTC+8 → 480), as the server buckets days and hours in it. */
export const localUtcOffset = () => -new Date().getTimezoneOffset();
/**
 * The device's IANA zone (Europe/Berlin, America/New_York), so the server can give each past hour its own offset across
 * daylight-saving changes. Omitted when the runtime cannot tell: the server then uses the offset alone.
 */
export function localTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return statsTimeZoneSchema.safeParse(zone).success ? zone : undefined;
  } catch { return undefined; }
}

/** Dashboard statistics, read only while a statistics view is visible; unchanged polls cost a few bytes. */
export function useStats(hostId: string, range: StatsRange, visible = true, filters?: FleetFilters) {
  const rpc = useRpc(getStats), cache = useQueryClient(), active = useForeground();
  const queryKey = [...statsQueryKey(hostId, range), filters ?? null, localUtcOffset(), localTimeZone() ?? null];
  const enabled = active && visible;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<StatsState>(queryKey), timeZone = localTimeZone();
    // A revision from another zone (travel, a changed device setting) never matches: the server answers in full.
    return mergeStats(previous, await rpc({ range, filters, utcOffsetMinutes: localUtcOffset(), ...(timeZone ? { timeZone } : {}),
      ...(previous?.revision ? { revision: previous.revision } : {}) }));
  }, enabled, refetchInterval: enabled ? 30_000 : false, staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 });
}
