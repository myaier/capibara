import { t } from "./text";
import { object, prettyValue, string, timelineSummary, type TimelineItem, type TimelineRow } from "./timeline";

/**
 * 时间线查找 (codex-B1): words in the rows a timeline has already loaded, looked up the way the rows show them — message text, a
 * tool's command, input and output, a todo list. Nothing is read from the host for it (no `searchAgentTimeline`, which loads the
 * Agent), nothing is stored, and rows that were not loaded are never reported as having no match: the find bar says how many
 * rows it looked at. The view highlights the ranges with nested Text, which also works on phones (no DOM ranges there).
 */

/** A tool's detail blocks as its expanded row shows them, in that order. */
export function toolDetails(item: TimelineItem): Array<{ label: string; value: unknown }> {
  const detail = object(item.detail);
  const fields: Array<{ label: string; value: unknown }> = [];
  const append = (label: string, value: unknown) => { if (value !== undefined && value !== null && value !== "") fields.push({ label, value }); };
  append(t("sharedTimelineFind.m001"), detail.command); append(t("sharedTimelineFind.m002"), detail.cwd); append(t("sharedTimelineFind.m003"), detail.filePath);
  append(t("sharedTimelineFind.m004"), detail.query); append(t("sharedTimelineFind.m005"), detail.url); append(t("sharedTimelineFind.m006"), detail.unifiedDiff);
  append(t("sharedTimelineFind.m007"), detail.oldString); append(t("sharedTimelineFind.m008"), detail.newString);
  append(t("sharedTimelineFind.m009"), detail.input ?? item.input ?? item.arguments);
  append(t("sharedTimelineFind.m010"), detail.output ?? detail.result ?? detail.content ?? detail.text);
  append(t("sharedTimelineFind.m011"), detail.log); append(t("sharedTimelineFind.m012"), detail.actions);
  append(t("sharedTimelineFind.m013"), detail.childSessionId); append(t("sharedTimelineFind.m014"), detail.exitCode);
  if (item.error) append(t("sharedTimelineFind.m015"), item.error);
  if (!fields.length) append(t("sharedTimelineFind.m016"), detail);
  return fields;
}

/** Whether a row expands, and how many lines its text keeps until it does (tools and reasoning 2, long text 5). */
export function rowLayout(item: TimelineItem): { expandable: boolean; lines: number | undefined } {
  const short = item.type === "tool_call" || item.type === "reasoning";
  const expandable = short || item.type === "plugin" || timelineSummary(item).length > 650;
  return { expandable, lines: expandable ? short ? 2 : 5 : undefined };
}

const lowered = new Map<number, number>();
/**
 * Case and width folding that keeps every UTF-16 unit where it was, so a match's offsets are offsets in the text the row shows:
 * full-width ASCII (ＡＢＣ、１２３、，：（）) reads as ASCII, the ideographic space as a space, letters in lower case (Σ and ς alike).
 * Chinese and other scripts without case are compared as they are.
 */
export function foldFind(text: string): string {
  // Plain ASCII only needs lower case, which never changes its length.
  if (!/[^\u0000-\u007f]/.test(text)) return text.toLowerCase();
  const units = new Uint16Array(text.length);
  for (let index = 0; index < text.length; index++) {
    let unit = text.charCodeAt(index);
    if (unit < 0x80) { if (unit >= 65 && unit <= 90) unit += 32; }
    else if (unit >= 0xff01 && unit <= 0xff5e) { unit -= 0xfee0; if (unit >= 65 && unit <= 90) unit += 32; }
    else if (unit === 0x3000) unit = 32;
    // Surrogate halves, CJK (radicals, kana, ideographs) and Hangul syllables have no case.
    else if ((unit < 0xd800 || unit > 0xdfff) && (unit < 0x2e80 || unit >= 0xa000) && (unit < 0xac00 || unit >= 0xd7a4)) {
      let lower = lowered.get(unit);
      if (lower === undefined) {
        const text = String.fromCharCode(unit).toLowerCase();
        // A lower case that is longer (İ) would move every later offset: such a letter stays as it is.
        lower = text.length === 1 ? text.charCodeAt(0) : unit;
        if (lower === 0x3c2) lower = 0x3c3;
        lowered.set(unit, lower);
      }
      unit = lower;
    }
    units[index] = unit;
  }
  let folded = "";
  for (let start = 0; start < units.length; start += 4096) folded += String.fromCharCode.apply(null, units.subarray(start, start + 4096) as unknown as number[]);
  return folded;
}

/** At most 8 distinct folded terms of a query: words split on spaces, "quoted phrases" (also “中文引号”) kept whole. */
export function findTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of foldFind(query.slice(0, 200)).matchAll(/"([^"]*)"|“([^”]*)”|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? match[3]!.replace(/^["“”]+|["“”]+$/g, "")).trim();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, 8);
}

export interface FindRange { start: number; end: number }
/** Every occurrence of any term in `folded` (at most `limit`), in order, overlapping ones merged into one range. */
export function termRanges(folded: string, terms: readonly string[], limit = Infinity): FindRange[] {
  const found: FindRange[] = [];
  for (const term of terms) {
    let count = 0;
    for (let at = folded.indexOf(term); at >= 0 && count < limit; at = folded.indexOf(term, at + term.length), count++) found.push({ start: at, end: at + term.length });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: FindRange[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end); else merged.push({ ...range });
  }
  return merged.length > limit ? merged.slice(0, limit) : merged;
}

/** Where a row shows a text: always, cut to its first lines until the row expands (`clip`), or only once it does (`expand`). */
export type FindReveal = "always" | "clip" | "expand";
/**
 * One searchable text of a row. Keys: `name` (a tool's name in the title), `summary` (the row's text), `todo:<n>`, `detail:<label>`
 * (a tool's block, see toolDetails) and `plugin` (a plugin row's data). A block repeating the row's text is left out.
 */
export interface FindField { key: string; text: string; folded: string; reveal: FindReveal; lines?: number }
// Rows keep their item objects across page merges, so each item is folded once while it lives.
const fieldCache = new WeakMap<TimelineItem, FindField[]>();
export function findFields(item: TimelineItem): FindField[] {
  const cached = fieldCache.get(item);
  if (cached) return cached;
  const fields: FindField[] = [], { expandable, lines } = rowLayout(item);
  const add = (key: string, text: string, reveal: FindReveal) => { if (text) fields.push({ key, text, folded: foldFind(text), reveal, ...(reveal === "clip" ? { lines } : {}) }); };
  if (item.type === "todo") (Array.isArray(item.items) ? item.items : []).forEach((task, index) => { const todo = object(task); add(`todo:${index}`, string(todo.text) || string(todo.activeForm), "always"); });
  else {
    const summary = timelineSummary(item), name = item.type === "tool_call" ? string(item.name) : "";
    if (name && name !== summary) add("name", name, "always");
    add("summary", summary, expandable ? "clip" : "always");
    if (item.type === "tool_call") for (const { label, value } of toolDetails(item)) { const text = prettyValue(value); if (text !== summary) add(`detail:${label}`, text, "expand"); }
    if (item.type === "plugin") add("plugin", prettyValue(item.data), "expand");
  }
  fieldCache.set(item, fields);
  return fields;
}

/** Characters a collapsed line surely holds on a phone (about 24 Chinese characters fit in 390 px). */
const LINE_CHARS = 20;
/** Whether a collapsed row hides a range of a field: blocks shown only when it expands, text past its first lines. */
function hiddenWhenCollapsed(field: FindField, range: FindRange): boolean {
  if (field.reveal !== "clip") return field.reveal === "expand";
  const lines = field.lines ?? 5;
  if (range.end > lines * LINE_CHARS) return true;
  let breaks = 0;
  for (let at = field.text.indexOf("\n"); at >= 0 && at < range.start; at = field.text.indexOf("\n", at + 1)) if (++breaks >= lines) return true;
  return false;
}

/** One match: a range of one field of one row (by its stable key); `hidden` while the row is collapsed. */
export interface FindHit { row: string; field: string; start: number; end: number; hidden: boolean }
export interface FindResult {
  /** The terms joined by spaces: two queries with the same terms have the same results. */ query: string;
  terms: readonly string[]; hits: readonly FindHit[]; byRow: ReadonlyMap<string, readonly FindHit[]>;
  /** Rows looked at: the loaded ones (of the current filter). */ rows: number;
  /** The first FIND_MAX_HITS matches only: there may be more. */ capped: boolean;
  /** The timeline epoch the rows came from; a new epoch makes the result void. */ epoch: string | null;
}
export const FIND_MAX_HITS = 1000;
/** A row matches when it holds every term somewhere (a command in one block, an error in another); then every occurrence is a hit. */
export function findInRows(rows: readonly TimelineRow[], query: string, epoch: string | null = null, maxHits = FIND_MAX_HITS): FindResult {
  const terms = findTerms(query), hits: FindHit[] = [], byRow = new Map<string, FindHit[]>();
  if (terms.length) for (const row of rows) {
    if (hits.length >= maxHits) break;
    const fields = findFields(row.item);
    if (!terms.every(term => fields.some(field => field.folded.includes(term)))) continue;
    const own: FindHit[] = [];
    for (const field of fields) {
      const room = maxHits - hits.length - own.length;
      if (room <= 0) break;
      for (const range of termRanges(field.folded, terms, room)) own.push({ row: row.key, field: field.key, start: range.start, end: range.end, hidden: hiddenWhenCollapsed(field, range) });
    }
    if (own.length) { hits.push(...own); byRow.set(row.key, own); }
  }
  return { query: terms.join(" "), terms, hits, byRow, rows: rows.length, capped: hits.length >= maxHits, epoch };
}

/** `text` cut into plain and found parts for nested Text; `hit` is the range's index in `ranges`. Ranges past the text are dropped. */
export function highlightParts(text: string, ranges: readonly FindRange[]): Array<{ text: string; hit: number | null }> {
  const parts: Array<{ text: string; hit: number | null }> = [];
  let at = 0;
  ranges.forEach((range, index) => {
    const start = Math.max(at, range.start), end = Math.min(range.end, text.length);
    if (end <= start) return;
    if (start > at) parts.push({ text: text.slice(at, start), hit: null });
    parts.push({ text: text.slice(start, end), hit: index });
    at = end;
  });
  if (at < text.length) parts.push({ text: text.slice(at), hit: null });
  return parts;
}

/** A hit's identity across renders and result updates: its row, field and offset. */
export const hitKey = (hit: Pick<FindHit, "row" | "field" | "start">): string => `${hit.row}\u0000${hit.field}\u0000${hit.start}`;

/**
 * Where a text splits so the current hit's line starts a block of its own (codex-obs-send-ui-F2): the view measures where that
 * block starts in the row and scrolls the list to it. Blank lines right before the hit's line go with it, so `before` never ends
 * on a line break (a trailing one draws no empty line on the web). `blank` counts those lines, `prefix` is what its line holds
 * before the hit (a long line wraps it further down). Null for an offset outside the text.
 */
export interface HitLineSplit { at: number; before: string; after: string; blank: number; prefix: string }
export function hitLineSplit(text: string, start: number): HitLineSplit | null {
  if (start < 0 || start > text.length) return null;
  const line = start > 0 ? text.lastIndexOf("\n", start - 1) + 1 : 0;
  let at = line;
  while (at > 0 && text[at - 1] === "\n" && (at === 1 || text[at - 2] === "\n")) at--;
  return { at, before: at > 0 ? text.slice(0, at - 1) : "", after: text.slice(at), blank: line - at, prefix: text.slice(line, start) };
}
/** Characters drawn two columns wide: Hangul jamo, CJK, Hangul syllables, compatibility ideographs, full-width forms, emoji. */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
/** About how many wrapped lines of a `width` px block come before `prefix` on its line (CJK and other wide characters count twice). */
export function wrappedLines(prefix: string, width: number, charWidth: number): number {
  if (!prefix || width <= 0 || charWidth <= 0) return 0;
  let columns = 0;
  for (const char of prefix) columns += WIDE.test(char) ? 2 : 1;
  return Math.floor(columns * charWidth / width);
}
/**
 * How far below the top of the split's block the hit is drawn: its blank lines and, on a long line, the wrapped lines before it
 * (estimated from the block's width; a word that wraps early puts it lower, never off the top of the list).
 */
export function hitLineOffset(split: HitLineSplit, width: number, charWidth: number, lineHeight: number): number {
  return (split.blank + wrappedLines(split.prefix, width, charWidth)) * lineHeight;
}
/** What the timeline's list is asked to do to show a hit (FlatList `scrollToIndex`). */
export interface HitScroll { index: number; animated: boolean; viewPosition: number; viewOffset?: number }
/**
 * The scroll that puts a hit `y` px below its row's top a quarter down a list `visible` px tall: FlatList scrolls to the row's
 * offset minus `viewOffset` with viewPosition 0, so a negative offset reaches far into a tall row.
 */
export function hitScroll(y: number, visible: number): { viewPosition: 0; viewOffset: number } {
  return { viewPosition: 0, viewOffset: Math.round((visible > 0 ? visible : 600) / 4 - y) };
}

/**
 * Brings the current hit into view (codex-B1, codex-obs-send-ui-F2). The list scrolls by rows, and one row (an expanded tool's
 * output, a long reply) can hold screens of hits: the view measures the current hit's line inside its row and reports it
 * (`measured`), and the jumper scrolls to that line, a quarter down the list. A hit measured already goes straight there; one
 * not yet measured (its row not rendered, being expanded, or the hit just moved) goes to its row first (`toRow`, after a moment)
 * and on to the line once measured. Later measurements, and those of a hit no longer current, never move the list.
 */
export function createHitJumper(options: { scroll(params: HitScroll): void; indexOf(row: string): number; visible(): number }) {
  let target: { key: string; precise: boolean } | null = null, last: { key: string; y: number } | null = null;
  const toLine = (hit: FindHit, y: number) => {
    const index = options.indexOf(hit.row);
    if (index < 0 || !target) return;
    target.precise = true;
    options.scroll({ index, animated: true, ...hitScroll(y, options.visible()) });
  };
  return {
    /** A new jump to `hit` (a new query, 上一处 / 下一处). True while its line waits to be measured: call `toRow` after a moment. */
    jump(hit: FindHit): boolean {
      const key = hitKey(hit);
      target = { key, precise: false };
      if (last?.key === key) { toLine(hit, last.y); return false; }
      last = null;
      return true;
    },
    /** Nothing measured in time (its row is not rendered, or the hit is not in a block that measures): to its row. */
    toRow(hit: FindHit) {
      if (!target || target.key !== hitKey(hit) || target.precise) return;
      const index = options.indexOf(hit.row);
      if (index >= 0) options.scroll({ index, animated: true, viewPosition: 0.25 });
    },
    /** The view measured `hit`'s line `y` px below the top of its row. */
    measured(hit: FindHit, y: number) {
      const key = hitKey(hit);
      last = { key, y };
      if (target?.key === key && !target.precise) toLine(hit, y);
    },
  };
}
export type HitJumper = ReturnType<typeof createHitJumper>;

export interface FindSnapshot {
  open: boolean;
  /** What the field holds; `result` follows it after the debounce. */ input: string;
  result: FindResult | null;
  /** The current hit's index in `result.hits`, -1 without one. */ current: number;
  /** Typing or new rows wait for the debounce. */ pending: boolean;
  /** Bumps when the view should bring the current hit into view: a new query, 上一处 / 下一处, a new epoch — never rows streaming in. */ jump: number;
}
export interface FindClock { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }
const systemClock: FindClock = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };

/**
 * The find bar's state for one timeline view. Typing and new rows are searched after a 150–250 ms quiet period, always with the latest
 * text and rows, so a superseded query never shows; a new epoch voids the result at once and searches again without waiting. Rows
 * streaming in keep the current hit (by row key, field and offset) and never move the list; a new query starts at its first hit.
 */
export function createTimelineFind(options: { clock?: FindClock; debounceMs?: number } = {}) {
  const clock = options.clock ?? systemClock, debounceMs = Math.min(250, Math.max(150, options.debounceMs ?? 200));
  let state: FindSnapshot = { open: false, input: "", result: null, current: -1, pending: false, jump: 0 };
  let rows: readonly TimelineRow[] = [], epoch: string | null = null, timer: unknown = null, waiting: "query" | "rows" | null = null;
  // `known`: the last epoch that had rows (a replacement passes through no page at all). `unseen`: the current hit was picked
  // without bringing it into view (rows arrived after the query), so 下一处 shows it first instead of skipping it.
  let known: string | null = null, unseen = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<FindSnapshot>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const cancel = () => { if (timer !== null) clock.clearTimeout(timer); timer = null; waiting = null; };
  /** The hit to keep after rows changed: the same one, else the first in or after its row, else the last. */
  function kept(result: FindResult, previous: FindHit | undefined): number {
    if (!result.hits.length) return -1;
    if (!previous) return 0;
    const same = result.hits.findIndex(hit => hit.row === previous.row && hit.field === previous.field && hit.start === previous.start);
    if (same >= 0) return same;
    const order = new Map(rows.map((row, index) => [row.key, index])), from = order.get(previous.row) ?? -1;
    const next = result.hits.findIndex(hit => (order.get(hit.row) ?? -1) >= from);
    return next >= 0 ? next : result.hits.length - 1;
  }
  function search(reason: "query" | "rows") {
    cancel();
    if (!state.open || !findTerms(state.input).length) { if (state.result || state.pending || state.current !== -1) publish({ result: null, current: -1, pending: false }); return; }
    const result = findInRows(rows, state.input, epoch);
    const previous = state.result && state.result.epoch === epoch ? state.result.hits[state.current] : undefined;
    const current = reason === "query" ? (result.hits.length ? 0 : -1) : kept(result, previous);
    unseen = reason === "query" ? false : previous ? unseen : current >= 0;
    publish({ result, current, pending: false, ...(reason === "query" ? { jump: state.jump + 1 } : {}) });
  }
  function schedule(reason: "query" | "rows") {
    // A query waiting already decides how the result lands (at its first hit).
    const next = waiting === "query" ? "query" : reason;
    if (timer !== null) clock.clearTimeout(timer);
    waiting = next;
    timer = clock.setTimeout(() => { timer = null; search(next); }, debounceMs);
    if (!state.pending) publish({ pending: true });
  }
  function move(step: 1 | -1) {
    if (!state.open) return;
    // Enter while typing searches now and lands on the first hit, as a browser's find does.
    if (waiting === "query") { search("query"); return; }
    const count = state.result?.hits.length ?? 0;
    if (!count) return;
    if (unseen && state.current >= 0) { unseen = false; publish({ jump: state.jump + 1 }); return; }
    publish({ current: ((state.current < 0 ? (step > 0 ? -1 : 0) : state.current) + step + count) % count, jump: state.jump + 1 });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open() { if (state.open) return; publish({ open: true }); if (findTerms(state.input).length) search("query"); },
    /** The text stays for the next open, as in a browser. */
    close() { cancel(); unseen = false; publish({ open: false, result: null, current: -1, pending: false }); },
    setInput(input: string) {
      if (input === state.input) return;
      const same = !!state.result && findTerms(input).join(" ") === state.result.query && waiting !== "query";
      publish({ input });
      if (!state.open) return;
      if (!findTerms(input).length) { search("query"); return; }
      // Another space or the same words in other case: the result stands.
      if (!same) schedule("query");
    },
    /** The rows the view shows, in order, and the epoch they belong to (null while the timeline has no page). */
    setRows(next: readonly TimelineRow[], nextEpoch: string | null) {
      if (next === rows && nextEpoch === epoch) return;
      const replaced = nextEpoch !== null && known !== null && nextEpoch !== known;
      rows = next; epoch = nextEpoch;
      if (nextEpoch !== null) known = nextEpoch;
      if (!state.open || !findTerms(state.input).length) return;
      // Being replaced: the old hits point at rows that are gone, and there is nothing to search until the new ones arrive.
      if (nextEpoch === null) { cancel(); publish({ result: null, current: -1, pending: true }); return; }
      if (replaced) { search("query"); return; }
      schedule("rows");
    },
    next: () => move(1),
    previous: () => move(-1),
    /** The current hit, if the result is for the rows' epoch. */
    currentHit(): FindHit | null { return state.result && state.result.epoch === epoch ? state.result.hits[state.current] ?? null : null; },
    dispose() { cancel(); listeners.clear(); },
  };
}
export type TimelineFind = ReturnType<typeof createTimelineFind>;
