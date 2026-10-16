import { z } from "zod";

export const trajectoryRowSchema = z.object({
  ref: z.string(), epoch: z.string(), seqStart: z.number(), seqEnd: z.number(),
  at: z.string().nullable(), turnId: z.string().nullable(), kind: z.string(), text: z.string(),
  toolName: z.string().nullable(), toolStatus: z.string().nullable(),
});
export const sessionTrajectorySchema = z.object({
  agent: z.object({ id: z.string(), title: z.string(), provider: z.string(), model: z.string().nullable(),
    cwd: z.string().nullable(), workspaceId: z.string().nullable(), archivedAt: z.string().nullable(),
    status: z.string(), attentionReason: z.string().nullable() }),
  project: z.object({ id: z.string(), name: z.string(), rootPath: z.string().nullable() }).nullable(),
  capturedAt: z.string(), rows: z.array(trajectoryRowSchema).max(1500),
  coverage: z.object({ complete: z.boolean(), hasOlder: z.boolean(), hasNewer: z.boolean(), gap: z.boolean(),
    truncated: z.boolean(), reason: z.string().nullable(), projectedItems: z.number(), characters: z.number(), pages: z.number(),
    firstAt: z.string().nullable(), lastAt: z.string().nullable(), epoch: z.string(), endSeq: z.number().int().nonnegative().optional() }),
  counts: z.object({ userTurns: z.number(), assistantMessages: z.number(), tools: z.number(), toolFailures: z.number(),
    errors: z.number(), observedTurnIds: z.number() }),
  completionEvidence: z.object({ kind: z.enum(["attention_finished", "none"]), at: z.string().nullable() }),
});
export type TrajectoryRow = z.infer<typeof trajectoryRowSchema>;
export type SessionTrajectory = z.infer<typeof sessionTrajectorySchema>;
