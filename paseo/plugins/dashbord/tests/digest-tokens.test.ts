import assert from "node:assert/strict";
import test from "node:test";
import { buildActivity } from "../server/digest/activity";
import { createFold, foldRows } from "../server/digest/fold";
import { attachTokens } from "../server/digest/tokens";
import type { TokenCall, TokenCallSource } from "../server/token-source";

const call = (at: number, start: number | null = null): TokenCall => ({ at, start, model: null, input: 100, output: 20, cacheRead: 60, cacheWrite: 10, reasoning: 5, subagent: false });
function turns() {
  const state = foldRows(createFold("a"), [
    { seq: 1, lastSeq: 1, at: 10000, type: "user_message", turnId: "one" }, { seq: 2, lastSeq: 2, at: 20000, type: "assistant_message", turnId: "one" },
    { seq: 3, lastSeq: 3, at: 23000, type: "user_message", turnId: "two" }, { seq: 4, lastSeq: 4, at: 30000, type: "assistant_message", turnId: "two" },
  ]);
  return buildActivity(state, { now: 40000, status: "idle" }).turns;
}

test("fake token source maps each call once, includes all inputs, and handles five-second overlaps", async () => {
  const calls = [call(9000), call(10000), call(22000, 20000), call(23000), call(35000), call(35001)];
  const fake: TokenCallSource = { callsForSessions: async ids => { assert.deepEqual(ids, ["session"]); return { source: "codex", calls }; } };
  const list = turns(), tokens = attachTokens(list, await fake.callsForSessions(["session"]), 40000)!;
  assert.equal(tokens.totals.calls, 6); assert.deepEqual(list.map(t => t.tokens?.calls), [2, 2]);
  assert.deepEqual(tokens.calls[2], [22000, 20, 170, 10]); assert.equal(tokens.totals.reasoning, 30);
});

test("token speed excludes unknown, invalid or subsecond durations and samples evenly", () => {
  const list = turns();
  const history = { source: "claude" as const, calls: [call(10000, 9999), call(11000, 12000), call(12000, null), call(15000, 14000)] };
  const tokens = attachTokens(list, history, 40000)!;
  assert.deepEqual(tokens.calls.map(c => c[3]), [null, null, null, 20]);
  assert.equal(tokens.totals.genMs, 1001); assert.equal(tokens.totals.genOutput, 40);
  const many = attachTokens([], { source: "codex", calls: Array.from({ length: 1000 }, (_, i) => call(i * 1000)) }, 1e6)!;
  assert.equal(many.calls.length, 400); assert.equal(many.calls[0]![0], 0); assert.equal(many.calls.at(-1)![0], 999000); assert.equal(many.totals.calls, 1000);
  assert.equal(attachTokens(turns(), null, 40000), null);
});

test("an overlapping older turn can receive an otherwise unmatched call, but never duplicates it", () => {
  const list = turns(); list[0]!.end = 60000;
  attachTokens(list, { source: "codex", calls: [call(50000)] }, 60000);
  assert.equal(list[0]!.tokens?.calls, 1); assert.equal(list[1]!.tokens, null);
});

test("a record standing for several model calls (a Grok turn) counts them all; every token source reaches 复盘", () => {
  const list = turns(), tokens = attachTokens(list, { source: "codex", calls: [{ ...call(22000), calls: 4 }, call(23500)] }, 40000)!;
  assert.equal(tokens.totals.calls, 5); assert.deepEqual(list.map(turn => turn.tokens?.calls), [4, 1]);
  // The digest schema names every ledger source (claude, codex, grok, pi): Pi and Grok sessions get their tokens too.
  assert.equal(attachTokens(turns(), { source: "pi", calls: [call(22000)] }, 40000)?.source, "pi");
  assert.equal(attachTokens(turns(), { source: "grok", calls: [{ ...call(22000), calls: 3 }] }, 40000)?.totals.calls, 3);
});
