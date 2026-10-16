import assert from "node:assert/strict";
import test from "node:test";
import { digestHighlightSchema, HIGHLIGHT_KINDS, type Digest, type DigestCheck, type DigestHighlight, type DigestSegment, type DigestTurn } from "../shared/digest";
import { emptyTokenCounts } from "../shared/tokens";
import { createFold } from "../server/digest/fold";
import { buildHighlights } from "../server/digest/highlights";
import { emptyLanes, type FoldState, type ToolFact, type TurnFact } from "../server/digest/model";

function turn(index: number, change: Partial<DigestTurn> = {}): DigestTurn {
  return { index, turnId: `turn-${index}`, start: index * 1000, end: index * 1000 + 900, outcome: "completed", prompt: "目标", reply: "完成",
    tools: 0, failures: 0, lanes: emptyLanes(), files: 0, added: 0, removed: 0, commands: 0, checksPassed: 0, checksFailed: 0,
    time: emptyLanes(), tokens: null, ...change };
}
function stateFor(turns: readonly DigestTurn[] = [turn(1)]): FoldState {
  const state = createFold("synthetic", "", "canonical-epoch");
  state.turns = turns.map<TurnFact>(value => ({ index: value.index, turnId: value.turnId, start: value.start, end: value.end ?? value.start,
    seq: value.index * 100, lastSeq: value.index * 100 + 99, prompt: value.prompt, reply: value.reply, tail: "assistant_message", error: false,
    messages: 2, replyId: null, replySeq: value.index * 100 + 99, compactionOpen: false }));
  return state;
}
function tool(state: FoldState, seq: number, change: Partial<ToolFact> = {}): ToolFact {
  const value: ToolFact = { id: `call-${seq}`, turn: 1, seq, lastSeq: seq + 1, start: seq * 1000, end: seq * 1000 + 100,
    status: "ok", name: "Bash", lane: "shell", target: "执行检查", path: null, added: 0, removed: 0,
    command: "npm test", commandKey: "same-command", program: "npm", check: "test", git: null, ...change };
  state.tools.set(value.id, value); return value;
}
function check(value: ToolFact): DigestCheck {
  return { kind: value.check!, start: value.start, end: value.status === "running" ? null : value.end,
    command: value.command, ok: value.status === "ok" ? true : value.status === "failed" ? false : null, turn: value.turn, seq: value.seq };
}
function segment(lane: DigestSegment["lane"], ms: number, change: Partial<DigestSegment> = {}): DigestSegment {
  return { lane, start: 1000, end: 1000 + ms, status: "ok", label: "执行阶段", turn: 1, n: 1, seq: null, ...change };
}
const ofKind = (result: DigestHighlight[], kind: DigestHighlight["kind"]) => result.filter(value => value.kind === kind);

test("check failures group by category and program and repaired episodes replace bad signals", () => {
  const turns = [turn(1)], state = stateFor(turns);
  const checks = [
    tool(state, 1, { status: "failed" }), tool(state, 2, { status: "failed" }),
    tool(state, 3, { program: "pytest", status: "failed", commandKey: "other", command: "pytest" }),
    tool(state, 4), tool(state, 5, { check: "typecheck", command: "tsc", program: "tsc" }),
    tool(state, 6, { check: "typecheck", command: "tsc", program: "tsc" }),
  ].map(check);
  const result = buildHighlights(state, turns, [], checks, null);
  assert.deepEqual(ofKind(result, "check_fixed").map(value => [value.title, value.value, value.seq]), [["测试失败 2 次后通过", 2, 4]]);
  assert.deepEqual(ofKind(result, "check_failed").map(value => [value.title, value.value, value.seq]), [["测试失败 1 次", 1, 3]]);
  assert.deepEqual(ofKind(result, "check_passed").map(value => [value.title, value.value, value.seq]), [["类型检查通过", 2, 6]]);
});

test("later failures start fresh episodes and pending checks do not announce a pass", () => {
  const turns = [turn(1)], state = stateFor(turns);
  const checks = [tool(state, 1, { status: "failed" }), tool(state, 2), tool(state, 3, { status: "failed" }),
    tool(state, 4, { check: "lint", command: "eslint .", program: "eslint" }),
    tool(state, 5, { check: "lint", command: "eslint .", program: "eslint", status: "running" })].map(check);
  const result = buildHighlights(state, turns, [], checks, null);
  assert.equal(ofKind(result, "check_fixed").length, 1); assert.equal(ofKind(result, "check_failed").length, 1);
  assert.equal(ofKind(result, "check_passed").length, 0);
  assert.equal(ofKind(result, "check_failed")[0]?.value, 1);
});

test("tool streaks use final statuses and repeated commands also count interrupted retries", () => {
  const turns = [turn(1)], state = stateFor(turns);
  for (let i = 1; i <= 3; i++) tool(state, i, { status: "failed", commandKey: "streak" });
  tool(state, 4, { status: "canceled" });
  for (let i = 5; i <= 9; i++) tool(state, i, { status: i % 2 ? "failed" : "ok", commandKey: i % 2 ? "repeat" : "success" });
  const streaks = ofKind(buildHighlights(state, turns, [], [], null), "fail_streak");
  assert.deepEqual(streaks.map(value => [value.title, value.value, value.seq]), [["同一命令失败 3 次", 3, 9], ["连续 3 次失败", 3, 3]]);
});

test("check fallback preserves unknown references and two failed tools do not form a streak", () => {
  const turns = [turn(1)], state = stateFor(turns);
  tool(state, 1, { status: "failed" }); tool(state, 2, { status: "failed" });
  const checks: DigestCheck[] = [{ kind: "lint", start: 100, end: 200, command: "eslint .", ok: false, turn: 1, seq: null }];
  const result = buildHighlights(state, turns, [], checks, null);
  assert.equal(ofKind(result, "fail_streak").length, 0); assert.equal(ofKind(result, "check_failed")[0]?.seq, null);
});

test("duration and edit thresholds are inclusive and only the largest tools and edits remain", () => {
  const turns = [turn(1)], state = stateFor(turns);
  for (const [index, ms] of [59_999, 60_000, 70_000, 80_000, 90_000].entries()) tool(state, index + 1, { start: 1000, end: 1000 + ms });
  for (const [index, lines] of [79, 80, 90, 100].entries()) tool(state, 10 + index, { lane: "edit", path: "source.ts", added: lines, removed: 0 });
  const segments = [segment("model", 179_999), segment("model", 180_000), segment("wait", 59_999), segment("wait", 60_000)];
  const result = buildHighlights(state, turns, segments, [], null);
  assert.deepEqual(ofKind(result, "slow_tool").map(value => value.value), [90_000, 80_000, 70_000]);
  assert.deepEqual(ofKind(result, "big_edit").map(value => value.value), [100, 90]);
  assert.equal(ofKind(result, "long_think")[0]?.value, 180_000); assert.equal(ofKind(result, "long_think").length, 1);
  assert.equal(ofKind(result, "approval_wait")[0]?.value, 60_000); assert.equal(ofKind(result, "approval_wait").length, 1);
  assert.equal(ofKind(result, "long_think")[0]?.seq, null); assert.equal(ofKind(result, "approval_wait")[0]?.seq, null);
});

test("ongoing tool duration uses the activity span and Git milestones require success", () => {
  const turns = [turn(1, { end: null, outcome: "running" })], state = stateFor(turns);
  tool(state, 1, { lane: "agent", start: 1000, end: 1000, status: "running", target: "核对数据", check: null });
  tool(state, 2, { git: "已提交代码", status: "failed" }); tool(state, 3, { git: "已推送代码" });
  const result = buildHighlights(state, turns, [segment("agent", 70_000, { seq: 1, status: "running" })], [], null);
  assert.equal(ofKind(result, "subagent")[0]?.value, 70_000); assert.equal(ofKind(result, "subagent")[0]?.seq, 1);
  assert.equal(ofKind(result, "subagent")[0]?.detail, "核对数据");
  assert.equal(ofKind(result, "slow_tool")[0]?.value, 70_000);
  assert.deepEqual(ofKind(result, "git").map(value => value.seq), [3]);
});

test("outcomes, errors, compactions and file counts keep canonical references and bounded excerpts", () => {
  const turns = [turn(1, { outcome: "failed", reply: " 错误\n".repeat(100) }), turn(2, { outcome: "canceled" }), turn(3, { files: 8 }), turn(4, { files: 7 })];
  const state = stateFor(turns);
  state.events.push({ type: "error", at: 200, turn: 1, seq: 12, detail: "错误\n".repeat(300) },
    { type: "compaction", at: 300, turn: 1, seq: 13, detail: "上下文压缩" });
  const result = buildHighlights(state, turns, [], [], null);
  assert.equal(ofKind(result, "turn_failed")[0]?.seq, 199); assert.equal(ofKind(result, "interrupted")[0]?.seq, 299);
  assert.equal(ofKind(result, "many_files")[0]?.seq, 300); assert.equal(ofKind(result, "many_files").length, 1);
  assert.equal(ofKind(result, "error")[0]?.seq, 12); assert.equal(ofKind(result, "compaction")[0]?.seq, 13);
  for (const highlight of result) { digestHighlightSchema.parse(highlight); assert.ok(!highlight.detail.includes("\n")); }
});

test("token-heavy share counts cache input once, excludes reasoning double-counting and requires three turns", () => {
  const turns = [turn(1, { tokens: { ...emptyTokenCounts(), input: 5, output: 5 } }),
    turn(2, { tokens: { ...emptyTokenCounts(), input: 5, cacheWrite: 10, cacheRead: 15, output: 5, reasoning: 5 } }),
    turn(3, { tokens: { ...emptyTokenCounts(), input: 5, output: 5 } })];
  const state = stateFor(turns), tokens: Digest["tokens"] = { source: "codex", totals: { ...emptyTokenCounts(), input: 100 }, calls: [] };
  const heavy = ofKind(buildHighlights(state, turns, [], [], tokens), "token_heavy")[0]!;
  assert.equal(heavy.value, 0.35); assert.equal(heavy.turn, 2); assert.equal(heavy.seq, 200); assert.match(heavy.title, /35%/);
  assert.equal(ofKind(buildHighlights(state, turns.slice(0, 2), [], [], tokens), "token_heavy").length, 0);
  assert.equal(ofKind(buildHighlights(state, turns, [], [], { ...tokens, totals: { ...tokens.totals, input: 101 } }), "token_heavy").length, 0);
  assert.equal(ofKind(buildHighlights(state, turns, [], [], null), "token_heavy").length, 0);
});

test("all highlight kinds exist and candidates are capped by severity then recency", () => {
  const turns = [turn(1, { outcome: "failed", files: 8, tokens: { ...emptyTokenCounts(), input: 80 } }), turn(2, { outcome: "canceled" }), turn(3)];
  const state = stateFor(turns), checks = [tool(state, 1, { status: "failed" }), tool(state, 2),
    tool(state, 3, { check: "lint", command: "eslint", program: "eslint" }),
    tool(state, 4, { check: "build", status: "failed", program: "vite" })].map(check);
  for (let seq = 5; seq <= 7; seq++) tool(state, seq, { status: "failed", commandKey: "streak" });
  tool(state, 8, { lane: "edit", added: 80 }); tool(state, 9, { git: "已提交代码" }); tool(state, 10, { lane: "agent", start: 1000, end: 61_000 });
  state.events = [{ type: "error", at: 500, turn: 1, seq: 14, detail: "错误" }, { type: "compaction", at: 600, turn: 1, seq: 15, detail: "压缩" }];
  const segments = [segment("model", 180_000), segment("wait", 60_000)];
  const tokens: Digest["tokens"] = { source: "claude", totals: { ...emptyTokenCounts(), input: 100 }, calls: [] };
  const result = buildHighlights(state, turns, segments, checks, tokens);
  assert.deepEqual(new Set(result.map(value => value.kind)), new Set(HIGHLIGHT_KINDS));
  const order = { bad: 0, warn: 1, good: 2, info: 3 };
  for (let i = 1; i < result.length; i++) {
    const previous = result[i - 1]!, current = result[i]!;
    assert.ok(order[previous.severity] <= order[current.severity]);
    if (previous.severity === current.severity) assert.ok(previous.at >= current.at);
  }
  for (let i = 0; i < 50; i++) state.events.push({ type: "error", at: 100_000 + i, turn: 1, seq: 1000 + i, detail: "错误" });
  const capped = buildHighlights(state, turns, segments, checks, tokens);
  assert.equal(capped.length, 30); assert.equal(capped[0]?.seq, 1049); assert.equal(capped[29]?.seq, 1020);
  for (const highlight of capped) digestHighlightSchema.parse(highlight);
});
