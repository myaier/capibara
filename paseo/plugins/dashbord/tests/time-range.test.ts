import assert from "node:assert/strict";
import test from "node:test";
import { applyReadReceipt, applyTelemetry, normalizeAgent } from "../shared/model";
import { DEFAULT_TIME_RANGE, historyActivityTimestamp, withinRange } from "../shared/time-range";

const now = Date.parse("2026-09-17T12:00:00Z");
const day = 86400000;
const ago = (days: number) => new Date(now - days * day).toISOString();
const at = (date: string) => normalizeAgent({ id: "a", status: "completed", updatedAt: date });
test("default history range is a rolling seven days with inclusive exact boundaries", () => {
  assert.equal(DEFAULT_TIME_RANGE, "7d");
  assert.equal(withinRange(at(ago(7)), undefined, now), true);
  assert.equal(withinRange(at(new Date(now - 7 * day - 1).toISOString()), "7d", now), false);
  assert.equal(withinRange(at(new Date(now).toISOString()), "7d", now), true);
  assert.equal(withinRange(at(new Date(now + 1).toISOString()), "7d", now), false);
});
test("24-hour and 30-day ranges use the selected interval", () => {
  assert.equal(withinRange(at(ago(1)), "24h", now), true);
  assert.equal(withinRange(at(ago(2)), "24h", now), false);
  assert.equal(withinRange(at(ago(30)), "30d", now), true);
  assert.equal(withinRange(at(ago(31)), "30d", now), false);
});
test("live running, waiting and initializing sessions remain visible regardless of age", () => {
  for (const status of ["running", "initializing"] as const) assert.equal(withinRange(normalizeAgent({ id: status, status, createdAt: ago(100) }), "24h", now), true);
  assert.equal(withinRange(normalizeAgent({ id: "waiting", status: "running", pendingPermissionCount: 1, createdAt: ago(100) }), "24h", now), true);
  assert.equal(withinRange(normalizeAgent({ id: "idle", status: "idle", createdAt: ago(100) }), "24h", now), false);
});
test("unread completed results survive old ranges while read and unknown completions do not", () => {
  const source = { id: "old-result", status: "idle", createdAt: ago(40), updatedAt: ago(20), lastUserMessageAt: ago(21), attentionReason: "finished", attentionTimestamp: ago(20), requiresAttention: true };
  const unread = normalizeAgent(source);
  assert.equal(withinRange(unread, "7d", now), true);
  assert.equal(withinRange(unread, "24h", now), true);
  assert.equal(withinRange(normalizeAgent({ ...source, requiresAttention: false }), "7d", now), false);
  assert.equal(withinRange(normalizeAgent({ ...source, requiresAttention: undefined }), "7d", now), false);
  const read = applyReadReceipt(unread, { completionAt: ago(20), lastUserMessageAt: ago(21), readAt: ago(19) });
  assert.equal(withinRange(read, "7d", now), false);
  assert.equal(withinRange(normalizeAgent({ ...source, archivedAt: ago(0) }), "7d", now), false);
});
test("archive writes today cannot make old executed sessions look recent", () => {
  const agent = normalizeAgent({ id: "old", status: "closed", archivedAt: ago(0), updatedAt: ago(0), lastUserMessageAt: ago(30), createdAt: ago(50) });
  assert.equal(historyActivityTimestamp(agent), now - 30 * day);
  assert.equal(withinRange(agent, "7d", now), false);
  assert.equal(withinRange(agent, "all", now), true);
});
test("known recent terminal outcome includes an archived session with an older prompt", () => {
  const original = normalizeAgent({ id: "completed", status: "closed", archivedAt: ago(0), updatedAt: ago(0), lastUserMessageAt: ago(20), createdAt: ago(30) });
  const agent = applyTelemetry(original, { outcome: "completed", turnEndedAt: ago(2) });
  assert.equal(agent.status, "completed"); assert.equal(withinRange(agent, "7d", now), true);
  assert.equal(historyActivityTimestamp(agent), now - 2 * day);
});
test("legacy archived models prefer execution markers over lastActivity derived from archive update", () => {
  const agent = { ...normalizeAgent({ id: "legacy", status: "closed", archivedAt: ago(0), createdAt: ago(50), lastUserMessageAt: ago(25) }), lastActivityAt: ago(0), updatedAt: ago(0), lastExecutionAt: undefined };
  assert.equal(withinRange(agent, "7d", now), false);
});
test("archived missing execution metadata falls back to prearchive update or creation", () => {
  assert.equal(withinRange(normalizeAgent({ id: "old", status: "closed", archivedAt: ago(0), updatedAt: ago(0), createdAt: ago(40) }), "7d", now), false);
  assert.equal(withinRange(normalizeAgent({ id: "retained", status: "closed", archivedAt: ago(0), updatedAt: ago(2), createdAt: ago(40) }), "7d", now), true);
});
test("unknown dates and archived stale active flags do not bypass recent-history filtering", () => {
  const unknown = normalizeAgent({ id: "unknown", status: "closed" });
  assert.equal(withinRange(unknown, "7d", now), false); assert.equal(withinRange(unknown, "all", now), true);
  const stale = normalizeAgent({ id: "archived", status: "running", archivedAt: ago(0), updatedAt: ago(0), lastUserMessageAt: ago(40) });
  assert.equal(withinRange(stale, "7d", now), false);
});
