import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const TITLE_SOURCE = "observatory.title-source";
export const TITLE_VALUE = "observatory.title-value";
export const SESSION_TITLE_MAX = 160;
export const sessionTitle = z.string().trim().min(1).max(SESSION_TITLE_MAX).refine(value => !/[\r\n\u0000-\u001f]/.test(value));
const target = { serverId: z.string().min(1).max(256), agentId: z.string().min(1).max(256) };
export const renameSession = defineRpc({ name: "observatory.sessions.rename", input: z.object({ ...target,
  title: sessionTitle, expectedTitle: z.string().nullable() }), output: z.object({ title: z.string() }) });
export const nameSessions = defineRpc({ name: "observatory.sessions.name", input: z.object({ serverId: target.serverId,
  agentIds: z.array(target.agentId).max(20) }), output: z.object({ queued: z.number(), handledIds: z.array(target.agentId).max(20) }) });

/** Match the host's provisional title exactly; an independently named session is left alone. */
export function provisionalTitle(prompt: string): string {
  return (prompt.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "").replace(/\s+/g, " ").slice(0, 60).trim();
}
/** Codex records `/skill args` as `$skill args`, while the host titled the session from the slash form it was sent. */
export function isProvisionalTitle(title: string, prompt: string): boolean {
  if (title === provisionalTitle(prompt)) return true;
  const trimmed = prompt.trim(), skill = /^\$([^\s/]+)(?:\s|$)/.exec(trimmed)?.[1];
  return !!skill && (title === provisionalTitle(`/${trimmed.slice(1)}`) || title === `/${skill}`);
}

/** Catalogs do not publish a universal size/price rank. These are light-family preferences, never fabricated model IDs. */
export function lightModelRank(id: string): number | null {
  if (/(?:^|[-/\s])nano(?:$|[-/\s])|flash[- ]lite/i.test(id)) return 0;
  if (/haiku|(?:^|[-/\s])mini(?:$|[-/\s])|(?:^|[-/\s])luna(?:$|[-/\s])/i.test(id)) return 1;
  if (/flash/i.test(id)) return 2;
  return null;
}
export function lowestEffort(options: readonly { id: string }[]): string | null {
  const order = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return order.find(id => options.some(option => option.id === id)) ?? null;
}
