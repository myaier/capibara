import { useCallback } from "react";
import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getScheduleHeartbeats, getScheduleRun, heartbeatGuard, heartbeatsByAgent, listScheduleRuns, mergeHeartbeats, mergeScheduleRuns, type HeartbeatGuard, type HeartbeatSummary,
  type HeartbeatsState, type RunWindow, type ScheduleRunsState } from "../shared/schedules";
import { useForeground } from "./use-foreground";

/** One cache entry per window and search (`query` as `normalizeRunQuery` returns it), so a revision only ever answers its own list. */
export const scheduleRunsQueryKey = (hostId: string, window: RunWindow, query = "") => ["agent-observatory", hostId, "schedules", window, query] as const;

/**
 * 定时运行 feed, read only while the page is on screen and the app in the foreground. Unchanged polls cost a few bytes
 * (revisioned like 事件 / 看板); while a run is going it polls every 10 s so it flips to 成功 / 失败 promptly, otherwise every 45 s.
 * A non-empty `query` is searched on the server, through each run's full recorded reply.
 */
export function useScheduleRuns(hostId: string, window: RunWindow, visible = true, query = "") {
  const rpc = useRpc(listScheduleRuns), cache = useQueryClient(), foreground = useForeground();
  const queryKey = scheduleRunsQueryKey(hostId, window, query), enabled = foreground && visible;
  return useQuery({
    queryKey,
    queryFn: async () => {
      const previous = cache.getQueryData<ScheduleRunsState>(queryKey);
      return mergeScheduleRuns(previous, await rpc({ window, ...(query ? { query } : {}), ...(previous?.revision ? { revision: previous.revision } : {}) }));
    },
    enabled, retry: 1, staleTime: 5000, refetchOnWindowFocus: false,
    // 「加载更早」 and a new search keep the current list on screen until the new one arrives (never another host's list).
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === hostId ? previous : undefined,
    refetchInterval: query => !enabled ? false : query.state.data?.runs.some(run => run.status === "running") ? 10_000 : 45_000,
  });
}

/** One run's recorded reply, prompt and feed row. A finished run never changes, so it is kept for the session. */
export function useScheduleRun(runId: string | null, running: boolean) {
  const rpc = useRpc(getScheduleRun), foreground = useForeground();
  return useQuery({ queryKey: ["agent-observatory", "schedule-run", runId], queryFn: () => rpc({ runId: runId! }), enabled: !!runId && foreground,
    staleTime: running ? 5000 : Infinity, refetchInterval: running && foreground ? 10_000 : false, refetchOnWindowFocus: false, retry: 1 });
}

export const heartbeatsQueryKey = (hostId: string) => ["agent-observatory", hostId, "schedule-heartbeats"] as const;
export type HeartbeatIndex = HeartbeatsState & { byAgent: ReadonlyMap<string, HeartbeatSummary[]> };
// Module-level so react-query re-runs it only when the data changes.
const indexHeartbeats = (state: HeartbeatsState): HeartbeatIndex => ({ ...state, byAgent: heartbeatsByAgent(state.heartbeats) });

/**
 * Heartbeats by the Agent they wake (`data.byAgent.get(agentId)`, most relevant first), for the session rows' 「22:35 唤醒」 and
 * the detail's 心跳 card. Read once a minute, only while `enabled` and the app is in the foreground; unchanged reads are a few bytes.
 * Whether the read can show that a session has none is `heartbeatGuard(data, !!error)` (归档已读完成, codex-F16).
 */
export function useHeartbeats(hostId: string, enabled = true) {
  const rpc = useRpc(getScheduleHeartbeats), cache = useQueryClient(), foreground = useForeground();
  const queryKey = heartbeatsQueryKey(hostId), active = enabled && foreground;
  return useQuery({
    queryKey,
    queryFn: async () => {
      const previous = cache.getQueryData<HeartbeatsState>(queryKey);
      return mergeHeartbeats(previous, await rpc(previous?.revision ? { revision: previous.revision } : {}));
    },
    select: indexHeartbeats,
    enabled: active, retry: 1, staleTime: 30_000, refetchOnWindowFocus: false, refetchInterval: active ? 60_000 : false,
  });
}

/**
 * 归档已读完成's second tap (codex-F16): reads the schedule files now (`fresh`, not a build up to 10 minutes old), hands the answer to
 * the heartbeats cache and says whether it can be trusted. A failed request resolves to a guard that is not ready; it never throws.
 */
export function useHeartbeatCheck(hostId: string): () => Promise<HeartbeatGuard> {
  const rpc = useRpc(getScheduleHeartbeats), cache = useQueryClient();
  return useCallback(async () => {
    try {
      const response = await rpc({ fresh: true });
      if (response.mode !== "full") return heartbeatGuard(undefined, true);
      cache.setQueryData(heartbeatsQueryKey(hostId), response);
      return heartbeatGuard(response);
    } catch { return heartbeatGuard(undefined, true); }
  }, [rpc, cache, hostId]);
}
