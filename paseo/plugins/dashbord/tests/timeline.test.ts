import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TIMELINE_ROWS, normalizeTimelinePage, projectTimelineRows, reconcileTimelinePage } from "../shared/timeline";

const message = (seq: number, text: string, seqEnd = seq) => ({ seqStart: seq, seqEnd, timestamp: "2026-09-16T12:00:00Z", item: { type: "assistant_message", text } });
const page = (entries: ReturnType<typeof message>[], extra: Record<string, unknown> = {}) => normalizeTimelinePage({ epoch: "epoch-1", entries, hasOlder: false, ...extra });
test("authoritative tail replaces overlapping projected text without duplication", () => {
  const first = reconcileTimelinePage(null, page([message(1, "Hello", 2)]));
  const next = reconcileTimelinePage(first, page([message(1, "Hello world", 5)]));
  assert.equal(next.rows.length, 1); assert.equal(next.rows[0].item.text, "Hello world");
  assert.deepEqual(reconcileTimelinePage(next, page([message(1, "Hello world", 5)])).rows, next.rows);
});
test("older pages and subsequent tail refresh preserve earlier history", () => {
  const first = reconcileTimelinePage(null, page([message(20, "last")], { hasOlder: true }));
  const older = reconcileTimelinePage(first, page([message(10, "before")], { hasOlder: false }), "before");
  const updated = reconcileTimelinePage(older, page([message(20, "latest")], { hasOlder: true }));
  assert.deepEqual(updated.rows.map(row => row.item.text), ["before", "latest"]);
  assert.equal(updated.hasOlder, false);
  assert.deepEqual(updated.startCursor, { epoch: "epoch-1", seq: 10 });
});
test("a replacement epoch cannot mix with an earlier conversation", () => {
  const old = reconcileTimelinePage(null, page([message(1, "old")]));
  const next = reconcileTimelinePage(old, page([message(1, "new")], { epoch: "epoch-2" }));
  assert.equal(next.rows.length, 1); assert.equal(next.rows[0].item.text, "new");
  assert.equal(next.epoch, "epoch-2");
});
test("loading old history does not turn a completed tool back into running", () => {
  const tool = (seqEnd: number, status: string) => normalizeTimelinePage({ epoch: "e", entries: [{ seqStart: 1, seqEnd, item: { type: "tool_call", callId: "call-1", status } }] });
  const latest = reconcileTimelinePage(null, tool(10, "completed"));
  const merged = reconcileTimelinePage(latest, tool(2, "running"), "before");
  assert.equal(merged.rows.length, 1); assert.equal(merged.rows[0].item.status, "completed");
});
test("raw provider child rows derive real cursors and update tool identity", () => {
  const raw = normalizeTimelinePage({ epoch: "p", rows: [{ seq: 7, timestamp: "", item: { type: "tool_call", callId: "x", status: "running" } }, { seq: 9, timestamp: "", item: { type: "tool_call", callId: "x", status: "completed" } }], hasOlder: true });
  const next = reconcileTimelinePage(null, raw);
  assert.equal(next.rows.length, 1); assert.equal(next.rows[0].item.status, "completed");
  assert.deepEqual(next.endCursor, { epoch: "p", seq: 9 });
});
test("long-running tool projection does not discard unrelated older messages", () => {
  const first = reconcileTimelinePage(null, page([message(2, "keep me"), message(5, "also keep")]));
  const tail = normalizeTimelinePage({ epoch: "epoch-1", entries: [
    { seqStart: 1, seqEnd: 100, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }, { startSeq: 100, endSeq: 100 }], item: { type: "tool_call", callId: "long", status: "completed" } },
    message(101, "finished"),
  ] });
  const next = reconcileTimelinePage(first, tail);
  assert.deepEqual(next.rows.filter(row => row.item.type === "assistant_message").map(row => row.item.text), ["keep me", "also keep", "finished"]);
});
test("history window memory is bounded and reports truncation", () => {
  const next = reconcileTimelinePage(null, page(Array.from({ length: MAX_TIMELINE_ROWS + 10 }, (_, n) => message(n, String(n)))));
  assert.equal(next.rows.length, MAX_TIMELINE_ROWS); assert.equal(next.truncated, true); assert.equal(next.hasOlder, true);
});
test("token deltas form one message after authoritative history reconciliation", () => {
  const raw = normalizeTimelinePage({ epoch: "tokens", rows: [
    { seq: 1, item: { type: "assistant_message", messageId: "one", text: "我" } },
    { seq: 2, item: { type: "assistant_message", messageId: "one", text: "会" } },
    { seq: 3, item: { type: "assistant_message", text: "检查" } },
  ] });
  const canonical = reconcileTimelinePage(null, raw);
  const repeated = reconcileTimelinePage(canonical, raw);
  const presented = projectTimelineRows(repeated.rows);
  assert.equal(canonical.rows.length, 3, "presentation does not mutate pagination source rows");
  assert.equal(presented.length, 1); assert.equal(presented[0].item.text, "我会检查");
  assert.equal(presented[0].seqStart, 1); assert.equal(presented[0].seqEnd, 3);
});
test("identical neighboring tokens concatenate rather than being guessed duplicates", () => {
  const raw = normalizeTimelinePage({ epoch: "tokens", rows: [
    { seq: 1, item: { type: "assistant_message", text: "ha" } },
    { seq: 2, item: { type: "assistant_message", text: "ha" } },
  ] });
  assert.equal(projectTimelineRows(raw.rows)[0].item.text, "haha");
});
test("message IDs, turns, sequence gaps, tools and users remain boundaries", () => {
  const raw = normalizeTimelinePage({ epoch: "boundaries", rows: [
    { seq: 1, turnId: "t1", item: { type: "assistant_message", messageId: "one", text: "one" } },
    { seq: 2, turnId: "t1", item: { type: "assistant_message", messageId: "two", text: "two" } },
    { seq: 3, turnId: "t2", item: { type: "assistant_message", messageId: "two", text: "turn" } },
    { seq: 5, turnId: "t2", item: { type: "assistant_message", messageId: "two", text: "gap" } },
    { seq: 6, item: { type: "tool_call", callId: "tool", name: "read" } },
    { seq: 7, item: { type: "assistant_message", text: "after tool" } },
    { seq: 8, item: { type: "user_message", text: "next" } },
    { seq: 9, item: { type: "assistant_message", text: "answer" } },
  ] });
  assert.equal(projectTimelineRows(raw.rows).length, 8);
});
test("partial tool completion retains original name, detail and input", () => {
  const raw = normalizeTimelinePage({ epoch: "tools", rows: [
    { seq: 1, turnId: "t", item: { type: "tool_call", callId: "x", name: "exec_command", status: "running", detail: { type: "shell", command: "git status", cwd: "/repo" }, input: { command: "git status" } } },
    { seq: 4, turnId: "t", item: { type: "tool_call", callId: "x", status: "completed", detail: { type: "unknown", output: "clean" } } },
  ] });
  const result = reconcileTimelinePage(null, raw);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].item.name, "exec_command");
  assert.deepEqual(result.rows[0].item.detail, { type: "shell", command: "git status", cwd: "/repo", output: "clean" });
  assert.equal(result.rows[0].item.status, "completed");
});
test("older tool page enriches newer completion without rolling status back", () => {
  const newer = normalizeTimelinePage({ epoch: "tools", rows: [{ seq: 10, item: { type: "tool_call", callId: "x", status: "completed" } }] });
  const older = normalizeTimelinePage({ epoch: "tools", rows: [{ seq: 2, item: { type: "tool_call", callId: "x", name: "read_file", status: "running", detail: { type: "read", filePath: "README.md" } } }] });
  const result = reconcileTimelinePage(reconcileTimelinePage(null, newer), older, "before");
  assert.equal(result.rows[0].item.name, "read_file"); assert.equal(result.rows[0].item.status, "completed");
});
