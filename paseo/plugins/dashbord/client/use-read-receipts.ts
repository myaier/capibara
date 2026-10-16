import { useRpc } from "./fleet-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getReadReceipts, mergeReadReceipts, type ReadReceiptsState } from "../shared/read-state";
import { useForeground } from "./use-foreground";
export const readReceiptQueryKey = ["agent-observatory", "read-receipts"] as const;
export function useReadReceipts() {
  const read = useRpc(getReadReceipts), cache = useQueryClient(), active = useForeground();
  return useQuery({queryKey:readReceiptQueryKey,queryFn:async()=>{const previous=cache.getQueryData<ReadReceiptsState>(readReceiptQueryKey);return mergeReadReceipts(previous,await read(previous?.revision?{revision:previous.revision}:{}));},enabled:active,refetchInterval:active?15_000:false,staleTime:1500,retry:1});
}
