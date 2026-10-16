import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkSend, outgoingMessage, pendingRequestIds, sendChecked, type AgentState } from "../client/send-check";
import { messageKey } from "../client/deferred-state";
import { onItsWay } from "../shared/deferred-rpc";
import { readSendCapabilities } from "../server/steerable-providers";
import { BUILTIN_SEND, MAX_SEND_IDS, capabilitiesFromReply, getSteerableProviders, steerableReply, type SendCapabilities } from "../shared/steer";
import { ledgerHost } from "./ledger-host";

type State = AgentState;
/** A host that only answers reads, for planning alone. */
function api(state: State | null) {
  return { paseo: { agents: { ref: (_id: string) => ({ refresh: async () => state ? { agent: { ...state } } : null }) } } };
}
const caps = (steerable: string[] = [], slashSteerable: string[] = []) => ({ steerable, slashSteerable });
const T1 = { turnId: "t1", startedAt: "2026-10-12T01:00:00.000Z" }, T2 = { turnId: "t2", startedAt: "2026-10-12T01:05:00.000Z" };
const acpRunning = (patch: Partial<State> = {}): State => ({ provider: "acp-agent", status: "running", activeTurn: T1, pendingPermissions: [], ...patch });
const confirmOf = (result: Awaited<ReturnType<typeof sendChecked>>) => { assert.ok("confirm" in result, "a confirmation, nothing sent"); return result.confirm; };
const answerOf = (result: Awaited<ReturnType<typeof sendChecked>>) => { assert.ok("answered" in result, "the ledger answered"); return result.answered; };

test("a running turn is steered where the provider supports it, never interrupted silently (opus-F10)", async () => {
  const host = await ledgerHost({ provider: "claude", status: "running", activeTurn: T1 });
  try {
    const message = outgoingMessage("a", "看一下这个问题");
    const answer = answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver));
    assert.equal(answer.status, "sent");
    // The server planned it again and sent it under the message's id, steered.
    assert.deepEqual(host.delivered, [{ text: "看一下这个问题", options: { activeTurnBehavior: "steer", messageId: message.messageId } }]);
  } finally { await host.close(); }
  // A custom id that extends a steering provider (read from the daemon config on the server) steers too.
  const custom = api({ provider: "team-claude", status: "running" });
  assert.equal((await checkSend(custom.paseo, outgoingMessage("a", "继续"), caps(["team-claude"]))).plan.kind, "steer");
  assert.equal((await checkSend(custom.paseo, outgoingMessage("a", "继续"), BUILTIN_SEND)).plan.kind, "confirm", "without the server's list a custom id is not trusted to steer");
});

// The confirm round trip: the client asks first, with 「等这一轮结束再发」 beside it; yes sends once, as confirmed, under the same id.
test("interrupting a turn needs the user's OK for that turn; the server sends once with it, interrupting", async () => {
  const host = await ledgerHost(acpRunning());
  try {
    const message = outgoingMessage("a", "继续");
    const asked = confirmOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver));
    assert.deepEqual([asked.check.plan.kind, asked.check.plan.label, asked.server], ["confirm", "中断并发送", false]);
    assert.match(asked.check.plan.confirm!, /中断/);
    assert.deepEqual(asked.offer, { label: "等这一轮结束再发", note: "不打断当前回合，等它这一轮结束后自动发送" });
    assert.deepEqual(asked.consent, { interrupt: true, approvals: [], turn: "t1@2026-10-12T01:00:00.000Z" });
    assert.deepEqual([host.delivered, host.log], [[], ["read"]], "nothing asked of the server before the OK");
    const answer = answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver, asked.consent));
    assert.equal(answer.status, "sent");
    assert.deepEqual(host.delivered, [{ text: "继续", options: { activeTurnBehavior: "interrupt", messageId: message.messageId } }]);
    // While an approval waits, a steering provider takes it mid-turn and the host denies the request: that is asked too.
    const plan = (await checkSend(api({ provider: "claude", status: "running", pendingPermissions: [{ id: "p" }] }).paseo, outgoingMessage("a", "继续"), BUILTIN_SEND)).plan;
    assert.equal(plan.kind, "confirm"); assert.match(plan.confirm!, /取消这次审批/);
    assert.deepEqual(plan.options, { activeTurnBehavior: "steer" });
  } finally { await host.close(); }
});

// r3-F1: an OK is for the turn it was given in. The same turn: one confirmation. Another turn: asked again, by the client when
// its own read shows it, else by the server, which reads the Agent again under its send lock.
test("one OK per turn: another turn is asked about again, on the client or by the server, and nothing goes out on the old OK", async () => {
  const host = await ledgerHost(acpRunning());
  try {
    const message = outgoingMessage("a", "继续");
    const asked = confirmOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver));
    host.set({ activeTurn: T2 });
    const again = confirmOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver, asked.consent));
    assert.deepEqual([again.server, again.consent?.turn], [false, "t2@2026-10-12T01:05:00.000Z"]);
    assert.equal(host.delivered.length, 0);
    // The turn changes between the client's read and the server's: the server asks, for its turn, and sends nothing.
    host.set({ activeTurn: T1 });
    const late = confirmOf(await sendChecked(host.client, message, BUILTIN_SEND, async input => { host.set({ activeTurn: T2 }); return host.deliver(input); }, asked.consent));
    assert.deepEqual([late.server, late.check.plan.label, late.consent?.turn, late.offer?.label], [true, "中断并发送", "t2@2026-10-12T01:05:00.000Z", "等这一轮结束再发"]);
    assert.equal(host.delivered.length, 0);
    assert.equal(message.tried, false, "nothing went out: the next try is a first one");
    // Yes to the server's confirmation, in that turn: sent once.
    assert.equal(answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver, late.consent)).status, "sent");
    assert.equal(host.delivered.length, 1);
  } finally { await host.close(); }
});

test("codex-F4: another request in the same turn, with the same count, needs a new confirmation", async () => {
  // attention-send-repro F2: approval A is answered on another device and B is asked in the same live turn.
  const host = await ledgerHost({ provider: "codex", status: "running", activeTurn: { turnId: "same-turn", startedAt: "2026-10-12T01:00:00.000Z" }, pendingPermissions: [{ id: "approval-A", kind: "tool" }] });
  try {
    const message = outgoingMessage("fixture", "跟进说明");
    const old = confirmOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver));
    assert.deepEqual(old.consent?.approvals, ["approval-A"]);
    assert.equal(old.offer?.label, "等审批处理完再发");
    host.set({ pendingPermissions: [{ id: "approval-B", kind: "question" }] });
    const latest = confirmOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver, old.consent));
    assert.notEqual(old.check.fingerprint, latest.check.fingerprint);
    assert.deepEqual(latest.consent?.approvals, ["approval-B"], "the confirmation was for request A");
    assert.equal(host.delivered.length, 0);
    assert.equal(answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver, latest.consent)).status, "sent");
    assert.deepEqual(host.delivered.map(entry => entry.options.activeTurnBehavior), ["steer"]);
  } finally { await host.close(); }
  // Request ids are what counts, in any order; a request without an id keeps one name across reads.
  assert.deepEqual(pendingRequestIds({ pendingPermissions: [{ id: "b" }, { id: "a" }] }), ["b", "a"]);
  const anonymous = { pendingPermissions: [{ kind: "tool", name: "Bash", title: "Run command" }] };
  assert.deepEqual(pendingRequestIds(anonymous), pendingRequestIds(structuredClone(anonymous)));
  assert.notDeepEqual(pendingRequestIds(anonymous), pendingRequestIds({ pendingPermissions: [{ kind: "tool", name: "Edit", title: "Edit file" }] }));
});

test("a slash command is steered only into Claude-based providers; others ask to interrupt and send", async () => {
  const caps2 = caps(["codex-relay", "claude-team"], ["claude-team"]);
  for (const provider of ["codex", "pi", "opencode", "omp", "codex-relay"]) {
    const running = api({ provider, status: "running", activeTurn: { turnId: "t" } });
    const { plan } = await checkSend(running.paseo, outgoingMessage("a", "/review 看一下", { what: "命令" }), caps2);
    assert.equal(plan.kind, "confirm", provider); assert.equal(plan.label, "中断并发送", provider);
    assert.equal(plan.options, undefined, `${provider}: never sent as a steer`);
    // Plain text still steers into the same provider.
    assert.equal((await checkSend(running.paseo, outgoingMessage("a", "继续"), caps2)).plan.kind, "steer", provider);
  }
  for (const provider of ["claude", "claude-team"]) {
    const running = api({ provider, status: "running", activeTurn: { turnId: "t" } });
    assert.equal((await checkSend(running.paseo, outgoingMessage("a", "/review"), caps2)).plan.kind, "steer", provider);
  }
});

// One message per Agent and key on its way: the same text queued on another screen or device is this send's delivery.
test("existing: the same message on its way answers the send with that message, which locks it, and nothing more goes out", async () => {
  const host = await ledgerHost(acpRunning());
  try {
    const source = "分析建议", text = "请复查这里", key = messageKey(source, text);
    const queued = await host.enqueue({ text, messageId: "queued-elsewhere-1", key, source });
    assert.equal(queued.state, "queued");
    // The turn ended but the ledger has not looked yet; this client sends the same text.
    host.set({ status: "idle", activeTurn: null });
    const message = outgoingMessage("a", text, { source });
    const answer = answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver));
    assert.equal(answer.status, "existing");
    assert.ok("view" in answer && answer.view.messageId === "queued-elsewhere-1");
    assert.equal(host.delivered.length, 0);
    assert.ok(onItsWay(await host.list(), "a", key), "the list shows it on its way: the entry locks its send");
  } finally { await host.close(); }
});

// r3-F5: the server sent it but its answer to the client was lost. Trying again asks for the same id: one delivery.
test("an answer lost after the server sent it: the next try asks about the same id, and nothing goes out twice", async () => {
  const host = await ledgerHost({ provider: "acp-agent", status: "idle" });
  try {
    const message = outgoingMessage("a", "下一步");
    host.lose();
    await assert.rejects(sendChecked(host.client, message, BUILTIN_SEND, host.deliver), /rpc timeout/);
    assert.equal(message.tried, true, "it may have gone out");
    assert.equal(host.delivered.length, 1);
    const answer = answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver));
    assert.equal(answer.status, "sent");
    assert.ok("view" in answer && answer.view.messageId === message.messageId);
    assert.equal(host.delivered.length, 1, "the ledger answered with what became of it");
  } finally { await host.close(); }
});

// The daemon took the message but its answer never came (a reload, a dropped connection): the ledger holds it for the user,
// who sends it anyway (after looking in the conversation) or cancels it in its row; trying again never sends it twice.
test("a send whose outcome the daemon cannot tell is held for the user; trying again does not send it again", async () => {
  for (const [error, note] of [["agent_request_outcome_unknown", /没收到发送结果/], ["agent_request_key_conflict", /没收到发送结果/], ["Agent closed while sending", /发送失败：和宿主的连接断了/]] as const) {
    const host = await ledgerHost({ provider: "claude", status: "idle" });
    try {
      host.failures.push(new Error(error));
      const message = outgoingMessage("a", "继续");
      const held = answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver));
      assert.equal(held.status, "held", error);
      assert.ok("view" in held && note.test(held.view.note), held.status === "held" ? held.view.note : error);
      const again = answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver));
      assert.equal(again.status, "held");
      assert.equal(host.delivered.length, 1, `${error}: no second send`);
      assert.ok(onItsWay(await host.list(), "a", message.key), "on its way until the user decides: the entry locks its send");
    } finally { await host.close(); }
  }
});

test("idle and unloaded Agents get the message at once; archived or missing ones cannot", async () => {
  const idle = await ledgerHost({ provider: "acp-agent", status: "idle" });
  try { assert.equal(answerOf(await sendChecked(idle.client, outgoingMessage("a", "下一步"), BUILTIN_SEND, idle.deliver)).status, "sent"); }
  finally { await idle.close(); }
  // Paseo 0.11 closes every Agent when the daemon stops; sending loads it again.
  const closed = await ledgerHost({ provider: "claude", status: "closed" });
  try {
    const plan = (await checkSend(closed.client, outgoingMessage("a", "下一步"), BUILTIN_SEND)).plan;
    assert.equal(plan.kind, "send"); assert.match(plan.note!, /自动载入/);
    const message = outgoingMessage("a", "下一步");
    assert.equal(answerOf(await sendChecked(closed.client, message, BUILTIN_SEND, closed.deliver)).status, "sent");
    assert.deepEqual(closed.delivered, [{ text: "下一步", options: { activeTurnBehavior: "interrupt", messageId: message.messageId } }]);
  } finally { await closed.close(); }
  for (const state of [{ provider: "claude", status: "idle" as const, archivedAt: "2026-10-11T00:00:00.000Z" }, null]) {
    const gone = await ledgerHost(state);
    try {
      assert.equal((await checkSend(gone.client, outgoingMessage("a", "hi"), BUILTIN_SEND)).plan.kind, "unavailable");
      await assert.rejects(sendChecked(gone.client, outgoingMessage("a", "hi"), BUILTIN_SEND, gone.deliver), /归档|不可用/);
      assert.equal(gone.delivered.length, 0);
    } finally { await gone.close(); }
  }
  // Archived after the client read it: the server says so, and sends nothing.
  const late = await ledgerHost({ provider: "claude", status: "idle" });
  try {
    const answer = answerOf(await sendChecked(late.client, outgoingMessage("a", "hi"), BUILTIN_SEND, async input => { late.set({ archivedAt: "2026-10-12T00:00:00.000Z" }); return late.deliver(input); }));
    assert.deepEqual([answer.status, "message" in answer && /已归档或不存在/.test(answer.message)], ["gone", true]);
    assert.equal(late.delivered.length, 0);
  } finally { await late.close(); }
});

test("beforeSend sees the snapshot the send was decided on, and only when it is sent", async () => {
  const snapshot = { provider: "acp-agent", status: "idle" as const, requiresAttention: true, attentionReason: "finished" as const, attentionTimestamp: "2026-10-12T01:00:00.000Z", lastUserMessageAt: "2026-10-12T00:59:00.000Z" };
  const host = await ledgerHost(snapshot);
  try {
    const seen: unknown[] = [];
    const hooks = { beforeSend: async (agent: unknown) => { seen.push(agent); host.log.push("before"); } };
    assert.equal(answerOf(await sendChecked(host.client, outgoingMessage("a", "继续做完", { what: "回复" }), BUILTIN_SEND, host.deliver, null, hooks)).status, "sent");
    assert.deepEqual(host.log, ["read", "before", "read", "server-read", "send"]);
    assert.deepEqual(seen, [snapshot]);
  } finally { await host.close(); }
  // A confirmation needed: nothing runs before the user confirms.
  const running = await ledgerHost(acpRunning());
  try {
    let ran = false;
    assert.ok("confirm" in await sendChecked(running.client, outgoingMessage("a", "继续"), BUILTIN_SEND, running.deliver, null, { beforeSend: async () => { ran = true; } }));
    assert.equal(ran, false);
  } finally { await running.close(); }
});

test("after beforeSend the Agent is read again: a changed plan is returned to confirm, never sent the old way (P1-1)", async () => {
  // An Agent that cannot steer starts a turn while the hook runs: sending now would interrupt it, so the user confirms that.
  const host = await ledgerHost({ provider: "acp-agent", status: "idle", lastUserMessageAt: "2026-10-12T01:00:00.000Z" });
  try {
    const hooks = { beforeSend: async () => { host.set({ status: "running", activeTurn: T2 }); } };
    const message = outgoingMessage("a", "继续");
    const asked = confirmOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver, null, hooks));
    assert.deepEqual([asked.check.plan.kind, asked.check.plan.label, asked.server], ["confirm", "中断并发送", false]);
    assert.deepEqual([host.log, host.delivered.length], [["read", "read"], 0]);
    assert.equal(message.tried, undefined, "nothing tried yet");
    // Confirmed for exactly that turn: sent, interrupting as confirmed.
    assert.equal(answerOf(await sendChecked(host.client, message, BUILTIN_SEND, host.deliver, asked.consent, hooks)).status, "sent");
    assert.deepEqual(host.delivered.map(entry => entry.options), [{ activeTurnBehavior: "interrupt", messageId: message.messageId }]);
  } finally { await host.close(); }
  // The same way out after the hook (not loaded → loaded and idle): sent at once.
  const loading = await ledgerHost({ provider: "claude", status: "closed" });
  try {
    assert.equal(answerOf(await sendChecked(loading.client, outgoingMessage("a", "继续"), BUILTIN_SEND, loading.deliver, null, { beforeSend: async () => { loading.set({ status: "idle" }); } })).status, "sent");
    assert.equal(loading.delivered.length, 1);
  } finally { await loading.close(); }
});

test("the server's capability reply: slash-steerable ids and bases are optional (an older handler sends only providers)", () => {
  assert.deepEqual(getSteerableProviders.output.parse({ providers: ["claude", "team-claude"] }), { providers: ["claude", "team-claude"], slashSteerable: [], bases: {} });
  assert.deepEqual(getSteerableProviders.output.parse({ providers: ["claude"], slashSteerable: ["team-claude"] }), { providers: ["claude"], slashSteerable: ["team-claude"], bases: {} });
  assert.throws(() => getSteerableProviders.output.parse({ providers: ["x".repeat(65)] }));
});

// codex-obs-send-ui-F3: the built-in each custom id extends travels from the server's config read to `sendPlan`.
test("bases survive the RPC schema, bounded; the server's reply keeps them and drops what the schema would refuse", () => {
  const reply = { providers: ["claude", "codex", "my-codex"], slashSteerable: ["claude"], bases: { "my-codex": "codex", "my-pi": "pi" } };
  assert.deepEqual(getSteerableProviders.output.parse(reply).bases, { "my-codex": "codex", "my-pi": "pi" }, "parsing keeps them");
  const many = Object.fromEntries(Array.from({ length: MAX_SEND_IDS + 1 }, (_, index) => [`custom-${index}`, "codex"]));
  assert.throws(() => getSteerableProviders.output.parse({ ...reply, bases: many }), "at most 200 bases");
  assert.throws(() => getSteerableProviders.output.parse({ ...reply, bases: { ["x".repeat(65)]: "codex" } }));
  const bounded = steerableReply({ steerable: ["claude", "y".repeat(65)], slashSteerable: ["claude"], bases: { ...many, ["x".repeat(65)]: "codex" } });
  assert.equal(Object.keys(bounded.bases ?? {}).length, MAX_SEND_IDS); assert.deepEqual(bounded.providers, ["claude"]);
  assert.doesNotThrow(() => getSteerableProviders.output.parse(bounded), "whatever the server read, its reply parses");
  assert.deepEqual(capabilitiesFromReply(getSteerableProviders.output.parse(reply)), { steerable: ["claude", "codex", "my-codex"], slashSteerable: ["claude"], bases: { "my-codex": "codex", "my-pi": "pi" } });
});

/** The plan for `text` to a running Agent of `provider`, with the given capabilities. */
const runningPlan = async (provider: string, text: string, capabilities: SendCapabilities, extra: Partial<State> = {}) =>
  (await checkSend(api({ provider, status: "running", activeTurn: { turnId: "t" }, ...extra }).paseo, outgoingMessage("a", text, { what: "命令" }), capabilities)).plan;
const OUT_OF_BAND: Array<[base: string, custom: string, text: string]> = [
  ["codex", "my-codex", "/compact"], ["pi", "my-pi", "/compact"], ["pi", "my-pi", "/autocompact"], ["omp", "my-omp", "/compact"], ["omp", "my-omp", "/handoff"],
  ["omp", "my-omp", "/steer 先看测试"], ["omp", "my-omp", "/follow-up 记得写说明"]];

test("a custom Codex's /compact and a custom Pi's or omp's out-of-band commands are planned as their built-ins run them (codex-obs-send-ui-F3)", async () => {
  const bases = { "my-codex": "codex", "my-pi": "pi", "my-omp": "omp", "my-claude": "claude" };
  const capabilities: SendCapabilities = { steerable: Object.keys(bases), slashSteerable: ["my-claude"], bases };
  for (const [base, custom, text] of OUT_OF_BAND) {
    const builtin = await runningPlan(base, text, capabilities), own = await runningPlan(custom, text, capabilities);
    assert.equal(builtin.kind, "send", `${base} ${text}: beside the turn`);
    assert.deepEqual(own, builtin, `${custom} ${text}: the same plan as ${base}`);
    // While a request waits too: run beside the turn, the approval stays.
    assert.deepEqual(await runningPlan(custom, text, capabilities, { pendingPermissions: [{ id: "p" }] }), await runningPlan(base, text, capabilities, { pendingPermissions: [{ id: "p" }] }));
  }
  // Codex's /goal may or may not run beside the turn; Claude's /compact replaces it: the custom ids say the same.
  assert.deepEqual(await runningPlan("my-codex", "/goal 修复测试", capabilities), await runningPlan("codex", "/goal 修复测试", capabilities));
  assert.equal((await runningPlan("my-codex", "/goal 修复测试", capabilities)).kind, "confirm");
  assert.deepEqual(await runningPlan("my-claude", "/compact", capabilities), await runningPlan("claude", "/compact", capabilities));
  assert.deepEqual(await runningPlan("my-claude", "/review", capabilities), await runningPlan("claude", "/review", capabilities));
  // Without bases (an older server) a command into a custom id is read cautiously: it would interrupt.
  const unknown = await runningPlan("my-codex", "/compact", { steerable: ["my-codex"], slashSteerable: [] });
  assert.deepEqual([unknown.kind, unknown.label], ["confirm", "中断并发送"]);
});

test("from the daemon config to the plan: what the server reads reaches sendPlan through the RPC (codex-obs-send-ui-F3)", async () => {
  const home = await mkdtemp(join(tmpdir(), "observatory-send-bases-"));
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ agents: { providers: { "my-codex": { extends: "codex" }, "my-pi": { extends: "pi" }, "my-omp": { extends: "omp" }, "my-acp": { extends: "acp" } } } }));
    // The server's handler: readSendCapabilities, then steerableReply; the client parses the reply and keeps all three.
    const capabilities = capabilitiesFromReply(getSteerableProviders.output.parse(JSON.parse(JSON.stringify(steerableReply(await readSendCapabilities({ PASEO_HOME: home }))))));
    assert.deepEqual(capabilities.bases, { "my-codex": "codex", "my-pi": "pi", "my-omp": "omp" });
    for (const [base, custom, text] of OUT_OF_BAND) assert.deepEqual(await runningPlan(custom, text, capabilities), await runningPlan(base, text, capabilities), `${custom} ${text}`);
    // The send itself goes out as planned, through the ledger that read the same capabilities: no steer flag (Codex runs it
    // beside the turn), one id.
    const host = await ledgerHost({ provider: "my-codex", status: "running", activeTurn: { turnId: "t" } }, capabilities);
    try {
      const message = outgoingMessage("a", "/compact", { what: "命令" });
      assert.equal(answerOf(await sendChecked(host.client, message, capabilities, host.deliver)).status, "sent");
      assert.deepEqual(host.delivered, [{ text: "/compact", options: { activeTurnBehavior: "interrupt", messageId: message.messageId } }]);
    } finally { await host.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});
