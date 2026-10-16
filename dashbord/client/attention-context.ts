import { createContext, useContext } from "react";
import type { AttentionStores } from "./use-attention";

/**
 * The resident stub's 需要处理 stores inside the UI chunk: the stub hands them to every surface as the `attentionStores` prop
 * (index.client.tsx) and the surface provides them here (ui-chunk.client.tsx). A prop, not a global: the chunk is a separate
 * bundle with its own module state, and a reconnect evaluates a fresh stub whose stores must not outlive it.
 */
export const AttentionStoresContext = createContext<AttentionStores | null>(null);
/** Reads a host's badge again now, after a change the directory alone does not show (no badge shown yet: nothing to do). */
export function useInvalidateAttention(): (hostId: string) => void {
  const stores = useContext(AttentionStoresContext);
  return hostId => { stores?.invalidate(hostId); };
}
