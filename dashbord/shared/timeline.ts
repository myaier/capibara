import { t } from "./text";
/** A transport-independent timeline model; never imports a host runtime. */
export type TimelineItem = { type: string; [key: string]: unknown };
export interface TimelineCursor { epoch: string; seq: number }
export interface TimelineRow {
  key: string;
  epoch: string;
  seqStart: number;
  seqEnd: number;
  sourceRanges?: Array<{ startSeq: number; endSeq: number }>;
  turnId?: string;
  providerMessageId?: string;
  timestamp: string;
  item: TimelineItem;
}
export interface TimelinePage {
  epoch: string;
  rows: TimelineRow[];
  startCursor: TimelineCursor | null;
  endCursor: TimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  reset: boolean;
  gap: boolean;
  truncated: boolean;
}
export const MAX_TIMELINE_ROWS = 800;
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function itemIdentity(item: TimelineItem): string | null {
  if (item.type === "tool_call" && string(item.callId)) return `tool:${string(item.callId)}`;
  if (item.type === "plugin" && string(item.id)) return `plugin:${string(item.pluginId)}:${string(item.id)}`;
  return null;
}
function rowIdentity(row: Pick<TimelineRow, "item" | "turnId">): string | null {
  const identity = itemIdentity(row.item);
  return identity && row.item.type === "tool_call" ? `${row.turnId ?? ""}:${identity}` : identity;
}
/** Tool completions may report only status/output. Omitted fields are sticky. */
export function mergeToolItems(earlier: TimelineItem, later: TimelineItem): TimelineItem {
  const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  const beforeDetail = object(earlier.detail), afterDetail = object(later.detail);
  const detail = { ...beforeDetail, ...defined(afterDetail) };
  if ((!string(afterDetail.type) || afterDetail.type === "unknown") && string(beforeDetail.type) && beforeDetail.type !== "unknown") detail.type = beforeDetail.type;
  const result: TimelineItem = { ...earlier, ...defined(later), type: "tool_call", name: string(later.name) || string(earlier.name) };
  if (Object.keys(detail).length) result.detail = detail;
  if (earlier.metadata || later.metadata) result.metadata = { ...object(earlier.metadata), ...defined(object(later.metadata)) };
  if (later.status === "completed" || later.status === "canceled") result.error = null;
  return result;
}
function mergeSourceRanges(a: TimelineRow, b: TimelineRow): NonNullable<TimelineRow["sourceRanges"]> {
  const ranges = [...(a.sourceRanges ?? [{ startSeq: a.seqStart, endSeq: a.seqEnd }]),
    ...(b.sourceRanges ?? [{ startSeq: b.seqStart, endSeq: b.seqEnd }])].sort((left, right) => left.startSeq - right.startSeq);
  const output: NonNullable<TimelineRow["sourceRanges"]> = [];
  for (const range of ranges) {
    const last = output[output.length - 1];
    if (last && range.startSeq <= last.endSeq + 1) last.endSeq = Math.max(last.endSeq, range.endSeq);
    else output.push({ ...range });
  }
  return output;
}
function mergeToolRows(a: TimelineRow, b: TimelineRow): TimelineRow {
  const [earlier, later] = a.seqEnd <= b.seqEnd ? [a, b] : [b, a];
  return { ...later, key: a.seqStart <= b.seqStart ? a.key : b.key,
    seqStart: Math.min(a.seqStart, b.seqStart), seqEnd: Math.max(a.seqEnd, b.seqEnd),
    sourceRanges: mergeSourceRanges(a, b), item: mergeToolItems(earlier.item, later.item) };
}
/**
 * A presentation projection over immutable source rows. Concatenation happens
 * only for adjacent, disjoint source sequences of the same message and turn;
 * repeated authoritative pages are reconciled before this function runs.
 */
export function projectTimelineRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const collapsed: TimelineRow[] = [];
  const tools = new Map<string, number>();
  for (const row of rows) {
    const identity = row.item.type === "tool_call" ? rowIdentity(row) : null;
    const priorIndex = identity === null ? undefined : tools.get(identity);
    if (priorIndex !== undefined) collapsed[priorIndex] = mergeToolRows(collapsed[priorIndex], row);
    else { if (identity !== null) tools.set(identity, collapsed.length); collapsed.push(row); }
  }
  const output: TimelineRow[] = [];
  for (const row of collapsed) {
    const previous = output[output.length - 1];
    const text = row.item.type === "assistant_message" || row.item.type === "reasoning";
    const previousMessage = previous ? string(previous.item.messageId) || previous.providerMessageId : undefined;
    const currentMessage = string(row.item.messageId) || row.providerMessageId;
    // Providers commonly attach the message ID only to the first delta.
    const sameMessage = !currentMessage || previousMessage === currentMessage;
    if (text && previous && previous.item.type === row.item.type && previous.epoch === row.epoch
      && previous.turnId === row.turnId && sameMessage && previous.seqEnd + 1 === row.seqStart
      && typeof previous.item.text === "string" && typeof row.item.text === "string") {
      output[output.length - 1] = { ...previous, seqEnd: row.seqEnd, sourceRanges: mergeSourceRanges(previous, row),
        item: { ...previous.item, text: previous.item.text + row.item.text } };
    } else output.push(row);
  }
  return output;
}
/** Normalize older raw child timelines and modern projected histories at one boundary. */
export function normalizeTimelinePage(value: unknown): TimelinePage {
  const page = object(value);
  const epoch = string(page.epoch) || "legacy";
  const source = Array.isArray(page.entries) ? page.entries : Array.isArray(page.rows) ? page.rows : [];
  const rows: TimelineRow[] = [];
  for (let index = 0; index < source.length; index++) {
    const entry = object(source[index]);
    const item = object(entry.item);
    if (!string(item.type)) continue;
    const seqStart = finite(entry.seqStart, finite(entry.seq, index));
    const seqEnd = Math.max(seqStart, finite(entry.seqEnd, seqStart));
    const typedItem = item as TimelineItem;
    const turnId = string(entry.turnId) || string(item.turnId) || undefined;
    const providerMessageId = string(entry.providerMessageId) || undefined;
    const sourceRanges = Array.isArray(entry.sourceSeqRanges) ? entry.sourceSeqRanges.map(range => object(range))
      .filter(range => typeof range.startSeq === "number" && typeof range.endSeq === "number")
      .map(range => ({ startSeq: range.startSeq as number, endSeq: range.endSeq as number })) : undefined;
    rows.push({ key: `${epoch}:${rowIdentity({ item: typedItem, turnId }) ?? seqStart}`, epoch, seqStart, seqEnd, sourceRanges, turnId, providerMessageId,
      timestamp: string(entry.timestamp), item: typedItem });
  }
  const readCursor = (value: unknown, fallback: number | undefined): TimelineCursor | null => {
    const cursor = object(value);
    return typeof cursor.seq === "number" ? { epoch: string(cursor.epoch) || epoch, seq: cursor.seq }
      : fallback === undefined ? null : { epoch, seq: fallback };
  };
  return { epoch, rows, startCursor: readCursor(page.startCursor, rows.length ? Math.min(...rows.map(row => row.seqStart)) : undefined),
    endCursor: readCursor(page.endCursor, rows.length ? Math.max(...rows.map(row => row.seqEnd)) : undefined),
    hasOlder: page.hasOlder === true, hasNewer: page.hasNewer === true,
    reset: page.reset === true || page.staleCursor === true, gap: page.gap === true, truncated: page.truncated === true };
}
/**
 * History is authoritative. Replace its covered range rather than concatenating
 * text deltas; preserve pages outside that range and the newest tool-call revision.
 */
export function reconcileTimelinePage(previous: TimelinePage | null, incoming: TimelinePage,
  direction: "tail" | "before" = "tail"): TimelinePage {
  const sameEpoch = previous?.epoch === incoming.epoch;
  const previousRows = sameEpoch && !incoming.reset ? previous.rows : [];
  const minSeq = incoming.rows.length ? Math.min(...incoming.rows.map(row => row.seqStart)) : Infinity;
  const rangesOverlap = (a: TimelineRow, b: TimelineRow) =>
    (a.sourceRanges?.length ? a.sourceRanges : [{ startSeq: a.seqStart, endSeq: a.seqEnd }]).some(left =>
      (b.sourceRanges?.length ? b.sourceRanges : [{ startSeq: b.seqStart, endSeq: b.seqEnd }]).some(right => left.startSeq <= right.endSeq && right.startSeq <= left.endSeq));
  // A long-running tool may span the entire page. It must not erase unrelated
  // earlier messages: reconcile each projected item's source range separately.
  const retained = previousRows.filter(row => !incoming.rows.some(next => {
    if (next.item.type !== row.item.type) return false;
    const identity = rowIdentity(row);
    if (identity || rowIdentity(next)) return identity === rowIdentity(next);
    if (row.turnId !== next.turnId) return false;
    const messageId = string(row.item.messageId), nextMessageId = string(next.item.messageId);
    if (messageId && nextMessageId && messageId !== nextMessageId) return false;
    return rangesOverlap(row, next);
  }));
  const byIdentity = new Map<string, TimelineRow>();
  const previousItems = new Map(previousRows.filter(row => rowIdentity(row)).map(row => [rowIdentity(row)!, row]));
  for (const row of [...retained, ...incoming.rows]) {
    const identity = rowIdentity(row) ?? `seq:${row.seqStart}`;
    const prior = byIdentity.get(identity) ?? previousItems.get(identity);
    if (prior && row.item.type === "tool_call") {
      byIdentity.set(identity, mergeToolRows(prior, row));
    } else if (prior && prior.seqEnd > row.seqEnd) {
      byIdentity.set(identity, prior);
    } else {
      byIdentity.set(identity, prior && itemIdentity(row.item) ? { ...row, seqStart: Math.min(prior.seqStart, row.seqStart) } : row);
    }
  }
  const allRows = [...byIdentity.values()].sort((a, b) => a.seqStart - b.seqStart || a.seqEnd - b.seqEnd);
  const truncated = allRows.length > MAX_TIMELINE_ROWS;
  // Keep newly requested older history while the user pages backwards.
  const rows = truncated ? direction === "before" ? allRows.slice(0, MAX_TIMELINE_ROWS) : allRows.slice(-MAX_TIMELINE_ROWS) : allRows;
  const preserveOlder = sameEpoch && !incoming.reset && direction === "tail"
    && !!previous.startCursor && previous.startCursor.seq <= minSeq;
  const preserveNewer = sameEpoch && !incoming.reset && direction === "before";
  return { ...incoming, rows,
    startCursor: rows.length ? { epoch: incoming.epoch, seq: rows[0].seqStart } : incoming.startCursor,
    endCursor: rows.length ? { epoch: incoming.epoch, seq: Math.max(...rows.map(row => row.seqEnd)) } : incoming.endCursor,
    hasOlder: truncated && direction === "tail" || (preserveOlder ? previous.hasOlder : incoming.hasOlder),
    hasNewer: truncated && direction === "before" || (preserveNewer ? previous.hasNewer : incoming.hasNewer),
    gap: incoming.gap || (sameEpoch && previous.gap), truncated: truncated || incoming.truncated };
}
export function timelineSummary(item: TimelineItem): string {
  const detail = object(item.detail);
  if (item.type === "tool_call") return string(detail.command) || string(detail.filePath) || string(detail.query)
    || string(detail.url) || string(detail.description) || string(detail.label) || string(item.name);
  if (item.type === "todo") return t("sharedTimeline.m001", { value1: Array.isArray(item.items) ? item.items.length : 0 });
  return string(item.text) || string(item.message) || string(item.kind) || item.type;
}
export function prettyValue(value: unknown, maxLength = 30000): string {
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""; }
  catch { text = t("sharedTimeline.m002"); }
  return text.length > maxLength ? t("sharedTimeline.m003", { value1: text.slice(0, maxLength) }) : text;
}
