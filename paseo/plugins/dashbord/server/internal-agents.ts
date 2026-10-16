import { t } from "../shared/text";
import type { PaseoApi } from "./paseo-types";
import { isInternalAgent } from "../shared/internal-agents";

const internalIds = new Set<string>();
const observations = new WeakMap<PaseoApi, Map<string, { at: number; value: Promise<boolean> }>>();
export function markInternalAgent(id: string) { internalIds.add(id); }
/** 0.9 lifecycle payloads omit labels, so resolve them once per Agent without blocking hooks. */
export function isInternalAgentAsync(paseo: PaseoApi, agent: { id: string; labels?: Record<string, string> }): Promise<boolean> {
  if (internalIds.has(agent.id) || isInternalAgent(agent)) { markInternalAgent(agent.id); return Promise.resolve(true); }
  if (agent.labels) return Promise.resolve(false);
  let cache = observations.get(paseo); if (!cache) { cache = new Map(); observations.set(paseo, cache); }
  const previous = cache.get(agent.id), now = Date.now();
  if (previous && now - previous.at < 60_000) return previous.value;
  const value = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const handle = paseo.agents.ref(agent.id);
      const current = handle.current();
      const snapshot = current ?? (await Promise.race([handle.refresh(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t("internalAgents.m001"))), 5000); timer.unref();
      })]))?.agent;
      if (!snapshot) throw new Error(t("internalAgents.m002"));
      const internal = isInternalAgent(snapshot);
      if (internal) markInternalAgent(agent.id);
      return internal || internalIds.has(agent.id);
    } finally { if (timer) clearTimeout(timer); }
  })();
  cache.set(agent.id, { at: now, value });
  if (cache.size > 4000) cache.delete(cache.keys().next().value!);
  void value.catch(() => cache?.delete(agent.id));
  return value;
}
