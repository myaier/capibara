import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeferredSend, type DeferredAgentSnapshot, type DeferredGuard, type DeferredPaseo } from "../server/deferred-send";
import { DeferredSendResultSchema, deferredSendContracts } from "../shared/deferred-rpc";

// The shared kit/deferred-send.ts, the parts a plugin opts into (codex-obs-attn-R3): `group`, messages answering one question,
// of which one goes out; `guard`, the plugin's own condition, checked under the agent's lock right before each send.
// Messages without them behave as kit-deferred-send.test.ts has it.

// A fake daemon as in kit-deferred-send.test.ts: snapshots, sends that start a turn and record the user message with our id.
function host(agents: Record<string, DeferredAgentSnapshot>) {
  let clock = Date.parse("2026-10-12T10:00:00Z");
  const sent: { agentId: string; text: string; options: { activeTurnBehavior: string; messageId: string } }[] = [];
  const failures: unknown[] = [];
  const timelines: Record<string, { item: { type: string; text: string; clientMessageId?: string }; timestamp: string }[]> = {};
  let hold: Promise<void> | null = null;
  const paseo: DeferredPaseo = {
    agents: {
      ref: (id) => ({
        refresh: async () => (agents[id] ? { agent: { ...agents[id] } } : null),
        send: async (text, options) => {
          if (hold) await hold;
          const failure = failures.shift();
          if (failure) throw failure;
          sent.push({ agentId: id, text, options });
          (timelines[id] ??= []).push({ item: { type: "user_message", text, clientMessageId: options.messageId }, timestamp: new Date(clock).toISOString() });
          const agent = agents[id];
          if (agent) Object.assign(agent, { status: "running", activeTurn: { turnId: `turn-${sent.length}` }, lastUserMessageAt: new Date(clock).toISOString() });
        },
        timeline: { refetch: async () => ({ entries: [...(timelines[id] ?? [])] }) },
      }),
    },
  };
  return { agents, sent, failures, paseo, now: () => clock, tick: (ms: number) => { clock += ms; }, holdSends: (until: Promise<void> | null) => { hold = until; } };
}
type Host = ReturnType<typeof host>;

/**
 * The plugin's check as the observatory's quick replies use it: the message answers the round named `round`; `rounds` says
 * which round each Agent is on now. `seen` records each call.
 */
function roundGuard(rounds: Record<string, string>, seen: Array<{ agentId: string; guard: DeferredGuard; status: string }> = []) {
  return (input: { agentId: string; guard: DeferredGuard; agent: DeferredAgentSnapshot }) => {
    seen.push({ agentId: input.agentId, guard: input.guard, status: input.agent.status });
    return input.guard.round === rounds[input.agentId] ? null : "它已经开始新的一轮，这条回复不再适用";
  };
}

async function ledger(h: Host, options: Partial<ConstructorParameters<typeof DeferredSend>[0]> = {}, file?: string) {
  const at = file ?? join(await mkdtemp(join(tmpdir(), "kit-deferred-guard-")), "plugin", "deferred-send.json");
  return { deferred: new DeferredSend({ file: at, pollMs: 3_600_000, now: h.now, log: () => undefined, ...options }), file: at };
}
const idle = (extra: Partial<DeferredAgentSnapshot> = {}): DeferredAgentSnapshot => ({ provider: "codex", status: "idle", lastUserMessageAt: "2026-10-12T09:00:00.000Z", ...extra });
const running = (extra: Partial<DeferredAgentSnapshot> = {}): DeferredAgentSnapshot => ({ ...idle(), status: "running", activeTurn: { turnId: "t1" }, ...extra });

test("the calls carry a group and a guard, and a refusal is one of the answers", () => {
  const contracts = deferredSendContracts("demo");
  const input = { agentId: "a", text: "继续", messageId: "msg-guard-1", key: "k", group: "round-1", guard: { prompt: "2026-10-12T09:00:00.000Z", round: null } };
  assert.deepEqual(contracts.send.input.parse(input), input);
  assert.deepEqual(contracts.enqueue.input.parse(input), input);
  assert.throws(() => contracts.send.input.parse({ ...input, guard: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, "v"])) }), "eight values at most");
  assert.throws(() => contracts.enqueue.input.parse({ ...input, group: "" }));
  assert.deepEqual(DeferredSendResultSchema.parse({ status: "refused", message: "不再适用，没有发送。" }), { status: "refused", message: "不再适用，没有发送。" });
});

test("one message per question: once one button of a group went out, every other one answers with it, now and later", async () => {
  const h = host({ a: idle() });
  const { deferred } = await ledger(h);
  const first = await deferred.send({ agentId: "a", text: "继续", messageId: "msg-group-1", key: "continue", group: "round-1" }, h.paseo);
  assert.equal(first.status, "sent");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  // Another button for the same question, from this client or another one: the question is answered, by 继续.
  for (const [index, wait] of [[2, 0], [3, 60_000], [4, 3_600_000]] as const) {
    h.tick(wait);
    const other = await deferred.send({ agentId: "a", text: "先别动", messageId: `msg-group-${index}`, key: "hold", group: "round-1" }, h.paseo);
    assert.ok(other.status === "existing", `after ${wait} ms`);
    assert.deepEqual([other.view.messageId, other.view.state, other.view.key], ["msg-group-1", "sent", "continue"]);
  }
  assert.equal((await deferred.enqueue({ agentId: "a", text: "先别动", messageId: "msg-group-5", key: "hold", group: "round-1" }, h.paseo)).messageId, "msg-group-1");
  // The next question is another group; a message without a group is untouched by any.
  assert.equal((await deferred.send({ agentId: "a", text: "先别动", messageId: "msg-group-6", key: "hold", group: "round-2" }, h.paseo)).status, "sent");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  assert.equal((await deferred.send({ agentId: "a", text: "先别动", messageId: "msg-group-7", key: "hold-plain" }, h.paseo)).status, "sent");
  assert.deepEqual(h.sent.map((entry) => entry.options.messageId), ["msg-group-1", "msg-group-6", "msg-group-7"]);
});

test("two clients tap different buttons of one question at once: one goes out, the other answers with it", async () => {
  for (const pair of [["send", "send"], ["enqueue", "send"], ["send", "enqueue"]] as const) {
    const h = host({ a: idle() });
    const { deferred } = await ledger(h);
    let release!: () => void;
    h.holdSends(new Promise<void>((resolve) => { release = resolve; }));
    const call = (kind: "send" | "enqueue", id: string, text: string) => kind === "send"
      ? deferred.send({ agentId: "a", text, messageId: id, key: text, group: "round-1" }, h.paseo).then((result) => ("view" in result ? result.view.messageId : result.status))
      : deferred.enqueue({ agentId: "a", text, messageId: id, key: text, group: "round-1" }, h.paseo).then((view) => view.messageId);
    const answers = Promise.all([call(pair[0], "msg-two-x", "继续"), call(pair[1], "msg-two-y", "先别动")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [x, y] = await answers;
    assert.equal(h.sent.length, 1, pair.join("/"));
    assert.equal(x, y, `${pair.join("/")}: both answer with the one that went out`);
  }
});

test("a group's message that never went out (canceled, dropped) leaves the question open", async () => {
  const h = host({ a: running() });
  const { deferred } = await ledger(h);
  assert.equal((await deferred.enqueue({ agentId: "a", text: "继续", messageId: "msg-open-1", key: "continue", group: "round-1" }, h.paseo)).state, "queued");
  // On its way, it answers the question for the other buttons.
  const waiting = await deferred.send({ agentId: "a", text: "先别动", messageId: "msg-open-2", key: "hold", group: "round-1", consent: { interrupt: true, approvals: [], turn: "t1" } }, h.paseo);
  assert.ok(waiting.status === "existing" && waiting.view.messageId === "msg-open-1");
  assert.equal((await deferred.cancel("msg-open-1"))?.state, "canceled");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  assert.equal((await deferred.send({ agentId: "a", text: "先别动", messageId: "msg-open-3", key: "hold", group: "round-1" }, h.paseo)).status, "sent");
  assert.deepEqual(h.sent.map((entry) => entry.options.messageId), ["msg-open-3"]);
});

test("sending now asks the plugin's guard under the lock with the Agent just read: refused, nothing is recorded or sent", async () => {
  const h = host({ a: idle() });
  const rounds = { a: "r2" }, seen: Array<{ agentId: string; guard: DeferredGuard; status: string }> = [];
  const { deferred } = await ledger(h, { guard: roundGuard(rounds, seen) });
  const refused = await deferred.send({ agentId: "a", text: "继续", messageId: "msg-refuse-1", key: "continue", group: "round-1", guard: { round: "r1" } }, h.paseo);
  assert.deepEqual(refused, { status: "refused", message: "它已经开始新的一轮，这条回复不再适用，没有发送。" });
  assert.deepEqual(seen, [{ agentId: "a", guard: { round: "r1" }, status: "idle" }]);
  assert.deepEqual([h.sent.length, (await deferred.list()).length], [0, 0]);
  // Refused before any consent was asked for: a running Agent's confirmation never shows for a message that no longer fits.
  Object.assign(h.agents.a!, { status: "running", activeTurn: { turnId: "t2" } });
  assert.equal((await deferred.send({ agentId: "a", text: "继续", messageId: "msg-refuse-2", key: "continue", guard: { round: "r1" } }, h.paseo)).status, "refused");
  // Still the round it answers: it goes out, its guard kept with it.
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  rounds.a = "r1";
  assert.equal((await deferred.send({ agentId: "a", text: "继续", messageId: "msg-refuse-3", key: "continue", guard: { round: "r1" } }, h.paseo)).status, "sent");
  assert.equal(h.sent.length, 1);
});

test("a queued message's guard is asked before each delivery: dropped once it no longer holds, maybe-sent after an attempt", async () => {
  const h = host({ a: running(), b: running() });
  const rounds = { a: "r1", b: "r1" };
  const { deferred } = await ledger(h, { guard: roundGuard(rounds) });
  assert.equal((await deferred.enqueue({ agentId: "a", text: "继续", messageId: "msg-drop-1", key: "continue", group: "round-1", guard: { round: "r1" } }, h.paseo)).state, "queued");
  // A heartbeat ran another round while it waited, without a message: the conversation's prompt did not move.
  rounds.a = "r2";
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush("a");
  assert.equal(h.sent.length, 0);
  const [dropped] = await deferred.list({ agentId: "a" });
  assert.deepEqual([dropped?.state, dropped?.note], ["discarded", "它已经开始新的一轮，这条回复不再适用，没有发送。"]);
  // The dropped message no longer answers its question.
  rounds.a = "r1";
  assert.equal((await deferred.send({ agentId: "a", text: "先别动", messageId: "msg-drop-2", key: "hold", group: "round-1", guard: { round: "r1" } }, h.paseo)).status, "sent");
  // B: an attempt failed, then the round moved on. That attempt may have been the one that opened it: maybe-sent, never again.
  assert.equal((await deferred.enqueue({ agentId: "b", text: "继续", messageId: "msg-drop-3", key: "continue", guard: { round: "r1" } }, h.paseo)).state, "queued");
  Object.assign(h.agents.b!, { status: "idle", activeTurn: null });
  h.failures.push(new Error("connection reset"));
  await deferred.flush("b");
  rounds.b = "r2";
  h.tick(120_000);
  await deferred.flush("b");
  const [after] = await deferred.list({ agentId: "b" });
  assert.equal(after?.state, "maybe-sent");
  assert.match(after?.note ?? "", /不再适用；之前已经发出过一次，没确认是否送达，不会再发/);
  assert.deepEqual(h.sent.map((entry) => entry.options.messageId), ["msg-drop-2"]);
});

test("queueing asks the guard too: a message already moved past is recorded as 未发送, never queued; its id answers the same", async () => {
  const h = host({ a: running() });
  const { deferred } = await ledger(h, { guard: roundGuard({ a: "r2" }) });
  const view = await deferred.enqueue({ agentId: "a", text: "继续", messageId: "msg-late-1", key: "continue", group: "round-1", guard: { round: "r1" } }, h.paseo);
  assert.deepEqual([view.state, view.note], ["discarded", "它已经开始新的一轮，这条回复不再适用，没有发送。"]);
  assert.deepEqual(await deferred.enqueue({ agentId: "a", text: "继续", messageId: "msg-late-1", key: "continue", group: "round-1", guard: { round: "r1" } }, h.paseo), view);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.equal(h.sent.length, 0);
});

test("a guard the plugin cannot check never lets a message out: busy now, held when queued, checked again on 仍然发送", async () => {
  const h = host({ a: idle() });
  let broken = true;
  const { deferred } = await ledger(h, { guard: () => { if (broken) throw new Error("读不到轮次"); return null; } });
  const now = await deferred.send({ agentId: "a", text: "继续", messageId: "msg-unknown-1", key: "continue", guard: { round: "r1" } }, h.paseo);
  assert.deepEqual(now, { status: "busy", message: "没能确认这条消息还适用（读不到轮次），没有发送。请稍后再试。" });
  const held = await deferred.enqueue({ agentId: "a", text: "继续", messageId: "msg-unknown-2", key: "continue", guard: { round: "r1" } }, h.paseo);
  assert.deepEqual([held.state, held.note], ["held", "没能确认这条消息还适用（读不到轮次），没有发送。点「仍然发送」会再检查一次；也可以取消。"]);
  assert.equal(h.sent.length, 0);
  // 仍然发送 delivers it only once the plugin can tell it still fits.
  assert.equal((await deferred.resume("msg-unknown-2", h.paseo))?.state, "held");
  broken = false;
  assert.equal((await deferred.resume("msg-unknown-2", h.paseo))?.state, "sent");
  assert.equal(h.sent.length, 1);
  // A plugin without a check: a message with a guard never goes out.
  const other = host({ b: idle() });
  const plain = await ledger(other);
  assert.equal((await plain.deferred.send({ agentId: "b", text: "继续", messageId: "msg-unknown-3", guard: { round: "r1" } }, other.paseo)).status, "busy");
  assert.equal(other.sent.length, 0);
});

test("a group and a guard survive a reload; a file written before them loads as before", async () => {
  const h = host({ a: running() });
  const rounds = { a: "r1" };
  const first = await ledger(h, { guard: roundGuard(rounds) });
  await first.deferred.enqueue({ agentId: "a", text: "继续", messageId: "msg-reload-1", key: "continue", group: "round-1", guard: { round: "r1" } }, h.paseo);
  first.deferred.stop();
  const stored = JSON.parse(await readFile(first.file, "utf8")) as { messages: Array<{ group: string; guard: DeferredGuard }> };
  assert.deepEqual([stored.messages[0]?.group, stored.messages[0]?.guard], ["round-1", { round: "r1" }]);
  rounds.a = "r2";
  const second = await ledger(h, { guard: roundGuard(rounds) }, first.file);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  second.deferred.use(h.paseo);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([h.sent.length, (await second.deferred.list())[0]?.state], [0, "discarded"]);
  second.deferred.stop();
  // A queue file from before groups and guards: its message goes out as it always did.
  const old = join(await mkdtemp(join(tmpdir(), "kit-deferred-guard-")), "plugin", "deferred-send.json");
  await mkdir(join(old, ".."), { recursive: true });
  await writeFile(old, JSON.stringify({ version: 1, messages: [{ messageId: "msg-old-1", agentId: "b", key: "k", source: "", text: "旧消息", createdAt: h.now(), baseline: "2026-10-12T09:00:00.000Z",
    held: null, heldAt: null, attempts: 0, nextAt: 0, sendingAt: null, direct: false, behavior: "steer", outcome: null, sendId: "msg-old-1", priorIds: [], firstAttemptAt: null, lastAttemptAt: null }],
    receipts: [], sends: [] }));
  h.agents.b = idle();
  const third = await ledger(h, { guard: () => "never asked" }, old);
  third.deferred.use(h.paseo);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(h.sent.map((entry) => entry.options.messageId), ["msg-old-1"]);
  third.deferred.stop();
});
