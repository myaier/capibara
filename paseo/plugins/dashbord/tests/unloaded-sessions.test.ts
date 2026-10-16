import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { AttentionIndex } from "../server/attention";
import { CompletionReadController, ReadReceiptStore } from "../server/read-state";
import { TelemetryStore } from "../server/telemetry";
import { enrichAgents } from "../shared/background";
import { needsAttention } from "../shared/dashboard-model";
import { acknowledgement, applyReadReceipt, completionReadState, isUnreadCompletion, knownCompletionAt, normalizeAgent, stopUnseen, type AgentRecord, type AgentSource } from "../shared/model";
import type { MarkCompletionReadInput, ReadReceipt } from "../shared/read-state";
import { turnStop } from "../shared/stop-reason";
import { withinRange } from "../shared/time-range";
import { sessionPhase } from "../shared/attention";
import type { TimelineItem } from "../shared/timeline";

// P2-3 / P2-4 (r1): a session the host has not loaded (status `closed`, as every one is after a daemon restart) with the host's
// attention still raised. Clearing it would load the Agent (a provider process that then stays), and an ACP one cannot be
// loaded again at all ("acp does not support ACP session resume"), so the request fails. 标记已读 and 知道了 there are recorded
// by the plugin alone, and the page reads them as read / seen at once: out of 需要处理, 未读 and the 7-day pin.
const T0 = Date.parse("2026-10-12T08:00:00.000Z"), DAY = 86_400_000, iso = (ms: number) => new Date(ms).toISOString();
const user: TimelineItem = { type: "user_message", text: "继续" };

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "observatory-unloaded-"));
  let now = T0;
  const telemetry = new TelemetryStore({ directory, now: () => now, writeDelayMs: 60_000 });
  const receipts = new ReadReceiptStore({ directory });
  return { directory, telemetry, receipts, at: (ms: number) => { now = ms; }, async dispose() { await telemetry.close(); await receipts.close(); await rm(directory, { recursive: true, force: true }); } };
}
type Scratch = Awaited<ReturnType<typeof scratch>>;

/**
 * The host: `refresh()` reads the Agent's record (it never loads one); `clear_agent_attention` would load it first. On an
 * unloaded ACP Agent that fails, as the daemon's does (`loadable: false`); a loadable one comes back idle with attention cleared.
 */
function host(source: AgentSource & Record<string, unknown>, loadable: boolean) {
  let state: Record<string, unknown> = { activeTurn: null, pendingPermissions: [], ...source };
  const calls: Record<string, unknown>[] = [];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(state), project: null }) }) } } as unknown as PaseoApi;
  const transport = { async request(message: Record<string, unknown>) {
    calls.push(message);
    if (!loadable && state.status === "closed") throw new Error("ensureAgentLoaded: acp does not support ACP session resume");
    state = { ...state, status: state.status === "closed" ? "idle" : state.status, requiresAttention: false, attentionReason: null, attentionTimestamp: null };
    return { agentId: state.id, agents: [structuredClone(state)] };
  } };
  return { paseo, transport, calls, get state() { return state as unknown as AgentSource; } };
}

/** The page's record: the host's entry, the plugin's own observations, then the receipts it keeps (as every view applies them). */
async function page(f: Scratch, source: AgentSource): Promise<AgentRecord> {
  const [agent] = enrichAgents([normalizeAgent(source)], await f.telemetry.snapshot());
  const receipt = (await f.receipts.get(source.id)) ?? undefined;
  return applyReadReceipt(agent!, receipt);
}
/** The sidebar badge's count over the same Agent, with the receipts the server keeps. */
async function badge(f: Scratch, paseo: PaseoApi, source: AgentSource, now: number): Promise<number> {
  const list = async (options: { subscribe?: unknown }) => options.subscribe ? { entries: [], pageInfo: { nextCursor: null, hasMore: false }, subscription: { subscribe(observer: { snapshot(value: unknown): void }) { observer.snapshot({ entries: [] }); return () => {}; }, release: async () => {} } }
    : { entries: [{ agent: source }], pageInfo: { nextCursor: null, hasMore: false } };
  const index = new AttentionIndex({ telemetry: () => f.telemetry.snapshot(), background: () => [], isLive: () => false, receipts: () => f.receipts.snapshot(),
    preferences: async () => ({ snoozes: [], settings: { childCompletions: false } }) }, { now: () => now });
  try {
    await index.attach({ ...paseo, agents: { ...(paseo as unknown as { agents: object }).agents, list }, observeEvents: () => ({ subscribe() { return () => {}; }, release: async () => {} }) } as unknown as PaseoApi);
    return (await index.summary()).count;
  } finally { index.close(); }
}
/** What the detail sends for its 已读 action (client/agent-detail.tsx `acknowledge`). */
function markInput(agent: AgentRecord): MarkCompletionReadInput {
  const kind = acknowledgement(agent), readState = completionReadState(agent);
  const stopAt = kind === "problem" && stopUnseen(agent) ? agent.stop!.at : null;
  const completionAt = kind === "result" || kind === "problem" && readState === "unread" ? knownCompletionAt(agent) : null;
  return { agentId: agent.id, attentionTimestamp: agent.attentionTimestamp ?? null, lastUserMessageAt: agent.lastUserMessageAt,
    ...(kind === "problem" ? { kind: "error" as const, ...(stopAt ? { stopAt } : {}) } : {}), ...(completionAt ? { completionAt } : {}) };
}
const pinned = (agent: AgentRecord, now: number) => withinRange(agent, "7d", now + 30 * DAY);

/** One turn the plugin saw end (as index.server.ts records it), and the host's entry once the daemon restarted: closed, attention kept. */
async function restartedAfter(f: Scratch, id: string, turn: { outcome: "completed" | "failed"; items: TimelineItem[]; error?: string; asks?: boolean }) {
  const agent = { id, title: `会话 ${id}` };
  f.at(T0); await f.telemetry.record({ type: "turn_started", agent, turnId: `${id}-1` });
  const end = T0 + 60_000; f.at(end);
  const stop = turnStop({ outcome: turn.outcome, error: turn.error ?? null, items: turn.items, now: end, hostZone: "UTC" });
  await f.telemetry.record({ type: "turn_ended", agent, turnId: `${id}-1`, outcome: turn.outcome, asks: turn.outcome === "completed" ? turn.asks ?? false : null, stop });
  return { end, source: { id, title: agent.title, status: "closed", createdAt: iso(T0 - DAY), updatedAt: iso(end), lastUserMessageAt: iso(T0), activeTurn: null, pendingPermissions: [],
    requiresAttention: true, attentionReason: turn.outcome === "failed" ? "error" : "finished", attentionTimestamp: iso(end - 5), ...(turn.error ? { lastError: turn.error } : {}) } };
}

test("知道了 on a limit an unloaded session hit: one tap takes it out of 需要处理, 未读 and the pin, loading nothing (P2-3)", async () => {
  const f = await scratch();
  try {
    const { end, source } = await restartedAfter(f, "limited", { outcome: "completed", items: [user, { type: "assistant_message", text: "You've hit your limit · resets 10am (UTC)" }] });
    const before = await page(f, source);
    assert.deepEqual([before.status, before.stop?.kind, acknowledgement(before), isUnreadCompletion(before), needsAttention(before), pinned(before, end)], ["completed", "quota", "problem", true, true, true]);
    const h = host(source, false), now = end + 60_000;
    const controller = new CompletionReadController(f.receipts, h.transport, () => now, f.telemetry);
    const answer = await controller.mark(h.paseo, markInput(before));
    assert.deepEqual([answer.status, answer.message], ["read", "已标记为知道了（会话没有载入，没有为此载入它）。"]);
    assert.equal(h.calls.length, 0, "no clear_agent_attention: it would load the session (and an ACP one cannot load)");
    assert.deepEqual(answer.receipt, { agentId: "limited", completionAt: iso(end - 5), lastUserMessageAt: iso(T0), readAt: iso(now) } satisfies ReadReceipt, "the host's own token");
    const after = await page(f, h.state);
    assert.equal(typeof after.stop?.seenAt, "string");
    assert.deepEqual([completionReadState(after), isUnreadCompletion(after), needsAttention(after), acknowledgement(after), pinned(after, end)], ["read", false, false, null, false],
      "no follow-up 标记已读 that could never finish");
    assert.equal(await badge(f, h.paseo, h.state, now), 0);
    assert.equal(after.requiresAttention, true, "the host's flag itself is left for Paseo (it goes when the session is next loaded)");
  } finally { await f.dispose(); }
});

test("知道了 on a failed turn's limit: seen, no 知道了 again for the same turn's error, out of the pin, nothing loaded (P2-3)", async () => {
  const f = await scratch();
  try {
    const { end, source } = await restartedAfter(f, "failed", { outcome: "failed", items: [user], error: "You've hit your limit · resets 10am (UTC)" });
    const before = await page(f, source);
    assert.deepEqual([before.status, before.stop?.kind, acknowledgement(before), needsAttention(before), pinned(before, end)], ["error", "quota", "problem", true, true]);
    const h = host(source, false), now = end + 60_000;
    const answer = await new CompletionReadController(f.receipts, h.transport, () => now, f.telemetry).mark(h.paseo, markInput(before));
    assert.deepEqual([answer.status, answer.message, h.calls.length, answer.receipt?.completionAt], ["read", "已标记为知道了（会话没有载入，没有为此载入它）。", 0, iso(end - 5)]);
    const after = await page(f, h.state);
    // r1 2′: the error attention is still raised in the host; before, the detail offered 知道了 again (and that one loaded it).
    assert.deepEqual([stopUnseen(after), needsAttention(after), acknowledgement(after), pinned(after, end)], [false, false, null, false]);
    assert.deepEqual([after.status, sessionPhase(after)], ["error", "quota"], "it still says why it stopped");
    assert.equal(await badge(f, h.paseo, h.state, now), 0);
  } finally { await f.dispose(); }
});

test("知道了 on an unloaded session's plain failure: seen and out of the badge, still red, nothing loaded (P2-4)", async () => {
  const f = await scratch();
  try {
    const { end, source } = await restartedAfter(f, "broke", { outcome: "failed", items: [user], error: "spawn ENOENT" });
    const before = await page(f, source);
    assert.deepEqual([before.status, before.stop ?? null, acknowledgement(before), needsAttention(before), pinned(before, end)], ["error", null, "problem", true, true]);
    const h = host(source, false), now = end + 60_000;
    const answer = await new CompletionReadController(f.receipts, h.transport, () => now, f.telemetry).mark(h.paseo, markInput(before));
    assert.deepEqual([answer.status, answer.message, h.calls.length], ["read", "已标记为知道了（会话没有载入，没有为此载入它）。", 0], "before: clear_agent_attention, which an ACP session fails");
    const after = await page(f, h.state);
    assert.deepEqual([needsAttention(after), acknowledgement(after), pinned(after, end), sessionPhase(after)], [false, null, false, "error"]);
    assert.equal(await badge(f, h.paseo, h.state, now), 0);
    // The next failure of a newer prompt needs 知道了 again.
    const newer = await page(f, { ...h.state, lastUserMessageAt: iso(now + 60_000), attentionTimestamp: iso(now + 120_000), updatedAt: iso(now + 120_000) });
    assert.deepEqual([needsAttention(newer), acknowledgement(newer)], [true, "problem"]);
  } finally { await f.dispose(); }
});

test("标记已读 on an unloaded session's unread result: a receipt for the host's token, read at once; loaded ones clear as before (P2-4)", async () => {
  const f = await scratch();
  try {
    const { end, source } = await restartedAfter(f, "done", { outcome: "completed", items: [user, { type: "assistant_message", text: "迁移完成，测试全部通过。" }] });
    const before = await page(f, source);
    assert.deepEqual([acknowledgement(before), isUnreadCompletion(before), needsAttention(before), pinned(before, end)], ["result", true, true, true]);
    const now = end + 60_000, unloaded = host(source, false);
    const answer = await new CompletionReadController(f.receipts, unloaded.transport, () => now, f.telemetry).mark(unloaded.paseo, markInput(before));
    assert.deepEqual([answer.status, answer.message, unloaded.calls.length], ["read", "已标记为已读（会话没有载入，没有为此载入它）。", 0]);
    const after = await page(f, unloaded.state);
    assert.deepEqual([completionReadState(after), isUnreadCompletion(after), needsAttention(after), acknowledgement(after), pinned(after, end)], ["read", false, false, null, false]);
    assert.equal(await badge(f, unloaded.paseo, unloaded.state, now), 0);
    // A token that is not the host's current one is stale, as for a loaded session.
    const stale = await new CompletionReadController(f.receipts, unloaded.transport, () => now, f.telemetry).mark(unloaded.paseo, { ...markInput(before), attentionTimestamp: iso(end - 50) });
    assert.deepEqual([stale.status, unloaded.calls.length], ["stale", 0]);
  } finally { await f.dispose(); }
  // Loaded: cleared in the host and checked again, exactly as before.
  const g = await scratch();
  try {
    const { end, source } = await restartedAfter(g, "loaded", { outcome: "completed", items: [user, { type: "assistant_message", text: "迁移完成。" }] });
    const loaded = host({ ...source, status: "idle" }, false);
    const answer = await new CompletionReadController(g.receipts, loaded.transport, () => end + 60_000, g.telemetry).mark(loaded.paseo, markInput(await page(g, loaded.state)));
    assert.deepEqual([answer.status, answer.message, loaded.calls], ["read", "已标记为已读，并同步到 Paseo。", [{ type: "clear_agent_attention", agentId: "loaded" }]]);
    assert.equal(loaded.state.requiresAttention, false);
  } finally { await g.dispose(); }
});

test("a quick reply about to be sent (rearm) still clears an unloaded session's attention: sending loads it anyway", async () => {
  const f = await scratch();
  try {
    const { end, source } = await restartedAfter(f, "asks", { outcome: "completed", items: [user, { type: "assistant_message", text: "要我继续吗？" }], asks: true });
    const h = host(source, true);
    const answer = await new CompletionReadController(f.receipts, h.transport, () => end + 60_000, f.telemetry)
      .mark(h.paseo, { agentId: "asks", attentionTimestamp: source.attentionTimestamp, lastUserMessageAt: source.lastUserMessageAt, rearm: true });
    assert.deepEqual([answer.status, h.calls.length, h.state.requiresAttention], ["read", 1, false], "so the turn the reply starts is announced when it ends");
  } finally { await f.dispose(); }
});

test("two unread turns on an unloaded session: the receipt names the newer one and the older token it stands for is settled too (codex-F5, P2-4)", async () => {
  const f = await scratch();
  try {
    const agent = { id: "beat", title: "心跳" }, t1 = T0, t2 = T0 + 3_600_000, t3 = t2 + 300_000;
    f.at(t2); await f.telemetry.record({ type: "turn_started", agent, turnId: "second" });
    f.at(t3); await f.telemetry.record({ type: "turn_ended", agent, turnId: "second", outcome: "completed", asks: false });
    // The host still names the first, unread completion (edge-triggered); the daemon restarted since.
    const source = { id: "beat", title: "心跳", status: "closed", createdAt: iso(T0 - DAY), updatedAt: iso(t3), lastUserMessageAt: iso(t2), activeTurn: null, pendingPermissions: [],
      requiresAttention: true, attentionReason: "finished", attentionTimestamp: iso(t1) };
    const before = await page(f, source);
    assert.deepEqual([completionReadState(before), knownCompletionAt(before), acknowledgement(before)], ["unread", iso(t3), "result"]);
    const h = host(source, false), now = t3 + 60_000;
    const answer = await new CompletionReadController(f.receipts, h.transport, () => now, f.telemetry).mark(h.paseo, markInput(before));
    assert.deepEqual([answer.status, answer.receipt?.completionAt, h.calls.length], ["read", iso(t3), 0]);
    const after = await page(f, h.state);
    assert.deepEqual([completionReadState(after), needsAttention(after), pinned(after, t3)], ["read", false, false]);
    assert.equal(await badge(f, h.paseo, h.state, now), 0);
    // A third completion later is unread again: the receipt names the second only.
    f.at(t3 + 600_000); await f.telemetry.record({ type: "turn_started", agent, turnId: "third" });
    f.at(t3 + 900_000); await f.telemetry.record({ type: "turn_ended", agent, turnId: "third", outcome: "completed", asks: false });
    const third = await page(f, { ...source, lastUserMessageAt: iso(t3 + 600_000), updatedAt: iso(t3 + 900_000) });
    assert.deepEqual([completionReadState(third), needsAttention(third)], ["unread", true]);
  } finally { await f.dispose(); }
});

test("标记已读 on an unloaded session's 待回复: the question counts as opened until a newer prompt, and stays 待回复 (P2-4)", async () => {
  const f = await scratch();
  try {
    const { end, source } = await restartedAfter(f, "question", { outcome: "completed", items: [user, { type: "assistant_message", text: "两个方案都写好了，要我按方案 A 推进吗？" }], asks: true });
    const before = await page(f, source);
    assert.deepEqual([before.status, acknowledgement(before), needsAttention(before), pinned(before, end)], ["idle", "question", true, true]);
    const h = host(source, false), now = end + 60_000;
    const answer = await new CompletionReadController(f.receipts, h.transport, () => now, f.telemetry).mark(h.paseo, markInput(before));
    assert.deepEqual([answer.status, answer.message, h.calls.length], ["read", "已标记为已读（会话没有载入，没有为此载入它）。", 0]);
    const after = await page(f, h.state);
    assert.deepEqual([after.status, needsAttention(after), acknowledgement(after), pinned(after, end)], ["idle", false, null, false]);
    assert.equal(await badge(f, h.paseo, h.state, now), 0);
    // Another prompt since (the host's flag is still the old one, edge-triggered): the receipt no longer applies.
    const asked = { ...h.state, lastUserMessageAt: iso(now + 60_000), updatedAt: iso(now + 120_000) };
    f.at(now + 60_000); await f.telemetry.record({ type: "turn_started", agent: { id: "question", title: "会话 question" }, turnId: "question-2" });
    f.at(now + 120_000); await f.telemetry.record({ type: "turn_ended", agent: { id: "question", title: "会话 question" }, turnId: "question-2", outcome: "completed", asks: true });
    const again = await page(f, asked);
    assert.deepEqual([again.status, needsAttention(again), acknowledgement(again)], ["idle", true, "question"]);
  } finally { await f.dispose(); }
});

// codex-obs-attn-F1: heartbeats as 0.11.1 runs them. Each starts its turn with a system notification: no user message, so
// lastUserMessageAt stays at the user's prompt, and the host's attention keeps the first unread stamp (edge-triggered). The
// daemon restarted since: the session is unloaded (closed), so 标记已读 records a receipt here and clears nothing there.
test("heartbeat rounds on an unloaded session: each receipt names its own round's end; an older round's claim is stale (codex-obs-attn-F1)", async () => {
  const f = await scratch();
  try {
    const agent = { id: "beat", title: "心跳" }, t1 = T0 + 60_000, t2 = T0 + 3_600_000, t3 = t2 + 300_000, t4 = t3 + 3_600_000, t5 = t4 + 300_000;
    const turn = async (turnId: string, start: number, end: number) => {
      f.at(start); await f.telemetry.record({ type: "turn_started", agent, turnId });
      f.at(end); await f.telemetry.record({ type: "turn_ended", agent, turnId, outcome: "completed", asks: false });
    };
    await turn("prompted", T0, t1);
    await turn("heartbeat-1", t2, t3);
    const source = { id: "beat", title: "心跳", status: "closed", createdAt: iso(T0 - DAY), updatedAt: iso(t3), lastUserMessageAt: iso(T0), activeTurn: null, pendingPermissions: [],
      requiresAttention: true, attentionReason: "finished", attentionTimestamp: iso(t1 - 5) };
    const before = await page(f, source);
    assert.deepEqual([completionReadState(before), knownCompletionAt(before), acknowledgement(before), needsAttention(before)], ["unread", iso(t3), "result", true]);
    const h = host(source, false);
    const answer = await new CompletionReadController(f.receipts, h.transport, () => t3 + 60_000, f.telemetry).mark(h.paseo, markInput(before));
    assert.deepEqual([answer.status, answer.message, answer.receipt?.completionAt, h.calls.length], ["read", "已标记为已读（会话没有载入，没有为此载入它）。", iso(t3), 0], "before: the receipt named the first round's stamp");
    const after = await page(f, h.state);
    assert.deepEqual([completionReadState(after), needsAttention(after), acknowledgement(after), pinned(after, t3)], ["read", false, null, false]);
    assert.equal(await badge(f, h.paseo, h.state, t3 + 60_000), 0);
    assert.equal(after.requiresAttention, true, "the host's flag (still the first stamp) stays for Paseo");

    // The next heartbeat: a new result, unread again; the host's prompt and stamp are still the same.
    await turn("heartbeat-2", t4, t5);
    const latest = { ...source, updatedAt: iso(t5) };
    const third = await page(f, latest);
    assert.deepEqual([third.lastUserMessageAt, third.attentionTimestamp], [before.lastUserMessageAt, before.attentionTimestamp]);
    assert.deepEqual([completionReadState(third), knownCompletionAt(third), acknowledgement(third), needsAttention(third)], ["unread", iso(t5), "result", true]);
    assert.equal(await badge(f, h.paseo, latest, t5 + 60_000), 1);
    const later = host(latest, false), controller = new CompletionReadController(f.receipts, later.transport, () => t5 + 60_000, f.telemetry);
    // A page still showing the earlier round: its end is no longer the latest, nothing is recorded.
    const stale = await controller.mark(later.paseo, markInput(before));
    assert.deepEqual([stale.status, later.calls.length, (await f.receipts.get("beat"))?.completionAt], ["stale", 0, iso(t3)]);
    const read = await controller.mark(later.paseo, markInput(third));
    assert.deepEqual([read.status, read.receipt?.completionAt, later.calls.length], ["read", iso(t5), 0]);
    assert.deepEqual([completionReadState(await page(f, latest)), await badge(f, later.paseo, latest, t5 + 60_000)], ["read", 0]);
  } finally { await f.dispose(); }
});
