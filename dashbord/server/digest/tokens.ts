import { digestSchema, type Digest, type DigestTurn } from "../../shared/digest";
import { addTokenCounts, emptyTokenCounts } from "../../shared/tokens";
import type { TokenCallSource } from "../token-source";

export type TokenHistory = Awaited<ReturnType<TokenCallSource["callsForSessions"]>>;
export function sampleEvenly<T>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return values.slice();
  if (maximum <= 0) return [];
  if (maximum === 1) return [values[values.length - 1]!];
  return Array.from({ length: maximum }, (_, index) => values[Math.round(index * (values.length - 1) / (maximum - 1))]!);
}
const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
type DigestSource = NonNullable<Digest["tokens"]>["source"];
const digestSources: readonly string[] = digestSchema.shape.tokens.unwrap().shape.source.options;
/** A log source 复盘 can name; another one's history is left out rather than failing the digest's schema. */
const isDigestSource = (source: string): source is DigestSource => digestSources.includes(source);

/** Attribute each call once, preferring the latest-started turn when the five-second tolerances overlap. */
export function attachTokens(turns: DigestTurn[], history: TokenHistory, now: number): Digest["tokens"] {
  if (!history || !isDigestSource(history.source)) return null;
  const totals = emptyTokenCounts(), tuples: NonNullable<Digest["tokens"]>["calls"] = [];
  const ordered = [...turns].sort((a, b) => a.start - b.start || a.index - b.index);
  // Max-end tree lets a backwards search prune entire expired ranges, including overlapping turns.
  let size = 1; while (size < ordered.length) size *= 2;
  const ends = new Float64Array(size * 2).fill(-1);
  for (let index = 0; index < ordered.length; index++) ends[size + index] = (ordered[index]!.end ?? Math.max(ordered[index]!.start, now)) + 5000;
  for (let index = size - 1; index > 0; index--) ends[index] = Math.max(ends[index * 2]!, ends[index * 2 + 1]!);
  const owner = (at: number, last: number, node = 1, from = 0, to = size - 1): number => {
    if (from > last || ends[node]! < at) return -1;
    if (from === to) return from;
    const mid = (from + to) >> 1;
    const right = owner(at, last, node * 2 + 1, mid + 1, to);
    return right >= 0 ? right : owner(at, last, node * 2, from, mid);
  };
  let last = -1;
  for (const call of [...history.calls].sort((a, b) => a.at - b.at)) {
    if (!Number.isFinite(call.at) || call.at < 0) continue;
    const at = Math.floor(call.at), duration = call.start !== null && Number.isFinite(call.start) && call.start >= 0 && call.start <= at ? at - call.start : 0;
    // A record can stand for several model calls (a Grok turn, server/token-source).
    const counts = { calls: Math.max(1, count(call.calls ?? 1)), input: count(call.input), cacheWrite: count(call.cacheWrite), cacheRead: count(call.cacheRead), output: count(call.output),
      reasoning: count(call.reasoning), genMs: duration, genOutput: duration > 0 ? count(call.output) : 0 };
    addTokenCounts(totals, counts);
    while (last + 1 < ordered.length && ordered[last + 1]!.start <= at) last++;
    const index = owner(at, last), turn = index < 0 ? undefined : ordered[index];
    if (turn) { turn.tokens ??= emptyTokenCounts(); addTokenCounts(turn.tokens, counts); }
    tuples.push([at, counts.output, counts.input + counts.cacheWrite + counts.cacheRead, duration >= 1000 ? counts.output / duration * 1000 : null]);
  }
  return { source: history.source, totals, calls: sampleEvenly(tuples, 400) };
}
