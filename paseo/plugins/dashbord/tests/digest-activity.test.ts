import assert from "node:assert/strict";
import test from "node:test";
import type { DigestSegment } from "../shared/digest";
import type { TelemetryEvent } from "../shared/telemetry";
import { buildActivity, attributeTime, thinSegments } from "../server/digest/activity";
import { createFold, foldRows } from "../server/digest/fold";
import type { CompactRow } from "../server/digest/model";

const row = (seq: number, at: number, type: string, extra: Partial<CompactRow> = {}): CompactRow => ({ seq, lastSeq: seq, at, type, turnId: "one", ...extra });
const segment = (lane: DigestSegment["lane"], start: number, end: number, extra: Partial<DigestSegment> = {}): DigestSegment =>
  ({ lane, start, end, status: "ok", label: lane, turn: 1, n: 1, seq: 2, ...extra });
const event = (at: number, type: TelemetryEvent["type"], extra: Partial<TelemetryEvent> = {}): TelemetryEvent =>
  ({ id: `${at}:${type}`, agentId: "a", agentTitle: "", at: new Date(at).toISOString(), type, label: "", ...extra });

test("parallel tools and waits use lane priority without double counting; model gaps keep subsecond time", () => {
  const { time, model } = attributeTime(0, 10000, [segment("read", 1000, 7000), segment("shell", 2000, 5000), segment("wait", 3000, 6000), segment("web", 7500, 9000)], 1);
  assert.deepEqual(time, { model: 2500, read: 2000, search: 0, edit: 0, shell: 1000, web: 1500, agent: 0, plan: 0, wait: 3000, other: 0 });
  assert.deepEqual(model.map(s => [s.start, s.end]), [[0, 1000], [9000, 10000]]);
  assert.equal(Object.values(time).reduce((a, b) => a + b, 0), 10000);
});

test("turn spans exclude idle gaps and running tools extend to the injected clock", () => {
  const state = foldRows(createFold("a"), [row(1, 1000, "user_message"), row(2, 3000, "assistant_message", { text: "done" }),
    row(3, 20000, "user_message", { turnId: "two" }), row(4, 22000, "tool_call", { turnId: "two", tool: { id: "t", lane: "shell", status: "running" } })]);
  const activity = buildActivity(state, { now: 30000, status: "running" });
  assert.deepEqual(activity.turns.map(t => [t.outcome, t.end]), [["completed", 3000], ["running", null]]);
  assert.equal(activity.turns[0]!.time.model, 2000); assert.equal(activity.turns[1]!.time.shell, 8000);
  assert.equal(activity.segments.find(s => s.lane === "shell")?.seq, 4);
});

test("telemetry outcomes override inference, are agent-scoped, and match by time", () => {
  const state = foldRows(createFold("a"), [row(1, 1000, "user_message"), row(2, 2000, "assistant_message", { text: "done" }),
    row(3, 10000, "user_message", { turnId: "two" }), row(4, 15000, "error", { turnId: "two", text: "failed" })]);
  const { turns } = buildActivity(state, { now: 20000, status: "idle", events: [event(3000, "turn_canceled"), event(16000, "turn_completed"), event(17000, "turn_failed", { agentId: "foreign" })] });
  assert.deepEqual(turns.map(t => t.outcome), ["canceled", "completed"]);
});

test("inferred error, failed tail, canceled tail and unknown are distinguished", () => {
  for (const [type, status, expected] of [["error", "ok", "failed"], ["tool_call", "failed", "failed"], ["tool_call", "canceled", "canceled"], ["reasoning", "ok", "unknown"]] as const) {
    const state = foldRows(createFold("a"), [row(1, 1000, "user_message"), row(2, 2000, type, type === "tool_call" ? { tool: { id: "t", status } } : {})]);
    assert.equal(buildActivity(state, { now: 2000, status: "idle" }).turns[0]!.outcome, expected);
  }
});

test("overlapping permission waits match resolution duration and pending waits extend only within active turns", () => {
  const state = foldRows(createFold("a"), [row(1, 0, "user_message"), row(2, 10000, "reasoning")]);
  const events = [event(2000, "permission_requested"), event(4000, "permission_requested"), event(8000, "permission_resolved", { durationMs: 4000 })];
  const active = buildActivity(state, { now: 12000, status: "running", events });
  assert.equal(active.approvals, 2); assert.equal(active.turns[0]!.time.wait, 10000);
  assert.equal(active.segments.filter(s => s.lane === "wait").length, 2);
  const stopped = buildActivity(state, { now: 12000, status: "idle", events });
  assert.equal(stopped.turns[0]!.time.wait, 8000); assert.ok(stopped.segments.every(s => s.end <= 10000));
});

test("thinning merges nearest lane neighbours, sums calls, preserves failed seq and leaves inputs intact", () => {
  const original = [segment("shell", 0, 10, { label: "Bash · one", seq: 1 }), segment("read", 5, 8),
    segment("shell", 11, 20, { status: "failed", seq: 3 }), segment("shell", 100, 110, { turn: 2, seq: 4 })];
  const thinned = thinSegments(original, 3);
  assert.equal(thinned.length, 3); assert.equal(original[0]!.n, 1);
  assert.deepEqual([thinned[0]!.n, thinned[0]!.status, thinned[0]!.seq, thinned[0]!.label], [2, "failed", 3, "Bash × 2"]);
  assert.equal(thinned.at(-1)!.turn, 2);
  const large = Array.from({ length: 5000 }, (_, i) => segment(i % 2 ? "shell" : "read", i * 10, i * 10 + 5));
  assert.equal(thinSegments(large).length, 800); assert.equal(thinSegments(large).reduce((n, s) => n + s.n, 0), 5000);
});
