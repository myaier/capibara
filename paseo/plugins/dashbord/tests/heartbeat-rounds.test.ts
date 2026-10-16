import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { CompletionReadController, ReadReceiptStore } from "../server/read-state";
import { registerResults } from "../server/results";
import { TelemetryStore } from "../server/telemetry";
import { enrichAgents } from "../shared/background";
import { acknowledgement, applyReadReceipt, completionReadState, knownCompletionAt, normalizeAgent, observedRound, sameResultSource, type AgentRecord, type AgentSource } from "../shared/model";
import type { AgentResult } from "../shared/results";

// codex-obs-attn-F1, end to end with the plugin's own stores. Paseo 0.11.1 starts a heartbeat's turn with a system notification
// (schedule/service.js): no user message, so lastUserMessageAt stays at the user's prompt, and while the first result is unread
// the host's attention keeps its first stamp (agent-manager.js `checkAndSetAttention`, edge-triggered). Before, the detail kept
// one result cache entry for every round, the result's source passed every round's 标记已读 check, and the receipt named the
// first stamp.

const detail = readFileSync(join(__dirname, "..", "client", "agent-detail.tsx"), "utf8");
/** The detail's result cache key (client/agent-detail.tsx, checked below). */
const resultKey = (agent: AgentRecord) => ["observatory-result", agent.id, agent.lastUserMessageAt, knownCompletionAt(agent), observedRound(agent)];

test("the detail caches results by round and marks read only a result read for its record's own turn (codex-obs-attn-F1)", () => {
  assert.match(detail, /const resultKey = \["observatory-result", agent\.id, agent\.lastUserMessageAt, knownCompletionAt\(agent\), observedRound\(agent\)\];/);
  assert.match(detail, /if \(ackKind !== "problem" && !unreadable && \(!result\.data \|\| !sameResultSource\(agent, result\.data\.source\)\)\) \{ toast\.show\("结果正在更新，请等最新回复载入后再标记"\); void result\.refetch\(\); return; \}/);
  // What was acknowledged here is remembered per round too: the next heartbeat's result is offered 标记已读 again.
  assert.match(detail, /const attentionKey = `\$\{agent\.attentionTimestamp \?\? ""\}:\$\{agent\.lastUserMessageAt \?\? ""\}:\$\{agent\.stop\?\.at \?\? ""\}:\$\{observedRound\(agent\) \?\? ""\}`;/);
  assert.match(detail, /ackKind === "result" \|\| ackKind === "problem" && readState === "unread" \? knownCompletionAt\(agent\) : null/, "the mark names the completion the page shows");
});

test("heartbeat rounds end to end: a new cache entry, the earlier round's result refused, the latest one read and marked by its own end (codex-obs-attn-F1)", async () => {
  const [t0, t1, t2, t3, t4, t5, t6] = [0, 1, 2, 3, 4, 5, 6].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
  const directory = await mkdtemp(join(tmpdir(), "observatory-heartbeat-rounds-"));
  let clock = Date.parse(t0);
  const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  const receipts = new ReadReceiptStore({ directory });
  // The host: loaded and idle, the user's prompt at T0 and the first, unread completion at T1, both kept through the heartbeats.
  let host: Record<string, unknown> = { id: "beat", title: "每小时巡检", provider: "fixture", status: "idle", createdAt: "2026-10-11T23:00:00.000Z", lastUserMessageAt: t0, updatedAt: t1,
    activeTurn: null, pendingPermissions: [], requiresAttention: true, attentionReason: "finished", attentionTimestamp: t1 };
  let reply = "第一轮：构建正常";
  const clears: Record<string, unknown>[] = [];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(host) }), current: () => structuredClone(host),
    timeline: { refetch: async () => ({ epoch: "e", window: { minSeq: 1 }, hasOlder: false, hasNewer: false, rows: [
      { seqStart: 1, seqEnd: 1, timestamp: t0, item: { type: "user_message", text: "每小时检查一次构建" } }, { seqStart: 2, seqEnd: 2, timestamp: String(host.updatedAt), item: { type: "assistant_message", text: reply } }] }) } }) } } as unknown as PaseoApi;
  // The plugin's server as index.server.ts wires it: results read the observed turn, 标记已读 checks against it.
  const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>>();
  const server = { handle(contract: { name: string }, handler: (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>) { handlers.set(contract.name, handler); return () => {}; },
    on() { return () => {}; } } as unknown as Parameters<typeof registerResults>[0];
  const removeResults = registerResults(server, async id => (await telemetry.snapshot(id)).agents[0] ?? null);
  const controller = new CompletionReadController(receipts, { async request(message) {
    clears.push(message); host = { ...host, requiresAttention: false, attentionReason: null, attentionTimestamp: null };
    return { agentId: "beat", agents: [structuredClone(host)] };
  } }, () => clock, telemetry);
  const turn = async (turnId: string, start: string, end: string, text: string) => {
    clock = Date.parse(start); await telemetry.record({ type: "turn_started", agent: { id: "beat", title: "每小时巡检" }, turnId });
    clock = Date.parse(end); reply = text; host = { ...host, updatedAt: end }; await telemetry.record({ type: "turn_ended", agent: { id: "beat", title: "每小时巡检" }, turnId, outcome: "completed", asks: false });
  };
  /** The page's record, as the dashboard derives it: the host's entry, the plugin's observations, the receipts it keeps. */
  const page = async () => applyReadReceipt(enrichAgents([normalizeAgent(host as unknown as AgentSource)], await telemetry.snapshot())[0]!, await receipts.get("beat"));
  /** What the detail requests for a record (the same request every round: the host's tokens do not change). */
  const fetchResult = async (agent: AgentRecord) => await handlers.get("observatory.results.get")!({ agentId: agent.id, expectedLastUserMessageAt: agent.lastUserMessageAt, expectedAttentionTimestamp: agent.attentionTimestamp ?? null }, { paseo }) as AgentResult;
  try {
    await turn("prompted", "2026-10-12T00:00:00.020Z", "2026-10-12T01:00:00.005Z", "第一轮：构建正常");
    const first = await page(), firstResult = await fetchResult(first);
    assert.deepEqual([knownCompletionAt(first), completionReadState(first), sameResultSource(first, firstResult.source)], [t1, "unread", true]);

    // A heartbeat runs while the first result is unread: nothing the host keeps changes.
    await turn("heartbeat-1", t2, t3, "第二轮：发现一个失败用例");
    const second = await page();
    assert.deepEqual([second.lastUserMessageAt, second.attentionTimestamp], [t0, t1]);
    assert.deepEqual([knownCompletionAt(second), completionReadState(second), acknowledgement(second)], [t3, "unread", "result"]);
    assert.notDeepEqual(resultKey(second), resultKey(first), "a new cache entry: the first round's result is not shown for the second");
    assert.equal(sameResultSource(second, firstResult.source), false, "and if it were on screen, 标记已读 would wait for the second round's");
    const secondResult = await fetchResult(second);
    assert.deepEqual([secondResult.latestReply?.text, sameResultSource(second, secondResult.source)], ["第二轮：发现一个失败用例", true], "the same request, read again for the new turn");

    // 标记已读 sends what the detail sends: the completion the page shows. The receipt names the second round's end.
    clock = Date.parse(t4);
    const answer = await controller.mark(paseo, { agentId: "beat", attentionTimestamp: t1, lastUserMessageAt: t0, completionAt: knownCompletionAt(second)! });
    assert.deepEqual([answer.status, answer.receipt?.completionAt, clears.length], ["read", t3, 1]);
    assert.equal(completionReadState(await page()), "read");

    // The next heartbeat: the host raises a fresh stamp now that its attention was cleared; a new round, unread, its own entry.
    await turn("heartbeat-2", t5, t6, "第三轮：失败用例已修复");
    host = { ...host, requiresAttention: true, attentionReason: "finished", attentionTimestamp: t6 };
    const third = await page();
    assert.deepEqual([knownCompletionAt(third), completionReadState(third), observedRound(third)], [t6, "unread", null], "the host's tokens name it again");
    assert.equal(sameResultSource(third, secondResult.source), false);
    const thirdResult = await fetchResult(third);
    assert.deepEqual([thirdResult.latestReply?.text, sameResultSource(third, thirdResult.source)], ["第三轮：失败用例已修复", true]);
  } finally { removeResults(); await controller.close(); await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});

// codex-obs-attn-R2: a heartbeat round that ends asking the user (待回复) is marked read with no completion to name, and the
// host's prompt and attention tokens stay as they were. The page names the round it shows; the server checks it is still the
// latest one it observed, before it clears anything or keeps a receipt, for a loaded session and one the host has not loaded.
test("待回复 is marked read for the round the page shows: a page left on an earlier heartbeat question is stale, loaded or not (codex-obs-attn-R2)", async () => {
  const [T0, T1, T2, T3, T4, T5, T6] = [0, 1, 2, 3, 4, 5, 6].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
  for (const status of ["idle", "closed"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "observatory-question-rounds-"));
    let clock = Date.parse(T2!), clears = 0;
    const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
    const receipts = new ReadReceiptStore({ directory });
    let raw: Record<string, unknown> = { id: "ask", provider: "fixture", status, createdAt: T0, lastUserMessageAt: T0, updatedAt: T3, requiresAttention: true, attentionReason: "finished",
      attentionTimestamp: T1, activeTurn: null, pendingPermissions: [] };
    const controller = new CompletionReadController(receipts, { request: async () => { clears++; raw = { ...raw, requiresAttention: false, attentionTimestamp: null, attentionReason: null }; return { agentId: "ask", agents: [raw] }; } },
      () => clock, telemetry);
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(raw) }) }) } } as unknown as PaseoApi;
    const round = async (turnId: string, start: string, end: string) => {
      clock = Date.parse(start); await telemetry.record({ type: "turn_started", agent: { id: "ask", title: "检查发布" }, turnId });
      clock = Date.parse(end); raw = { ...raw, updatedAt: end }; await telemetry.record({ type: "turn_ended", agent: { id: "ask", title: "检查发布" }, turnId, outcome: "completed", asks: true });
    };
    const page = async () => enrichAgents([normalizeAgent(raw as unknown as AgentSource)], await telemetry.snapshot())[0]!;
    /** The request client/agent-detail.tsx sends for 待回复 (checked against its source below). */
    const mark = (agent: AgentRecord) => controller.mark(paseo, { agentId: agent.id, attentionTimestamp: agent.attentionTimestamp ?? null, lastUserMessageAt: agent.lastUserMessageAt,
      round: { startedAt: agent.observedTurnStartedAt ?? null, endedAt: agent.observedTurnEndedAt ?? null } });
    try {
      await round("second", T2!, T3!);
      const earlier = await page();
      assert.deepEqual([earlier.status, acknowledgement(earlier), completionReadState(earlier)], ["idle", "question", "not_completed"], status);
      // The next heartbeat round asks again; the host's tokens are those the earlier page holds.
      await round("third", T4!, T5!);
      const latest = await page();
      assert.deepEqual([latest.attentionTimestamp, latest.lastUserMessageAt, acknowledgement(latest)], [earlier.attentionTimestamp, earlier.lastUserMessageAt, "question"]);
      clock = Date.parse(T6!);
      const stale = await mark(earlier);
      assert.deepEqual([stale.status, clears, (await receipts.snapshot()).receipts.length], ["stale", 0, 0], `${status}: nothing cleared, no receipt for the earlier round`);
      assert.match(stale.message, /又跑了一轮/);
      // A round under way on the server is another round too.
      clock = Date.parse(T6!) + 60_000; await telemetry.record({ type: "turn_started", agent: { id: "ask", title: "检查发布" }, turnId: "fourth" });
      assert.equal((await mark(latest)).status, "stale", `${status}: the page has not seen the round now going`);
      clock += 60_000; raw = { ...raw, updatedAt: new Date(clock).toISOString() }; await telemetry.record({ type: "turn_ended", agent: { id: "ask", title: "检查发布" }, turnId: "fourth", outcome: "completed", asks: true });
      const newest = await page();
      const read = await mark(newest);
      assert.equal(read.status, "read", status);
      if (status === "idle") assert.equal(clears, 1, "the loaded session's attention is cleared");
      else {
        // Not loaded: nothing cleared (that would load it); the receipt marks this round's question seen, and only this round's.
        assert.equal(clears, 0);
        assert.equal(applyReadReceipt(newest, read.receipt).requiresAttention, false);
        await round("fifth", new Date(clock + 60_000).toISOString(), new Date(clock + 120_000).toISOString());
        assert.equal(applyReadReceipt(await page(), read.receipt).requiresAttention, true, "the next round asks again");
      }
    } finally { await controller.close(); await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("the detail names the round of a question it marks read, and reads the turns again when the server says stale (codex-obs-attn-R2)", () => {
  assert.match(detail, /const round = ackKind === "question" \? \{ startedAt: agent\.observedTurnStartedAt \?\? null, endedAt: agent\.observedTurnEndedAt \?\? null \} : null;/);
  assert.match(detail, /\.\.\.\(completionAt \? \{ completionAt \} : \{\}\), \.\.\.\(round \? \{ round \} : \{\}\) \}\);/);
  assert.match(detail, /if \(answer\.status === "stale"\) void queryCache\.invalidateQueries\(\{ queryKey: telemetryQueryKey\(hostId\) \}\);/);
});

// codex-obs-attn-R4: a quick reply's rearm names the round it answers by its start. The server clears the attention only while
// that round is the latest it observed: a heartbeat round since (same host tokens), a record it cannot read or has not got
// clear nothing, so a question nobody has seen keeps 需要处理.
test("a quick reply's rearm clears only while its round is the latest; an unreadable or missing record clears nothing (codex-obs-attn-R4)", async () => {
  const [T0, T1, T2, T3, T4, T5, T6] = [0, 1, 2, 3, 4, 5, 6].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
  const directory = await mkdtemp(join(tmpdir(), "observatory-rearm-rounds-"));
  let clock = Date.parse(T2!), clears = 0;
  const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  const receipts = new ReadReceiptStore({ directory });
  let raw: Record<string, unknown> = { id: "ask", provider: "fixture", status: "idle", createdAt: T0, lastUserMessageAt: T0, updatedAt: T3, requiresAttention: true, attentionReason: "finished",
    attentionTimestamp: T1, activeTurn: null, pendingPermissions: [] };
  const transport = { request: async () => { clears++; raw = { ...raw, requiresAttention: false, attentionTimestamp: null, attentionReason: null }; return { agentId: "ask", agents: [raw] }; } };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(raw) }) }) } } as unknown as PaseoApi;
  const round = async (turnId: string, start: string, end: string) => {
    clock = Date.parse(start); await telemetry.record({ type: "turn_started", agent: { id: "ask", title: "检查发布" }, turnId });
    clock = Date.parse(end); raw = { ...raw, updatedAt: end }; await telemetry.record({ type: "turn_ended", agent: { id: "ask", title: "检查发布" }, turnId, outcome: "completed", asks: true });
  };
  /** What client/send-check.ts `clearingAttention` sends for a reply to the round that started at `start`. */
  const rearm = (start: string) => ({ agentId: "ask", attentionTimestamp: T1!, lastUserMessageAt: T0!, rearm: true, round: { startedAt: start } });
  const controller = new CompletionReadController(receipts, transport, () => clock, telemetry);
  try {
    await round("question", T2!, T3!);
    // Without the plugin's own record nothing tells the rounds apart; one that cannot be read tells nothing either.
    assert.equal((await new CompletionReadController(receipts, transport, () => clock).mark(paseo, rearm(T2!))).status, "stale");
    const unreadable = { snapshot: async () => { throw new Error("telemetry unavailable"); }, ackStop: async () => false };
    assert.equal((await new CompletionReadController(receipts, transport, () => clock, unreadable).mark(paseo, rearm(T2!))).status, "failed");
    // A heartbeat round asked again since: the reply's round is not the latest, its attention stays.
    await round("heartbeat", T4!, T5!);
    clock = Date.parse(T6!);
    assert.equal((await controller.mark(paseo, rearm(T2!))).status, "stale");
    assert.deepEqual([clears, raw.requiresAttention], [0, true], "nothing cleared so far");
    // A reply to that latest round: cleared, as before.
    assert.equal((await controller.mark(paseo, rearm(T4!))).status, "read");
    assert.deepEqual([clears, raw.requiresAttention], [1, false]);
  } finally { await controller.close(); await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});

// codex-obs-attn-R3-remaining: while the plugin's own store reports an error its record may be behind, so a round named then
// cannot be checked against it; the reply's own check sends nothing then (server/send-ledger.ts), and nothing is cleared for it.
test("a round named while the plugin's own store reports an error clears nothing, a quick reply's rearm or 待回复's 标记已读 (codex-obs-attn-R4, R3-remaining)", async () => {
  const [T0, T1, T2, T3] = [0, 1, 2, 3].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
  const directory = await mkdtemp(join(tmpdir(), "observatory-rearm-store-error-"));
  // The saved history is damaged: the store starts again empty and reports it until it saves again.
  await writeFile(join(directory, "telemetry.json"), "[truncated telemetry");
  let clock = Date.parse(T2!), clears = 0;
  const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  const receipts = new ReadReceiptStore({ directory });
  let raw: Record<string, unknown> = { id: "ask", provider: "fixture", status: "idle", createdAt: T0, lastUserMessageAt: T0, updatedAt: T3, requiresAttention: true, attentionReason: "finished",
    attentionTimestamp: T1, activeTurn: null, pendingPermissions: [] };
  const transport = { request: async () => { clears++; raw = { ...raw, requiresAttention: false, attentionTimestamp: null, attentionReason: null }; return { agentId: "ask", agents: [raw] }; } };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(raw) }) }) } } as unknown as PaseoApi;
  const controller = new CompletionReadController(receipts, transport, () => clock, telemetry);
  try {
    // A round seen since: the record names it, and the store still reports the history it could not read.
    await telemetry.record({ type: "turn_started", agent: { id: "ask", title: "检查发布" }, turnId: "question" });
    clock = Date.parse(T3!); await telemetry.record({ type: "turn_ended", agent: { id: "ask", title: "检查发布" }, turnId: "question", outcome: "completed", asks: true });
    const snapshot = await telemetry.snapshot("ask");
    assert.deepEqual([snapshot.agents[0]?.turnStartedAt, typeof snapshot.persistenceError], [T2, "string"]);
    const rearm = await controller.mark(paseo, { agentId: "ask", attentionTimestamp: T1!, lastUserMessageAt: T0!, rearm: true, round: { startedAt: T2! } });
    assert.deepEqual([rearm.status, rearm.message], ["failed", "观测台的记录暂时有问题，核实不了这一轮，本次未标记已读；请稍后再试。"]);
    const question = await controller.mark(paseo, { agentId: "ask", attentionTimestamp: T1!, lastUserMessageAt: T0!, round: { startedAt: T2!, endedAt: T3! } });
    assert.equal(question.status, "failed");
    assert.deepEqual([clears, raw.requiresAttention, (await receipts.snapshot()).receipts.length], [0, true, 0], "nothing cleared, no receipt");
    // Saved again, the store's error clears: that round is the latest it observed, and the reply's rearm clears it.
    await telemetry.flush();
    assert.equal((await telemetry.snapshot("ask")).persistenceError, null);
    assert.equal((await controller.mark(paseo, { agentId: "ask", attentionTimestamp: T1!, lastUserMessageAt: T0!, rearm: true, round: { startedAt: T2! } })).status, "read");
    assert.deepEqual([clears, raw.requiresAttention], [1, false]);
  } finally { await controller.close(); await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});
