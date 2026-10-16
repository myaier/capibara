import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getQuota, mergeQuota, type QuotaState } from "../shared/quota";
import { useForeground } from "./use-foreground";

export const quotaQueryKey = (hostId: string) => ["agent-observatory", hostId, "quota"] as const;

/**
 * 额度 for the Token page card and the 看板 chip (one cache per host). Read while `visible` and the app is in the
 * foreground: on open when the last answer is over a minute old, then every 5 minutes; every 3 s while the server says a
 * read is in flight. The server reads the host at most every 5 minutes for pages, and its own 10-minute sampler runs
 * only until 30 minutes after the last of these reads (server/quota.ts); the host answers from its 5-minute cache, so
 * polling never reaches a provider more often than the app's Usage panel, and nothing does while no page is open.
 * A cached answer brought back from the background is shown as an older reading until the fresh one arrives.
 */
export function useQuota(hostId: string, visible = true) {
  const rpc = useRpc(getQuota), cache = useQueryClient(), foreground = useForeground();
  const queryKey = quotaQueryKey(hostId), enabled = foreground && visible;
  return useQuery({
    queryKey,
    queryFn: async () => {
      const previous = cache.getQueryData<QuotaState>(queryKey);
      return mergeQuota(previous, await rpc(previous?.revision ? { revision: previous.revision } : {}));
    },
    enabled, retry: 1, staleTime: 60_000, refetchOnWindowFocus: false,
    refetchInterval: query => !enabled ? false : query.state.data?.refreshing ? 3000 : 5 * 60_000,
  });
}
