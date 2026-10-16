import { t } from "../../shared/text";
import type { PaseoAgentTimelineRefetchOptions } from "../paseo-types";
import { normalizeTimelinePage, object, type TimelineCursor } from "../../shared/timeline";
import { compactRow, createFold, foldRows, withTimeBounds } from "./fold";
import type { CompactRow, FoldState } from "./model";

export const MAX_ROWS = 8_000;
// The protocol has no finite page maximum. Projected entries carry whole tool outputs, so no request asks the daemon to
// serialize more than one batch; a first read pages backwards batch by batch until MAX_ROWS or MAX_BYTES.
export const PAGE_SIZE = 500;
/** Estimated JSON read by one first build; older history beyond it is left out and the digest is marked truncated. */
export const MAX_BYTES = 16 * 1024 * 1024;
export type TimelineFetch = (options: PaseoAgentTimelineRefetchOptions) => Promise<unknown>;
export interface History {
  state: FoldState; cursor: TimelineCursor | null; version: number;
  /** Authoritative compact entries by anchor. No raw tool bodies, reasoning, outputs or diffs. */
  facts: Map<number, CompactRow>;
}
class Replaced extends Error {}

function readPage(raw: unknown) {
  const value = object(raw);
  if (value.error) throw new Error(t("serverDigestReader.m001"));
  const page = normalizeTimelinePage(raw);
  if (page.rows.length && (typeof value.epoch !== "string" || !value.epoch)) throw new Error(t("serverDigestReader.m002"));
  return { ...page, projected: value.projection === "projected" || page.rows.some(row => row.seqStart !== row.seqEnd) };
}

function replay(agentId: string, cwd: string, epoch: string, facts: Map<number, CompactRow>, truncated: boolean): FoldState {
  const ordered = withTimeBounds([...facts.values()]);
  const state = foldRows(createFold(agentId, cwd, ordered.length ? epoch : null), ordered);
  // Only canonical rows promise dense seqs; projected ranges interleave and may legitimately be sparse.
  if (ordered.every(row => !row.projected)) {
    truncated ||= ordered.some((row, index) => index > 0 && row.seq !== ordered[index - 1]!.lastSeq + 1);
  }
  state.truncated = truncated;
  return state;
}

/** Approximate JSON length without serializing: long outputs are counted by string length, not copied. */
export function jsonSize(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length + 2;
  if (!value || typeof value !== "object") return 6;
  if (depth > 32) return 2;
  let size = 2;
  if (Array.isArray(value)) for (const item of value) size += jsonSize(item, depth + 1) + 1;
  else for (const [key, item] of Object.entries(value)) size += key.length + 4 + jsonSize(item, depth + 1);
  return size;
}
// Lets other RPCs and the host bridge run between batches of a long first read.
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function trim(facts: Map<number, CompactRow>): boolean {
  const overflow = facts.size - MAX_ROWS;
  if (overflow <= 0) return false;
  for (const seq of [...facts.keys()].sort((a, b) => a - b).slice(0, overflow)) facts.delete(seq);
  return true;
}

async function initial(fetch: TimelineFetch, agentId: string, cwd: string, version: number): Promise<History> {
  const facts = new Map<number, CompactRow>();
  let page = readPage(await fetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" }));
  const epoch = page.epoch, cursor = page.endCursor;
  let truncated = false, bytes = 0;
  const visited = new Set<number>();
  while (true) {
    if (page.epoch !== epoch || page.reset) throw new Replaced();
    const count = page.rows.length;
    for (const row of page.rows) {
      bytes += jsonSize(row);
      const previous = facts.get(row.seqStart);
      if (!previous || row.seqEnd > previous.lastSeq) facts.set(row.seqStart, compactRow(row, cwd, page.projected));
    }
    truncated ||= page.truncated || page.gap;
    if (trim(facts)) truncated = true;
    page.rows.length = 0;
    if (!page.hasOlder) break;
    if (facts.size >= MAX_ROWS || bytes >= MAX_BYTES || !page.startCursor || visited.has(page.startCursor.seq) || !count) { truncated = true; break; }
    const before = page.startCursor; visited.add(before.seq);
    await yieldTurn();
    page = readPage(await fetch({ direction: "before", cursor: before, limit: Math.min(PAGE_SIZE, MAX_ROWS - facts.size), projection: "projected" }));
  }
  return { state: replay(agentId, cwd, epoch, facts, truncated), cursor, facts, version };
}

/** Projected `after` may return anchors before the cursor. Replace those entries and replay the compact window. */
export async function fetchHistory(fetch: TimelineFetch, agentId: string, cwd: string, previous?: History): Promise<History> {
  if (previous?.cursor && previous.state.cwd === cwd) {
    let cursor = previous.cursor, facts: Map<number, CompactRow> | null = null, valid = true, changed = false;
    let truncated = previous.state.truncated;
    for (let pages = 0; ; pages++) {
      const page = readPage(await fetch({ direction: "after", cursor, limit: PAGE_SIZE, projection: "projected" }));
      if (page.epoch !== previous.state.epoch || page.reset || page.gap) { valid = false; break; }
      // One early-anchored tool can end beyond other, unreturned entries. Advancing to its end cursor
      // would skip them when an `after` page is limited; rebuild the bounded tail in that case.
      if (page.projected && page.hasNewer) { valid = false; break; }
      const rows = page.rows.sort((a, b) => a.seqStart - b.seqStart);
      if (!page.projected) {
        const fresh = rows.filter(row => row.seqEnd > cursor.seq);
        if (fresh.some((row, index) => row.seqStart !== (index ? fresh[index - 1]!.seqEnd : cursor.seq) + 1)) { valid = false; break; }
      }
      let nextSeq = Math.max(cursor.seq, page.endCursor?.seq ?? cursor.seq);
      for (const row of rows) {
        const compact = compactRow(row, cwd, page.projected), before = (facts ?? previous.facts).get(row.seqStart);
        nextSeq = Math.max(nextSeq, row.seqEnd);
        if (!before || JSON.stringify(compact) !== JSON.stringify(before)) {
          facts ??= new Map(previous.facts); facts.set(row.seqStart, compact); changed = true;
        }
      }
      if (facts && trim(facts)) truncated = true;
      truncated ||= page.truncated;
      page.rows.length = 0;
      if (!page.hasNewer) { cursor = { epoch: page.epoch, seq: nextSeq }; break; }
      if (nextSeq <= cursor.seq || pages >= 63) { valid = false; break; }
      cursor = { epoch: page.epoch, seq: nextSeq };
      await yieldTurn();
    }
    if (valid) {
      if (!changed && truncated === previous.state.truncated) return { ...previous, cursor };
      facts ??= previous.facts;
      return { state: replay(agentId, cwd, cursor.epoch, facts, truncated), cursor, facts, version: previous.version + 1 };
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const history = await initial(fetch, agentId, cwd, (previous?.version ?? 0) + 1);
      if (previous && !previous.state.rows && !history.state.rows) history.version = previous.version;
      return history;
    }
    catch (error) { if (!(error instanceof Replaced)) throw error; }
  }
  throw new Error(t("serverDigestReader.m003"));
}
