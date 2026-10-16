import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getLiveExtras, mergeLiveExtras, type LiveExtrasState } from "../shared/attention";
import { useForeground } from "./use-foreground";

export const liveExtrasQueryKey = (hostId: string) => ["agent-observatory", hostId, "live-extras"] as const;
/**
 * Running turns' todo progress and the host's attention notes (the one-line reasons of 待回复 / 未读). Read while the list
 * shows live work or something that needs you; an unchanged revision costs a few bytes.
 */
export function useLiveExtras(hostId: string, enabled: boolean) {
  const rpc = useRpc(getLiveExtras), cache = useQueryClient(), foreground = useForeground();
  const queryKey = liveExtrasQueryKey(hostId), on = enabled && foreground;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<LiveExtrasState>(queryKey);
    try { return mergeLiveExtras(previous, await rpc(previous?.revision ? { revision: previous.revision } : {})); }
    catch (error) { if (!previous) throw error; return mergeLiveExtras(undefined, await rpc({})); }
  }, enabled: on, refetchInterval: on ? 10_000 : false, refetchOnWindowFocus: false, staleTime: 3_000, retry: 1 });
}
