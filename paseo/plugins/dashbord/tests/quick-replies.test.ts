import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QUICK_REPLIES, REPLY_NUDGES, quickReplyText } from "../shared/reply";
import { answering, attentionToClear, checkFits, clearingAttention, createSendRefused, isSendRefused, ledgerInput, outgoingMessage, sameRound, sendChecked, type AgentState, type SendHooks } from "../client/send-check";
import { quickReplyGroup, quickReplyGuard, quickReplyKey } from "../client/deferred-state";
import { CompletionReadController, ReadReceiptStore } from "../server/read-state";
import { TelemetryStore } from "../server/telemetry";
import type { PaseoApi } from "../server/paseo-types";
import { BUILTIN_SEND } from "../shared/steer";
import { ledgerHost, type LedgerHost } from "./ledger-host";

const finished: AgentState = { provider: "my-claude", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-10-12T01:00:00.000Z",
  lastUserMessageAt: "2026-10-12T00:58:00.000Z", activeTurn: null, pendingPermissions: [] };

test("each kind of reply offers to go on and to hold, and the button text is exactly what is sent", () => {
  assert.deepEqual(QUICK_REPLIES["go-ahead"].map(reply => reply.text), ["继续，按你说的做", "先别动"]);
  assert.deepEqual(QUICK_REPLIES["keep-going"].map(reply => reply.text), ["继续做完", "先别动"]);
  for (const nudge of REPLY_NUDGES) {
    assert.ok(QUICK_REPLIES[nudge].length >= 2 && QUICK_REPLIES[nudge].length <= 3, nudge);
    for (const reply of QUICK_REPLIES[nudge]) assert.equal(quickReplyText(reply), `${reply.text}。`);
    // Going on is green and re-arms the host's notification for the work it starts; holding is amber and does not.
    assert.deepEqual(QUICK_REPLIES[nudge].map(reply => [reply.tone, reply.rearm]), [["green", true], ["amber", false]]);
  }
});

// The default Hermes evaluator has no classes: a refusal is a plain Error with a tag, and only the tag identifies it.
test("a refused send is a tagged plain Error, recognised by its tag alone", () => {
  const refused = createSendRefused("已经开始新的一轮");
  assert.ok(refused instanceof Error);
  assert.equal(refused.name, "SendRefused");
  assert.equal(refused.message, "已经开始新的一轮");
  assert.equal(isSendRefused(refused), true);
  for (const other of [new Error("已经开始新的一轮"), Object.assign(new Error("x"), { name: "SendRefused" }), { sendRefused: "yes" }, { sendRefused: false }, null, undefined, "SendRefused"])
    assert.equal(isSendRefused(other), false, String(other));
  // The tag alone decides, whichever copy of the module made the error.
  assert.equal(isSendRefused({ message: "m", sendRefused: true }), true);
});

test("only a finished turn's attention that is still raised is cleared before the reply", () => {
  assert.deepEqual(attentionToClear(finished), { attentionTimestamp: "2026-10-12T01:00:00.000Z", lastUserMessageAt: "2026-10-12T00:58:00.000Z" });
  assert.deepEqual(attentionToClear({ ...finished, status: "closed" }), { attentionTimestamp: "2026-10-12T01:00:00.000Z", lastUserMessageAt: "2026-10-12T00:58:00.000Z" }, "not loaded is still a finished turn");
  for (const agent of [
    { ...finished, requiresAttention: false }, { ...finished, attentionReason: "error" as const }, { ...finished, attentionTimestamp: null },
    { ...finished, status: "running" as const, activeTurn: { turnId: "t" } }, { ...finished, pendingPermissions: [{ id: "p" }] }, { ...finished, archivedAt: "2026-10-12T02:00:00.000Z" },
    { ...finished, status: "error" as const },
  ]) assert.equal(attentionToClear(agent), null, JSON.stringify(agent));
});

/**
 * A host where a quick reply goes, through the plugin's real ledger (tests/ledger-host.ts): what was read, cleared and sent,
 * in order. `whileClearing` changes the Agent while its attention is being cleared (the round trips a mark takes).
 */
async function host(state: AgentState, whileClearing?: (state: AgentState) => Partial<AgentState>) {
  const fake = await ledgerHost(state);
  const cleared: unknown[] = [];
  const clear = async (input: unknown) => { fake.log.push("clear"); cleared.push(input); if (whileClearing) fake.set(whileClearing(fake.state!)); };
  return Object.assign(fake, { cleared, clear });
}
/** What reached the host besides reads: the clears and the sends. */
const sends = (log: string[]) => log.filter(step => step === "clear" || step === "send");
const reply = (text: string) => outgoingMessage("a", text, { what: "回复", source: "快捷回复", key: quickReplyKey(text, finished.lastUserMessageAt, null) });
const answered = (result: Awaited<ReturnType<typeof sendChecked>>) => { assert.ok("answered" in result, "the ledger answered"); return result.answered; };

/** What QuickReplies passes: bound to the turn that ended after the prompt sent at `finished.lastUserMessageAt`. */
const quick = (fake: LedgerHost & { clear: (input: unknown) => Promise<void> }, rearm = true): SendHooks => ({ expect: answering(finished.lastUserMessageAt, "整理发布说明"), ...(rearm ? { beforeSend: clearingAttention(fake.clear, "a") } : {}) });
const NEW_TURN = "「整理发布说明」已经开始新的一轮，这条快捷回复不再适用。";

test("a quick reply to a finished turn clears its attention first, then sends the button text with one message id", async () => {
  const fake = await host(finished);
  try {
    const message = reply(quickReplyText(QUICK_REPLIES["keep-going"][0]!));
    const result = await sendChecked(fake.client, message, BUILTIN_SEND, fake.deliver, null, quick(fake));
    assert.deepEqual([answered(result).status, "plan" in result && result.plan.kind], ["sent", "send"], "an idle Agent just receives it");
    assert.deepEqual(fake.log, ["read", "clear", "read", "server-read", "send"], "read again after clearing, then the server reads and sends");
    // `rearm`: sending loads an unloaded Agent anyway, so the server clears its attention too.
    assert.deepEqual(fake.cleared, [{ agentId: "a", attentionTimestamp: "2026-10-12T01:00:00.000Z", lastUserMessageAt: "2026-10-12T00:58:00.000Z", rearm: true }]);
    assert.deepEqual(fake.delivered, [{ text: "继续做完。", options: { activeTurnBehavior: "interrupt", messageId: message.messageId } }]);
  } finally { await fake.close(); }
  // Read already (待回复 opened earlier): nothing to clear, the reply still goes.
  const read = await host({ ...finished, requiresAttention: false });
  try {
    assert.equal(answered(await sendChecked(read.client, reply("先别动。"), BUILTIN_SEND, read.deliver, null, quick(read))).status, "sent");
    assert.deepEqual(sends(read.log), ["send"]);
  } finally { await read.close(); }
});

test("clearing is best effort: a failed clear never stops the reply", async () => {
  const fake = await host(finished);
  try {
    const failing = async () => { fake.log.push("clear"); throw new Error("read-state store unavailable"); };
    assert.equal(answered(await sendChecked(fake.client, reply("继续，按你说的做。"), BUILTIN_SEND, fake.deliver, null, { expect: answering(finished.lastUserMessageAt, "整理发布说明"), beforeSend: clearingAttention(failing, "a") })).status, "sent");
    assert.deepEqual(sends(fake.log), ["clear", "send"]);
  } finally { await fake.close(); }
});

// P1-1: a quick reply answers the turn it was shown under. One sent into another turn (a heartbeat's, one started from another
// device) reads as an approval of whatever that turn is doing, steered or not.
test("the Agent moved on before the tap: the quick reply is not sent at all, steered or interrupting, and offers no retry (P1-1)", async () => {
  const cases: Array<[AgentState, boolean]> = [
    // r1 steer-race: a steering provider, running the heartbeat's turn, a prompt newer than the reply's.
    [{ ...finished, provider: "claude", status: "running", activeTurn: { turnId: "heartbeat" }, lastUserMessageAt: "2026-10-12T01:30:00.000Z" }, true],
    // A provider that cannot steer would interrupt it: not even a confirmation is offered.
    [{ ...finished, provider: "my-acp", status: "running", activeTurn: { turnId: "t2" } }, true],
    // The other turn already ended: idle again, but after a newer message.
    [{ ...finished, lastUserMessageAt: "2026-10-12T01:10:00.000Z", attentionTimestamp: "2026-10-12T01:12:00.000Z" }, true],
    // A hold (先别动) is bound the same way, though it clears nothing first.
    [{ ...finished, status: "running", activeTurn: { turnId: "t4" } }, false],
  ];
  for (const [state, rearm] of cases) {
    const fake = await host(state);
    try {
      await assert.rejects(sendChecked(fake.client, reply("继续，按你说的做。"), BUILTIN_SEND, fake.deliver, null, quick(fake, rearm)),
        (error: unknown) => isSendRefused(error) && error.message === NEW_TURN);
      assert.deepEqual([sends(fake.log), fake.log.includes("server-read")], [[], false], "nothing cleared, nothing asked of the server");
      // Queueing it for the end of the turn passes the same checks: refused too.
      await assert.rejects(checkFits(fake.client, reply("继续，按你说的做。"), quick(fake, rearm)), isSendRefused);
      assert.deepEqual(await fake.list(), []);
    } finally { await fake.close(); }
  }
});

test("a turn that starts while the attention is being cleared is caught by the second read: nothing goes out (P1-1)", async () => {
  // The clear is three round trips on the server; a heartbeat starts a turn meanwhile.
  const fake = await host(finished, () => ({ status: "running", activeTurn: { turnId: "heartbeat" }, lastUserMessageAt: "2026-10-12T01:05:00.000Z" }));
  try {
    await assert.rejects(sendChecked(fake.client, reply("继续，按你说的做。"), BUILTIN_SEND, fake.deliver, null, quick(fake)), isSendRefused);
    assert.deepEqual(fake.log, ["read", "clear", "read"], "never sent with the plan read before the clear (which would interrupt it)");
    assert.deepEqual(fake.delivered, []);
  } finally { await fake.close(); }
});

test("an Agent the host had not loaded is loaded by the clear: idle then, it just receives the reply, no confirmation", async () => {
  const fake = await host({ ...finished, status: "closed" }, () => ({ status: "idle", requiresAttention: false, attentionReason: null, attentionTimestamp: null }));
  try {
    const message = reply("继续做完。");
    const result = await sendChecked(fake.client, message, BUILTIN_SEND, fake.deliver, null, quick(fake));
    assert.deepEqual([answered(result).status, "plan" in result && result.plan.kind], ["sent", "send"]);
    assert.deepEqual(fake.log, ["read", "clear", "read", "server-read", "send"]);
    assert.deepEqual(fake.delivered, [{ text: "继续做完。", options: { activeTurnBehavior: "interrupt", messageId: message.messageId } }]);
  } finally { await fake.close(); }
});

test("the Agent moved on between this read and the server's: the server's confirmation is not offered, the reply is refused (P1-1)", async () => {
  // A turn starts on a provider that cannot steer after the card read the Agent: the server would interrupt it, so it asks.
  const fake = await host({ ...finished, provider: "my-acp" });
  try {
    const deliver: typeof fake.deliver = async input => { fake.set({ status: "running", activeTurn: { turnId: "heartbeat" } }); return fake.deliver(input); };
    await assert.rejects(sendChecked(fake.client, reply("继续做完。"), BUILTIN_SEND, deliver, null, quick(fake, false)),
      (error: unknown) => isSendRefused(error) && error.message === NEW_TURN);
    assert.deepEqual(fake.delivered, [], "asked, not sent; and 中断并发送 is never offered for a reply to another turn");
  } finally { await fake.close(); }
});

test("a retry after a lost answer: a new turn may be that very reply, so it is not sent again and the user looks first (P1-1)", async () => {
  const fake = await host(finished);
  try {
    const message = reply("继续做完。");
    // The server sent it, and its answer to the client was lost: the turn the reply started is running.
    fake.lose();
    await assert.rejects(sendChecked(fake.client, message, BUILTIN_SEND, fake.deliver, null, quick(fake)), /rpc timeout/);
    await assert.rejects(sendChecked(fake.client, message, BUILTIN_SEND, fake.deliver, null, quick(fake)),
      (error: unknown) => isSendRefused(error) && /可能就是刚才这条回复.*没有重发.*打开会话确认/.test(error.message));
    assert.equal(fake.delivered.length, 1, "one try only");
  } finally { await fake.close(); }
  // The request never reached the server: still resting after that turn, the retry goes out, under the same id.
  const quiet = await host(finished);
  try {
    const again = reply("继续做完。");
    let first = true;
    const deliver: typeof quiet.deliver = async input => { if (first) { first = false; throw new Error("socket closed"); } return quiet.deliver(input); };
    await assert.rejects(sendChecked(quiet.client, again, BUILTIN_SEND, deliver, null, quick(quiet)), /socket closed/);
    assert.equal(answered(await sendChecked(quiet.client, again, BUILTIN_SEND, deliver, null, quick(quiet))).status, "sent");
    assert.deepEqual(quiet.delivered.map(item => item.options.messageId), [again.messageId]);
  } finally { await quiet.close(); }
});

test("the binding reads the turn only: idle or not loaded, no turn open, the same prompt (by instant)", () => {
  const expect = answering("2026-10-12T00:58:00.000Z", "整理发布说明");
  assert.equal(expect(finished, false), null);
  assert.equal(expect({ ...finished, status: "closed" }, false), null, "not loaded is still resting after that turn");
  assert.equal(expect({ ...finished, lastUserMessageAt: "2026-10-12T08:58:00+08:00" }, false), null, "the same instant written with an offset");
  assert.equal(expect({ ...finished, activeTurn: { turnId: "t" } }, false), NEW_TURN);
  assert.equal(expect({ ...finished, status: "running" }, false), NEW_TURN);
  assert.equal(expect({ ...finished, lastUserMessageAt: null }, false), NEW_TURN);
  assert.equal(expect({ ...finished, status: "error" }, false), "「整理发布说明」的状态变了，这条快捷回复不再适用。");
  assert.equal(answering(null, "x")({ ...finished, lastUserMessageAt: null }, false), null, "no prompt either side");
});

// codex-obs-attn-F1: a heartbeat starts its rounds from a system notification, so the host's prompt stays and the Agent rests
// idle again after each. Only the turn starts the plugin saw tell the round the replies answer from the next.
const S2 = "2026-10-12T02:00:00.000Z", S3 = "2026-10-12T03:00:00.000Z", S4 = "2026-10-12T04:00:00.000Z";
test("another heartbeat round since the one they answer: nothing is read, cleared or sent (codex-obs-attn-F1)", async () => {
  // The host's state is the same after either round: idle, the first unread stamp, the old prompt.
  const later = await host(finished), reads: string[] = [];
  const seen = (start: string | null) => async () => { reads.push("telemetry"); return start; };
  try {
    await assert.rejects(sendChecked(later.client, reply("继续，按你说的做。"), BUILTIN_SEND, later.deliver, null, { ...quick(later), precheck: sameRound(seen(S3), S2, "整理发布说明") }),
      (error: unknown) => isSendRefused(error) && error.message === NEW_TURN);
    assert.deepEqual([later.log, later.delivered, reads], [[], [], ["telemetry"]], "refused before the Agent is even read");
  } finally { await later.close(); }
  // Without the round check the host's state alone lets it through: the defect this guards.
  const unguarded = await host(finished);
  try { assert.equal(answered(await sendChecked(unguarded.client, reply("继续，按你说的做。"), BUILTIN_SEND, unguarded.deliver, null, quick(unguarded))).status, "sent"); }
  finally { await unguarded.close(); }
  // Still the round they answer (or one the plugin has not seen yet): sent as before.
  const same = await host(finished);
  try {
    assert.equal(answered(await sendChecked(same.client, reply("继续做完。"), BUILTIN_SEND, same.deliver, null, { ...quick(same), precheck: sameRound(seen(S2), S2, "整理发布说明") })).status, "sent");
    assert.deepEqual(sends(same.log), ["clear", "send"]);
  } finally { await same.close(); }
  // A retry after a lost answer: the newer round may be that very reply, so it is not sent again.
  const lost = await host(finished);
  try {
    const message = reply("继续做完。");
    let start = S2;
    const check = { ...quick(lost), precheck: sameRound(async () => start, S2, "整理发布说明") };
    lost.lose();
    await assert.rejects(sendChecked(lost.client, message, BUILTIN_SEND, lost.deliver, null, check), /rpc timeout/);
    start = "2026-10-12T02:30:01.000Z";
    await assert.rejects(sendChecked(lost.client, message, BUILTIN_SEND, lost.deliver, null, check), (error: unknown) => isSendRefused(error) && /可能就是刚才这条回复.*没有重发/.test(error.message));
    assert.equal(lost.delivered.length, 1, "one try only");
  } finally { await lost.close(); }
});

// codex-obs-attn-R1: clearing the attention takes round trips (a mark, its reads), and a heartbeat round can start and end in
// them: the Agent rests idle after the prompt it had, so only the plugin's round tells it. The round is checked again after.
test("a heartbeat round that runs while the attention is cleared is caught before the send (codex-obs-attn-R1)", async () => {
  const fake = await host(finished);
  try {
    let start = S2, prechecks = 0;
    const hooks: SendHooks = { expect: answering(finished.lastUserMessageAt, "整理发布说明"), precheck: sameRound(async () => { prechecks++; return start; }, S2, "整理发布说明"),
      // The mark's round trips: a heartbeat round starts (S4) and ends meanwhile; the host's state is as it was.
      beforeSend: async agent => { await clearingAttention(fake.clear, "a")(agent); start = S4; } };
    await assert.rejects(sendChecked(fake.client, reply("继续，按你说的做。"), BUILTIN_SEND, fake.deliver, null, hooks),
      (error: unknown) => isSendRefused(error) && error.message === NEW_TURN);
    assert.equal(prechecks, 2, "checked before the Agent is read, and again after the clear");
    assert.deepEqual([sends(fake.log), fake.log.includes("server-read"), fake.delivered], [["clear"], false, []], "cleared, but nothing asked of the server or sent");
  } finally { await fake.close(); }
});

// codex-obs-attn-R1: a reply bound to a known round, whose round cannot be read now: nothing tells the rounds apart, so it is
// not sent; the user refreshes and tries again.
test("a known round that cannot be read stops the send, to try again after a refresh (codex-obs-attn-R1)", async () => {
  const fake = await host(finished);
  try {
    let fail = true;
    const hooks: SendHooks = { ...quick(fake), precheck: sameRound(async () => { if (fail) throw new Error("telemetry RPC unavailable"); return S2; }, S2, "整理发布说明") };
    const message = reply("继续做完。");
    await assert.rejects(sendChecked(fake.client, message, BUILTIN_SEND, fake.deliver, null, hooks),
      (error: unknown) => !isSendRefused(error) && /读不到「整理发布说明」最新的轮次.*这次没有发送.*请刷新后再试/.test((error as Error).message));
    assert.deepEqual([fake.log, fake.delivered, message.tried], [[], [], undefined], "nothing read, cleared or sent; not a lost try either");
    // Queueing it is stopped the same way.
    await assert.rejects(checkFits(fake.client, message, hooks), /请刷新后再试/);
    // Read again (the refresh): the same round, so it goes.
    fail = false;
    assert.equal(answered(await sendChecked(fake.client, message, BUILTIN_SEND, fake.deliver, null, hooks)).status, "sent");
    assert.equal(fake.delivered.length, 1);
  } finally { await fake.close(); }
});

test("the round check knows only what the plugin saw: nothing observed leaves the host's checks to decide, a failed read stops", async () => {
  assert.equal(await sameRound(async () => "2026-10-12T03:00:00.000Z", null, "x")(false), null, "no round to answer (an older server, nothing observed)");
  assert.equal(await sameRound(async () => { throw new Error("rpc"); }, null, "x")(false), null, "no round to answer: nothing to read");
  assert.equal(await sameRound(async () => null, S2, "x")(false), null, "no start observed now");
  await assert.rejects(sameRound(async () => { throw new Error("rpc"); }, S2, "x")(false), /读不到「x」最新的轮次/, "a round to answer, and the read failed");
  assert.equal(await sameRound(async () => "2026-10-12T10:00:00+08:00", S2, "x")(false), null, "the same instant written with an offset");
  assert.equal(await sameRound(async () => "2026-10-12T01:59:00.000Z", S2, "x")(false), null, "an older start (stale telemetry)");
  assert.equal(await sameRound(async () => "2026-10-12T02:00:00.001Z", S2, "整理发布说明")(false), NEW_TURN);
});

// A quick reply's key carries the turn it answers: the same words to another turn (another heartbeat round) are another
// request, so a receipt of one never settles the next; every way of writing the instants gives one key.
test("a quick reply's key is its words and the turn it answers", () => {
  const key = quickReplyKey("继续做完。", "2026-10-12T00:58:00.000Z", S2);
  assert.equal(quickReplyKey("继续做完。", "2026-10-12T08:58:00+08:00", "2026-10-12T10:00:00+08:00"), key);
  assert.notEqual(quickReplyKey("继续做完。", "2026-10-12T00:58:00.000Z", S3), key, "another round");
  assert.notEqual(quickReplyKey("先别动。", "2026-10-12T00:58:00.000Z", S2), key, "other words");
});

// codex-obs-attn-R3: the turn a quick reply answers goes to the server with it. Every button of one turn shares a group, so
// one reply of the turn goes out, on any device; the turn (its guard) is checked again under the Agent's send lock, after
// whatever the RPC waited for in transit, and before a queued reply goes out.
const PROMPT = finished.lastUserMessageAt!;
const bound = (text: string) => outgoingMessage("a", text, { what: "回复", source: `快捷回复「${text}」`, key: quickReplyKey(text, PROMPT, S2),
  group: quickReplyGroup(PROMPT, S2), guard: quickReplyGuard(PROMPT, S2) });
/** The client's checks of a reply to the round that started at S2: they pass, as they did before the RPC left. */
const bindings = (): SendHooks => ({ expect: answering(PROMPT, "整理发布说明"), precheck: sameRound(async () => S2, S2, "整理发布说明") });
const opening = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { open, opened }; };

test("two devices tap different replies of one turn: one goes out, the other is answered with it, not as itself (codex-obs-attn-R3)", async () => {
  const fake = await host(finished);
  fake.observe(S2);
  try {
    const both = opening(), first = opening(), second = opening();
    let waiting = 0;
    // Both passed their checks on the turn they answer; their requests then wait in transit.
    const inTransit = (gate: ReturnType<typeof opening>): typeof fake.deliver => async input => { if (++waiting === 2) both.open(); await gate.opened; return fake.deliver(input); };
    const goOn = bound("继续，按你说的做。"), hold = bound("先别动。");
    const a = sendChecked(fake.client, goOn, BUILTIN_SEND, inTransit(first), null, bindings());
    const b = sendChecked(fake.client, hold, BUILTIN_SEND, inTransit(second), null, bindings());
    await both.opened;
    first.open();
    assert.equal(answered(await a).status, "sent");
    second.open();
    const other = answered(await b);
    assert.ok(other.status === "existing", "the turn is answered already");
    assert.deepEqual([other.view.messageId, other.view.key, other.view.source], [goOn.messageId, goOn.key, "快捷回复「继续，按你说的做。」"], "named for the reply that went");
    assert.deepEqual(fake.delivered.map(item => item.text), ["继续，按你说的做。"], "先别动 never reached the new turn");
  } finally { await fake.close(); }
});

test("a reply whose request waited while a heartbeat round ran is refused by the server, nothing sent (codex-obs-attn-R3)", async () => {
  for (const meanwhile of [
    // The round ran and ended: the Agent rests after the same prompt, only the plugin saw it start.
    (fake: LedgerHost) => fake.observe(S4),
    // The round is still going when the request arrives.
    (fake: LedgerHost) => { fake.observe(S4); fake.set({ status: "running", activeTurn: { turnId: "heartbeat" } }); },
  ]) {
    const fake = await host({ ...finished, provider: "my-acp" });
    fake.observe(S2);
    try {
      const message = bound("继续做完。");
      const transit: typeof fake.deliver = async input => { meanwhile(fake); return fake.deliver(input); };
      await assert.rejects(sendChecked(fake.client, message, BUILTIN_SEND, transit, null, bindings()),
        (error: unknown) => isSendRefused(error) && /^「这个 Agent」(之后又跑了一轮，这条快捷回复答的是之前那一轮，|已经开始新的一轮，这条快捷回复)不再适用，没有发送。$/.test(error.message));
      assert.deepEqual([fake.delivered, await fake.list(), message.tried], [[], [], false], "nothing sent or recorded; never asked to interrupt the new round either");
    } finally { await fake.close(); }
  }
});

test("a queued reply is checked again before it goes out: a round run meanwhile drops it, and one already moved past is never queued (codex-obs-attn-R3)", async () => {
  // An approval pending while the Agent rests (the case that waits): queued under the turn it answers.
  const fake = await host({ ...finished, pendingPermissions: [{ id: "p1" }] });
  fake.observe(S2);
  try {
    const message = bound("继续做完。");
    await checkFits(fake.client, message, bindings());
    assert.equal((await fake.enqueue(ledgerInput(message))).state, "queued");
    // The approval is answered, and a heartbeat round runs before the Agent rests again: same prompt, another round.
    fake.set({ pendingPermissions: [] });
    fake.observe(S4);
    await fake.ledger.flush("a");
    const [dropped] = await fake.list();
    assert.deepEqual([dropped?.state, fake.delivered.length], ["discarded", 0]);
    assert.equal(dropped?.note, "「这个 Agent」之后又跑了一轮，这条快捷回复答的是之前那一轮，不再适用，没有发送。");
  } finally { await fake.close(); }
  // The request to queue it reached the server only after a heartbeat round began: never queued, never sent.
  const late = await host(finished);
  late.observe(S2);
  try {
    const message = bound("继续做完。");
    await checkFits(late.client, message, bindings());
    late.set({ status: "running", activeTurn: { turnId: "heartbeat" } });
    late.observe(S4);
    const view = await late.enqueue(ledgerInput(message));
    assert.deepEqual([view.state, view.messageId], ["discarded", message.messageId]);
    late.set({ status: "idle", activeTurn: null });
    await late.ledger.flush("a");
    assert.equal(late.delivered.length, 0);
  } finally { await late.close(); }
});

// codex-obs-attn-R4: going on clears the answered turn's attention first. That clear names the round the reply answers, so
// when a heartbeat round asks a new question in the meantime (the host's prompt and attention tokens unchanged), the server
// clears nothing, and the reply, refused for that round, leaves the new question needing the user.
test("a reply refused for a newer round leaves that round's attention raised: the clear names its round (codex-obs-attn-R4)", async () => {
  const [T0, T1, T2, T3, T4, T5, T6] = [0, 1, 2, 3, 4, 5, 6].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
  for (const heartbeat of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), "observatory-clear-round-"));
    let clock = Date.parse(T2!), clears = 0;
    const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
    const receipts = new ReadReceiptStore({ directory });
    const fake = await ledgerHost({ id: "a", provider: "codex", status: "idle", lastUserMessageAt: T0, requiresAttention: true, attentionReason: "finished", attentionTimestamp: T1,
      activeTurn: null, pendingPermissions: [] }, BUILTIN_SEND, { turns: telemetry });
    const controller = new CompletionReadController(receipts, { request: async () => {
      clears++; fake.set({ requiresAttention: false, attentionTimestamp: null, attentionReason: null }); return { agentId: "a", agents: [fake.state] };
    } }, () => clock, telemetry);
    const round = async (turnId: string, start: string, end: string) => {
      clock = Date.parse(start); await telemetry.record({ type: "turn_started", agent: { id: "a", title: "整理发布说明" }, turnId });
      clock = Date.parse(end); await telemetry.record({ type: "turn_ended", agent: { id: "a", title: "整理发布说明" }, turnId, outcome: "completed", asks: true });
    };
    try {
      await round("question", T2!, T3!);
      const marks: Array<Parameters<CompletionReadController["mark"]>[1]> = [], answers: string[] = [];
      // The mark's request; a heartbeat round asks a new question before it reaches the server.
      const clear = async (input: Parameters<CompletionReadController["mark"]>[1]) => {
        if (heartbeat) await round("heartbeat", T4!, T5!);
        clock = Date.parse(T6!); marks.push(input);
        answers.push((await controller.mark(fake.client as unknown as PaseoApi, input)).status);
      };
      const text = "继续，按你说的做。";
      const message = outgoingMessage("a", text, { what: "回复", key: quickReplyKey(text, T0, T2), group: quickReplyGroup(T0, T2), guard: quickReplyGuard(T0, T2) });
      const hooks: SendHooks = { expect: answering(T0, "整理发布说明"), precheck: sameRound(async () => (await telemetry.snapshot("a")).agents[0]?.turnStartedAt, T2, "整理发布说明"),
        beforeSend: clearingAttention(clear, "a", T2) };
      const sending = sendChecked(fake.client, message, BUILTIN_SEND, fake.deliver, null, hooks);
      if (heartbeat) {
        await assert.rejects(sending, isSendRefused);
        assert.deepEqual([answers, clears, fake.state?.requiresAttention, fake.delivered.length, (await fake.list()).length], [["stale"], 0, true, 0, 0],
          "the new round's question still needs the user; nothing cleared or sent");
      } else {
        assert.equal(answered(await sending).status, "sent");
        assert.deepEqual([answers, clears, fake.state?.requiresAttention, fake.delivered.length], [["read"], 1, false, 1], "the round it answers: cleared, then sent");
      }
      assert.deepEqual(marks.map(input => input.round), [{ startedAt: T2 }], "the clear names the round");
    } finally { await controller.close(); await telemetry.close(); await fake.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
