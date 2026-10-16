import { t } from "../../shared/text";
import { DIGEST_LANE_PRIORITY, type DigestLane, type DigestSegment, type DigestTurn } from "../../shared/digest";
import type { TelemetryEvent } from "../../shared/telemetry";
import { emptyLanes, excerpt, type FoldState } from "./model";

export interface ActivityOptions { now: number; status: string; activeTurn?: boolean; events?: readonly TelemetryEvent[] }
export interface Activity { turns: DigestTurn[]; segments: DigestSegment[]; approvals: number }
type TimedEvent = TelemetryEvent & { time: number };
function latestTurn<T extends { start: number }>(ordered: readonly T[], at: number): T | undefined {
  let low = 0, high = ordered.length;
  while (low < high) { const mid = (low + high) >> 1; if (ordered[mid]!.start <= at) low = mid + 1; else high = mid; }
  return ordered[low - 1];
}

function outcomes(state: FoldState, options: ActivityOptions, events: readonly TimedEvent[]): DigestTurn[] {
  const chronological = [...state.turns].sort((a, b) => a.start - b.start || a.index - b.index), terminals = new Map<number, TimedEvent>();
  for (const event of events) if (["turn_completed", "turn_failed", "turn_canceled"].includes(event.type)) {
    const turn = latestTurn(chronological, event.time); if (turn) terminals.set(turn.index, event);
  }
  return state.turns.map((fact, index) => {
    const next = state.turns[index + 1];
    const terminal = terminals.get(fact.index);
    const running = !next && (options.activeTurn || options.status === "running" || options.status === "initializing");
    const observed = terminal?.type === "turn_failed" ? "failed" : terminal?.type === "turn_canceled" ? "canceled" : terminal ? "completed" : null;
    const outcome: DigestTurn["outcome"] = observed ?? (running ? "running" : fact.error || fact.tail === "failed" ? "failed"
      : fact.tail === "canceled" ? "canceled" : fact.tail === "assistant_message" ? "completed" : "unknown");
    return { index: fact.index, turnId: fact.turnId?.slice(0, 128) ?? null, start: fact.start,
      end: outcome === "running" ? null : fact.end, outcome, prompt: excerpt(fact.prompt, 200), reply: excerpt(fact.reply, 240),
      tools: 0, failures: 0, lanes: emptyLanes(), files: 0, added: 0, removed: 0, commands: 0, checksPassed: 0, checksFailed: 0,
      time: emptyLanes(), tokens: null };
  });
}

/** Sweep parallel intervals once; every millisecond belongs to exactly one lane. */
export function attributeTime(start: number, end: number, segments: readonly DigestSegment[], turn: number): { time: DigestTurn["time"]; model: DigestSegment[] } {
  const time = emptyLanes(), model: DigestSegment[] = [];
  const edges: { at: number; lane: DigestLane; delta: number }[] = [];
  for (const segment of segments) {
    const from = Math.max(start, segment.start), to = Math.min(end, segment.end);
    if (to <= from || segment.lane === "model") continue;
    edges.push({ at: from, lane: segment.lane, delta: 1 }, { at: to, lane: segment.lane, delta: -1 });
  }
  edges.sort((a, b) => a.at - b.at);
  const active = emptyLanes();
  let previous = start, modelStart: number | null = null;
  const span = (at: number) => {
    if (at <= previous) return;
    const lane = DIGEST_LANE_PRIORITY.find(lane => active[lane] > 0) ?? "model";
    time[lane] += at - previous;
    if (lane === "model") modelStart ??= previous;
    else if (modelStart !== null) {
      if (previous - modelStart >= 1000) model.push({ lane: "model", start: modelStart, end: previous, status: "ok", label: t("serverDigestActivity.m001"), turn, n: 1, seq: null });
      modelStart = null;
    }
    previous = at;
  };
  for (let index = 0; index < edges.length;) {
    const at = edges[index]!.at; span(at);
    do { const edge = edges[index++]!; active[edge.lane] += edge.delta; } while (index < edges.length && edges[index]!.at === at);
  }
  span(end);
  if (modelStart !== null && end - modelStart >= 1000) model.push({ lane: "model", start: modelStart, end, status: "ok", label: t("serverDigestActivity.m002"), turn, n: 1, seq: null });
  return { time, model };
}

function permissionIntervals(events: readonly TimedEvent[], now: number) {
  const pending: number[] = [], waits: { start: number; end: number; running: boolean }[] = [];
  for (const event of events) {
    const at = event.time;
    if (event.type === "permission_requested") pending.push(at);
    if (event.type === "permission_resolved") {
      const knownStart = event.durationMs === undefined ? null : at - event.durationMs;
      const index = knownStart === null ? 0 : pending.findIndex(start => Math.abs(start - knownStart) < 2);
      const start = index >= 0 && pending[index] !== undefined ? pending.splice(index, 1)[0]! : knownStart;
      if (start !== null && start !== undefined) waits.push({ start, end: at, running: false });
    }
    if (["turn_completed", "turn_failed", "turn_canceled", "archived"].includes(event.type)) {
      for (const start of pending.splice(0)) waits.push({ start, end: at, running: false });
    }
  }
  for (const start of pending) waits.push({ start, end: now, running: true });
  return waits;
}

export function buildActivity(state: FoldState, options: ActivityOptions): Activity {
  const events = (options.events ?? []).filter(event => event.agentId === state.agentId).map(event => ({ ...event, time: Date.parse(event.at) }))
    .filter(event => Number.isFinite(event.time)).sort((a, b) => a.time - b.time);
  const turns = outcomes(state, options, events), byTurn = new Map<number, DigestSegment[]>();
  for (const turn of turns) byTurn.set(turn.index, []);
  for (const tool of state.tools.values()) {
    const turn = turns[tool.turn - 1]; if (!turn) continue;
    const end = tool.status === "running" && turn.outcome === "running" ? Math.max(options.now, tool.end) : tool.end;
    byTurn.get(tool.turn)!.push({ lane: tool.lane, start: tool.start, end: Math.max(tool.start, end), status: tool.status,
      label: excerpt(tool.target ? `${tool.name} · ${tool.target}` : tool.name, 80), turn: tool.turn, n: 1, seq: tool.seq });
    turn.tools++; turn.lanes[tool.lane]++; if (tool.status === "failed") turn.failures++;
  }
  for (const wait of permissionIntervals(events, options.now)) for (const turn of turns) {
    const start = Math.max(turn.start, wait.start), end = Math.min(turn.end ?? Math.max(turn.start, options.now), wait.end);
    if (end <= start) continue;
    byTurn.get(turn.index)!.push({ lane: "wait", start, end, status: wait.running && turn.end === null ? "running" : "ok",
      label: t("serverDigestActivity.m003"), turn: turn.index, n: 1, seq: null });
  }
  const segments: DigestSegment[] = [], modelSpans = new Map<number, FoldState["modelSpans"]>();
  for (const span of state.modelSpans) {
    const own = modelSpans.get(span.turn) ?? []; own.push(span); modelSpans.set(span.turn, own);
  }
  for (const turn of turns) {
    const own = byTurn.get(turn.index)!, end = turn.end ?? Math.max(turn.start, options.now);
    const { time, model } = attributeTime(turn.start, end, own, turn.index); turn.time = time;
    const spans = modelSpans.get(turn.index) ?? [];
    for (const segment of model) segment.seq = spans.find(span => span.start < segment.end && span.end > segment.start)?.seq ?? null;
    if (turn.end === null && model.at(-1)?.end === end) model[model.length - 1]!.status = "running";
    segments.push(...own, ...model);
  }
  const ordered = [...turns].sort((a, b) => a.start - b.start || a.index - b.index);
  return { turns, segments: segments.sort((a, b) => a.start - b.start || (a.seq ?? Infinity) - (b.seq ?? Infinity)),
    approvals: events.filter(event => { const turn = latestTurn(ordered, event.time);
      return event.type === "permission_requested" && turn && event.time <= (turn.end ?? options.now); }).length };
}

/** Merge chronological neighbours within a lane/turn, choosing the smallest gaps first. */
export function thinSegments(segments: readonly DigestSegment[], maximum = 800): DigestSegment[] {
  if (maximum <= 0) return [];
  if (segments.length <= maximum) return segments.map(segment => ({ ...segment }));
  interface Node { segment: DigestSegment; previous: number | null; next: number | null; version: number; live: boolean }
  interface Pair { left: number; right: number; lv: number; rv: number; gap: number }
  const nodes: Node[] = [], tails = new Map<string, number>(), heap: Pair[] = [];
  const less = (a: Pair, b: Pair) => a.gap < b.gap || a.gap === b.gap && a.left < b.left;
  const push = (pair: Pair) => {
    heap.push(pair); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i]!, heap[p]!)) break; [heap[i], heap[p]] = [heap[p]!, heap[i]!]; i = p; }
  };
  const pop = (): Pair | undefined => {
    if (!heap.length) return;
    const result = heap[0]!, last = heap.pop()!;
    if (heap.length) { heap[0] = last; let i = 0;
      while (true) { let c = i * 2 + 1; if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break; [heap[c], heap[i]] = [heap[i]!, heap[c]!]; i = c; }
    }
    return result;
  };
  const enqueue = (left: number | null) => {
    if (left === null) return;
    const a = nodes[left]!, right = a.next; if (right === null) return;
    const b = nodes[right]!;
    push({ left, right, lv: a.version, rv: b.version, gap: Math.max(0, b.segment.start - a.segment.end) });
  };
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const key = `${segment.turn}:${segment.lane}`, previous = tails.get(key) ?? null, index = nodes.length;
    nodes.push({ segment: { ...segment }, previous, next: null, version: 0, live: true });
    if (previous !== null) { nodes[previous]!.next = index; enqueue(previous); } tails.set(key, index);
  }
  let count = nodes.length;
  const ranks = { ok: 0, canceled: 1, running: 2, failed: 3 };
  while (count > maximum) {
    const pair = pop(); if (!pair) break;
    const a = nodes[pair.left]!, b = nodes[pair.right]!;
    if (!a.live || !b.live || a.version !== pair.lv || b.version !== pair.rv || a.next !== pair.right) continue;
    const status = ranks[a.segment.status] >= ranks[b.segment.status] ? a.segment.status : b.segment.status;
    const seq = b.segment.status === "failed" && a.segment.status !== "failed" ? b.segment.seq : a.segment.seq;
    const name = a.segment.label.split(/ · | × /, 1)[0]!, n = a.segment.n + b.segment.n;
    a.segment = { ...a.segment, end: Math.max(a.segment.end, b.segment.end), n, status, seq, label: excerpt(`${name} × ${n}`, 80) };
    b.live = false; a.version++; a.next = b.next; if (b.next !== null) nodes[b.next]!.previous = pair.left;
    count--; enqueue(a.previous); enqueue(pair.left);
  }
  const result = nodes.filter(node => node.live).map(node => node.segment).sort((a, b) => a.start - b.start);
  // If there are more distinct lane/turn groups than slots, retain the newest groups. Never merge across turns.
  return result.slice(-maximum);
}
