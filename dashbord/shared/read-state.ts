import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
export const readReceiptSchema = z.object({
  agentId: z.string().min(1).max(512), completionAt: timestamp,
  lastUserMessageAt: timestamp.nullable(), readAt: timestamp,
});
export type ReadReceipt = z.infer<typeof readReceiptSchema>;
export const archiveReadOriginSchema = z.object({
  agentId: z.string().min(1).max(512), archivedAt: timestamp, lastUserMessageAt: timestamp.nullable(),
});
export type ArchiveReadOrigin = z.infer<typeof archiveReadOriginSchema>;
export const markCompletionRead = defineRpc({
  name: "observatory.read-state.mark",
  // `error`: acknowledge a failed turn or a stop (知道了). It clears native attention like opening the Agent in Paseo, and
  // records no completion receipt. Without `kind` it is a finished turn or a question (标记已读).
  // `attentionTimestamp` is the host's own token, checked and cleared. It is null for a turn the host closed mid-way, which
  // raised no attention; `stopAt` (with `error`) then names the stop the server observed, and 知道了 is recorded on it.
  // `completionAt` is the completion the page shows as unread: after another prompt, or a heartbeat's turn (which leaves the
  // prompt as it was), the host's token still names an older, unread one (it is edge-triggered), so the receipt is stored for
  // exactly the newer turn's observed end once the server has verified it; a claim of an older turn is stale (codex-F5,
  // codex-obs-attn-F1).
  // An Agent the host has not loaded is never loaded for this (clearing would load it; an ACP one cannot be loaded at all):
  // the host's token is then only checked, and a receipt here for that token is what marks it (P2-3, P2-4): a result read, a
  // reply that asks opened, a failure seen (知道了, which also records its stop). `rearm`: a quick reply about to be sent,
  // which loads the Agent anyway, clears it first regardless, so the turn the reply starts is announced when it ends.
  // `round`: the turn whose reply asks the user (待回复), as the page saw it start and end. A heartbeat's next round asks again
  // with the host's prompt and attention tokens unchanged, so the server marks it read only while the turn it observed last is
  // still this one (codex-obs-attn-R2); a page left on an earlier round's question gets stale. A quick reply's `rearm` names
  // the round it answers by its start alone (codex-obs-attn-R4): nothing is cleared once another round has begun since, or
  // when the plugin's own record of the rounds cannot be read.
  input: z.object({ agentId: z.string().min(1).max(512), attentionTimestamp: timestamp.nullable(), lastUserMessageAt: timestamp.nullable(), kind: z.enum(["completion", "error"]).optional(),
    completionAt: timestamp.optional(), stopAt: timestamp.optional(), rearm: z.boolean().optional(),
    round: z.object({ startedAt: timestamp.nullable(), endedAt: timestamp.nullable().optional() }).optional() }),
  output: z.object({ agentId: z.string(), status: z.enum(["read", "stale", "not_unread", "failed"]),
    receipt: readReceiptSchema.nullable(), message: z.string() }),
});
export type MarkCompletionReadInput = z.infer<typeof markCompletionRead.input>;
export type MarkCompletionReadResult = z.infer<typeof markCompletionRead.output>;
const revision = z.string().min(1).max(80);
const readReceiptsSnapshotSchema = z.object({ receipts: z.array(readReceiptSchema).max(2000), archiveOrigins: z.array(archiveReadOriginSchema).max(2000).default([]), error: z.string().nullable() });
/** A content revision; polling clients receive the receipts again only after they change. */
export const getReadReceipts = defineRpc({
  name: "observatory.read-state.list", input: z.object({ revision: revision.optional() }),
  output: z.discriminatedUnion("mode", [
    readReceiptsSnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
    z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
  ]),
});
export type ReadReceiptsSnapshot = z.infer<typeof readReceiptsSnapshotSchema>;
export type ReadReceiptsState = ReadReceiptsSnapshot & { revision?: string };
export type ReadReceiptsResponse = z.infer<typeof getReadReceipts.output>;
export function mergeReadReceipts(previous: ReadReceiptsState | undefined, response: ReadReceiptsResponse | ReadReceiptsSnapshot): ReadReceiptsState {
  if (!("mode" in response)) return response;
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return snapshot; }
  if (!previous) throw new Error(t("sharedReadState.m001"));
  return previous;
}
