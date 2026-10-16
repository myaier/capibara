import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTimelinePage, projectTimelineRows, type TimelineRow } from "../shared/timeline";
import { FIND_MAX_HITS, createHitJumper, createTimelineFind, findFields, findInRows, findTerms, foldFind, highlightParts, hitKey, hitLineOffset, hitLineSplit, hitScroll, rowLayout, termRanges, toolDetails, wrappedLines, type FindClock, type HitScroll } from "../shared/timeline-find";

// Rows as the projected timeline gives them (keys `<epoch>:<identity or seq>`), through the same normalisation the view uses.
function rows(entries: Array<Record<string, unknown>>, epoch = "e1"): TimelineRow[] {
  return projectTimelineRows(normalizeTimelinePage({ epoch, entries: entries.map((item, index) => ({ seqStart: index + 1, seqEnd: index + 1, timestamp: "2026-10-12T09:00:00Z", item })) }).rows);
}
// Each reply its own message: the projection joins adjacent deltas of one message into one row.
let messages = 0;
const say = (text: string) => ({ type: "assistant_message", text, messageId: `m${++messages}` });
const ask = (text: string) => ({ type: "user_message", text });
const shell = (callId: string, command: string, output: string, extra: Record<string, unknown> = {}) =>
  ({ type: "tool_call", callId, name: "exec_command", status: "completed", detail: { type: "shell", command, cwd: "/home/me/app", output }, ...extra });
const spans = (text: string, query: string) => termRanges(foldFind(text), findTerms(query)).map(range => text.slice(range.start, range.end));

test("folding keeps every offset: case, full-width letters, digits and punctuation, the ideographic space; Chinese as it is", () => {
  const text = "ＮＰＭ　Test：失败（ＥＲＲ１）Σας İ";
  const folded = foldFind(text);
  assert.equal(folded.length, text.length, "one unit for one unit, so ranges map back onto the shown text");
  assert.equal(folded, "npm test:失败(err1)σασ İ");
  assert.equal(foldFind("Plain ASCII, 42!"), "plain ascii, 42!");
  assert.deepEqual(spans("运行 npm Test 时ＴＥＳＴ失败", "test"), ["Test", "ＴＥＳＴ"]);
  assert.deepEqual(spans("错误：连接超时", "错误:"), ["错误："], "a half-width colon finds the full-width one");
});

test("queries split into at most 8 distinct terms; quoted phrases stay whole", () => {
  assert.deepEqual(findTerms("  npm   失败 NPM "), ["npm", "失败"]);
  assert.deepEqual(findTerms("\"git status\" 冲突"), ["git status", "冲突"]);
  assert.deepEqual(findTerms("“合并 请求” ＭＲ"), ["合并 请求", "mr"]);
  assert.deepEqual(findTerms("\"unclosed phrase"), ["unclosed", "phrase"]);
  assert.deepEqual(findTerms("a b c d e f g h i j"), ["a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.deepEqual(findTerms("   "), []);
});

test("ranges of several terms come in order, overlapping ones merged, at most the limit", () => {
  assert.deepEqual(termRanges("testing the test", ["test", "sting"]), [{ start: 0, end: 7 }, { start: 12, end: 16 }]);
  assert.deepEqual(termRanges("aaaa", ["aa"]), [{ start: 0, end: 2 }, { start: 2, end: 4 }], "non-overlapping occurrences, like a browser's find");
  assert.equal(termRanges("x".repeat(50), ["x"], 10).length, 10);
});

test("a row is searched where it shows text: tool name, command, blocks behind 展开, todo items, plugin data; repeats left out", () => {
  const [tool, todo, plugin, reply] = rows([
    shell("c1", "npm test", "FAIL api.test.ts\n1 failed"),
    { type: "todo", items: [{ text: "补充幂等测试", completed: true }, { activeForm: "Running the suite" }] },
    { type: "plugin", pluginId: "demo", id: "p1", kind: "note", data: { body: "deploy window" } },
    say("全部通过。"),
  ]);
  assert.deepEqual(findFields(tool!.item).map(field => [field.key, field.reveal]),
    [["name", "always"], ["summary", "clip"], ["detail:工作目录", "expand"], ["detail:执行输出", "expand"]], "the command block repeats the row's text");
  assert.deepEqual(toolDetails(tool!.item).map(detail => detail.label), ["命令", "工作目录", "执行输出"]);
  assert.deepEqual(findFields(todo!.item).map(field => [field.key, field.text]), [["todo:0", "补充幂等测试"], ["todo:1", "Running the suite"]]);
  assert.deepEqual(findFields(plugin!.item).map(field => field.key), ["summary", "plugin"]);
  assert.deepEqual(findFields(reply!.item).map(field => [field.key, field.reveal]), [["summary", "always"]]);
  assert.equal(findFields(tool!.item), findFields(tool!.item), "an item is folded once while it lives");
  assert.deepEqual(rowLayout(tool!.item), { expandable: true, lines: 2 });
  assert.deepEqual(rowLayout(say("短回复")), { expandable: false, lines: undefined });
  assert.deepEqual(rowLayout(say("长".repeat(700))), { expandable: true, lines: 5 });
});

test("a row matches when it holds every term somewhere; every occurrence is a hit, and collapsed rows know which they hide", () => {
  const timeline = rows([
    ask("跑一下 npm test"),
    shell("c1", "npm test", "FAIL api.test.ts\nTimeout 连接超时"),
    shell("c2", "git status", "nothing to commit"),
    say(`${"前情提要。".repeat(140)}\n最后：npm 测试超时已修复`),
  ]);
  const result = findInRows(timeline, "npm 超时", "e1");
  assert.deepEqual([...result.byRow.keys()], [timeline[1]!.key, timeline[3]!.key], "the request lacks 超时; the git row has neither");
  assert.deepEqual(result.hits.map(hit => [hit.field, hit.hidden]), [["summary", false], ["detail:执行输出", true], ["summary", true], ["summary", true]]);
  assert.equal(result.query, "npm 超时"); assert.equal(result.rows, 4); assert.equal(result.capped, false); assert.equal(result.epoch, "e1");
  const reply = timeline[3]!.item.text as string, [npm, late] = result.byRow.get(timeline[3]!.key)!;
  assert.deepEqual([reply.slice(npm!.start, npm!.end), reply.slice(late!.start, late!.end)], ["npm", "超时"]);
  assert.deepEqual(findInRows(timeline, "TIMEOUT").hits.map(hit => hit.field), ["detail:执行输出"], "case-insensitive inside tool output");
  assert.equal(findInRows(timeline, "").hits.length, 0);
  const many = findInRows(rows(Array.from({ length: 20 }, (_, index) => say("e".repeat(80) + index))), "e");
  assert.equal(many.hits.length, FIND_MAX_HITS); assert.equal(many.capped, true);
});

test("highlight parts cover the text exactly, in order", () => {
  assert.deepEqual(highlightParts("run npm test now", [{ start: 4, end: 7 }, { start: 8, end: 12 }]),
    [{ text: "run ", hit: null }, { text: "npm", hit: 0 }, { text: " ", hit: null }, { text: "test", hit: 1 }, { text: " now", hit: null }]);
  assert.deepEqual(highlightParts("短文本", [{ start: 0, end: 1 }, { start: 10, end: 12 }]), [{ text: "短", hit: 0 }, { text: "文本", hit: null }], "a range past the shown text is dropped");
  assert.deepEqual(highlightParts("abc", []), [{ text: "abc", hit: null }]);
});

/** A manual clock: timers run only when the test advances time. */
function manualClock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: FindClock = { setTimeout(run, ms) { const id = ++next; timers.set(id, { at: now + ms, run }); return id; }, clearTimeout(id) { timers.delete(id as number); } };
  return { clock, advance(ms: number) { const end = now + ms; for (;;) { const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].run(); } now = end; }, get pending() { return timers.size; } };
}

test("typing is searched after a quiet 200 ms with the latest text only, and lands on the first hit", () => {
  const time = manualClock(), find = createTimelineFind({ clock: time.clock });
  const timeline = rows([say("alpha beta"), say("beta gamma"), say("gamma")]);
  let searches = 0;
  find.subscribe(() => { if (find.getSnapshot().result) searches++; });
  find.setRows(timeline, "e1"); find.open();
  find.setInput("al"); time.advance(100);
  find.setInput("gamma"); time.advance(199);
  assert.equal(find.getSnapshot().result, null, "nothing before the quiet period"); assert.equal(find.getSnapshot().pending, true);
  time.advance(1);
  const state = find.getSnapshot();
  assert.equal(state.result?.query, "gamma"); assert.equal(state.result?.hits.length, 2); assert.equal(state.current, 0); assert.equal(state.jump, 1);
  assert.equal(searches, 1, "the superseded 「al」 never searched");
  find.setInput("GAMMA "); assert.equal(time.pending, 0, "the same terms keep the result");
  assert.equal(find.getSnapshot().result, state.result);
});

test("上一处 / 下一处 wrap, and Enter while typing searches at once", () => {
  const time = manualClock(), find = createTimelineFind({ clock: time.clock });
  find.setRows(rows([say("one hit"), say("hit two"), say("hit three")]), "e1"); find.open();
  find.setInput("hit"); find.next();
  assert.equal(find.getSnapshot().result?.hits.length, 3, "searched without waiting"); assert.equal(find.getSnapshot().current, 0); assert.equal(time.pending, 0);
  find.next(); find.next(); assert.equal(find.getSnapshot().current, 2);
  find.next(); assert.equal(find.getSnapshot().current, 0, "wraps to the first");
  find.previous(); assert.equal(find.getSnapshot().current, 2, "and back to the last");
  assert.equal(find.getSnapshot().jump, 5, "every move brings the hit into view");
  find.setInput(""); assert.equal(find.getSnapshot().result, null);
  find.next(); assert.equal(find.getSnapshot().current, -1);
});

test("rows streaming in keep the current hit and never move the list; a new epoch searches again at once", () => {
  const time = manualClock(), find = createTimelineFind({ clock: time.clock });
  const first = rows([say("deploy started"), say("waiting"), say("deploy failed")]);
  find.setRows(first, "e1"); find.open(); find.setInput("deploy"); time.advance(200);
  find.next();
  const current = find.getSnapshot().result!.hits[1]!, jump = find.getSnapshot().jump;
  // A new reply before them all and one after: the same hit stays current, by row key and offset.
  const streamed = rows([say("deploy queued"), say("deploy started"), say("waiting"), say("deploy failed"), say("deploy retried")]);
  const shifted = streamed.map((row, index) => index === 0 ? { ...row, key: "e1:early" } : first[index - 1] ? { ...row, key: first[index - 1]!.key } : { ...row, key: "e1:late" });
  find.setRows(shifted, "e1"); time.advance(200);
  const after = find.getSnapshot();
  assert.equal(after.result?.hits.length, 4); assert.deepEqual(after.result?.hits[after.current], current); assert.equal(after.jump, jump, "no scroll for new rows");
  // The conversation was replaced: the old result is void right away, the new one comes without the debounce.
  find.setRows([], null);
  assert.equal(find.getSnapshot().result, null); assert.equal(find.getSnapshot().pending, true);
  find.setRows(rows([say("fresh deploy")], "e2"), "e2");
  assert.equal(time.pending, 0); assert.equal(find.getSnapshot().result?.epoch, "e2"); assert.equal(find.getSnapshot().result?.hits.length, 1);
  assert.equal(find.getSnapshot().current, 0); assert.equal(find.getSnapshot().jump, jump + 1);
  assert.equal(find.currentHit()?.row, "e2:1");
});

test("a hit that arrived with the rows is shown first, not skipped; closing keeps the text for the next open", () => {
  const time = manualClock(), find = createTimelineFind({ clock: time.clock });
  find.open(); find.setInput("ready"); time.advance(200);
  assert.equal(find.getSnapshot().result?.hits.length, 0, "nothing loaded yet");
  find.setRows(rows([say("ready one"), say("ready two")]), "e1"); time.advance(200);
  assert.equal(find.getSnapshot().current, 0); const jump = find.getSnapshot().jump;
  find.next(); assert.equal(find.getSnapshot().current, 0, "下一处 first shows the hit picked meanwhile"); assert.equal(find.getSnapshot().jump, jump + 1);
  find.next(); assert.equal(find.getSnapshot().current, 1);
  find.close();
  assert.deepEqual([find.getSnapshot().open, find.getSnapshot().result, find.getSnapshot().input], [false, null, "ready"]);
  find.setRows(rows([say("ready again")], "e1"), "e1"); assert.equal(time.pending, 0, "a closed find does not search");
  find.open(); assert.equal(find.getSnapshot().result?.hits.length, 1);
  find.dispose(); assert.equal(time.pending, 0);
});

// codex-obs-send-ui-F2 (send-ui/repro.ts): two hits 201 lines apart in one tool output used to give the same scroll to their row.
test("the current hit's line splits off as a block of its own; blank lines before it go with it", () => {
  const text = "first line\nsecond NEEDLE here\n\n\nfourth NEEDLE\nlast";
  assert.deepEqual(hitLineSplit(text, text.indexOf("NEEDLE")), { at: 11, before: "first line", after: "second NEEDLE here\n\n\nfourth NEEDLE\nlast", blank: 0, prefix: "second " });
  const late = text.lastIndexOf("NEEDLE"), split = hitLineSplit(text, late)!;
  assert.deepEqual([split.before, split.after, split.blank, split.prefix], ["first line\nsecond NEEDLE here", "\n\nfourth NEEDLE\nlast", 2, "fourth "], "the two blank lines move with it");
  assert.equal(split.before + "\n" + split.after, text, "nothing is lost or doubled");
  assert.deepEqual(hitLineSplit("NEEDLE first", 0), { at: 0, before: "", after: "NEEDLE first", blank: 0, prefix: "" });
  assert.deepEqual(hitLineSplit("\nNEEDLE", 1), { at: 0, before: "", after: "\nNEEDLE", blank: 1, prefix: "" }, "a leading blank line stays drawn");
  assert.equal(hitLineSplit("short", 9), null);
});

test("a hit far along a long line is drawn that many wrapped lines lower (estimated, wide characters twice)", () => {
  assert.equal(wrappedLines("x".repeat(100), 360, 7.2), 2, "720 px of text in 360 px: two lines before it");
  assert.equal(wrappedLines("x".repeat(49), 360, 7.2), 0);
  assert.equal(wrappedLines("汉".repeat(25), 360, 7.2), 1, "25 wide characters fill 360 px");
  assert.equal(wrappedLines("", 360, 7.2), 0); assert.equal(wrappedLines("abc", 0, 7.2), 0);
  const split = hitLineSplit(`a\n\n${"x".repeat(100)}NEEDLE`, 103)!;
  assert.equal(hitLineOffset(split, 360, 7.2, 18), (1 + 2) * 18, "one blank line and two wrapped lines");
});

test("a hit y px into its row lands a quarter down the list", () => {
  assert.deepEqual(hitScroll(3600, 800), { viewPosition: 0, viewOffset: -3400 });
  assert.deepEqual(hitScroll(40, 800), { viewPosition: 0, viewOffset: 160 }, "near the row's top: the row starts a little lower");
  assert.deepEqual(hitScroll(100, 0), { viewPosition: 0, viewOffset: 50 }, "before the list is measured, as for a 600 px list");
});

test("上一处 / 下一处 within one long tool output scroll to each hit's own line, not twice to the row (codex-obs-send-ui-F2)", () => {
  const output = ["NEEDLE_FIRST", ...Array.from({ length: 200 }, (_, index) => `ordinary line ${index}`), "NEEDLE_SECOND"].join("\n");
  const [row] = rows([shell("only", "show-log", output)]);
  const [first, second] = findInRows([row!], "NEEDLE", "e1").hits;
  assert.deepEqual([first!.start, second!.start], [0, 3503]);
  const scrolls: HitScroll[] = [];
  const jumper = createHitJumper({ scroll: params => scrolls.push(params), indexOf: key => key === row!.key ? 0 : -1, visible: () => 800 });
  // First hit: its line is not measured yet, so the row first; the measured line then.
  assert.equal(jumper.jump(first!), true);
  jumper.toRow(first!);
  jumper.measured(first!, 60);
  // 下一处: same row, 201 lines further down; measured once its block splits there.
  assert.equal(jumper.jump(second!), true);
  jumper.measured(second!, 60 + 201 * 18);
  assert.deepEqual(scrolls, [
    { index: 0, animated: true, viewPosition: 0.25 },
    { index: 0, animated: true, viewPosition: 0, viewOffset: 140 },
    { index: 0, animated: true, viewPosition: 0, viewOffset: 200 - 3678 },
  ]);
  assert.notDeepEqual(scrolls[1], scrolls[2], "the two hits get their own scroll");
  // Measured in time: no row-level scroll first; a later toRow or re-measure, or a measure of a hit no longer current, never moves it.
  jumper.toRow(second!); jumper.measured(second!, 9999); jumper.measured(first!, 10);
  assert.equal(scrolls.length, 3);
  // Back to a hit whose line was just measured: straight to it.
  assert.equal(jumper.jump(first!), false);
  assert.deepEqual(scrolls.at(-1), { index: 0, animated: true, viewPosition: 0, viewOffset: 190 });
  // A hit whose row is not in the list (filtered out): nothing.
  const other = { ...second!, row: "e1:gone" };
  assert.equal(jumper.jump(other), true); jumper.toRow(other); jumper.measured(other, 5);
  assert.equal(scrolls.length, 4);
  assert.notEqual(hitKey(first!), hitKey(second!));
});
