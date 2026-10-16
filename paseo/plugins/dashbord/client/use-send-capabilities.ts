import { useRpc, useRpcScope } from "./fleet-client";
import { useQuery } from "@tanstack/react-query";
import { capabilitiesFromReply, getSteerableProviders, type SendCapabilities } from "../shared/steer";

/** The providers that can accept a message during a running turn on this host. */
export function useSteerableProviders(enabled: boolean) {
  const scope = useRpcScope();
  const read = useRpc(getSteerableProviders);
  return useQuery({ queryKey: ["agent-observatory", "send-capabilities", scope], enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 1,
    queryFn: async (): Promise<SendCapabilities> => capabilitiesFromReply(await read({})) });
}
