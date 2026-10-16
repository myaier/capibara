import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getTelemetry, mergeTelemetry, type TelemetryState } from "../shared/telemetry";
import { useForeground } from "./use-foreground";

export const telemetryQueryKey = (hostId: string) => ["agent-observatory", hostId, "telemetry"] as const;
/** Revisioned fallback polling; directory activity refreshes sooner (see useAgentActivity). */
export function useTelemetry(hostId: string) {
  const rpc = useRpc(getTelemetry), cache = useQueryClient(), active = useForeground();
  const queryKey = telemetryQueryKey(hostId);
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<TelemetryState>(queryKey);
    return mergeTelemetry(previous, await rpc(previous?.revision ? { revision: previous.revision } : {}));
  }, refetchInterval: active ? 15_000 : false, enabled: active, retry: 1, staleTime: 2000 });
}
