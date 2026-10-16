import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAnalytics, mergeAnalytics, type AnalyticsState } from "../shared/analytics";
import { useForeground } from "./use-foreground";
import { localTimeZone, localUtcOffset } from "./use-stats";

/**
 * Loaded only while its view is visible; unchanged polls cost a few bytes and advance coverage. The device's clock
 * goes along, so the server lays out the days and hours in it (opus-F40); a revision from another zone never matches,
 * so the server answers in full after travel or a changed setting.
 */
export function useAnalytics(hostId: string, visible = true, projectId?: string) {
  const rpc = useRpc(getAnalytics), cache = useQueryClient(), active = useForeground();
  const queryKey = ["agent-observatory", hostId, "analytics", projectId ?? "all"];
  const enabled = active && visible;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<AnalyticsState>(queryKey), timeZone = localTimeZone();
    return mergeAnalytics(previous, await rpc({ ...(projectId ? { projectId } : {}), utcOffsetMinutes: localUtcOffset(), ...(timeZone ? { timeZone } : {}),
      ...(previous?.revision ? { revision: previous.revision } : {}) }));
  }, enabled, refetchInterval: enabled ? 15_000 : false, staleTime: 5000, refetchOnWindowFocus: false, retry: 1 });
}
