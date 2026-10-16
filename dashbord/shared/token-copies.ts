import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { TOKEN_SOURCES } from "./tokens";

const key = z.string().regex(/^[a-f0-9]{16}$/);
export const copyCounterSchema = z.object({ key, source: z.enum(TOKEN_SOURCES), at: z.number(), start: z.number().nullable(),
  model: z.string().nullable(), input: z.number(), cacheWrite: z.number(), cacheRead: z.number(), output: z.number(), reasoning: z.number(), calls: z.number().optional() });
export type CopyCounter = z.infer<typeof copyCounterSchema>;
export const getTokenCopies = defineRpc({ name: "observatory.tokens.copies", input: z.object({ keys: z.array(key).max(2048) }),
  output: z.object({ calls: z.array(copyCounterSchema), missing: z.array(key) }) });
/** Only an expiring projection changes; the persistent ledger is never edited. */
export const prepareTokenExclusion = defineRpc({ name: "observatory.tokens.exclude", input: z.object({ keys: z.array(key).max(200), expected: z.record(z.string(), z.string().max(2048)), id: z.string().uuid().optional() }),
  output: z.object({ id: z.string().uuid(), missing: z.array(key) }) });

/** Identical keys plus matching counters prove a copy; mutable responses may have a monotonic newer output. */
export function sameTokenCall(a: CopyCounter, b: CopyCounter): boolean {
  return a.key === b.key && a.source === b.source && a.model === b.model && a.input === b.input && a.cacheWrite === b.cacheWrite && a.cacheRead === b.cacheRead &&
    (a.calls ?? 1) === (b.calls ?? 1) && a.start === b.start && a.at === b.at && a.output === b.output && a.reasoning === b.reasoning;
}
export const copyFingerprint = (call: CopyCounter): string => JSON.stringify([call.key, call.source, call.at, call.start, call.model, call.input, call.cacheWrite, call.cacheRead, call.output, call.reasoning, call.calls ?? 1]);
