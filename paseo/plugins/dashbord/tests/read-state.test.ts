import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { markCompletionRead, mergeReadReceipts, type MarkCompletionReadInput, type ReadReceipt } from "../shared/read-state";
import { CompletionReadController, ReadReceiptStore } from "../server/read-state";
import { TelemetryStore } from "../server/telemetry";
import { enrichAgents } from "../shared/background";
import { acknowledgement, applyArchiveReadOrigin, applyReadReceipt, completionReadState, knownCompletionAt, normalizeAgent, type AgentSource } from "../shared/model";

const completed = "2026-09-17T12:10:00.000Z";
const prompted = "2026-09-17T12:00:00.000Z";
const readAt = "2026-09-17T12:12:00.000Z";
const input: MarkCompletionReadInput = { agentId: "a", attentionTimestamp: completed, lastUserMessageAt: prompted };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { state?: Record<string, unknown>; beforeClear?: (controller: CompletionReadController, state: Record<string, unknown>) => void;
  postRead?: (controller: CompletionReadController, state: Record<string, unknown>) => void; gate?: Promise<void>; failure?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-read-state-"));
  const store = new ReadReceiptStore({ directory });
  const state: Record<string, unknown> = { id: "a", status: "idle", archivedAt: null, activeTurn: null, pendingPermissions: [],
    requiresAttention: true, attentionReason: "finished", attentionTimestamp: completed, lastUserMessageAt: prompted, ...options.state };
  let reads = 0; const calls: Record<string, unknown>[] = [];
  const controller = new CompletionReadController(store, { async request(message, responseType) {
    calls.push(message); assert.equal(responseType, "clear_agent_attention_response");
    await options.gate;
    if (options.failure) throw new Error("offline");
    options.beforeClear?.(controller, state);
    state.requiresAttention = false; state.attentionReason = null; state.attentionTimestamp = null;
    return { agentId: "a", agents: [structuredClone(state)] };
  } }, () => Date.parse(readAt));
  const paseo = { agents: { ref(id: string) { assert.equal(id, "a"); return { async refresh() {
    reads++; if (reads > 1) options.postRead?.(controller, state);
    return { agent: structuredClone(state), project: null };
  } }; } } } as unknown as PaseoApi;
  return { directory, store, controller, paseo, state, calls,
    async close() { await controller.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("confirmed native single-agent read persists completion proof after both snapshots", async () => {
  const f = await fixture();
  try {
    const result = await f.controller.mark(f.paseo, input);
    assert.equal(result.status, "read");
    assert.deepEqual(f.calls, [{ type: "clear_agent_attention", agentId: "a" }]);
    assert.equal(f.state.requiresAttention, false); assert.equal(f.state.attentionTimestamp, null);
    assert.deepEqual(result.receipt, { agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt });
    const persisted = JSON.parse(await readFile(join(f.directory, "read-receipts.json"), "utf8"));
    assert.equal(persisted.version, 2); assert.deepEqual(persisted.receipts, [result.receipt]);
    assert.equal((await stat(join(f.directory, "read-receipts.json"))).mode & 0o777, 0o600);
  } finally { await f.close(); }
});
test("stale completion or prompt token never clears current native state", async () => {
  for (const patch of [{ attentionTimestamp: "2026-09-17T12:11:00.000Z" }, { lastUserMessageAt: "2026-09-17T12:09:00.000Z" }]) {
    const f = await fixture({ state: patch });
    try { const result = await f.controller.mark(f.paseo, input); assert.equal(result.status, "stale"); assert.equal(f.calls.length, 0); assert.equal((await f.store.snapshot()).receipts.length, 0); }
    finally { await f.close(); }
  }
});
test("running, pending-permission, archived and new-error sessions cannot be marked complete-read", async () => {
  for (const state of [{ status: "running" }, { activeTurn: { turnId: "next" } }, { pendingPermissions: [{ id: "approval" }] },
    { attentionReason: "permission" }, { archivedAt: completed }, { status: "error" }]) {
    const f = await fixture({ state });
    try { assert.equal((await f.controller.mark(f.paseo, input)).status, "stale"); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  }
});
test("explicit native already-read and unknown attention state are no-op", async () => {
  for (const state of [{ requiresAttention: false, attentionReason: null, attentionTimestamp: null }, { requiresAttention: undefined }]) {
    const f = await fixture({ state });
    try { assert.equal((await f.controller.mark(f.paseo, input)).status, "not_unread"); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  }
});
test("lifecycle race during clear returns stale without a new persisted receipt", async () => {
  const f = await fixture({ beforeClear(controller) { controller.bump("a"); } });
  try { assert.equal((await f.controller.mark(f.paseo, input)).status, "stale"); assert.equal((await f.store.snapshot()).receipts.length, 0); }
  finally { await f.close(); }
});
test("a newer completion in postcheck remains unread and has no matching old receipt", async () => {
  const f = await fixture({ postRead(controller, state) { controller.bump("a"); state.requiresAttention = true; state.attentionReason = "finished"; state.attentionTimestamp = "2026-09-17T12:11:00.000Z"; } });
  try {
    const result = await f.controller.mark(f.paseo, input); assert.equal(result.status, "stale");
    assert.equal(f.state.requiresAttention, true); assert.equal((await f.store.snapshot()).receipts.length, 0);
  } finally { await f.close(); }
});
test("native clear failure never publishes an optimistic read receipt", async () => {
  const f = await fixture({ failure: true });
  try { const result = await f.controller.mark(f.paseo, input); assert.equal(result.status, "failed"); assert.match(result.message, /offline/); assert.equal(f.state.requiresAttention, true); assert.equal((await f.store.snapshot()).receipts.length, 0); }
  finally { await f.close(); }
});
test("repeated clicks deduplicate one native clear and a later no-op preserves receipt", async () => {
  const gate = deferred(); const f = await fixture({ gate: gate.promise });
  try {
    const first = f.controller.mark(f.paseo, input), second = f.controller.mark(f.paseo, input);
    gate.resolve(); const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b); assert.equal(f.calls.length, 1);
    const already = await f.controller.mark(f.paseo, input); assert.equal(already.status, "not_unread"); assert.deepEqual(already.receipt, a.receipt); assert.equal(f.calls.length, 1);
  } finally { gate.resolve(); await f.close(); }
});
test("receipt storage is bounded, reloadable and contains only timestamps and IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-receipts-store-"));
  const store = new ReadReceiptStore({ directory, limit: 2 });
  try {
    for (let index = 0; index < 3; index++) await store.record({ agentId: `agent-${index}`, completionAt: completed, lastUserMessageAt: prompted,
      readAt: `2026-09-17T12:1${index}:00.000Z`, prompt: "MUST_NOT_PERSIST", title: "MUST_NOT_PERSIST" } as ReadReceipt);
    assert.equal((await store.snapshot()).receipts.length, 2);
    assert.equal((await store.snapshot()).receipts.some(row => row.agentId === "agent-0"), false);
    const content = await readFile(join(directory, "read-receipts.json"), "utf8"); assert.equal(content.includes("MUST_NOT_PERSIST"), false);
    const reloaded = new ReadReceiptStore({ directory }); assert.equal((await reloaded.snapshot()).receipts.length, 2); await reloaded.close();
    assert.deepEqual(await readdir(directory), ["read-receipts.json"]);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test("older late acknowledgement cannot overwrite a newer completion receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-receipts-order-")); const store = new ReadReceiptStore({ directory });
  try {
    await store.record({ agentId: "a", completionAt: "2026-09-17T12:11:00.000Z", lastUserMessageAt: prompted, readAt });
    await store.record({ agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt });
    assert.equal((await store.get("a"))?.completionAt, "2026-09-17T12:11:00.000Z");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test("corrupt receipt storage reports error and preserves original on next successful save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-receipts-corrupt-"));
  await writeFile(join(directory, "read-receipts.json"), "{invalid"); const store = new ReadReceiptStore({ directory });
  try {
    assert.ok((await store.snapshot()).error); await store.record({ agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt });
    const files = await readdir(directory); assert.ok(files.some(name => name.endsWith(".backup")));
    assert.equal((await store.snapshot()).error, null);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("archive origins are bounded and survive reload independently of read receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-archive-origins-"));
  const store = new ReadReceiptStore({ directory, limit: 2 });
  try {
    await store.recordArchiveOrigin({ agentId: "a", archivedAt: "2026-09-17T12:13:00Z", lastUserMessageAt: prompted });
    await store.recordArchiveOrigin({ agentId: "b", archivedAt: "2026-09-17T12:14:00Z", lastUserMessageAt: null });
    await store.recordArchiveOrigin({ agentId: "c", archivedAt: "2026-09-17T12:15:00Z", lastUserMessageAt: prompted });
    assert.deepEqual((await store.snapshot()).archiveOrigins.map(origin => origin.agentId), ["c", "b"]);
    assert.equal((await store.snapshot()).receipts.length, 0, "archival metadata must never fabricate a read receipt");
    const reloaded = new ReadReceiptStore({ directory });
    assert.equal((await reloaded.snapshot()).archiveOrigins.length, 2); await reloaded.close();
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy receipt files migrate and repeated archive hooks retain the known prompt timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-archive-migration-"));
  const receipt = { agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt };
  await writeFile(join(directory, "read-receipts.json"), JSON.stringify({ version: 1, receipts: [receipt] }));
  const store = new ReadReceiptStore({ directory });
  try {
    assert.equal((await store.snapshot()).receipts.length, 1); assert.equal((await store.snapshot()).archiveOrigins.length, 0);
    await store.recordArchiveOrigin({ agentId: "a", archivedAt: readAt, lastUserMessageAt: prompted });
    await store.recordArchiveOrigin({ agentId: "a", archivedAt: readAt, lastUserMessageAt: null });
    assert.equal((await store.snapshot()).archiveOrigins[0]?.lastUserMessageAt, prompted);
    assert.equal(JSON.parse(await readFile(join(directory, "read-receipts.json"), "utf8")).version, 2);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("receipt reads short-circuit until a receipt or archive origin changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-receipts-revision-"));
  const store = new ReadReceiptStore({ directory });
  try {
    const first = await store.read();
    assert.equal(first.mode, "full");
    const same = await store.read(first.revision);
    assert.equal(same.mode, "unchanged"); assert.ok(JSON.stringify(same).length < 90);
    assert.deepEqual(mergeReadReceipts(mergeReadReceipts(undefined, first), same), mergeReadReceipts(undefined, first));
    await store.record({ agentId: "a", completionAt: "2026-09-16T12:00:00.000Z", lastUserMessageAt: null, readAt: "2026-09-16T12:01:00.000Z" });
    const receipt = await store.read(first.revision);
    assert.equal(receipt.mode, "full"); assert.ok(receipt.mode === "full" && receipt.receipts.length === 1);
    await store.recordArchiveOrigin({ agentId: "b", archivedAt: "2026-09-16T12:02:00.000Z", lastUserMessageAt: null });
    assert.equal((await store.read(receipt.revision)).mode, "full");
    const reloaded = new ReadReceiptStore({ directory });
    assert.equal((await reloaded.read((await store.read()).revision)).mode, "unchanged", "content revisions survive a plugin reload");
    await reloaded.close();
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

// codex-F5: two unread completions in a row. T1 finished and nobody looked; a heartbeat prompted again at T2; that turn
// finished at T3. Paseo's attention is edge-triggered, so it still names T1. The receipt must name T3, the completion the
// page shows as unread, or archiving (which clears attention) leaves nothing that proves the user read it.
test("two unread turns → 标记已读 → archive → receipts read back from disk → restore: read all the way (codex-F5)", async () => {
  const t0 = "2026-10-12T00:00:00.000Z", t1 = "2026-10-12T01:00:00.000Z", t2 = "2026-10-12T02:00:00.000Z", t3 = "2026-10-12T03:00:00.000Z";
  const t4 = "2026-10-12T04:00:00.000Z", t5 = "2026-10-12T05:00:00.000Z";
  const directory = await mkdtemp(join(tmpdir(), "observatory-read-twice-"));
  let clock = Date.parse(t2);
  const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  const store = new ReadReceiptStore({ directory });
  let host: Record<string, unknown> = { id: "beat", provider: "codex", status: "idle", createdAt: t0, lastUserMessageAt: t2, updatedAt: t3, activeTurn: null, pendingPermissions: [],
    requiresAttention: true, attentionReason: "finished", attentionTimestamp: t1 };
  const calls: Record<string, unknown>[] = [];
  const controller = new CompletionReadController(store, { async request(message) {
    calls.push(message); host = { ...host, requiresAttention: false, attentionReason: null, attentionTimestamp: null };
    return { agentId: "beat", agents: [structuredClone(host)] };
  } }, () => Date.parse(t4), telemetry);
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(host), project: null }) }) } } as unknown as PaseoApi;
  try {
    await telemetry.record({ type: "turn_started", agent: { id: "beat", title: "心跳" }, turnId: "second" });
    clock = Date.parse(t3); await telemetry.record({ type: "turn_ended", agent: { id: "beat", title: "心跳" }, turnId: "second", outcome: "completed", asks: false });
    const page = async (source: Record<string, unknown>) => enrichAgents([normalizeAgent(source as unknown as AgentSource)], await telemetry.snapshot())[0]!;
    const unread = await page(host);
    assert.equal(completionReadState(unread), "unread");
    assert.equal(knownCompletionAt(unread), t3, "the page shows the newer completion");
    assert.equal(acknowledgement(unread), "result");
    const answer = await controller.mark(paseo, { agentId: "beat", attentionTimestamp: unread.attentionTimestamp!, lastUserMessageAt: unread.lastUserMessageAt, completionAt: knownCompletionAt(unread)! });
    assert.equal(answer.status, "read");
    assert.equal(calls.length, 1, "the host's own token T1 is what gets cleared");
    assert.deepEqual(answer.receipt, { agentId: "beat", completionAt: t3, lastUserMessageAt: t2, readAt: t4 });
    assert.equal(completionReadState(applyReadReceipt(await page(host), answer.receipt)), "read");
    await controller.close();

    // Archive (Paseo clears attention again and writes updatedAt), then read the receipts back from disk as a restart would.
    const archived = { ...host, status: "closed", archivedAt: t5, updatedAt: t5 };
    const reloaded = new ReadReceiptStore({ directory });
    await reloaded.recordArchiveOrigin({ agentId: "beat", archivedAt: t5, lastUserMessageAt: t2 });
    const saved = await reloaded.snapshot();
    const receipt = saved.receipts.find(item => item.agentId === "beat")!, origin = saved.archiveOrigins.find(item => item.agentId === "beat")!;
    const shown = applyReadReceipt(applyArchiveReadOrigin(await page(archived), origin), receipt);
    assert.equal(completionReadState(shown), "read", "archived: the receipt still proves the read");
    assert.equal(shown.completionReadFor, t3);
    // 恢复会话: the Agent is listed again, attention still clear; the archive origin keeps native false from proving anything.
    const restored = applyReadReceipt(applyArchiveReadOrigin(await page({ ...host, updatedAt: t5 }), origin), receipt);
    assert.equal(completionReadState(restored), "read", "restored: read");
    await reloaded.close();
  } finally { await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a receipt's completion is verified: old clients keep the host's token, a claim the server did not observe is stale (codex-F5)", async () => {
  const t1 = "2026-10-12T01:00:00.000Z", t2 = "2026-10-12T02:00:00.000Z", t3 = "2026-10-12T03:00:00.000Z";
  type Observed = { agentId: string; outcome: "completed" | "failed" | "canceled" | null; turnEndedAt: string | null; stop: null };
  const observedEnd: Observed = { agentId: "a", outcome: "completed", turnEndedAt: t3, stop: null };
  const telemetry = (agents: Observed[]) => ({ snapshot: async () => ({ agents }), ackStop: async () => false });
  async function attempt(state: Record<string, unknown>, input: MarkCompletionReadInput, observed: Observed[]) {
    const directory = await mkdtemp(join(tmpdir(), "observatory-read-claim-"));
    const store = new ReadReceiptStore({ directory }), calls: Record<string, unknown>[] = [];
    let host: Record<string, unknown> = { id: "a", status: "idle", activeTurn: null, pendingPermissions: [], requiresAttention: true, attentionReason: "finished", ...state };
    const controller = new CompletionReadController(store, { async request(message) { calls.push(message); host = { ...host, requiresAttention: false, attentionReason: null, attentionTimestamp: null }; return { agentId: "a", agents: [structuredClone(host)] }; } },
      () => Date.parse("2026-10-12T04:00:00.000Z"), telemetry(observed));
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(host), project: null }) }) } } as unknown as PaseoApi;
    try { return { answer: await controller.mark(paseo, input), calls }; }
    finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
  }
  const edge = { attentionTimestamp: t1, lastUserMessageAt: t2 };
  // An older client sends no completionAt: the host's token, as before.
  assert.equal((await attempt(edge, { agentId: "a", ...edge }, [observedEnd])).answer.receipt?.completionAt, t1);
  // A claim the server observed differently (another end, or none) is stale, and native attention is left alone.
  for (const observed of [[{ ...observedEnd, turnEndedAt: "2026-10-12T03:30:00.000Z" }], [{ ...observedEnd, outcome: "failed" }], []] as Observed[][]) {
    const { answer, calls } = await attempt(edge, { agentId: "a", ...edge, completionAt: t3 }, observed);
    assert.deepEqual([answer.status, calls.length], ["stale", 0], JSON.stringify(observed));
  }
  // Nor before the prompt, nor in the future.
  assert.equal((await attempt(edge, { agentId: "a", ...edge, completionAt: "2026-10-12T01:30:00.000Z" }, [{ ...observedEnd, turnEndedAt: "2026-10-12T01:30:00.000Z" }])).answer.status, "stale");
  assert.equal((await attempt(edge, { agentId: "a", ...edge, completionAt: "2026-10-12T05:00:00.000Z" }, [{ ...observedEnd, turnEndedAt: "2026-10-12T05:00:00.000Z" }])).answer.status, "stale");
  // When the host's token belongs to the latest prompt it stays the token, whatever the client claims.
  const current = { attentionTimestamp: t3, lastUserMessageAt: t2 };
  assert.equal((await attempt(current, { agentId: "a", ...current, completionAt: "2026-10-12T03:00:00.050Z" }, [observedEnd])).answer.receipt?.completionAt, t3);
});

test("知道了 on a stop: recorded on the stop without native attention, alongside clearing it with; never on another stop (opus-F34)", async () => {
  const prompt = "2026-10-12T02:00:00.000Z", stopAt = "2026-10-12T02:05:00.000Z", ended = "2026-10-12T02:04:59.990Z";
  async function attempt(state: Record<string, unknown>, input: MarkCompletionReadInput, observedStop: { kind: "unfinished" | "quota"; resetAt: null; at: string; closedMidTurn?: boolean } | null, wired = true) {
    const directory = await mkdtemp(join(tmpdir(), "observatory-read-stop-"));
    const store = new ReadReceiptStore({ directory }), calls: Record<string, unknown>[] = [], acks: string[] = [];
    let host: Record<string, unknown> = { id: "a", status: "closed", activeTurn: null, pendingPermissions: [], lastUserMessageAt: prompt, requiresAttention: false, attentionReason: null, attentionTimestamp: null, ...state };
    const telemetry = { snapshot: async () => ({ agents: [{ agentId: "a", outcome: null, turnEndedAt: null, stop: observedStop }] }), ackStop: async (_id: string, at: string) => { acks.push(at); return at === observedStop?.at; } };
    const controller = new CompletionReadController(store, { async request(message) { calls.push(message); host = { ...host, requiresAttention: false, attentionReason: null, attentionTimestamp: null }; return { agentId: "a", agents: [structuredClone(host)] }; } },
      () => Date.parse("2026-10-12T03:00:00.000Z"), wired ? telemetry : undefined);
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(host), project: null }) }) } } as unknown as PaseoApi;
    try { return { answer: await controller.mark(paseo, input), calls, acks, receipts: (await store.snapshot()).receipts.length }; }
    finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
  }
  const closed = { kind: "unfinished" as const, resetAt: null, at: stopAt, closedMidTurn: true };
  const ack: MarkCompletionReadInput = { agentId: "a", attentionTimestamp: null, lastUserMessageAt: prompt, kind: "error", stopAt };
  // A turn the host closed mid-way: no attention to clear, so it is recorded on the stop (and nothing is loaded).
  let run = await attempt({}, ack, closed);
  assert.deepEqual([run.answer.status, run.answer.message, run.calls.length, run.acks, run.receipts], ["read", "已标记为知道了。", 0, [stopAt], 0]);
  // Another stop than the one observed now: stale, nothing recorded.
  run = await attempt({}, { ...ack, stopAt: "2026-10-12T02:06:00.000Z" }, closed);
  assert.deepEqual([run.answer.status, run.calls.length, run.acks], ["stale", 0, []]);
  run = await attempt({}, ack, null);
  assert.deepEqual([run.answer.status, run.acks], ["stale", []], "the stop is gone (a new turn)");
  // A newer prompt since: stale before anything else.
  run = await attempt({ lastUserMessageAt: "2026-10-12T02:30:00.000Z" }, ack, closed);
  assert.deepEqual([run.answer.status, run.acks], ["stale", []]);
  // A turn's end with the host's attention (a limit, completed): cleared as before, and recorded on the stop as well.
  const limit = { kind: "quota" as const, resetAt: null, at: stopAt };
  run = await attempt({ status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: ended }, { ...ack, attentionTimestamp: ended }, limit);
  assert.deepEqual([run.answer.status, run.answer.message, run.calls.length, run.acks, run.receipts], ["read", "已标记为知道了，并同步到 Paseo。", 1, [stopAt], 0]);
  // The host closed (unloaded) the Agent after raising attention: clearing it would load the Agent (an ACP one cannot be loaded at
  // all, so the request fails), so the stop is recorded here and the host is not asked. Its finished turn's result is seen
  // with it: a receipt for the host's token (P2-3).
  run = await attempt({ status: "closed", requiresAttention: true, attentionReason: "finished", attentionTimestamp: ended }, { ...ack, attentionTimestamp: ended }, { ...closed });
  assert.deepEqual([run.answer.status, run.answer.message, run.calls.length, run.acks, run.receipts], ["read", "已标记为知道了（会话没有载入，没有为此载入它）。", 0, [stopAt], 1]);
  assert.equal(run.answer.receipt?.completionAt, ended);
  // A failed turn's: the receipt names its error token, which the page reads as seen (it has no result to read).
  run = await attempt({ status: "closed", requiresAttention: true, attentionReason: "error", attentionTimestamp: ended }, { ...ack, attentionTimestamp: ended }, limit);
  assert.deepEqual([run.answer.status, run.calls.length, run.acks, run.receipts, run.answer.receipt?.completionAt], ["read", 0, [stopAt], 1, ended]);
  run = await attempt({ status: "closed", requiresAttention: true, attentionReason: "finished", attentionTimestamp: ended }, { ...ack, attentionTimestamp: ended, stopAt: "2026-10-12T02:06:00.000Z" }, limit);
  assert.deepEqual([run.answer.status, run.calls.length, run.acks], ["stale", 0, []], "another stop than the observed one");
  // Without telemetry wired the old behaviour stays: native attention only.
  run = await attempt({}, ack, closed, false);
  assert.deepEqual([run.answer.status, run.calls.length], ["not_unread", 0]);
  // Older clients and closed stops both parse: attentionTimestamp may be null, completionAt and stopAt are optional.
  assert.equal(markCompletionRead.input.safeParse({ agentId: "a", attentionTimestamp: ended, lastUserMessageAt: null }).success, true);
  assert.equal(markCompletionRead.input.safeParse(ack).success, true);
});

test("标记已读 on an Agent the host has not loaded: checked against the host's token, recorded here, never cleared there (P2-4)", async () => {
  // The host keeps attention on an unloaded session; clearing it would load the session (the transport records any clear).
  const unloaded = await fixture({ state: { status: "closed" } });
  try {
    const answer = await unloaded.controller.mark(unloaded.paseo, input);
    assert.deepEqual([answer.status, answer.message, unloaded.calls.length], ["read", "已标记为已读（会话没有载入，没有为此载入它）。", 0]);
    assert.deepEqual(answer.receipt, { agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt });
    assert.equal(unloaded.state.requiresAttention, true, "the host's flag stays for Paseo to clear when the session is next loaded");
    assert.deepEqual((await unloaded.store.snapshot()).receipts, [answer.receipt]);
  } finally { await unloaded.close(); }
  // The same preconditions as a loaded one: another token or prompt, a running or waiting session, are stale and record nothing.
  for (const patch of [{ attentionTimestamp: "2026-09-17T12:11:00.000Z" }, { lastUserMessageAt: "2026-09-17T12:09:00.000Z" }, { activeTurn: { turnId: "next" } }, { pendingPermissions: [{ id: "p" }] }]) {
    const f = await fixture({ state: { status: "closed", ...patch } });
    try { const answer = await f.controller.mark(f.paseo, input); assert.deepEqual([answer.status, f.calls.length, (await f.store.snapshot()).receipts.length], ["stale", 0, 0], JSON.stringify(patch)); }
    finally { await f.close(); }
  }
  // A quick reply about to go out (`rearm`) loads the Agent to send anyway: its attention is cleared first, as before.
  const f = await fixture({ state: { status: "closed" } });
  try {
    const answer = await f.controller.mark(f.paseo, { ...input, rearm: true });
    assert.deepEqual([answer.status, answer.message, f.calls.length, f.state.requiresAttention], ["read", "已标记为已读，并同步到 Paseo。", 1, false]);
  } finally { await f.close(); }
});

// codex-obs-attn-F1: the real 0.11.1 heartbeat shape. Its turn starts with a system notification, which records no user
// message (lastUserMessageAt stays T0), and while the first result is unread the host's attention keeps T1 (edge-triggered).
// Before, the server kept that stamp as the token (it is not older than the prompt) and stored the receipt for T1.
test("a heartbeat's turn: 标记已读 stores the receipt for its observed end though the prompt and the host's stamp stay; an older round's claim is stale (codex-obs-attn-F1)", async () => {
  const [t0, t1, t2, t3, t4] = [0, 1, 2, 3, 4].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
  const directory = await mkdtemp(join(tmpdir(), "observatory-read-heartbeat-"));
  let clock = Date.parse(t0);
  const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  const store = new ReadReceiptStore({ directory });
  let host: Record<string, unknown> = { id: "beat", provider: "fixture", status: "idle", createdAt: "2026-10-11T23:00:00.000Z", lastUserMessageAt: t0, updatedAt: t3, activeTurn: null, pendingPermissions: [],
    requiresAttention: true, attentionReason: "finished", attentionTimestamp: t1 };
  const calls: Record<string, unknown>[] = [];
  const controller = new CompletionReadController(store, { async request(message) {
    calls.push(message); host = { ...host, requiresAttention: false, attentionReason: null, attentionTimestamp: null };
    return { agentId: "beat", agents: [structuredClone(host)] };
  } }, () => Date.parse(t4), telemetry);
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(host), project: null }) }) } } as unknown as PaseoApi;
  const turn = async (turnId: string, start: string, end: string) => {
    clock = Date.parse(start); await telemetry.record({ type: "turn_started", agent: { id: "beat", title: "心跳" }, turnId });
    clock = Date.parse(end); await telemetry.record({ type: "turn_ended", agent: { id: "beat", title: "心跳" }, turnId, outcome: "completed", asks: false });
  };
  try {
    await turn("first", "2026-10-12T00:00:00.020Z", "2026-10-12T01:00:00.005Z");
    await turn("heartbeat", t2, t3);
    const page = enrichAgents([normalizeAgent(host as unknown as AgentSource)], await telemetry.snapshot())[0]!;
    assert.deepEqual([page.lastUserMessageAt, page.attentionTimestamp, completionReadState(page), knownCompletionAt(page), acknowledgement(page)], [t0, t1, "unread", t3, "result"]);
    const mark = (completionAt?: string) => controller.mark(paseo, { agentId: "beat", attentionTimestamp: t1, lastUserMessageAt: t0, ...(completionAt ? { completionAt } : {}) });
    // A page still showing the first round claims the host's stamp; another end is no better: stale, nothing cleared or stored.
    for (const claim of [t1, "2026-10-12T01:00:00.005Z", "2026-10-12T02:30:00.000Z"]) {
      const answer = await mark(claim);
      assert.deepEqual([answer.status, answer.message, calls.length, (await store.snapshot()).receipts.length], ["stale", "完成结果已有更新，请刷新后再标记已读。", 0, 0], claim);
    }
    const answer = await mark(knownCompletionAt(page)!);
    assert.deepEqual([answer.status, calls.length], ["read", 1], "the host's own (older) stamp is what gets cleared");
    assert.deepEqual(answer.receipt, { agentId: "beat", completionAt: t3, lastUserMessageAt: t0, readAt: t4 });
    const reloaded = new ReadReceiptStore({ directory });
    assert.deepEqual((await reloaded.snapshot()).receipts, [answer.receipt], "on disk"); await reloaded.close();
    assert.equal(completionReadState(applyReadReceipt(enrichAgents([normalizeAgent(host as unknown as AgentSource)], await telemetry.snapshot())[0]!, answer.receipt)), "read");
  } finally { await controller.close(); await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("codex repro (attn-F1): the receipt names the observed end whether the prompt moved (codex-F5) or a heartbeat left it; older clients keep the host's stamp", async () => {
  const [t0, t1, t2, t3, t4] = [0, 1, 2, 3, 4].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
  type Observed = { agentId: string; outcome: "completed" | "failed" | "canceled" | null; turnStartedAt?: string | null; turnEndedAt: string | null; stop: null };
  async function receipt(userAt: string, observed: Observed, claim: "page" | "none" = "page") {
    const directory = await mkdtemp(join(tmpdir(), "observatory-read-repro-"));
    let host: Record<string, unknown> = { id: "a", provider: "fixture", status: "idle", createdAt: "2026-10-11T23:00:00.000Z", lastUserMessageAt: userAt, updatedAt: t3, requiresAttention: true, attentionReason: "finished", attentionTimestamp: t1, pendingPermissions: [], activeTurn: null };
    const page = enrichAgents([normalizeAgent(host as unknown as AgentSource)], { startedAt: t0, persistenceError: null, events: [], agents: [{ completedTurns: 2, failedTurns: 0, canceledTurns: 0, totalRunMs: 0, permissionWaitMs: 0, turnStartedAt: null, ...observed }] })[0]!;
    const controller = new CompletionReadController(new ReadReceiptStore({ directory }), { async request() { host = { ...host, requiresAttention: false, attentionReason: null, attentionTimestamp: null }; return { agentId: "a", agents: [structuredClone(host)] }; } },
      () => Date.parse(t4), { snapshot: async () => ({ agents: [observed] }), ackStop: async () => false });
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(host) }) }) } } as unknown as PaseoApi;
    try { return { shown: knownCompletionAt(page), answer: await controller.mark(paseo, { agentId: "a", attentionTimestamp: t1, lastUserMessageAt: userAt, ...(claim === "page" ? { completionAt: knownCompletionAt(page)! } : {}) }) }; }
    finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
  }
  const heartbeatTurn: Observed = { agentId: "a", outcome: "completed", turnStartedAt: t2, turnEndedAt: t3, stop: null };
  // codex's repro: lastUserMessageAt T0, attention T1, observed T2 → T3. Before: shown T1, stored T1.
  let run = await receipt(t0, heartbeatTurn);
  assert.deepEqual([run.shown, run.answer.status, run.answer.receipt?.completionAt], [t3, "read", t3]);
  // The original codex-F5 shape (the prompt moved to T2) still stores T3.
  run = await receipt(t2, heartbeatTurn);
  assert.deepEqual([run.shown, run.answer.status, run.answer.receipt?.completionAt], [t3, "read", t3]);
  // An older client sends no claim: the host's stamp, as before.
  run = await receipt(t0, heartbeatTurn, "none");
  assert.deepEqual([run.answer.status, run.answer.receipt?.completionAt], ["read", t1]);
  // Telemetry without a start (an end whose start the plugin missed): only a newer prompt retires the stamp, as before.
  run = await receipt(t0, { ...heartbeatTurn, turnStartedAt: null });
  assert.deepEqual([run.shown, run.answer.receipt?.completionAt], [t1, t1]);
});

test("one turn: the host's stamp stays the receipt's token though the plugin observed the turn's start and end (codex-obs-attn-F1)", async () => {
  const prompt = "2026-10-12T02:00:00.000Z", native = "2026-10-12T03:00:00.000Z";
  const observed = { agentId: "a", outcome: "completed" as const, turnStartedAt: "2026-10-12T02:00:00.030Z", turnEndedAt: "2026-10-12T03:00:00.006Z", stop: null };
  for (const completionAt of [native, observed.turnEndedAt]) {
    const directory = await mkdtemp(join(tmpdir(), "observatory-read-one-"));
    let host: Record<string, unknown> = { id: "a", status: "idle", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: native, pendingPermissions: [], activeTurn: null };
    const controller = new CompletionReadController(new ReadReceiptStore({ directory }), { async request() { host = { ...host, requiresAttention: false, attentionReason: null, attentionTimestamp: null }; return { agentId: "a", agents: [structuredClone(host)] }; } },
      () => Date.parse("2026-10-12T04:00:00.000Z"), { snapshot: async () => ({ agents: [observed] }), ackStop: async () => false });
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(host) }) }) } } as unknown as PaseoApi;
    try {
      const answer = await controller.mark(paseo, { agentId: "a", attentionTimestamp: native, lastUserMessageAt: prompt, completionAt });
      assert.deepEqual([answer.status, answer.receipt?.completionAt], ["read", native], completionAt);
    } finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
