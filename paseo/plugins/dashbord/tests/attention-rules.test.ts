import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardRows, needsAttention } from "../shared/dashboard-model";
import { activitySignature, contextPressure, matchesAgentStatus, normalizeAgent, type AgentRecord } from "../shared/model";
import { isCompletionSnoozed, snoozeToken } from "../shared/preferences";

const T = "2026-10-11T04:00:00.000Z";
const question = normalizeAgent({ id: "q", status: "running", pendingPermissions: [{ id: "1", kind: "question", input: { questions: [{ question: "先修哪个？", options: [{ label: "A" }, { label: "B" }] }] } }] });
const approval = normalizeAgent({ id: "p", status: "running", pendingPermissions: [{ id: "1", kind: "tool", name: "Bash", detail: { type: "shell", command: "rm -rf build" } }] });

test("a question is 待回复 and not 待审批, in the chips and in the list filter (opus-F12)", () => {
  assert.equal(matchesAgentStatus(question, "idle"), true);
  assert.equal(matchesAgentStatus(question, "waiting"), false);
  assert.equal(matchesAgentStatus(approval, "waiting"), true);
  assert.equal(matchesAgentStatus(approval, "idle"), false);
  const options = { query: "", view: "list" as const, sort: "attention" as const, expanded: new Set<string>() };
  assert.deepEqual(buildDashboardRows([question, approval], { ...options, status: "idle" }).rows.map(row => row.node.agent.id), ["q"]);
  assert.deepEqual(buildDashboardRows([question, approval], { ...options, status: "waiting" }).rows.map(row => row.node.agent.id), ["p"]);
  assert.equal(needsAttention(question), true, "both still need you");
});

test("待回复 can be snoozed and marked read with the reply's attention stamp as the token (opus-F1)", () => {
  const asking: AgentRecord = { ...normalizeAgent({ id: "i", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: T }), status: "idle" };
  assert.equal(snoozeToken(asking), T);
  assert.equal(needsAttention(asking), true);
  const snoozes = [{ agentId: "i", completionAt: T, until: "2026-10-11T05:00:00.000Z" }];
  assert.equal(isCompletionSnoozed(asking, snoozes, Date.parse("2026-10-11T04:30:00.000Z")), true);
  assert.equal(needsAttention(asking, true), false, "snoozed for an hour");
  const newer = { ...asking, attentionTimestamp: "2026-10-11T04:20:00.000Z" };
  assert.equal(isCompletionSnoozed(newer, snoozes, Date.parse("2026-10-11T04:30:00.000Z")), false, "a newer question shows again");
  assert.equal(snoozeToken({ ...asking, requiresAttention: false }), null, "nothing to snooze once read");
  // A heartbeat prompts again while the first reply is still unread: the host keeps its old stamp, the new question is new.
  const again = { ...asking, lastUserMessageAt: "2026-10-11T04:10:00.000Z" };
  assert.equal(snoozeToken(again), "2026-10-11T04:10:00.000Z");
  assert.equal(isCompletionSnoozed(again, snoozes, Date.parse("2026-10-11T04:30:00.000Z")), false, "a question after a newer prompt shows again");
});

test("待回复 after heartbeat rounds: each round the plugin saw start is its own snooze token; the host's tokens stay (codex-obs-attn-F1)", () => {
  // The host's real shape: a heartbeat starts a turn from a system notification, so lastUserMessageAt stays at T0, and the
  // first unread question keeps the attention stamp at T1 (edge-triggered). Only the observed turn starts move.
  const T0 = "2026-10-11T04:00:00.000Z", T1 = "2026-10-11T04:05:00.000Z", now = Date.parse("2026-10-11T04:30:00.000Z"), until = "2026-10-11T05:30:00.000Z";
  const asking: AgentRecord = { ...normalizeAgent({ id: "h", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: T1, lastUserMessageAt: T0 }), status: "idle" };
  const round1 = { ...asking, observedTurnStartedAt: "2026-10-11T04:04:00.000Z", observedTurnEndedAt: T1 };
  const round2 = { ...asking, observedTurnStartedAt: "2026-10-11T04:10:00.000Z", observedTurnEndedAt: "2026-10-11T04:11:00.000Z" };
  const round3 = { ...asking, observedTurnStartedAt: "2026-10-11T04:20:00.000Z", observedTurnEndedAt: "2026-10-11T04:21:00.000Z" };
  assert.equal(snoozeToken(round1), T1, "one round: the host's stamp, as before");
  assert.equal(snoozeToken(asking), T1, "nothing observed: the host's stamp, as before");
  assert.equal(snoozeToken(round2), "2026-10-11T04:10:00.000Z");
  assert.equal(snoozeToken({ ...round2, observedTurnEndedAt: T1 }), "2026-10-11T04:10:00.000Z", "the same token before the page saw the round end");
  const snoozed2 = [{ agentId: "h", completionAt: snoozeToken(round2)!, until }];
  assert.equal(isCompletionSnoozed(round2, snoozed2, now), true);
  assert.equal(isCompletionSnoozed(round3, snoozed2, now), false, "the next round's question shows again");
  assert.equal(needsAttention(round3, isCompletionSnoozed(round3, snoozed2, now)), true);
  assert.equal(isCompletionSnoozed(round2, [{ agentId: "h", completionAt: T1, until }], now), false, "a snooze for the first round leaves the second");
  // A prompt after the round started names the turn, as before; a turn that started after the prompt is named by its start.
  assert.equal(snoozeToken({ ...round2, lastUserMessageAt: "2026-10-11T04:10:30.000Z" }), "2026-10-11T04:10:30.000Z");
  assert.equal(snoozeToken({ ...round2, lastUserMessageAt: "2026-10-11T04:09:59.000Z" }), "2026-10-11T04:10:00.000Z");
});

test("usage-only updates do not refresh the page; state, attention, requests and prompts do (opus-F6)", () => {
  const base = { id: "a", status: "running", requiresAttention: false, lastUserMessageAt: T, activeTurn: { startedAt: T }, lastUsage: { inputTokens: 10 } };
  const signature = activitySignature(base);
  assert.equal(activitySignature({ ...base, lastUsage: { inputTokens: 99_000, contextWindowUsedTokens: 1 } }), signature);
  assert.equal(activitySignature({ ...base, updatedAt: "2026-10-11T04:01:00.000Z" }), signature);
  for (const change of [{ status: "idle" }, { requiresAttention: true }, { pendingPermissions: [{}] }, { lastUserMessageAt: "2026-10-11T04:02:00.000Z" }, { archivedAt: T }, { attentionReason: "error" }])
    assert.notEqual(activitySignature({ ...base, ...change }), signature, JSON.stringify(change));
});

test("context pressure from 85 % (high) and 95 % (critical); unknown sizes say nothing (opus-B13)", () => {
  assert.equal(contextPressure({ contextUsed: 84_000, contextTotal: 100_000 }), null);
  assert.deepEqual(contextPressure({ contextUsed: 87_400, contextTotal: 100_000 }), { percent: 87, level: "high" });
  assert.deepEqual(contextPressure({ contextUsed: 95_000, contextTotal: 100_000 }), { percent: 95, level: "critical" });
  assert.deepEqual(contextPressure({ contextUsed: 130_000, contextTotal: 100_000 }), { percent: 100, level: "critical" });
  assert.equal(contextPressure({ contextUsed: null, contextTotal: 100_000 }), null);
  assert.equal(contextPressure({ contextUsed: 10, contextTotal: 0 }), null);
});
