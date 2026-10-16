import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getBackground, mergeBackground, type BackgroundState } from "../shared/background";
import { useForeground } from "./use-foreground";

export const backgroundQueryKey = (hostId: string) => ["agent-observatory", hostId, "background"] as const;

/**
 * 后台执行中 per Agent, from the server's tracker. Revisioned polls are the safety net; directory activity (a turn
 * ending, see DashboardSurface) refetches at once. The page does not subscribe to subagent events itself: that stream
 * carries every subagent's output rows, too much to relay to a phone for a few counts.
 */
export function useBackground(hostId: string, enabled = true) {
  const rpc = useRpc(getBackground), cache = useQueryClient(), foreground = useForeground();
  const queryKey = backgroundQueryKey(hostId), on = enabled && foreground;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<BackgroundState>(queryKey);
    return mergeBackground(previous, await rpc(previous?.revision ? { revision: previous.revision } : {}));
  }, enabled: on, refetchInterval: on ? 10_000 : false, staleTime: 2_000, retry: 1 });
}
