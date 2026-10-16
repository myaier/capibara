import { useEffect, useRef } from "react";
import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getDigest, mergeDigest, type DigestState } from "../shared/digest";
import { useForeground } from "./use-foreground";

/** Running agents refresh every 30 s, the grain of the server's revision clock, so unchanged replies stay tiny; idle ones every minute. */
export const digestPollMs = (enabled: boolean, running: boolean): number | false => !enabled ? false : running ? 30_000 : 60_000;

/** An agent's execution digest (复盘) while its tab is open and the app is in the foreground. */
export function useDigest(agentId: string, visible: boolean, running: boolean) {
  const rpc = useRpc(getDigest), cache = useQueryClient(), active = useForeground();
  const queryKey = ["agent-observatory", "digest", agentId], enabled = active && visible;
  const query = useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<DigestState>(queryKey);
    return mergeDigest(previous, await rpc({ agentId, ...(previous?.revision ? { revision: previous.revision } : {}) }));
  }, enabled, refetchInterval: digestPollMs(enabled, running), refetchOnWindowFocus: false, staleTime: 5000, retry: 1 });
  // A finished turn settles the digest (final reply, durations): read it once then instead of waiting for the idle poll.
  // Invalidation refetches only an enabled query; a hidden tab reads the stale digest when it opens.
  const last = useRef({ agentId, running });
  useEffect(() => {
    const previous = last.current; last.current = { agentId, running };
    if (previous.agentId === agentId && previous.running && !running) void cache.invalidateQueries({ queryKey: ["agent-observatory", "digest", agentId], exact: true });
  }, [agentId, running, cache]);
  return query;
}
