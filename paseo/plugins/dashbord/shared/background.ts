import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { applyTelemetry, timestamp, type AgentBackground, type AgentRecord } from "./model";
import type { TelemetrySnapshot } from "./telemetry";

/**
 * 后台执行中: provider subagents (Claude Code background Task agents and the like) keep working after their parent's
 * turn ended. Paseo shows them as "N working" and counts the workspace as running while the Agent itself is idle.
 */
export const backgroundAgentSchema = z.object({
  agentId: z.string().min(1).max(256),
  running: z.number().int().positive().max(100),
  since: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  labels: z.array(z.string().max(120)).max(3),
});
export type BackgroundAgent = z.infer<typeof backgroundAgentSchema>;

const revision = z.string().min(1).max(80);
export const backgroundResponseSchema = z.discriminatedUnion("mode", [
  // `available` is false while the host's subagent stream is not open (older hosts never open it).
  z.object({ mode: z.literal("full"), unchanged: z.literal(false), revision, available: z.boolean(), agents: z.array(backgroundAgentSchema).max(500) }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);
export type BackgroundResponse = z.infer<typeof backgroundResponseSchema>;
export const getBackground = defineRpc({
  name: "observatory.background.get",
  input: z.object({ revision: revision.optional() }),
  output: backgroundResponseSchema,
});

export interface BackgroundState { available: boolean; agents: BackgroundAgent[]; revision: string }
export function mergeBackground(previous: BackgroundState | undefined, response: BackgroundResponse): BackgroundState {
  if (response.mode === "full") return { available: response.available, agents: response.agents, revision: response.revision };
  if (!previous) throw new Error(t("sharedBackground.m001"));
  return previous;
}

const SETTLED = new Set(["idle", "completed", "quiet", "canceled"]);
/**
 * An Agent whose own turn ended while its subagents still work is 执行中. Approvals, errors, starting and closed
 * sessions keep their state; a running one only gains the background details.
 */
export function applyBackground(agent: AgentRecord, background?: AgentBackground | null): AgentRecord {
  if (!background || background.running < 1 || agent.archivedAt) return agent;
  const settled = SETTLED.has(agent.status);
  if (!settled && agent.status !== "running") return agent;
  const activity = (timestamp(background.updatedAt) ?? 0) > (timestamp(agent.lastActivityAt) ?? 0) ? background.updatedAt : agent.lastActivityAt;
  return { ...agent, ...(settled ? { status: "running" as const } : {}), background, lastActivityAt: activity };
}

/** Lifecycle outcomes first, then background work, which outranks a finished turn. */
export function enrichAgents(agents: AgentRecord[], telemetry?: TelemetrySnapshot, background?: Pick<BackgroundState, "agents">): AgentRecord[] {
  if (!telemetry && !background?.agents.length) return agents;
  const records = new Map((telemetry?.agents ?? []).map(item => [item.agentId, item]));
  const working = new Map((background?.agents ?? []).map(item => [item.agentId, item]));
  return agents.map(agent => {
    const record = records.get(agent.id), enriched = applyTelemetry(agent, record);
    return applyBackground(record?.link ? { ...enriched, changeRequest: record.link } : enriched, working.get(agent.id));
  });
}
