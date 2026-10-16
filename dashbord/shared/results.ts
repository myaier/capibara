import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const resultExcerptSchema = z.object({ text: z.string().max(60_000), ref: z.string(), at: z.string().nullable(), truncated: z.boolean() });
export const agentResultSchema = z.object({
  agentId: z.string(), capturedAt: z.string(), epoch: z.string(),
  // Which turn it was read for (shared/model.ts `resultSource`): the host's tokens, and the completion and heartbeat round they
  // cannot name on their own (codex-obs-attn-F1). Older servers send only the tokens.
  source: z.object({ lastUserMessageAt: z.string().nullable(), attentionTimestamp: z.string().nullable(),
    completionAt: z.string().nullable().optional(), roundEndedAt: z.string().nullable().optional() }).optional(),
  firstInput: resultExcerptSchema.extend({ completeOrigin: z.boolean() }).nullable(),
  latestUserInput: resultExcerptSchema.nullable(), latestReply: resultExcerptSchema.nullable(),
  isRunning: z.boolean(), isFinal: z.boolean(),
  artifacts: z.array(z.object({ kind: z.enum(["file", "url"]), label: z.string().max(500), path: z.string().max(2000), ref: z.string() })).max(40),
  testEvidence: z.array(z.object({ command: z.string().max(1000), text: z.string().max(4000), outcome: z.enum(["passed", "failed", "unknown"]), ref: z.string() })).max(20),
  metrics: z.object({ tools: z.number(), failedTools: z.number(), changedFiles: z.number(), userTurns: z.number() }),
  coverage: z.object({ firstInputConfirmed: z.boolean(), truncated: z.boolean(), rows: z.number(), hasOlder: z.boolean(), reason: z.string().nullable() }),
});
const revision = z.string().min(1).max(80);
/** Running Agents are polled every few seconds; an unchanged result (ignoring capture time) costs a few bytes. */
export const getAgentResult = defineRpc({ name: "observatory.results.get", input: z.object({ agentId: z.string().min(1).max(256),
  expectedLastUserMessageAt: z.string().nullable().optional(), expectedAttentionTimestamp: z.string().nullable().optional(), revision: revision.optional() }),
  output: z.discriminatedUnion("mode", [agentResultSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }), z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision })]) });
export type AgentResult = z.infer<typeof agentResultSchema>;
export type AgentResultState = AgentResult & { revision?: string };
export type AgentResultResponse = z.infer<typeof getAgentResult.output>;
export function mergeAgentResult(previous: AgentResultState | undefined, response: AgentResultResponse | AgentResult): AgentResultState {
  if (!("mode" in response)) return response;
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...result } = response; return result; }
  if (!previous) throw new Error(t("sharedResults.m001"));
  return previous;
}
export type ResultExcerpt = z.infer<typeof resultExcerptSchema>;
