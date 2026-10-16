import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { answeringGuard, createSendLedger, handingOver, registerSendLedger } from "../server/send-ledger";
import { observatoryDeferred } from "../shared/steer";
import { DeferredViewSchema } from "../shared/deferred-rpc";
import { messageKey, quickReplyGroup, quickReplyGuard, quickReplyKey } from "../client/deferred-state";
import { ledgerInput, outgoingMessage, type AgentState } from "../client/send-check";
import { TelemetryStore } from "../server/telemetry";
import { BUILTIN_SEND } from "../shared/steer";
import { ledgerHost } from "./ledger-host";

type Handler = (input: unknown, call: { paseo: unknown }) => unknown;
/** A host context that keeps what is registered on it. */
function fakeHost() {
  const handlers = new Map<string, Handler>(), hooks: string[] = [];
  const host = {
    handle: (contract: { name: string }, handler: Handler) => { handlers.set(contract.name, handler); },
    on: function (this: unknown, name: string) { hooks.push(`${name}:${this === host}`); return () => undefined; },
  };
  return { host: host as unknown as PluginServerContext, handlers, hooks };
}

/** One Agent as the daemon has it, whose sends are recorded; `idle()` ends its turn. */
function daemon() {
  const sent: Array<{ text: string; options: unknown }> = [];
  let agent = { provider: "acp-agent", status: "running", activeTurn: { turnId: "t1" }, pendingPermissions: [] as unknown[], lastUserMessageAt: "2026-10-12T01:00:00.000Z", archivedAt: null as string | null };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { ...agent } }), send: async (text: string, options: unknown) => { sent.push({ text, options }); },
    timeline: { refetch: async () => ({ entries: [] }) } }) } };
  return { paseo, sent, idle() { agent = { ...agent, status: "idle", activeTurn: null as never }; } };
}

test("observatory.deferred.* are registered, and every RPC of the plugin hands the ledger the daemon API first", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-send-ledger-"));
  const ledger = createSendLedger({ file: join(root, "plugin-data", "agent-observatory", "deferred-send.json"), capabilities: () => ({ steerable: [], slashSteerable: [], bases: {} }) });
  try {
    const { host, handlers, hooks } = fakeHost();
    const used: unknown[] = [];
    const server = handingOver(host, { use: paseo => { used.push(paseo); } });
    registerSendLedger(server, ledger);
    assert.deepEqual([...handlers.keys()], ["observatory.deferred.send", "observatory.deferred.enqueue", "observatory.deferred.list", "observatory.deferred.cancel", "observatory.deferred.resume"]);
    assert.deepEqual(Object.values(observatoryDeferred).map(contract => contract.name), [...handlers.keys()]);
    // Any other RPC of the plugin hands it over as well (after a reload the sidebar badge's poll wakes the ledger).
    server.handle({ name: "observatory.attention.get" } as never, (() => "badge") as never);
    const call = { paseo: { marker: "daemon api" } };
    assert.equal(await handlers.get("observatory.attention.get")!({}, call), "badge");
    assert.deepEqual(used, [call.paseo]);
    // Everything else reaches the host context unchanged, called on the context itself.
    server.on("agent.turn_ended" as never, (() => undefined) as never);
    assert.deepEqual(hooks, ["agent.turn_ended:true"]);
  } finally { ledger.stop(); await rm(root, { recursive: true, force: true }); }
});

test("the five calls drive the ledger: a queued message is listed, goes out once the turn ends, and its row reads sent", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-send-ledger-"));
  const ledger = createSendLedger({ file: join(root, "plugin-data", "agent-observatory", "deferred-send.json"), capabilities: () => ({ steerable: [], slashSteerable: [], bases: {} }) });
  try {
    const { host, handlers } = fakeHost(), host2 = daemon();
    registerSendLedger(handingOver(host, ledger), ledger);
    const call = (name: string, input: unknown) => handlers.get(`observatory.deferred.${name}`)!(input, { paseo: host2.paseo });
    const text = "请复查这里", key = messageKey("分析建议", text);
    // Sending now would interrupt the running turn: the server asks first, nothing goes out.
    const asked = await call("send", { agentId: "a", text, messageId: "message-0001", key, source: "分析建议「复查」", what: "消息", consent: null }) as { status: string; consent: unknown };
    assert.deepEqual([asked.status, asked.consent], ["confirm", { interrupt: true, approvals: [], turn: "t1" }]);
    // 「等这一轮结束再发」 instead: queued, listed, and the same text sent now answers with that message.
    const queued = DeferredViewSchema.parse(await call("enqueue", { agentId: "a", text, messageId: "message-0002", key, source: "分析建议「复查」" }));
    assert.equal(queued.state, "queued");
    assert.deepEqual((await call("list", { agentId: "a" }) as Array<{ messageId: string }>).map(view => view.messageId), ["message-0002"]);
    const existing = await call("send", { agentId: "a", text, messageId: "message-0003", key, source: "分析建议「复查」", what: "消息", consent: { interrupt: true, approvals: [], turn: "t1" } }) as { status: string; view: { messageId: string } };
    assert.deepEqual([existing.status, existing.view.messageId], ["existing", "message-0002"]);
    assert.equal(host2.sent.length, 0);
    // The turn ends: the ledger's next look sends it once, with the queued id.
    host2.idle();
    await ledger.flush("a");
    assert.deepEqual(host2.sent, [{ text, options: { activeTurnBehavior: "steer", messageId: "message-0002" } }]);
    assert.equal(((await call("list", { agentId: "a" })) as Array<{ state: string }>)[0]!.state, "sent");
    // Cancel and resume of a message that is gone answer with what it is.
    assert.equal((await call("cancel", { messageId: "message-0002" }) as { state: string } | null)?.state, "sent");
  } finally { ledger.stop(); await rm(root, { recursive: true, force: true }); }
});

// The entry wires the ledger in; loading it would start every store, so its wiring is read from the source.
test("the server entry hands every RPC the ledger, tells it when a turn ends or an approval is answered, and stops it on unload", () => {
  const server = readFileSync(join(__dirname, "..", "index.server.ts"), "utf8");
  // A quick reply's turn is checked against what the plugin observed (codex-obs-attn-R3): the ledger reads the telemetry.
  assert.match(server, /const deferred = createSendLedger\(\{ guard: answeringGuard\(telemetry\) \}\);/);
  assert.ok(server.indexOf("const telemetry = new TelemetryStore();") < server.indexOf("const deferred = createSendLedger("), "the telemetry exists before the ledger");
  assert.equal(server.split("new TelemetryStore(").length, 2, "one telemetry store");
  assert.match(server, /const hub = lifecycleHub\(handingOver\(host, deferred\)\);/);
  assert.match(server, /registerSendLedger\(server, deferred\);/);
  const hook = (name: string) => server.slice(server.indexOf(`server.on("${name}"`), server.indexOf(`server.on("${name}"`) + 400);
  for (const name of ["agent.turn_ended", "agent.permission_resolved"]) assert.match(hook(name), /deferred\.notify\(agent\.id, paseo\);/, name);
  assert.match(server.slice(server.indexOf("return async () => {")), /deferred\.stop\(\);/);
});

// codex-obs-attn-R3: a quick reply names the turn it answers; the server checks it under the Agent's send lock, the way
// `answering` and `sameRound` check it on the client.
const PROMPT = "2026-10-12T01:00:00.000Z", ROUND = "2026-10-12T02:00:00.000Z";
const resting = { provider: "codex", status: "idle", title: "整理发布说明", lastUserMessageAt: PROMPT, activeTurn: null, pendingPermissions: [] };
function turns(started: string | null | (() => never), persistenceError: string | null = null) {
  const reads: string[] = [];
  return { reads, snapshot: async (agentId: string) => { reads.push(agentId); if (typeof started === "function") started(); return { persistenceError, agents: [{ agentId, turnStartedAt: started as string | null }] }; } };
}

test("a quick reply fits only while the Agent rests after the very turn it answers, as the plugin observed it", async () => {
  const guard = quickReplyGuard(PROMPT, ROUND), observed = turns(ROUND), check = answeringGuard(observed);
  assert.equal(await check({ agentId: "a", guard, agent: resting }), null);
  assert.equal(await check({ agentId: "a", guard, agent: { ...resting, status: "closed" } }), null, "not loaded is still resting");
  const NEW = "「整理发布说明」已经开始新的一轮，这条快捷回复不再适用";
  for (const agent of [{ ...resting, lastUserMessageAt: "2026-10-12T03:00:00.000Z" }, { ...resting, activeTurn: { turnId: "t2" } }, { ...resting, status: "running" }]) {
    assert.equal(await check({ agentId: "a", guard, agent }), NEW, JSON.stringify(agent));
  }
  assert.equal(await check({ agentId: "a", guard, agent: { ...resting, status: "error" } }), "「整理发布说明」的状态变了，这条快捷回复不再适用");
  // A heartbeat round since (no message, same prompt): only the plugin's own record shows it.
  assert.equal(await answeringGuard(turns("2026-10-12T04:00:00.000Z"))({ agentId: "a", guard, agent: resting }), "「整理发布说明」之后又跑了一轮，这条快捷回复答的是之前那一轮，不再适用");
  // A record that cannot vouch for the round throws (codex-obs-attn-R3-remaining), as a read that fails does: the ledger sends
  // nothing now (busy) and holds a queued one, it neither drops nor passes it.
  const MISSING = /: 观测台读不到「整理发布说明」最近一轮的记录$/;
  await assert.rejects(answeringGuard(turns(null))({ agentId: "a", guard, agent: resting }), MISSING, "no round in it");
  await assert.rejects(answeringGuard(turns("2026-10-12T01:30:00.000Z"))({ agentId: "a", guard, agent: resting }), MISSING, "only an older round than the reply's");
  await assert.rejects(answeringGuard(turns("not a time"))({ agentId: "a", guard, agent: resting }), MISSING);
  await assert.rejects(answeringGuard({ snapshot: async () => ({ persistenceError: null, agents: [] }) })({ agentId: "a", guard, agent: resting }), MISSING, "no record of the Agent");
  await assert.rejects(answeringGuard({ snapshot: async () => ({ agents: [{ agentId: "b", turnStartedAt: ROUND }] }) })({ agentId: "a", guard, agent: resting }), MISSING, "another Agent's only");
  await assert.rejects(answeringGuard(turns(ROUND, "事件暂时无法写入磁盘，仍在内存里继续记录。"))({ agentId: "a", guard, agent: resting }), /: 观测台的记录暂时有问题，核实不了「整理发布说明」最近一轮$/,
    "the store reports an error: its record may be behind");
  await assert.rejects(answeringGuard(turns(() => { throw new Error("telemetry unavailable"); }))({ agentId: "a", guard, agent: resting }), /telemetry unavailable/);
  // No round to compare (none observed when the reply was shown): the Agent's state decides alone, as on the client.
  const plain = turns(() => { throw new Error("never read"); });
  assert.equal(await answeringGuard(plain)({ agentId: "a", guard: quickReplyGuard(PROMPT, null), agent: resting }), null);
  assert.deepEqual(plain.reads, [], "its record is not even read");
});

test("two devices tap different quick replies of one turn: one goes out through the RPCs, the other answers with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-send-ledger-"));
  const ledger = createSendLedger({ file: join(root, "plugin-data", "agent-observatory", "deferred-send.json"), capabilities: () => ({ steerable: ["codex"], slashSteerable: [], bases: {} }),
    guard: answeringGuard(turns(ROUND)) });
  try {
    const { host, handlers } = fakeHost();
    const sent: string[] = [];
    let agent: Record<string, unknown> = { ...resting };
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { ...agent } }), timeline: { refetch: async () => ({ entries: [] }) },
      send: async (text: string) => { sent.push(text); agent = { ...agent, status: "running", activeTurn: { turnId: "t2" }, lastUserMessageAt: "2026-10-12T05:00:00.000Z" }; } }) } };
    registerSendLedger(handingOver(host, ledger), ledger);
    const call = (input: unknown) => handlers.get("observatory.deferred.send")!(input, { paseo });
    const tap = (text: string, id: string) => ({ agentId: "a", text, messageId: id, key: quickReplyKey(text, PROMPT, ROUND), source: `快捷回复「${text}」`, what: "回复", consent: null,
      group: quickReplyGroup(PROMPT, ROUND), guard: quickReplyGuard(PROMPT, ROUND) });
    const first = await call(tap("继续，按你说的做。", "message-0101")) as { status: string };
    assert.equal(first.status, "sent");
    // The second device's tap reaches the server after the first went out: the turn is answered, by 继续.
    const second = await call(tap("先别动。", "message-0102")) as { status: string; view: { messageId: string; source: string } };
    assert.deepEqual([second.status, second.view.messageId, second.view.source], ["existing", "message-0101", "快捷回复「继续，按你说的做。」"]);
    assert.deepEqual(sent, ["继续，按你说的做。"]);
    // Without a group, a stale reply that reaches the server after the Agent moved on is refused by its guard.
    const stale = await call({ ...tap("先别动。", "message-0103"), group: undefined }) as { status: string; message: string };
    assert.deepEqual([stale.status, stale.message], ["refused", "「整理发布说明」已经开始新的一轮，这条快捷回复不再适用，没有发送。"]);
    assert.equal(sent.length, 1);
  } finally { ledger.stop(); await rm(root, { recursive: true, force: true }); }
});

test("a quick reply bound to a round the plugin's own record can no longer vouch for is never sent and never dropped: the real store rebuilt from a damaged file answers busy, a queued one is held (codex-obs-attn-R3-remaining)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-guard-recovery-"));
  const [T0, T1, T2, T3, T4, T5, T6] = [0, 1, 2, 3, 4, 5, 6].map(hour => `2026-10-13T0${hour}:00:00.000Z`) as [string, string, string, string, string, string, string];
  let now = Date.parse(T2);
  const first = new TelemetryStore({ directory, now: () => now, writeDelayMs: 60_000 });
  let restored: TelemetryStore | undefined;
  let host: Awaited<ReturnType<typeof ledgerHost>> | undefined;
  try {
    // A heartbeat's rounds under one prompt: the reply below answers T2's question; T4's is newer, and saved to disk.
    for (const [turnId, start, end] of [["old-question", T2, T3], ["new-question", T4, T5]] as const) {
      now = Date.parse(start); await first.record({ type: "turn_started", agent: { id: "a", title: "整理发布说明" }, turnId });
      now = Date.parse(end); await first.record({ type: "turn_ended", agent: { id: "a", title: "整理发布说明" }, turnId, outcome: "completed", asks: true });
    }
    assert.equal((await first.snapshot("a")).agents[0]?.turnStartedAt, T4);
    await first.close();
    // The saved history is damaged; the plugin starts again on it.
    await writeFile(join(directory, "telemetry.json"), "[truncated telemetry");
    now = Date.parse(T6);
    restored = new TelemetryStore({ directory, now: () => now, writeDelayMs: 60_000 });
    const recovered = await restored.snapshot("a");
    assert.deepEqual([recovered.agents, typeof recovered.persistenceError], [[], "string"], "restarted empty, and it says so");
    // The host's record of the Agent (its title words the notes).
    host = await ledgerHost({ id: "a", provider: "codex", title: "整理发布说明", status: "idle", lastUserMessageAt: T0, requiresAttention: true, attentionReason: "finished",
      attentionTimestamp: T1, activeTurn: null, pendingPermissions: [] } as AgentState, BUILTIN_SEND, { turns: restored });
    const reply = (text: string, round: string | null = T2) => outgoingMessage("a", text, { what: "回复", source: `快捷回复「${text}」`, key: quickReplyKey(text, T0, round),
      group: quickReplyGroup(T0, round), guard: quickReplyGuard(T0, round) });
    // Sent now: busy, saying why; the host's state alone (idle, the same prompt) would have let it through.
    const direct = await host.deliver({ ...ledgerInput(reply("继续，按你说的做。")), what: "回复", consent: null });
    assert.deepEqual(direct, { status: "busy", message: "没能确认这条消息还适用（观测台的记录暂时有问题，核实不了「整理发布说明」最近一轮），没有发送。请稍后再试。" });
    // Queued for the end of the turn: held, its note says why; 仍然发送 checks again and holds it again.
    const waiting = reply("先别动。"), queued = await host.enqueue(ledgerInput(waiting));
    assert.deepEqual([queued.state, queued.note], ["held", "没能确认这条消息还适用（观测台的记录暂时有问题，核实不了「整理发布说明」最近一轮），没有发送。点「仍然发送」会再检查一次；也可以取消。"]);
    assert.equal((await host.ledger.resume(waiting.messageId, host.server))?.state, "held");
    // Once the store saves again its error clears, but its record still holds no round of this Agent: still unverifiable, for a
    // reply to the newer question too (another turn, so not the held reply's group).
    await restored.record({ type: "turn_started", agent: { id: "other", title: "别的 Agent" }, turnId: "elsewhere" }); await restored.flush();
    assert.equal((await restored.snapshot("a")).persistenceError, null);
    const later = await host.deliver({ ...ledgerInput(reply("继续，按你说的做。", T4)), what: "回复", consent: null });
    assert.deepEqual(later, { status: "busy", message: "没能确认这条消息还适用（观测台读不到「整理发布说明」最近一轮的记录），没有发送。请稍后再试。" });
    assert.equal((await host.ledger.resume(waiting.messageId, host.server))?.state, "held");
    assert.equal(host.delivered.length, 0, "nothing went out on a guess");
    // The Agent's next round, observed (a heartbeat's, under the same prompt): the held reply answers an older one, so it is
    // dropped on its next check.
    now = Date.parse(T6) + 60_000; await restored.record({ type: "turn_started", agent: { id: "a", title: "整理发布说明" }, turnId: "next" });
    const dropped = await host.ledger.resume(waiting.messageId, host.server);
    assert.deepEqual([dropped?.state, dropped?.note], ["discarded", "「整理发布说明」之后又跑了一轮，这条快捷回复答的是之前那一轮，不再适用，没有发送。"]);
    // A reply bound to no round (none was observed when it was shown) keeps to the Agent's own state, as before.
    const plain = await host.deliver({ ...ledgerInput(reply("继续做完。", null)), what: "回复", consent: null });
    assert.equal(plain.status, "sent");
    assert.deepEqual(host.delivered.map(entry => entry.text), ["继续做完。"]);
  } finally { await first.close(); await restored?.close(); await host?.close(); await rm(directory, { recursive: true, force: true }); }
});
