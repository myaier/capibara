import { useRpc, useRpcScope } from "./fleet-client";
import { useQuery } from "@tanstack/react-query";
import { getProviderBases, type ProviderBases } from "../shared/provider-bases";

/** Which base each custom provider runs on (server/provider-bases.ts); cached for minutes. */
export function useProviderBases(enabled: boolean) {
  const scope = useRpcScope();
  const rpc = useRpc(getProviderBases);
  return useQuery({ queryKey: ["agent-observatory", "provider-bases", scope], enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 1, queryFn: async () => (await rpc({})).bases as ProviderBases });
}
