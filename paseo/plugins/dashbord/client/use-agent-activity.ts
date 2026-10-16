import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";
import { activitySignature } from "../shared/activity-signature";
import type { AgentSource } from "../shared/model";

/**
 * Directory activity that matters to the page's other data: an Agent's state, attention, requests, prompt or archive
 * changed (opus-F6). Usage-only updates (every model call of a running turn) are ignored, and a burst becomes one call.
 * Paseo 0.9 feeds `agents.subscribe` only from observations owned by this surface's API (the shared directory store),
 * so this adds no server demand of its own.
 */
export function useAgentActivity(onActivity: () => void, delayMs = 3000) {
  const paseo = usePaseo(), callback = useRef(onActivity);
  callback.current = onActivity;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Map<string, string>();
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; callback.current(); }, delayMs); };
    const unsubscribe = paseo.agents.subscribe(update => {
      const change = (update ?? {}) as { kind?: string; agent?: AgentSource; agentId?: string };
      if (change.kind === "remove") { if (change.agentId) seen.delete(change.agentId); schedule(); return; }
      const agent = change.agent;
      if (!agent?.id) return;
      const signature = activitySignature(agent);
      // The first update seen for an Agent counts: updates only arrive when something changed.
      if (seen.get(agent.id) !== signature) { seen.set(agent.id, signature); schedule(); }
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [paseo, delayMs]);
}
