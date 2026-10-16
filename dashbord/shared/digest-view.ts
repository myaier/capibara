/** Pure layout helpers for the 复盘 view (no React), unit-tested in tests/digest-view.test.ts. */
import type { DigestLane, DigestSegment, DigestTimeShare, DigestTurn } from "./digest";

export interface AxisPiece { from: number; to: number; x: number; width: number }
export interface AxisBreak { x: number; width: number; ms: number }
export interface TimeAxis { pieces: AxisPiece[]; breaks: AxisBreak[]; width: number; x: (at: number) => number }

/**
 * Maps time to pixels for a chart of several turns: spans closer than `gapMs` form one linear piece; longer idle gaps
 * become fixed-width breaks, so a session with hours between turns still shows each turn's detail. Every piece keeps
 * at least `minPieceWidth`; the rest of the width is shared in proportion to duration.
 */
export function buildTimeAxis(spans: ReadonlyArray<{ start: number; end: number }>, width: number, options: { gapMs?: number; breakWidth?: number; minPieceWidth?: number } = {}): TimeAxis {
  const gapMs = options.gapMs ?? 120_000, breakWidth = options.breakWidth ?? 18, minPieceWidth = options.minPieceWidth ?? 16;
  const sorted = spans.filter(span => Number.isFinite(span.start) && Number.isFinite(span.end)).map(span => ({ start: span.start, end: Math.max(span.start, span.end) })).sort((a, b) => a.start - b.start);
  const clusters: Array<{ start: number; end: number }> = [];
  for (const span of sorted) {
    const last = clusters.at(-1);
    if (last && span.start - last.end <= gapMs) last.end = Math.max(last.end, span.end);
    else clusters.push({ ...span });
  }
  if (!clusters.length || width <= 0) return { pieces: [], breaks: [], width: Math.max(0, width), x: () => 0 };
  const breaks = clusters.length - 1, available = Math.max(0, width - breaks * breakWidth);
  const durations = clusters.map(cluster => Math.max(1, cluster.end - cluster.start)), total = durations.reduce((sum, value) => sum + value, 0);
  const minimum = Math.min(minPieceWidth, available / clusters.length), spare = Math.max(0, available - minimum * clusters.length);
  const pieces: AxisPiece[] = [], gaps: AxisBreak[] = [];
  let x = 0;
  clusters.forEach((cluster, index) => {
    const pieceWidth = minimum + spare * durations[index]! / total;
    pieces.push({ from: cluster.start, to: cluster.end, x, width: pieceWidth });
    x += pieceWidth;
    if (index < clusters.length - 1) { gaps.push({ x, width: breakWidth, ms: clusters[index + 1]!.start - cluster.end }); x += breakWidth; }
  });
  const map = (at: number) => {
    let piece = pieces[0]!;
    for (const candidate of pieces) { if (at >= candidate.from) piece = candidate; else break; }
    // Times inside a break (or past the end) sit at the end of the piece before it.
    if (at > piece.to) return piece.x + piece.width;
    const span = piece.to - piece.from;
    return piece.x + (span > 0 ? Math.max(0, at - piece.from) / span * piece.width : 0);
  };
  return { pieces, breaks: gaps, width, x: map };
}

/** Top-to-bottom lane order in the chart; lanes without segments are left out. */
export const LANE_ORDER: readonly DigestLane[] = ["model", "read", "search", "edit", "shell", "web", "agent", "plan", "wait", "other"];
export function lanesIn(segments: readonly Pick<DigestSegment, "lane">[]): DigestLane[] {
  const present = new Set(segments.map(segment => segment.lane));
  return LANE_ORDER.filter(lane => present.has(lane));
}
/** Segments overlapping [from, to], clipped to it. */
export function segmentsBetween<T extends Pick<DigestSegment, "start" | "end">>(segments: readonly T[], from: number, to: number): T[] {
  return segments.filter(segment => segment.end >= from && segment.start <= to).map(segment => ({ ...segment, start: Math.max(from, segment.start), end: Math.min(to, segment.end) }));
}
/** Time share entries with time, largest first, and their fraction of the total. */
export function shareEntries(share: DigestTimeShare): Array<{ lane: DigestLane; ms: number; fraction: number }> {
  const entries = (Object.entries(share) as Array<[DigestLane, number]>).filter(([, ms]) => ms > 0);
  const total = entries.reduce((sum, [, ms]) => sum + ms, 0);
  return entries.sort((a, b) => b[1] - a[1]).map(([lane, ms]) => ({ lane, ms, fraction: total ? ms / total : 0 }));
}
/** A turn's span, running turns ending at `now`. */
export const turnSpan = (turn: Pick<DigestTurn, "start" | "end">, now: number) => ({ start: turn.start, end: turn.end ?? Math.max(turn.start, now) });
/** "src/payments/" + "idempotency.ts" */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { dir: "", name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}
