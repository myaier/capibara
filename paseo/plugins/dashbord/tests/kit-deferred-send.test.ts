import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeferredSend, type DeferredAgentSnapshot, type DeferredPaseo } from "../server/deferred-send";
import { DeferredViewSchema, deferOffer, deferredBadge, deferredSendContracts } from "../shared/deferred-rpc";
import { sendPlan } from "../client/send-plan";

// The shared kit/deferred-send.ts (「等这一轮结束再发」): a plugin's server queue for messages that should wait for the
// agent's turn to end instead of interrupting it or cancelling a pending approval.

// A fake daemon: snapshots, sends that start a turn and record the user message with our id as its
// clientMessageId (as Paseo 0.11.1 does), and `say()` for someone else writing to the agent.
function host(agents: Record<string, DeferredAgentSnapshot>) {
  let clock = Date.parse("2026-10-12T10:00:00Z");
  const sent: { agentId: string; text: string; options: unknown }[] = [];
  const failures: unknown[] = [];
  const timelines: Record<string, { item: { type: string; text: string; clientMessageId?: string }; timestamp: string }[]> = {};
  let others = 0;
  const record = (id: string, text: string, clientMessageId: string) => {
    (timelines[id] ??= []).push({ item: { type: "user_message", text, clientMessageId }, timestamp: new Date(clock).toISOString() });
    const agent = agents[id];
    if (agent) agent.lastUserMessageAt = new Date(clock).toISOString();
  };
  const paseo: DeferredPaseo = {
    agents: {
      ref: (id) => ({
        refresh: async () => (agents[id] ? { agent: { ...agents[id] } } : null),
        send: async (text, options) => {
          const failure = failures.shift();
          if (failure) throw failure;
          sent.push({ agentId: id, text, options });
          record(id, text, options.messageId);
          const agent = agents[id];
          if (agent) agent.status = "running";
        },
        timeline: { refetch: async () => ({ entries: [...(timelines[id] ?? [])] }) },
      }),
    },
  };
  const say = (id: string) => record(id, "someone else", `external-${++others}`);
  return { agents, sent, failures, timelines, paseo, say, now: () => clock, tick: (ms: number) => { clock += ms; } };
}

async function queue(h: ReturnType<typeof host>, options: Partial<ConstructorParameters<typeof DeferredSend>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kit-deferred-"));
  const file = join(directory, "plugin", "deferred-send.json");
  const logs: string[] = [];
  const deferred = new DeferredSend({ file, pollMs: 3_600_000, now: h.now, log: (message) => logs.push(message), ...options });
  return { deferred, file, directory, logs };
}

const idle = (extra: Partial<DeferredAgentSnapshot> = {}): DeferredAgentSnapshot => ({ status: "idle", lastUserMessageAt: "2026-10-12T09:00:00.000Z", ...extra });
const running = (extra: Partial<DeferredAgentSnapshot> = {}): DeferredAgentSnapshot => ({ ...idle(extra), status: "running", activeTurn: { turnId: "t1" }, ...extra });

test("an idle agent gets the message at once; a busy one when its turn ends, with the same id and steer options", async () => {
  const h = host({ free: idle(), busy: running() });
  const { deferred } = await queue(h);
  const now = await deferred.enqueue({ agentId: "free", text: "hello", messageId: "msg-free-1", source: "技能 /review" }, h.paseo);
  assert.equal(now.state, "sent");
  assert.deepEqual(h.sent[0], { agentId: "free", text: "hello", options: { activeTurnBehavior: "steer", messageId: "msg-free-1" } });

  const later = await deferred.enqueue({ agentId: "busy", text: "after this", messageId: "msg-busy-1" }, h.paseo);
  assert.equal(later.state, "queued");
  await deferred.flush();
  assert.equal(h.sent.length, 1, "nothing goes into a running turn");
  Object.assign(h.agents.busy!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent[1], { agentId: "busy", text: "after this", options: { activeTurnBehavior: "steer", messageId: "msg-busy-1" } });
  assert.deepEqual((await deferred.list({ agentId: "busy" })).map((view) => view.state), ["sent"]);
  // The same id again returns what happened instead of queueing it twice.
  assert.equal((await deferred.enqueue({ agentId: "busy", text: "after this", messageId: "msg-busy-1" }, h.paseo)).state, "sent");
  assert.equal(h.sent.length, 2);
});

test("a pending approval keeps the message waiting; it is never sent past one", async () => {
  const h = host({ a: idle({ pendingPermissions: [{ id: "p1" }] }) });
  const { deferred } = await queue(h);
  assert.equal((await deferred.enqueue({ agentId: "a", text: "x", messageId: "msg-perm-1" }, h.paseo)).state, "queued");
  await deferred.flush();
  assert.equal(h.sent.length, 0);
  h.agents.a!.pendingPermissions = [];
  await deferred.flush();
  assert.equal(h.sent.length, 1);
});

test("one message per turn in order; the queue's own send does not count as the conversation moving on", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "first", messageId: "msg-order-1" }, h.paseo);
  h.tick(1_000);
  await deferred.enqueue({ agentId: "a", text: "second", messageId: "msg-order-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first"]);
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first"], "the first send started a turn");
  h.tick(5_000);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first", "second"]);
});

test("a message is held when someone talked to the agent after it was queued, and goes out once the user says so", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "stale?", messageId: "msg-held-1" }, h.paseo);
  h.say("a");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.equal(h.sent.length, 0);
  const [held] = await deferred.list();
  assert.equal(held?.state, "held");
  assert.match(held?.note ?? "", /新消息/);
  const resumed = await deferred.resume("msg-held-1");
  assert.equal(resumed?.state, "sent");
  assert.equal(h.sent.length, 1);
});

test("an unknown outcome holds the message for the user and does not block the next one", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "one", messageId: "msg-unknown-1" }, h.paseo);
  await deferred.enqueue({ agentId: "a", text: "two", messageId: "msg-unknown-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  h.failures.push(Object.assign(new Error("agent_request_outcome_unknown"), { code: "agent_request_outcome_unknown" }));
  await deferred.flush();
  const held = (await deferred.list()).find((view) => view.messageId === "msg-unknown-1");
  assert.equal(held?.state, "held");
  assert.match(held?.note ?? "", /可能已经送达/);
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["two"]);
  // While it waits for the user the same content is not queued twice; dropping it says it may have gone out.
  assert.equal((await deferred.enqueue({ agentId: "a", text: "one", messageId: "msg-unknown-3" }, h.paseo)).messageId, "msg-unknown-1");
  const dropped = await deferred.cancel("msg-unknown-1");
  assert.equal(dropped?.state, "maybe-sent");
  assert.match(dropped?.note ?? "", /可能已经送达/);
});

test("failed sends retry with backoff under the same id and are held after six tries", async () => {
  const h = host({ a: idle() });
  const { deferred } = await queue(h);
  h.failures.push(new Error("socket closed"));
  assert.equal((await deferred.enqueue({ agentId: "a", text: "retry me", messageId: "msg-retry-1" }, h.paseo)).state, "queued");
  await deferred.flush();
  assert.equal(h.sent.length, 0, "waits for the backoff");
  h.tick(2_000);
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => (entry.options as { messageId: string }).messageId), ["msg-retry-1"]);

  for (let index = 0; index < 6; index++) h.failures.push(new Error("daemon unavailable"));
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.enqueue({ agentId: "a", text: "give up", messageId: "msg-retry-2" }, h.paseo);
  for (let index = 0; index < 6; index++) {
    h.tick(61_000);
    await deferred.flush();
  }
  const view = (await deferred.list()).find((entry) => entry.messageId === "msg-retry-2");
  assert.equal(view?.state, "held");
  assert.match(view?.note ?? "", /多次发送失败：宿主返回：daemon unavailable/);
});

test("archived or deleted agents drop their messages; waiting more than a day expires; cancel removes one", async () => {
  const h = host({ a: running(), b: running(), c: running() });
  const { deferred } = await queue(h);
  await assert.rejects(deferred.enqueue({ agentId: "missing", text: "x", messageId: "msg-gone-0" }, h.paseo), /已归档或不存在/);
  await deferred.enqueue({ agentId: "a", text: "x", messageId: "msg-gone-1" }, h.paseo);
  await deferred.enqueue({ agentId: "b", text: "y", messageId: "msg-old-1" }, h.paseo);
  await deferred.enqueue({ agentId: "c", text: "z", messageId: "msg-cancel-1" }, h.paseo);
  h.agents.a!.archivedAt = "2026-10-12T11:00:00.000Z";
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.equal((await deferred.cancel("msg-cancel-1"))?.state, "canceled");
  const states = async () => Object.fromEntries((await deferred.list()).map((view) => [view.messageId, view.state]));
  assert.deepEqual(await states(), { "msg-gone-1": "discarded", "msg-old-1": "queued", "msg-cancel-1": "canceled" });
  h.tick(25 * 3_600_000);
  await deferred.flush();
  // Outcomes stay listed for half an hour.
  assert.deepEqual(await states(), { "msg-old-1": "expired" });
  assert.equal(h.sent.length, 0);
});

test("the queue survives a reload, and an unreadable file is set aside instead of blocking sends", async () => {
  const h = host({ a: running() });
  const { deferred, file, directory, logs } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "after reload", messageId: "msg-reload-1" }, h.paseo);
  deferred.stop();
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  const reloaded = new DeferredSend({ file, pollMs: 3_600_000, now: h.now, log: (message) => logs.push(message) });
  reloaded.use(h.paseo);
  // Wait for delivery and its durable receipt, not a timing guess that races the next file replacement under load.
  await reloaded.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["after reload"]);
  reloaded.stop();

  await writeFile(file, "{ not json");
  const fresh = new DeferredSend({ file, pollMs: 3_600_000, now: h.now, log: (message) => logs.push(message) });
  assert.deepEqual(await fresh.list(), []);
  assert.ok((await readdir(join(directory, "plugin"))).some((name) => name.startsWith("deferred-send.json.corrupt-")));
  assert.ok(logs.some((line) => line.includes("unreadable queue")));
  assert.equal(JSON.parse(await readFile(file, "utf8").catch(() => '{"version":1}')).version, 1);
});

test("server views match the shared schema; the confirm dialog offers waiting only where a send would interrupt or cancel", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "x".repeat(400), messageId: "msg-schema-1", source: "手记 #ab12" }, h.paseo);
  for (const view of await deferred.list()) {
    DeferredViewSchema.parse(view);
    assert.equal(view.preview.length, 160);
  }
  const contracts = deferredSendContracts("notes");
  assert.deepEqual(Object.values(contracts).map((contract) => contract.name), ["notes.deferred.send", "notes.deferred.enqueue", "notes.deferred.list", "notes.deferred.cancel", "notes.deferred.resume"]);

  const grok = { provider: "grok", status: "running" as const };
  assert.equal(deferOffer(grok, sendPlan(grok))?.label, "等这一轮结束再发");
  const approval = { provider: "claude", status: "running" as const, pendingPermissions: 1 };
  assert.equal(deferOffer(approval, sendPlan(approval))?.label, "等审批处理完再发");
  const claude = { provider: "claude", status: "running" as const };
  assert.equal(deferOffer(claude, sendPlan(claude)), null, "a steerable agent takes the message mid-turn");
  assert.equal(deferOffer(claude, sendPlan(claude, { text: "/review" })), null, "claude takes its skills mid-turn");
  assert.equal(deferOffer(claude, sendPlan(claude, { text: "/compact" }))?.label, "等这一轮结束再发", "but /compact replaces the turn");
  const codex = { provider: "codex", status: "running" as const };
  assert.equal(deferOffer(codex, sendPlan(codex, { text: "/review" }))?.label, "等这一轮结束再发");
  assert.equal(deferOffer({ provider: "grok", status: "idle" }, sendPlan({ provider: "grok", status: "idle" })), null);
  assert.deepEqual(deferredBadge({ state: "held" }), { label: "待确认", tone: "orange" });
  assert.deepEqual(deferredBadge({ state: "sending" }), { label: "发送中", tone: "warning" });
});

// Races and limits the 10-12 cross review found (codex-kit-F4…F7): a cancel during the idle check, queues in two
// plugins sharing one idle moment, someone else speaking around the queue's own send, a send slower than the RPC limit.
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
};

test("a cancel that lands while the queue reads the agent wins: nothing is sent", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "x", messageId: "msg-race-cancel" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  const reading = gate(), release = gate();
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => {
    const handle = ref(id);
    return { ...handle, refresh: async () => { const snapshot = await handle.refresh(); reading.open(); await release.opened; return snapshot; } };
  };
  const flushing = deferred.flush();
  await reading.opened;
  assert.equal((await deferred.cancel("msg-race-cancel"))?.state, "canceled");
  release.open();
  await flushing;
  assert.equal(h.sent.length, 0);
  assert.deepEqual((await deferred.list()).map((view) => view.state), ["canceled"]);
});

test("queues of two plugins share a per-agent lock: one idle moment gets one message", async () => {
  const h = host({ a: running() });
  const directory = await mkdtemp(join(tmpdir(), "kit-deferred-two-"));
  const first = new DeferredSend({ file: join(directory, "one", "deferred-send.json"), pollMs: 3_600_000, now: h.now, log: () => undefined });
  const second = new DeferredSend({ file: join(directory, "two", "deferred-send.json"), pollMs: 3_600_000, now: h.now, log: () => undefined });
  await first.enqueue({ agentId: "a", text: "from one", messageId: "msg-lock-1" }, h.paseo);
  await second.enqueue({ agentId: "a", text: "from two", messageId: "msg-lock-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await Promise.all([first.flush(), second.flush()]);
  assert.equal(h.sent.length, 1, "the second queue finds the lock or the new turn");
  h.tick(10_000);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await Promise.all([first.flush(), second.flush()]);
  // The lock file tells every queue which ids any of them sent: the other plugin's message goes out on the next turn.
  assert.equal(h.sent.length, 2, "one message per turn, both delivered");
  const views = [...(await first.list()), ...(await second.list())];
  assert.deepEqual(views.map((view) => view.state).sort(), ["sent", "sent"]);
  first.stop();
  second.stop();
});

test("only a lastUserMessageAt from the queue's own send keeps later messages current; anyone else's holds them", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "first", messageId: "msg-own-1" }, h.paseo);
  await deferred.enqueue({ agentId: "a", text: "second", messageId: "msg-own-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first"]);
  // Someone else writes to the agent after the queue's send, then the turn ends.
  h.tick(20_000);
  h.say("a");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first"]);
  assert.equal((await deferred.list()).find((view) => view.messageId === "msg-own-2")?.state, "held");
});

test("「仍然发送」 takes the conversation as it is then; a message after that OK holds it again, and a stale one expires", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "x", messageId: "msg-resume-1" }, h.paseo);
  h.say("a");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.equal((await deferred.list())[0]?.state, "held");
  Object.assign(h.agents.a!, { status: "running", activeTurn: { turnId: "t2" } });
  assert.equal((await deferred.resume("msg-resume-1", h.paseo))?.state, "queued");
  h.tick(60_000);
  h.say("a");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.equal(h.sent.length, 0);
  assert.equal((await deferred.list())[0]?.state, "held");
  h.tick(25 * 3_600_000);
  assert.equal((await deferred.resume("msg-resume-1", h.paseo))?.state, "expired");
  assert.equal(h.sent.length, 0);
});

test("enqueue answers within its wait even when the send is slow; the send still finishes and is recorded", async () => {
  const h = host({ a: idle() });
  const directory = await mkdtemp(join(tmpdir(), "kit-deferred-slow-"));
  const deferred = new DeferredSend({ file: join(directory, "p", "deferred-send.json"), pollMs: 3_600_000, answerWaitMs: 50, now: h.now, log: () => undefined });
  const release = gate();
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => {
    const handle = ref(id);
    return { ...handle, send: async (text, options) => { await release.opened; await handle.send(text, options); } };
  };
  const answered = await deferred.enqueue({ agentId: "a", text: "slow", messageId: "msg-slow-1" }, h.paseo);
  assert.equal(answered.state, "sending");
  release.open();
  await deferred.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await deferred.list())[0]?.state, "sent");
  assert.equal(h.sent.length, 1);
  deferred.stop();
});

// Second review round (codex-kit recheck): stale-lock takeovers, where `lastUserMessageAt` came from, failed-then-resumed.
test("a message from someone else right after the queue's own send still holds the next one", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "first", messageId: "msg-attr-1" }, h.paseo);
  await deferred.enqueue({ agentId: "a", text: "second", messageId: "msg-attr-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  // Half a second later the user types into the conversation, then the turn ends.
  h.tick(500);
  h.say("a");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first"]);
  assert.equal((await deferred.list()).find((view) => view.messageId === "msg-attr-2")?.state, "held");
});

test("a send the daemon accepted before its reply was lost counts as the queue's own on the replay", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "first", messageId: "msg-replay-1" }, h.paseo);
  await deferred.enqueue({ agentId: "a", text: "second", messageId: "msg-replay-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  const accepted = new Set<string>();
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => {
    const handle = ref(id);
    return {
      ...handle,
      send: async (text, options) => {
        if (accepted.has(options.messageId)) return; // the daemon replays its receipt: nothing new happens
        accepted.add(options.messageId);
        await handle.send(text, options);
        if (options.messageId === "msg-replay-1" && accepted.size === 1) throw new Error("connection reset");
      },
    };
  };
  await deferred.flush();
  assert.equal((await deferred.list()).find((view) => view.messageId === "msg-replay-1")?.state, "queued");
  h.tick(2_000);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.equal((await deferred.list()).find((view) => view.messageId === "msg-replay-1")?.state, "sent");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first", "second"], "the second one is not held: the change was the queue's own");
});

test("a message held after failed sends and then resumed is checked against the conversation again", async () => {
  const h = host({ a: idle() });
  const { deferred } = await queue(h);
  for (let index = 0; index < 6; index++) h.failures.push(new Error("daemon unavailable"));
  await deferred.enqueue({ agentId: "a", text: "x", messageId: "msg-failed-resume" }, h.paseo);
  for (let index = 0; index < 6; index++) {
    h.tick(61_000);
    await deferred.flush();
  }
  assert.equal((await deferred.list())[0]?.state, "held");
  Object.assign(h.agents.a!, { status: "running", activeTurn: { turnId: "t3" } });
  // Its last send is two minutes old and the timeline shows it never arrived: it goes back in the queue.
  h.tick(121_000);
  assert.equal((await deferred.resume("msg-failed-resume", h.paseo))?.state, "queued");
  h.tick(60_000);
  h.say("a");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.equal(h.sent.length, 0);
  assert.equal((await deferred.list())[0]?.state, "held");
});

test("many queues at one idle moment send exactly one message; the others wait for their turn", async () => {
  for (let round = 0; round < 5; round++) {
    const h = host({ a: running() });
    const directory = await mkdtemp(join(tmpdir(), "kit-deferred-many-"));
    const queues = Array.from({ length: 8 }, (_, index) => new DeferredSend({ file: join(directory, `p${index}`, "deferred-send.json"), pollMs: 3_600_000, now: h.now, log: () => undefined }));
    for (const [index, queue] of queues.entries()) await queue.enqueue({ agentId: "a", text: `m${index}`, messageId: `msg-many-${round}-${index}` }, h.paseo);
    Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
    await Promise.all(queues.map((queue) => queue.flush()));
    assert.equal(h.sent.length, 1, `round ${round}`);
    for (const queue of queues) queue.stop();
  }
});

test("a lock held by another process makes the queue wait; it is free again once that process ends, even by a crash", async (t) => {
  const h = host({ a: running() });
  const { deferred, directory } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "x", messageId: "msg-proc-lock" }, h.paseo);
  await new Promise((resolve) => setTimeout(resolve, 50)); // the queue's first look, while the agent still runs
  await mkdir(join(directory, ".deferred-send-locks"), { recursive: true });
  const holder = spawn(process.execPath, ["--input-type=module", "-e", [
    `import { DatabaseSync } from "node:sqlite";`,
    `const db = new DatabaseSync(${JSON.stringify(join(directory, ".deferred-send-locks", "a.lock.db"))}, { timeout: 0 });`,
    `db.exec("BEGIN EXCLUSIVE");`,
    `process.stdout.write("held");`,
    `setInterval(() => {}, 1000);`,
  ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { holder.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.once("data", () => resolve());
    holder.once("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.equal(h.sent.length, 0, "another process holds the agent's lock");
  holder.kill("SIGKILL");
  await new Promise((resolve) => (holder.exitCode !== null || holder.signalCode !== null ? resolve(null) : holder.once("exit", resolve)));
  await deferred.flush();
  assert.equal(h.sent.length, 1, "the OS dropped the crashed holder's lock");
  deferred.stop();
});
test("someone else's message that lands while the queue's own send is still answering holds the next one", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "first", messageId: "msg-during-1" }, h.paseo);
  await deferred.enqueue({ agentId: "a", text: "second", messageId: "msg-during-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => {
    const handle = ref(id);
    return { ...handle, send: async (text, options) => { await handle.send(text, options); h.say(id); } };
  };
  await deferred.flush();
  h.paseo.agents.ref = ref;
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first"]);
  assert.equal((await deferred.list()).find((view) => view.messageId === "msg-during-2")?.state, "held");
});

test("when the timeline cannot be read the message waits and is tried again, it is not held", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "first", messageId: "msg-tl-1" }, h.paseo);
  await deferred.enqueue({ agentId: "a", text: "second", messageId: "msg-tl-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => ({ ...ref(id), timeline: { refetch: async () => { throw new Error("socket closed"); } } });
  await deferred.flush();
  assert.equal((await deferred.list()).find((view) => view.messageId === "msg-tl-2")?.state, "queued");
  h.paseo.agents.ref = ref;
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first", "second"]);
});

test("a stop that lands right before the send means nothing is sent, and the claim is undone", async () => {
  const h = host({ a: idle() });
  const { deferred } = await queue(h);
  const enqueue = await deferred.enqueue({ agentId: "a", text: "x", messageId: "msg-stop-1" }, h.paseo);
  assert.equal(enqueue.state, "sent");
  // A second message: stop while its claim is being written.
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  const pending = deferred.enqueue({ agentId: "a", text: "y", messageId: "msg-stop-2" }, h.paseo);
  deferred.stop();
  await pending.catch(() => undefined);
  assert.equal(h.sent.length, 1);
});

// Fourth review round (codex-kit recheck4): a lock file that cannot be used, the latest user message far back.
test("a lock file that cannot be used never lets a message out unguarded; after a few tries the message asks the user", async () => {
  const h = host({ a: running() });
  const { deferred, directory } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "x", messageId: "msg-bad-lock" }, h.paseo);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await mkdir(join(directory, ".deferred-send-locks"), { recursive: true });
  await writeFile(join(directory, ".deferred-send-locks", "a.lock.db"), "this is not a database, it only looks like one".repeat(200));
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  for (let attempt = 0; attempt < 5; attempt++) await deferred.flush();
  assert.equal(h.sent.length, 0);
  const [view] = await deferred.list();
  assert.equal(view?.state, "held");
  assert.match(view?.note ?? "", /拿不到发送锁/);
  deferred.stop();
});

test("the latest user message is found further back than one page; a message without an id reads as unsure", async () => {
  const h = host({ a: running() });
  const { deferred } = await queue(h);
  await deferred.enqueue({ agentId: "a", text: "first", messageId: "msg-page-1" }, h.paseo);
  await deferred.enqueue({ agentId: "a", text: "second", messageId: "msg-page-2" }, h.paseo);
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  // The first send's turn runs long: 250 timeline entries after our user message.
  const ref = h.paseo.agents.ref;
  const tail = Array.from({ length: 250 }, (_, index) => ({ item: { type: "tool_call", text: `step ${index}` } }));
  h.paseo.agents.ref = (id) => {
    const handle = ref(id);
    return {
      ...handle,
      timeline: {
        refetch: async (options: { direction: string; cursor?: unknown }) => {
          const full = [...((await handle.timeline.refetch({ direction: "tail", limit: 1000, projection: "projected" })) as { entries: unknown[] }).entries, ...tail];
          const end = options.direction === "tail" ? full.length : (options.cursor as number);
          const start = Math.max(0, end - 100);
          return { entries: full.slice(start, end), startCursor: start, hasOlder: start > 0 };
        },
      },
    };
  };
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null });
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["first", "second"], "found on the third page: our own");
  h.paseo.agents.ref = ref;

  const other = host({ b: running() });
  const second = await queue(other);
  await second.deferred.enqueue({ agentId: "b", text: "x", messageId: "msg-unsure-1" }, other.paseo);
  other.agents.b!.lastUserMessageAt = new Date(other.now() + 1000).toISOString();
  const otherRef = other.paseo.agents.ref;
  other.paseo.agents.ref = (id) => ({ ...otherRef(id), timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message", text: "no id" } }] }) } });
  Object.assign(other.agents.b!, { status: "idle", activeTurn: null });
  await second.deferred.flush();
  const [view] = await second.deferred.list();
  assert.equal(view?.state, "held");
  assert.match(view?.note ?? "", /分不清/);
});

// Sending now through the ledger (codex-deferred recheck R1–R4, R7): the server plans again at the moment of sending,
// one message per agent and content is on its way, and a send with a lost reply is held instead of forgotten.
const unknownOutcome = () => Object.assign(new Error("agent_request_outcome_unknown"), { code: "agent_request_outcome_unknown" });
const lookForSent = (deferred: DeferredSend) => (deferred as unknown as { lookForSent(): Promise<void> }).lookForSent();

test("sending now plans from the agent as it is: an idle one gets it at once, a steerable running one mid-turn", async () => {
  const h = host({ free: idle({ provider: "grok" }), busy: running({ provider: "claude" }) });
  const { deferred } = await queue(h);
  const now = await deferred.send({ agentId: "free", text: "hello", messageId: "msg-now-1", key: "k-hello" }, h.paseo);
  assert.equal(now.status, "sent");
  assert.deepEqual(h.sent[0], { agentId: "free", text: "hello", options: { activeTurnBehavior: "interrupt", messageId: "msg-now-1" } });
  const steer = await deferred.send({ agentId: "busy", text: "also this", messageId: "msg-now-2" }, h.paseo);
  assert.equal(steer.status, "sent");
  assert.deepEqual(h.sent[1]?.options, { activeTurnBehavior: "steer", messageId: "msg-now-2" });
  // The same id again answers with what happened; nothing goes out twice.
  assert.equal((await deferred.send({ agentId: "free", text: "hello", messageId: "msg-now-1", key: "k-hello" }, h.paseo)).status, "sent");
  assert.equal(h.sent.length, 2);
  for (const view of await deferred.list()) DeferredViewSchema.parse(view);
  assert.equal((await deferred.send({ agentId: "missing", text: "x", messageId: "msg-now-3" }, h.paseo)).status, "gone");
});

test("sending now asks again whenever the consent no longer covers what the send would do (R1)", async () => {
  const h = host({ a: running({ provider: "grok" }) });
  const { deferred } = await queue(h);
  // grok cannot steer: the send would interrupt the turn.
  const ask = await deferred.send({ agentId: "a", text: "stop and do this", messageId: "msg-consent-1" }, h.paseo);
  assert.equal(ask.status, "confirm");
  assert.ok(ask.status === "confirm");
  assert.deepEqual(ask.consent, { interrupt: true, approvals: [], turn: "t1" });
  assert.match(ask.plan.confirm, /中断/);
  assert.equal(h.sent.length, 0);
  // The user agreed to interrupting the turn; meanwhile an approval came up: cancelling it needs a new OK.
  h.agents.a!.pendingPermissions = [{ id: "perm-1" }];
  const again = await deferred.send({ agentId: "a", text: "stop and do this", messageId: "msg-consent-1", consent: ask.consent }, h.paseo);
  assert.ok(again.status === "confirm");
  assert.deepEqual(again.consent, { interrupt: true, approvals: ["perm-1"], turn: "t1" });
  assert.match(again.plan.confirm, /取消这次审批/);
  assert.equal(h.sent.length, 0);
  const sent = await deferred.send({ agentId: "a", text: "stop and do this", messageId: "msg-consent-1", consent: again.consent }, h.paseo);
  assert.equal(sent.status, "sent");
  assert.deepEqual(h.sent[0]?.options, { activeTurnBehavior: "interrupt", messageId: "msg-consent-1" });
  // Planned while the agent was idle (no consent), sent while it runs: asked first.
  const h2 = host({ b: running({ provider: "grok" }) });
  const second = await queue(h2);
  assert.equal((await second.deferred.send({ agentId: "b", text: "x", messageId: "msg-consent-2", consent: null }, h2.paseo)).status, "confirm");
  assert.equal(h2.sent.length, 0);
  // The OK was for turn t1; t1 ended and t2 runs now: interrupting t2 needs its own OK (codex-deferred r3-F1).
  const okForT1 = (await second.deferred.send({ agentId: "b", text: "y", messageId: "msg-consent-3" }, h2.paseo)) as { consent: unknown };
  h2.agents.b!.activeTurn = { turnId: "t2", startedAt: "2026-10-12T10:05:00.000Z" };
  const t2 = await second.deferred.send({ agentId: "b", text: "y", messageId: "msg-consent-3", consent: okForT1.consent as never }, h2.paseo);
  assert.equal(t2.status, "confirm");
  assert.equal(h2.sent.length, 0);
});

test("custom provider ids are planned with the daemon's capabilities; a slash command that replaces the turn asks", async () => {
  const h = host({ a: running({ provider: "my-claude" }), b: running({ provider: "my-claude" }) });
  const { deferred } = await queue(h, { capabilities: async () => ({ steerable: ["my-claude"], slashSteerable: ["my-claude"], bases: { "my-claude": "claude" } }) });
  assert.equal((await deferred.send({ agentId: "a", text: "/review", messageId: "msg-caps-1" }, h.paseo)).status, "sent");
  assert.deepEqual(h.sent[0]?.options, { activeTurnBehavior: "steer", messageId: "msg-caps-1" });
  const compact = await deferred.send({ agentId: "b", text: "/compact", messageId: "msg-caps-2", what: "命令" }, h.paseo);
  assert.ok(compact.status === "confirm");
  assert.match(compact.plan.confirm, /这条命令不能插进当前回合/);
  // Without the capabilities the custom id is read cautiously: interrupting needs an OK.
  const cautious = await queue(h);
  assert.equal((await cautious.deferred.send({ agentId: "a", text: "hi", messageId: "msg-caps-3" }, h.paseo)).status, "confirm");
});

test("one message per agent and content is on its way: queueing, sending now and two clients at once all get it (R2, R7)", async () => {
  const h = host({ a: running({ provider: "grok" }) });
  const { deferred } = await queue(h);
  assert.equal((await deferred.enqueue({ agentId: "a", text: "/review", messageId: "msg-key-1", key: "skills-review" }, h.paseo)).state, "queued");
  const direct = await deferred.send({ agentId: "a", text: "/review", messageId: "msg-key-2", key: "skills-review", consent: { interrupt: true, approvals: [] } }, h.paseo);
  assert.ok(direct.status === "existing");
  assert.equal(direct.view.messageId, "msg-key-1");
  assert.equal((await deferred.enqueue({ agentId: "a", text: "/review", messageId: "msg-key-3", key: "skills-review" }, h.paseo)).messageId, "msg-key-1");
  assert.equal((await deferred.enqueue({ agentId: "a", text: "/test", messageId: "msg-key-4", key: "skills-test" }, h.paseo)).messageId, "msg-key-4");
  // A key carried in a `<uuid>~<key>` id (queued before keys were explicit) counts too.
  assert.equal((await deferred.enqueue({ agentId: "a", text: "x", messageId: "legacy-uuid~k-legacy" }, h.paseo)).state, "queued");
  assert.equal((await deferred.send({ agentId: "a", text: "x", messageId: "msg-key-5", key: "k-legacy" }, h.paseo)).status, "existing");
  assert.equal(h.sent.length, 0);

  // Two clients at the same moment, sending now and queueing the same content: one message goes out.
  for (const pair of [["send", "send"], ["enqueue", "enqueue"], ["send", "enqueue"]] as const) {
    const h2 = host({ b: idle({ provider: "claude" }) });
    const two = await queue(h2);
    const call = (kind: "send" | "enqueue", id: string) => kind === "send"
      ? two.deferred.send({ agentId: "b", text: "go", messageId: id, key: "same" }, h2.paseo).then((result) => ("view" in result ? result.view.messageId : result.status))
      : two.deferred.enqueue({ agentId: "b", text: "go", messageId: id, key: "same" }, h2.paseo).then((view) => view.messageId);
    const answers = await Promise.all([call(pair[0], `msg-race-${pair.join("-")}-x`), call(pair[1], `msg-race-${pair.join("-")}-y`)]);
    assert.equal(h2.sent.length, 1, pair.join("/"));
    assert.equal(answers[0], answers[1], `${pair.join("/")}: both answer with the message that went out`);
  }
});

test("a send now with a lost reply is held; once the agent's timeline shows it, it counts as sent (R3, R4)", async () => {
  const h = host({ a: idle({ provider: "claude" }), c: idle({ provider: "claude" }) });
  const { deferred } = await queue(h);
  const ref = h.paseo.agents.ref;
  let lose = 1;
  h.paseo.agents.ref = (id) => {
    const handle = ref(id);
    return { ...handle, send: async (text, options) => { await handle.send(text, options); if (lose-- > 0) throw unknownOutcome(); } };
  };
  const lost = await deferred.send({ agentId: "a", text: "did it go?", messageId: "msg-lost-1", key: "k-lost" }, h.paseo);
  assert.ok(lost.status === "held");
  assert.match(lost.view.note, /可能已经送达/);
  // The same content again, from this or any client, after a reload too: the held message answers.
  assert.equal((await deferred.send({ agentId: "a", text: "did it go?", messageId: "msg-lost-2", key: "k-lost" }, h.paseo)).status, "existing");
  assert.equal(h.sent.length, 1);
  // The agent is loaded and its timeline carries our id: it did go out.
  await lookForSent(deferred);
  const found = (await deferred.list()).find((view) => view.messageId === "msg-lost-1");
  assert.equal(found?.state, "sent");
  assert.match(found?.note ?? "", /找到了/);

  // An agent the daemon has not loaded is not read (that would load it).
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async () => { throw unknownOutcome(); } });
  assert.equal((await deferred.send({ agentId: "c", text: "closed", messageId: "msg-lost-4" }, h.paseo)).status, "held");
  h.agents.c!.status = "closed";
  let reads = 0;
  h.paseo.agents.ref = (id) => ({ ...ref(id), timeline: { refetch: async () => { reads++; return { entries: [] }; } } });
  h.tick(61_000);
  await lookForSent(deferred);
  assert.equal(reads, 0);
});

// What Paseo 0.11.1 does with a message id (server/message-receipts): a pending receipt is written before the send and
// marked completed after it; a send that throws leaves it pending, and the same id is refused from then on.
function receipts(h: ReturnType<typeof host>) {
  const state = new Map<string, "pending" | "completed">();
  const ref = h.paseo.agents.ref;
  const crash: string[] = [];
  h.paseo.agents.ref = (id) => {
    const handle = ref(id);
    return {
      ...handle,
      send: async (text, options) => {
        const receipt = state.get(options.messageId);
        if (receipt === "completed") return;
        if (receipt === "pending") throw unknownOutcome();
        state.set(options.messageId, "pending");
        if (crash.includes(options.messageId)) throw new Error("provider exploded"); // after the receipt, before the turn
        await handle.send(text, options);
        state.set(options.messageId, "completed");
      },
    };
  };
  return { state, crash };
}

test("a send Paseo took and then failed is never retried under its id forever: 「仍然发送」 looks first, then resends once", async () => {
  const h = host({ a: idle({ provider: "claude" }) });
  const { deferred } = await queue(h);
  const daemon = receipts(h);
  daemon.crash.push("msg-pending-1");
  await deferred.enqueue({ agentId: "a", text: "please run the tests", messageId: "msg-pending-1" }, h.paseo);
  // The first send failed after the receipt; the automatic retry gets "outcome unknown" from then on.
  h.tick(3_000);
  await deferred.flush();
  let view: { state: string; note: string; messageId: string } | null | undefined = (await deferred.list())[0];
  assert.equal(view?.state, "held");
  assert.match(view?.note ?? "", /可能已经送达/);
  assert.equal(h.sent.length, 0);
  // Right away: the timeline shows nothing yet, but the send may still be on its way inside the daemon.
  assert.match((await deferred.resume("msg-pending-1", h.paseo))?.note ?? "", /可能还在进行/);
  assert.equal(h.sent.length, 0);
  // Two minutes on, still not in the timeline: it goes out once more, under a new id the daemon has not seen.
  h.tick(121_000);
  view = await deferred.resume("msg-pending-1", h.paseo);
  assert.equal(view?.state, "sent");
  assert.equal(view?.messageId, "msg-pending-1", "the client's id stays the message's name");
  assert.equal(h.sent.length, 1);
  const sentId = (h.sent[0]!.options as { messageId: string }).messageId;
  assert.notEqual(sentId, "msg-pending-1");
  assert.equal(daemon.state.get("msg-pending-1"), "pending");
  assert.equal(daemon.state.get(sentId), "completed");
  assert.equal(h.timelines.a!.filter((entry) => entry.item.text === "please run the tests").length, 1, "one copy in the conversation");
});

test("「仍然发送」 marks a message sent when the timeline already has it, and says so when it cannot tell", async () => {
  const h = host({ a: idle({ provider: "claude" }), b: idle({ provider: "claude" }), c: idle({ provider: "claude" }) });
  const { deferred } = await queue(h);
  const ref = h.paseo.agents.ref;
  // The daemon took it (the turn started), but the reply never came back.
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async (text, options) => { await ref(id).send(text, options); throw unknownOutcome(); } });
  assert.equal((await deferred.send({ agentId: "a", text: "arrived", messageId: "msg-look-1" }, h.paseo)).status, "held");
  h.paseo.agents.ref = ref;
  const found = await deferred.resume("msg-look-1", h.paseo);
  assert.equal(found?.state, "sent");
  assert.match(found?.note ?? "", /找到了/);
  assert.equal(h.sent.length, 1, "not sent again");

  // A very long conversation since: the earlier send is further back than the look goes.
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async () => { throw unknownOutcome(); } });
  assert.equal((await deferred.send({ agentId: "b", text: "lost", messageId: "msg-look-2" }, h.paseo)).status, "held");
  const later = new Date(h.now() + 1_000).toISOString();
  h.paseo.agents.ref = (id) => ({
    ...ref(id),
    timeline: { refetch: async () => ({ entries: Array.from({ length: 100 }, () => ({ item: { type: "tool_call" }, timestamp: later })), hasOlder: true, startCursor: { epoch: "e", seq: 1 } }) },
  });
  h.tick(121_000);
  const unsure = await deferred.resume("msg-look-2", h.paseo);
  assert.equal(unsure?.state, "held");
  assert.match(unsure?.note ?? "", /没法确认/);
  // The timeline cannot be read at all.
  h.paseo.agents.ref = (id) => ({ ...ref(id), timeline: { refetch: async () => { throw new Error("socket closed"); } } });
  const unreadable = await deferred.resume("msg-look-2", h.paseo);
  assert.equal(unreadable?.state, "held");
  assert.match(unreadable?.note ?? "", /读不到会话记录/);
  assert.equal(h.sent.length, 1);
  // Dropping it says it may have gone out; a failed one just stops.
  assert.equal((await deferred.cancel("msg-look-2"))?.state, "maybe-sent");
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async () => { throw new Error("provider exploded"); } });
  assert.equal((await deferred.send({ agentId: "c", text: "failed", messageId: "msg-look-3" }, h.paseo)).status, "held");
  const canceled = await deferred.cancel("msg-look-3");
  assert.equal(canceled?.state, "canceled");
  assert.match(canceled?.note ?? "", /不再重试/);
});

test("a failed send now is held with the reason; a send whose process ended mid-way is never repeated by itself", async () => {
  const h = host({ a: idle({ provider: "claude" }), b: idle({ provider: "claude" }) });
  const { deferred, file } = await queue(h);
  h.failures.push(new Error("provider exploded"));
  const failed = await deferred.send({ agentId: "a", text: "retry later", messageId: "msg-fail-1" }, h.paseo);
  assert.ok(failed.status === "held");
  assert.match(failed.view.note, /发送失败：宿主返回：provider exploded/);
  // Known causes read in Chinese.
  h.failures.push(new Error("claude run did not start within 60 seconds (phase: run start)"));
  const slow = await deferred.send({ agentId: "a", text: "slow start", messageId: "msg-fail-2" }, h.paseo);
  assert.ok(slow.status === "held");
  assert.match(slow.view.note, /发送失败：Agent 在 60 秒内没有开始这一轮/);
  assert.equal((await deferred.cancel("msg-fail-2"))?.state, "canceled");
  assert.equal((await deferred.cancel("msg-fail-1"))?.state, "canceled");

  deferred.stop();
  const store = JSON.parse(await readFile(file, "utf8"));
  store.messages.push({
    messageId: "msg-orphan-1", agentId: "b", key: "k-orphan", source: "", text: "half way", createdAt: h.now(), baseline: null,
    held: null, heldAt: null, attempts: 1, nextAt: 0, sendingAt: h.now(), direct: true, behavior: "interrupt", outcome: null,
  });
  await writeFile(file, JSON.stringify(store));
  const reloaded = new DeferredSend({ file, pollMs: 3_600_000, now: h.now, log: () => undefined });
  reloaded.use(h.paseo);
  await reloaded.flush();
  assert.equal(h.sent.length, 0);
  const orphan = (await reloaded.list()).find((view) => view.messageId === "msg-orphan-1");
  assert.equal(orphan?.state, "held");
  assert.match(orphan?.note ?? "", /可能已经送达/);
  reloaded.stop();
});

test("sending now waits a little for another ledger's send to the same agent, then answers busy without sending", async (t) => {
  const h = host({ a: idle({ provider: "claude" }) });
  const { deferred, directory } = await queue(h);
  await mkdir(join(directory, ".deferred-send-locks"), { recursive: true });
  const holder = spawn(process.execPath, ["--input-type=module", "-e", [
    `import { DatabaseSync } from "node:sqlite";`,
    `const db = new DatabaseSync(${JSON.stringify(join(directory, ".deferred-send-locks", "a.lock.db"))}, { timeout: 0 });`,
    `db.exec("BEGIN EXCLUSIVE");`,
    `process.stdout.write("held");`,
    `setInterval(() => {}, 1000);`,
  ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { holder.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.once("data", () => resolve());
    holder.once("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  const started = Date.now();
  const answer = await deferred.send({ agentId: "a", text: "x", messageId: "msg-busy-1" }, h.paseo);
  assert.equal(answer.status, "busy");
  assert.ok(Date.now() - started < 10_000);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await deferred.list(), [], "nothing is recorded: the same id can be tried again");
  holder.kill("SIGKILL");
  await new Promise((resolve) => (holder.exitCode !== null || holder.signalCode !== null ? resolve(null) : holder.once("exit", resolve)));
  assert.equal((await deferred.send({ agentId: "a", text: "x", messageId: "msg-busy-1" }, h.paseo)).status, "sent");
  deferred.stop();
});

// Third review round (codex-deferred r3): the plan follows the agent read last, a rebuilt timeline is not proof of
// absence, every call that answers an RPC answers in time, and host errors read in Chinese.
test("the daemon's capabilities are read before the agent: an approval that shows up meanwhile is asked about (r3-F2)", async () => {
  const h = host({ a: idle({ provider: "grok" }) });
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const { deferred } = await queue(h, { capabilities: async () => { await slow; return {}; } });
  const answer = deferred.send({ agentId: "a", text: "go", messageId: "msg-caps-slow" }, h.paseo);
  await new Promise((resolve) => setTimeout(resolve, 30));
  Object.assign(h.agents.a!, { status: "running", activeTurn: { turnId: "t9" }, pendingPermissions: [{ id: "new-approval" }] });
  release();
  const result = await answer;
  assert.equal(result.status, "confirm");
  assert.equal(h.sent.length, 0);
});

test("a timeline rebuilt from the provider's history (no client ids) is not taken as proof the message never arrived (r3-F3)", async () => {
  const h = host({ a: idle({ provider: "claude" }), b: idle({ provider: "claude" }) });
  const { deferred } = await queue(h);
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async (text, options) => { await ref(id).send(text, options); throw unknownOutcome(); } });
  assert.equal((await deferred.send({ agentId: "a", text: "same words", messageId: "msg-hist-1" }, h.paseo)).status, "held");
  h.paseo.agents.ref = ref;
  // Reloaded from the provider's history: the same message, without our id.
  for (const entry of h.timelines.a!) delete entry.item.clientMessageId;
  h.tick(121_000);
  const found = await deferred.resume("msg-hist-1", h.paseo);
  assert.equal(found?.state, "sent");
  assert.equal(h.sent.length, 1, "not sent a second time");

  // Lost, and a message of unknown origin with other words came in since: it cannot be told apart, so it waits.
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async () => { throw unknownOutcome(); } });
  assert.equal((await deferred.send({ agentId: "b", text: "mine", messageId: "msg-hist-2" }, h.paseo)).status, "held");
  h.paseo.agents.ref = ref;
  h.timelines.b = [{ item: { type: "user_message", text: "someone else, no id" }, timestamp: new Date(h.now() + 1_000).toISOString() }];
  h.tick(121_000);
  const unsure = await deferred.resume("msg-hist-2", h.paseo);
  assert.equal(unsure?.state, "held");
  assert.match(unsure?.note ?? "", /分不清来源/);
  assert.equal(h.sent.length, 1);
});

test("calls that answer an RPC answer within their budget, and nothing goes out after they gave up (r3-F4)", async () => {
  const h = host({ a: idle({ provider: "claude" }), b: idle({ provider: "claude" }) });
  const { deferred } = await queue(h, { rpcBudgetMs: 200 });
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => ({ ...ref(id), refresh: async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return ref(id).refresh(); } });
  const started = Date.now();
  await assert.rejects(deferred.send({ agentId: "a", text: "late", messageId: "msg-budget-1" }, h.paseo), /超时/);
  assert.ok(Date.now() - started < 1_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(h.sent.length, 0, "the slow read finished later, but nothing was sent");
  assert.deepEqual(await deferred.list(), []);

  // 「仍然发送」 that has to page far back stops at the budget and says it could not tell.
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async () => { throw unknownOutcome(); } });
  assert.equal((await deferred.send({ agentId: "b", text: "far", messageId: "msg-budget-2" }, h.paseo)).status, "held");
  const later = new Date(h.now() + 1_000).toISOString();
  h.paseo.agents.ref = (id) => ({
    ...ref(id),
    timeline: { refetch: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return { entries: [{ item: { type: "tool_call" }, timestamp: later }], hasOlder: true, startCursor: { epoch: "e", seq: 1 } }; } },
  });
  h.tick(121_000);
  const begun = Date.now();
  const view = await deferred.resume("msg-budget-2", h.paseo);
  assert.ok(Date.now() - begun < 1_000);
  assert.equal(view?.state, "held");
  assert.match(view?.note ?? "", /读不到会话记录/);
});

test("a turn that is still ending reads as such in Chinese (r3-F9)", async () => {
  const h = host({ a: idle({ provider: "grok" }) });
  const { deferred } = await queue(h);
  h.failures.push(new Error("A foreground turn is already active"));
  const held = await deferred.send({ agentId: "a", text: "busy", messageId: "msg-acp-1" }, h.paseo);
  assert.ok(held.status === "held");
  assert.match(held.view.note, /发送失败：Agent 还在结束上一轮/);
});

// Fourth review round (codex-deferred r4): the whole request keeps its budget, and earlier words are not this send.
test("words like these from before the first send are an earlier message, not proof this one arrived (r4-F3)", async () => {
  const h = host({ a: idle({ provider: "claude" }) });
  const { deferred } = await queue(h);
  // Thirty seconds earlier the user had sent the same words; the timeline was rebuilt and lost every client id.
  h.timelines.a = [{ item: { type: "user_message", text: "run tests" }, timestamp: new Date(h.now()).toISOString() }];
  h.tick(30_000);
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async () => { throw unknownOutcome(); } });
  assert.equal((await deferred.send({ agentId: "a", text: "run tests", messageId: "msg-prior-1" }, h.paseo)).status, "held");
  h.paseo.agents.ref = ref;
  h.tick(121_000);
  const view = await deferred.resume("msg-prior-1", h.paseo);
  assert.equal(view?.state, "held", "not marked sent on the strength of the earlier message");
  assert.equal(h.sent.length, 0);

  // The same words after the first send: in the conversation already, so not sent again, and said so plainly.
  h.paseo.agents.ref = (id) => ({ ...ref(id), send: async () => { throw unknownOutcome(); } });
  assert.equal((await deferred.send({ agentId: "a", text: "deploy", messageId: "msg-prior-2" }, h.paseo)).status, "held");
  h.paseo.agents.ref = ref;
  h.timelines.a.push({ item: { type: "user_message", text: "deploy" }, timestamp: new Date(h.now() + 500).toISOString() });
  h.tick(121_000);
  const same = await deferred.resume("msg-prior-2", h.paseo);
  assert.equal(same?.state, "sent");
  assert.match(same?.note ?? "", /同样内容/);
  assert.equal(h.sent.length, 0);
});

test("a ledger write that ends past the request's budget takes the record back: nothing goes out (r4-F1)", async () => {
  const h = host({ a: idle({ provider: "claude" }) });
  const { deferred } = await queue(h, { rpcBudgetMs: 150 });
  const target = deferred as unknown as { change: (update: unknown) => Promise<unknown> };
  const change = target.change.bind(deferred);
  let slow = true;
  target.change = async (update) => {
    const result = await change(update);
    if (slow) { slow = false; await new Promise((resolve) => setTimeout(resolve, 300)); }
    return result;
  };
  const answer = await deferred.send({ agentId: "a", text: "too late", messageId: "msg-late-1" }, h.paseo);
  assert.equal(answer.status, "busy");
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await deferred.list(), [], "the record was taken back: the same id can be sent again");
  assert.equal((await deferred.send({ agentId: "a", text: "too late", messageId: "msg-late-1" }, h.paseo)).status, "sent");
});

test("a request that first waited for another one with the same content still answers within its own budget (r4-F1)", async () => {
  const h = host({ a: running({ provider: "grok" }) });
  const { deferred } = await queue(h, { rpcBudgetMs: 400, sendWaitMs: 300 });
  const ref = h.paseo.agents.ref;
  h.paseo.agents.ref = (id) => ({ ...ref(id), refresh: async () => { await new Promise((resolve) => setTimeout(resolve, 250)); return ref(id).refresh(); } });
  const started = Date.now();
  const first = deferred.send({ agentId: "a", text: "same", messageId: "msg-pair-1", key: "pair" }, h.paseo);
  const second = deferred.send({ agentId: "a", text: "same", messageId: "msg-pair-2", key: "pair" }, h.paseo).then(
    (value) => ({ value, at: Date.now() - started }),
    (error: unknown) => ({ error, at: Date.now() - started }),
  );
  assert.equal((await first).status, "confirm");
  const answered = await second;
  assert.ok(answered.at < 400 + 200, `answered after ${answered.at} ms`);
  assert.equal(h.sent.length, 0);
});

test("an unreadable ledger is logged by error name only: the JSON error would quote part of a message", async () => {
  const h = host({ a: idle() });
  const { file, directory } = await queue(h);
  await mkdir(join(directory, "plugin"), { recursive: true });
  // V8 quotes about ten characters either side of the fault: here the start of a message body.
  await writeFile(file, '{"version":1,"messages":[{"text":QX7private-token-zz');
  const details: string[] = [];
  const reader = new DeferredSend({ file, pollMs: 3_600_000, now: h.now, log: (message, detail) => details.push(`${message} ${String(detail)} ${detail instanceof Error ? detail.stack : ""}`) });
  assert.deepEqual(await reader.list(), []);
  assert.ok(details.some((line) => line.includes("unreadable queue")), details.join("\n"));
  assert.ok(!details.some((line) => line.includes("QX7")), details.join("\n"));
});

test("leftovers holding message bodies are pruned: stale temp files and all but the newest week-old-at-most ledger copies", async () => {
  const h = host({ a: idle() });
  const { file, directory } = await queue(h);
  const folder = join(directory, "plugin");
  await mkdir(folder, { recursive: true });
  const now = h.now(), day = 24 * 3_600_000;
  const asides = [now - 1_000, now - 2_000, now - 3_000, now - 4_000, now - 8 * day].map((at) => `deferred-send.json.corrupt-${at}`);
  for (const name of asides) await writeFile(join(folder, name), "{ body");
  // A process that has exited left its temp file; our own process's temp names are left alone.
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => exited.once("exit", resolve));
  const stale = `deferred-send.json.${exited.pid}.0f0e0d0c-0000-4000-8000-000000000001.tmp`, own = `deferred-send.json.${process.pid}.0f0e0d0c-0000-4000-8000-000000000002.tmp`;
  await writeFile(join(folder, stale), "{ body"); await writeFile(join(folder, own), "{ body");
  const pruned = new DeferredSend({ file, pollMs: 3_600_000, now: h.now, log: () => undefined });
  await pruned.list();
  const left = (await readdir(folder)).sort();
  assert.deepEqual(left, [...asides.slice(0, 3), own].sort());
});

test("lock files are private whatever the umask", async () => {
  const h = host({ a: idle() });
  const { deferred, directory } = await queue(h);
  const previous = process.umask(0o022);
  try {
    await deferred.send({ agentId: "a", text: "now", messageId: "msg-mode-1" }, h.paseo);
  } finally {
    process.umask(previous);
  }
  const locks = join(directory, ".deferred-send-locks"), names = await readdir(locks);
  assert.ok(names.some((name) => name.endsWith(".lock.db")), names.join(","));
  for (const name of names) assert.equal((await lstat(join(locks, name))).mode & 0o777, 0o600, name);
  assert.equal((await stat(locks)).mode & 0o777, 0o700);
});
