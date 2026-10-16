import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AttentionIndex, registerAttention, type AttentionSources } from "../server/attention";
import { CompletionReadController, ReadReceiptStore } from "../server/read-state";
import { TelemetryStore } from "../server/telemetry";
import { enrichAgents } from "../shared/background";
import { buildDashboardRows, groupDashboardRows, needsAttention } from "../shared/dashboard-model";
import { acknowledgement, agentAttentionPriority, normalizeAgent, stopUnseen, type AgentRecord, type AgentSource } from "../shared/model";
import { attentionEntrySchema, attentionPhase, entryOf, getAttention, popoverReplies, reasonLine, reasonText, sessionPhase } from "../shared/attention";
import { nudgeSentence, replyAsksUser, replyNudge } from "../shared/reply";
import { turnStop } from "../shared/stop-reason";
import { withinRange } from "../shared/time-range";
import type { TimelineItem } from "../shared/timeline";
import type { CompletionSnooze } from "../shared/preferences";

// Real shapes only (gemini-F7, codex-F6, opus-F39, opus-F34): the server's own telemetry records the turn exactly as its
// lifecycle hook does, the host's directory entry is what Paseo 0.11 reports (a turn that ends leaves `idle` with a finished
// attention; a close leaves `closed` with none), and the page's enrichment turns both into the record every view reads.
const T0 = Date.parse("2026-10-12T08:00:00.000Z"), iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const user: TimelineItem = { type: "user_message", text: "继续" };
const turns: Record<"quota" | "silent" | "unfinished", TimelineItem[]> = {
  quota: [user, { type: "assistant_message", text: "You've hit your limit · resets 10am (UTC)" }],
  silent: [user],
  unfinished: [user, { type: "assistant_message", text: "先看一下配置。" }, { type: "tool_call", callId: "c1", name: "Edit", status: "completed" }],
};

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stops-"));
  let now = T0;
  const store = new TelemetryStore({ directory, now: () => now, writeDelayMs: 60_000 });
  return { directory, store, at: (ms: number) => { now = ms; }, async dispose() { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const enrich = async (store: TelemetryStore, sources: AgentSource[]): Promise<AgentRecord[]> => enrichAgents(sources.map(source => normalizeAgent(source)), await store.snapshot());

/** A turn that ended on its own: the hook's outcome and timeline decide the stop (index.server.ts does the same). */
async function endedTurn(store: TelemetryStore, at: (ms: number) => void, id: string, kind: keyof typeof turns, parentAgentId: string | null) {
  const agent = { id, title: `停下的 ${kind}` };
  at(T0); await store.record({ type: "turn_started", agent, turnId: `${id}-1` });
  const end = T0 + 60_000; at(end);
  const stop = turnStop({ outcome: "completed", items: turns[kind], now: end, hostZone: "UTC" });
  assert.equal(stop?.kind, kind);
  await store.record({ type: "turn_ended", agent, turnId: `${id}-1`, outcome: "completed", asks: null, stop });
  // Paseo marks the finished turn (running → idle) a moment before the plugin's hook stamps its end.
  return { id, title: agent.title, status: "idle", createdAt: iso(T0 - 600_000), updatedAt: iso(end), lastUserMessageAt: iso(T0), activeTurn: null,
    requiresAttention: true, attentionReason: "finished", attentionTimestamp: iso(end - 5), pendingPermissions: [], ...(parentAgentId ? { parentAgentId } : {}) } satisfies AgentSource;
}

test("a limit, an empty turn or a tool call left last end the turn completed; root or subagent, it needs you until seen (gemini-F7, codex-F6, opus-F39)", async () => {
  for (const kind of ["quota", "silent", "unfinished"] as const) {
    for (const parent of [null, "lead"]) {
      const f = await scratch();
      try {
        const source = await endedTurn(f.store, f.at, `agent-${kind}`, kind, parent);
        const [agent] = await enrich(f.store, [source]);
        const label = `${kind}${parent ? " (subagent)" : ""}`;
        assert.equal(agent!.status, "completed", `${label}: the host's completion stands`);
        assert.equal(agent!.stop?.kind, kind, label);
        for (const childCompletions of [false, true]) assert.equal(needsAttention(agent!, false, { childCompletions }), true, `${label}, childCompletions ${childCompletions}`);
        assert.equal(needsAttention(agent!, true), true, `${label}: 稍后处理 never hides a stop`);
        assert.equal(attentionPhase(agent!), kind, label);
        assert.equal(sessionPhase(agent!, true), kind, `${label}: the row shows the stop, never 稍后`);
        assert.equal(acknowledgement(agent!), "problem", `${label}: the detail offers 知道了, not 标记已读`);
        assert.equal(withinRange(agent!, "7d", T0 + 30 * DAY), true, `${label}: pinned while unseen`);
        // Opening the Agent in Paseo (or 知道了 here) clears the host's attention: seen, the stop still colours the row.
        const [seen] = await enrich(f.store, [{ ...source, requiresAttention: false, attentionReason: null, attentionTimestamp: null }]);
        assert.equal(seen!.status, "completed");
        assert.equal(needsAttention(seen!, false, { childCompletions: true }), false, label);
        assert.equal(sessionPhase(seen!), kind, label);
        assert.equal(acknowledgement(seen!), null, `${label}: nothing left to acknowledge`);
        assert.equal(withinRange(seen!, "7d", T0 + 30 * DAY), false, label);
      } finally { await f.dispose(); }
    }
  }
});

test("a subagent's stop pulls its collapsed thread into 需要处理, with the default settings and ranked as the popover ranks it", async () => {
  const f = await scratch();
  try {
    const child = await endedTurn(f.store, f.at, "child", "quota", "lead");
    const lead = { id: "lead", title: "主任务", status: "idle", createdAt: iso(T0 - DAY), updatedAt: iso(T0 - 1_000), requiresAttention: false, pendingPermissions: [] };
    const agents = await enrich(f.store, [lead, child]);
    const rows = buildDashboardRows(agents, { query: "", status: "all", view: "tree", sort: "attention", expanded: new Set() }).rows;
    assert.deepEqual(rows.map(row => row.node.agent.id), ["lead"], "collapsed");
    const sections = groupDashboardRows(rows, agent => needsAttention(agent, false, { childCompletions: false }));
    assert.deepEqual(sections.map(section => [section.group, section.rows.map(row => row.node.agent.id)]), [["attention", ["lead"]]]);
    assert.equal(agentAttentionPriority(agents.find(agent => agent.id === "child")!), 1, "a limit ranks with failures");
  } finally { await f.dispose(); }
});

function fakeHost(agents: AgentSource[]) {
  const subscription = { subscribe(observer: { snapshot(value: unknown): void }) { observer.snapshot({ entries: [] }); return () => {}; }, release: async () => {} };
  const list = async (options: { subscribe?: unknown }) => options.subscribe ? { entries: [], pageInfo: { nextCursor: null, hasMore: false }, subscription }
    : { entries: agents.map(agent => ({ agent })), pageInfo: { nextCursor: null, hasMore: false } };
  const calls: Array<Record<string, unknown>> = [];
  const paseo = { agents: { list, ref: (id: string) => ({ timeline: { refetch: async () => ({ rows: [] }) }, refresh: async () => ({ agent: structuredClone(agents.find(agent => agent.id === id)), project: null }) }) },
    observeEvents: () => ({ subscribe() { return () => {}; }, release: async () => {} }) };
  return { paseo: paseo as unknown as PaseoApi, calls, transport: { async request(message: Record<string, unknown>) { calls.push(message); throw new Error("no native attention to clear"); } } };
}
const index = (store: TelemetryStore, snoozes: CompletionSnooze[] = []) => new AttentionIndex({
  telemetry: () => store.snapshot(), background: () => [], isLive: () => false,
  receipts: async () => ({ receipts: [], archiveOrigins: [] }), preferences: async () => ({ snoozes, settings: { childCompletions: false } }),
}, { now: () => T0 + DAY });

test("a turn the host closed mid-way is in the list, the badge and the popover until 知道了 here, also after a restart (opus-F34)", async () => {
  const f = await scratch();
  const receipts = await mkdtemp(join(tmpdir(), "observatory-stops-receipts-"));
  try {
    const agent = { id: "nightly", title: "重建搜索索引" };
    f.at(T0); await f.store.record({ type: "turn_started", agent, turnId: "n-1" });
    const closedAt = T0 + 90_000; f.at(closedAt);
    await f.store.record({ type: "closed", agent });
    // What the directory reports after the close: the turn is gone, and Paseo raised no attention for it.
    const host = { id: "nightly", title: agent.title, status: "closed", createdAt: iso(T0 - DAY), updatedAt: iso(closedAt), lastUserMessageAt: iso(T0), activeTurn: null,
      requiresAttention: false, attentionReason: null, attentionTimestamp: null, pendingPermissions: [] };
    const [record] = await enrich(f.store, [host]);
    assert.equal(record!.status, "closed");
    assert.deepEqual({ kind: record!.stop?.kind, closedMidTurn: record!.stop?.closedMidTurn }, { kind: "unfinished", closedMidTurn: true });
    assert.equal(needsAttention(record!), true);
    assert.equal(needsAttention({ ...record!, parentAgentId: "lead" }), true, "a subagent's too");
    assert.equal(sessionPhase(record!), "unfinished");
    assert.equal(reasonLine(record!)?.text, "可能未收尾：宿主关闭会话时这一轮还没结束");
    assert.equal(acknowledgement(record!), "problem");
    assert.equal(withinRange(record!, "7d", closedAt + 8 * DAY), true, "never aged out by the time range while unseen");
    const sections = groupDashboardRows(buildDashboardRows([record!], { query: "", status: "all", view: "tree", sort: "attention", expanded: new Set() }).rows, item => needsAttention(item));
    assert.deepEqual(sections.map(section => section.group), ["attention"]);
    const { paseo, calls, transport } = fakeHost([host]);
    const badge = index(f.store);
    await badge.attach(paseo);
    const before = await badge.summary();
    assert.equal(before.count, 1);
    assert.deepEqual(before.entries.map(entry => [entry.agentId, entry.phase, entry.stop?.closedMidTurn]), [["nightly", "unfinished", true]]);
    assert.equal(reasonText({ phase: before.entries[0]!.phase, stop: before.entries[0]!.stop }).text, "可能未收尾：宿主关闭会话时这一轮还没结束", "the popover says the same");
    badge.close();

    // 知道了: nothing native to clear (and clearing would load the closed session), so it is recorded on the stop itself.
    const controller = new CompletionReadController(new ReadReceiptStore({ directory: receipts }), transport, () => closedAt + 60_000, f.store);
    const answer = await controller.mark(paseo, { agentId: "nightly", attentionTimestamp: null, lastUserMessageAt: host.lastUserMessageAt, kind: "error", stopAt: record!.stop!.at });
    assert.deepEqual([answer.status, answer.message, answer.receipt], ["read", "已标记为知道了。", null]);
    assert.equal(calls.length, 0, "no clear_agent_attention: the host had none for this turn");
    await controller.close();
    const [seen] = await enrich(f.store, [host]);
    assert.equal(stopUnseen(seen!), false);
    assert.equal(needsAttention(seen!), false);
    assert.equal(sessionPhase(seen!), "unfinished", "still says why it stopped");
    assert.equal(withinRange(seen!, "7d", closedAt + 8 * DAY), false);
    const after = index(f.store); await after.attach(paseo);
    assert.equal((await after.summary()).count, 0);
    after.close();

    // A daemon restart reads the telemetry file again: still seen. Loading the session later (idle, no attention) neither.
    await f.store.close();
    const reloaded = new TelemetryStore({ directory: f.directory, now: () => closedAt + DAY, writeDelayMs: 60_000 });
    try {
      const [restarted] = await enrich(reloaded, [host]);
      assert.equal(typeof restarted!.stop?.seenAt, "string");
      assert.equal(needsAttention(restarted!), false);
      const restartedBadge = index(reloaded); await restartedBadge.attach(paseo);
      assert.equal((await restartedBadge.summary()).count, 0);
      restartedBadge.close();
      const [loaded] = await enrich(reloaded, [{ ...host, status: "idle" }]);
      assert.equal(loaded!.status, "quiet");
      assert.equal(needsAttention(loaded!), false);
      // Unacknowledged, loading it again does not count as seen: the host still raised no attention for that turn.
      assert.equal(needsAttention({ ...loaded!, stop: { ...loaded!.stop!, seenAt: null } }), true);
    } finally { await reloaded.close(); }
  } finally { await f.dispose(); await rm(receipts, { recursive: true, force: true }); }
});

test("稍后处理 never applies to a stop: the badge counts it even with a snooze on its completion", async () => {
  const f = await scratch();
  try {
    const source = await endedTurn(f.store, f.at, "limited", "quota", null);
    const [agent] = await enrich(f.store, [source]);
    const snooze = { agentId: "limited", completionAt: source.attentionTimestamp, until: iso(T0 + 2 * DAY) };
    const { paseo } = fakeHost([source]);
    const badge = index(f.store, [snooze]); await badge.attach(paseo);
    const summary = await badge.summary();
    assert.deepEqual([summary.count, summary.loud, summary.entries[0]?.phase], [1, 1, "quota"]);
    badge.close();
    assert.equal(needsAttention(agent!, true), true);
  } finally { await f.dispose(); }
});

test("entries carry a guessed reset and the reply's 快捷回复 category; reasons say the reset is a guess (grok-F2, opus-B26)", () => {
  const ended = "2026-10-12T04:00:00.000Z", prompt = "2026-10-12T03:50:00.000Z";
  const base = normalizeAgent({ id: "a", status: "idle", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: ended });
  const reset = new Date(2026, 9, 13, 5, 0).toISOString(), now = new Date(2026, 9, 12, 21, 0).getTime();
  const limited = { ...base, status: "completed" as const, stop: { kind: "quota" as const, resetAt: reset, resetGuessed: true, at: ended } };
  const entry = entryOf(limited, "quota");
  assert.deepEqual(entry.stop, { kind: "quota", resetAt: reset, resetGuessed: true, closedMidTurn: false });
  assert.equal(reasonText({ phase: "quota", stop: entry.stop }, now).text, "额度用尽 · 约 明天 05:00 恢复（推测）");
  assert.equal(reasonText({ phase: "quota", stop: { ...entry.stop!, resetGuessed: false } }, now).text, "额度用尽 · 明天 05:00 恢复");
  assert.equal(entryOf(limited, "quota").nudge, null);
  const asking = { ...base, replyNudge: "go-ahead" as const };
  assert.equal(entryOf(asking, "unread").nudge, "go-ahead");
});

test("each badge read reports the device's time zone; one the RPC cannot take is never sent (grok-F2)", async () => {
  const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>>();
  const server = { handle(contract: { name: string }, handler: (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>) { handlers.set(contract.name, handler); } } as unknown as PluginServerContext;
  const zones: string[] = [];
  const sources: AttentionSources = { telemetry: async () => ({ startedAt: iso(T0), persistenceError: null, agents: [], events: [] }), background: () => [], isLive: () => false,
    receipts: async () => ({ receipts: [], archiveOrigins: [] }), preferences: async () => ({ snoozes: [], settings: { childCompletions: false } }), noteZone: zone => zones.push(zone) };
  const badge = registerAttention(server, sources, { now: () => T0 });
  try {
    const { paseo } = fakeHost([]);
    const read = handlers.get(getAttention.name)!;
    await read(getAttention.input.parse({ timeZone: "US/Pacific" }), { paseo });
    await read(getAttention.input.parse({}), { paseo });
    assert.deepEqual(zones, ["US/Pacific"]);
    assert.equal(getAttention.input.safeParse({ timeZone: "../../etc/passwd" }).success, false);
    assert.equal(getAttention.input.safeParse({ timeZone: "America/Argentina/Buenos_Aires" }).success, true);
  } finally { badge.close(); }
});

test("an entry quotes the sentence its quick replies answer and names the turn they answer; without the sentence the popover offers none (P2-1, P1-1)", async () => {
  const f = await scratch();
  try {
    const agent = { id: "release", title: "发布 1.0.55" }, end = T0 + 60_000;
    const reply = "改完了，下面是修改总结。\n\n- 拆了存储层\n- 补了测试\n\n要我顺手把旧表删掉、推到 main 吗？";
    f.at(T0); await f.store.record({ type: "turn_started", agent, turnId: "r-1" });
    f.at(end); await f.store.record({ type: "turn_ended", agent, turnId: "r-1", outcome: "completed", asks: replyAsksUser(reply), nudge: replyNudge(reply), stop: null });
    const source = { id: "release", title: agent.title, status: "idle", createdAt: iso(T0 - DAY), updatedAt: iso(end), lastUserMessageAt: iso(T0), activeTurn: null,
      requiresAttention: true, attentionReason: "finished", attentionTimestamp: iso(end - 5), pendingPermissions: [] };
    const child = { ...source, id: "helper", title: "子任务", parentAgentId: "release" };
    await f.store.record({ type: "turn_started", agent: { id: "helper", title: "子任务" }, turnId: "h-1" });
    await f.store.record({ type: "turn_ended", agent: { id: "helper", title: "子任务" }, turnId: "h-1", outcome: "completed", asks: true, nudge: "go-ahead", stop: null });
    const { paseo } = fakeHost([source, child]);
    const badge = new AttentionIndex({ telemetry: () => f.store.snapshot(), background: () => [], isLive: () => false,
      receipts: async () => ({ receipts: [], archiveOrigins: [] }), preferences: async () => ({ snoozes: [], settings: { childCompletions: true } }) }, { now: () => end + 1_000 });
    try {
      await badge.attach(paseo);
      // Before the turn's end is noted (after a reload, or a reply read back later): the category only, so no quick replies there.
      const entry = async (id: string) => (await badge.summary()).entries.find(item => item.agentId === id)!;
      let release = await entry("release");
      assert.deepEqual([release.phase, release.nudge, release.ask, release.promptAt], ["idle", "go-ahead", null, iso(T0)]);
      // The round they answer, as the plugin saw it start: a heartbeat's next round shares the prompt (codex-obs-attn-F1).
      assert.equal(release.roundAt, iso(T0));
      assert.equal(popoverReplies(release), null);
      // index.server.ts notes it as the turn ends: the popover quotes it, then offers the replies.
      badge.noteAsk("release", nudgeSentence(reply), iso(end));
      badge.noteAsk("helper", "要我继续吗？", iso(end));
      release = await entry("release");
      assert.equal(release.ask, "要我顺手把旧表删掉、推到 main 吗？");
      assert.equal(popoverReplies(release), "go-ahead");
      assert.equal(attentionEntrySchema.safeParse(release).success, true);
      // A subagent's entry carries neither (its parent answers it).
      const helper = await entry("helper");
      assert.deepEqual([helper.nudge, helper.ask, popoverReplies(helper)], [null, null, null]);
      // Not for every phase: the entry of an approval offers none even with a sentence.
      assert.equal(popoverReplies({ ...release, phase: "approval" }), null);
      // A new turn forgets it.
      badge.turnStarted("release");
      assert.equal((await entry("release")).ask, null);
      // Older servers send neither field: an entry still parses, offering no quick replies.
      const { ask: _ask, promptAt: _promptAt, roundAt: _roundAt, ...old } = release;
      const parsed = attentionEntrySchema.parse(old);
      assert.deepEqual([parsed.ask, parsed.promptAt, parsed.roundAt, popoverReplies(parsed)], [null, null, null, null]);
    } finally { badge.close(); }
    // The prompt the replies answer is normalized to the instant (the RPC takes no other form), whatever the host wrote.
    assert.equal(entryOf({ ...normalizeAgent({ id: "x", status: "idle", lastUserMessageAt: "2026-10-12T16:00:00+08:00" }), replyNudge: "keep-going" }, "idle").promptAt, "2026-10-12T08:00:00.000Z");
    assert.equal(entryOf(normalizeAgent({ id: "x", status: "idle" }), "idle").promptAt, null);
    assert.equal(entryOf({ ...normalizeAgent({ id: "x", status: "idle" }), observedTurnStartedAt: "2026-10-12T16:05:00+08:00" }, "idle").roundAt, "2026-10-12T08:05:00.000Z");
    assert.equal(entryOf(normalizeAgent({ id: "x", status: "idle" }), "idle").roundAt, null);
  } finally { await f.dispose(); }
});
