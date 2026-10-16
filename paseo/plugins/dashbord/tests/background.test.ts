import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundTracker, type BackgroundParent, type ListedSubagent } from "../server/background";
import { applyBackground, backgroundResponseSchema, enrichAgents, mergeBackground } from "../shared/background";
import { buildDashboardRows, groupDashboardRows, needsAttention } from "../shared/dashboard-model";
import { matchesStatus, normalizeAgent, ownTurnRunning, type AgentBackground } from "../shared/model";

const T0 = Date.parse("2026-10-10T02:40:00.000Z"), iso = (at: number) => new Date(at).toISOString();
type Observer = { snapshot(value: unknown): void; update(message: unknown): void; error?(error: unknown): void };

function host() {
  const observers: Observer[] = [], subscribed: string[][] = []; let released = 0;
  const paseo = { observeEvents(events: string[]) { subscribed.push(events); return { subscriptionId: null, ready: Promise.resolve({}), subscribe(observer: Observer) { observers.push(observer); return () => {}; }, release: async () => { released++; } }; } };
  return { paseo: paseo as never, observers, subscribed, get released() { return released; },
    open() { observers.at(-1)!.snapshot({ requestId: "r", subscriptionId: "s" }); },
    emit(payload: Record<string, unknown>) { observers.at(-1)!.update({ type: "agent.provider_subagents.update", payload }); } };
}
const upsert = (parentAgentId: string, id: string, status: string, at: number, extra: Record<string, unknown> = {}) =>
  ({ kind: "upsert", subagent: { id, parentAgentId, provider: "claude", title: "general-purpose", description: null, status, createdAt: iso(at), updatedAt: iso(at), ...extra } });
const parent = (id: string, patch: Partial<BackgroundParent> = {}): BackgroundParent => ({ id, status: "idle", archivedAt: null, lastUserMessageAt: null, ...patch });
const listed = (id: string, status: string, createdAt: number, updatedAt = createdAt, description: string | null = null): ListedSubagent =>
  ({ id, status, title: "general-purpose", description, createdAt: iso(createdAt), updatedAt: iso(updatedAt) });

test("subagent events: a running one makes its parent 后台执行中 until it ends or disappears", async () => {
  let now = T0; const tracker = new BackgroundTracker(async () => [], () => now), h = host();
  const opened = tracker.attach(h.paseo); h.open(); await opened;
  assert.deepEqual(h.subscribed, [["agent.provider_subagents.update"]]);
  h.emit(upsert("lead", "task-1", "running", T0, { description: "实现折叠" }));
  assert.deepEqual(tracker.snapshot(), [{ agentId: "lead", running: 1, since: iso(T0), updatedAt: iso(T0), labels: ["实现折叠"] }]);
  assert.deepEqual([...tracker.runningIds()], ["lead"]);
  now += 90_000; h.emit({ kind: "timeline", parentAgentId: "lead", subagentId: "task-1", timestamp: iso(now), item: { type: "tool_call" } });
  assert.equal(tracker.snapshot()[0]!.updatedAt, iso(T0 + 60_000), "activity has minute precision");
  h.emit(upsert("lead", "task-1", "completed", now, { createdAt: iso(T0) }));
  assert.deepEqual(tracker.snapshot(), []);
  // A late output row after the end does not restart it; a resume seen live has an exact start.
  h.emit({ kind: "timeline", parentAgentId: "lead", subagentId: "task-1", timestamp: iso(now + 1_000) });
  assert.deepEqual(tracker.snapshot(), []);
  h.emit(upsert("lead", "task-1", "running", now + 5_000, { createdAt: iso(T0) }));
  assert.equal(tracker.snapshot()[0]!.since, iso(now + 5_000));
  h.emit({ kind: "remove", parentAgentId: "lead", subagentId: "task-1" });
  assert.deepEqual(tracker.snapshot(), []);
  // Output from a subagent never seen means work in progress whose start is unknown.
  h.emit({ kind: "timeline", parentAgentId: "other", subagentId: "task-9", timestamp: iso(now) });
  assert.deepEqual(tracker.snapshot().map(row => [row.agentId, row.since]), [["other", null]]);
  h.emit({ kind: "nonsense" }); h.emit(upsert("other", "task-9", "unknown-status", now));
  assert.equal(tracker.snapshot().length, 1);
});

test("the per-Agent list is only asked of loaded Agents: the host loads an unloaded one to answer", async () => {
  let now = T0; const asked: string[] = [];
  const answers: Record<string, ListedSubagent[]> = { lead: [listed("task-1", "running", T0 - 86_400_000, T0, "实现折叠")], fresh: [listed("task-2", "running", T0 + 1_000)] };
  const tracker = new BackgroundTracker(async id => { asked.push(id); return answers[id] ?? []; }, () => now), h = host();
  // Loaded means seen live by this process (a lifecycle hook); the directory's status alone is not proof.
  for (const id of ["lead", "fresh", "unloaded", "archived", "busy"]) tracker.markLive(id);
  await tracker.sync([parent("lead")], T0);
  assert.deepEqual(asked, [], "nothing is asked before the stream is live, so no change can fall between list and stream");
  const opened = tracker.attach(h.paseo); h.open(); await opened;
  const directory = [parent("lead", { lastUserMessageAt: iso(T0 - 60_000) }), parent("fresh", { lastUserMessageAt: iso(T0) }),
    parent("unloaded", { status: "closed" }), parent("archived", { archivedAt: iso(T0) }), parent("busy", { status: "running" })];
  await tracker.sync(directory, T0);
  assert.deepEqual(asked.sort(), ["busy", "fresh", "lead"]);
  // Resumed before the last message: start unknown. Created after it: the creation is the start. Without a task
  // description the label is the subagent type.
  assert.deepEqual(tracker.snapshot().map(row => [row.agentId, row.since, row.labels]), [["fresh", iso(T0 + 1_000), ["general-purpose"]], ["lead", null, ["实现折叠"]]]);
  // Within a minute nothing is asked again; after it, only parents with running subagents.
  asked.length = 0; now += 30_000; await tracker.sync(directory, now); assert.deepEqual(asked, []);
  now += 31_000; answers.fresh = [listed("task-2", "completed", T0 + 1_000, now)];
  await tracker.sync(directory, now);
  assert.deepEqual(asked.sort(), ["fresh", "lead"]);
  assert.deepEqual(tracker.snapshot().map(row => row.agentId), ["lead"]);
  // Ten minutes on, every loaded Agent is read again.
  asked.length = 0; now += 10 * 60_000; await tracker.sync(directory, now);
  assert.deepEqual(asked.sort(), ["busy", "fresh", "lead"]);
});

test("list answers never overrule newer stream reports, and parents that unloaded are forgotten", async () => {
  let now = T0, release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tracker = new BackgroundTracker(async () => { await gate; return [listed("task-1", "running", T0)]; }, () => now), h = host();
  const opened = tracker.attach(h.paseo); h.open(); await opened;
  tracker.markLive("lead");
  const pending = tracker.sync([parent("lead")], T0);
  now += 1_000; h.emit(upsert("lead", "task-1", "completed", now));
  release(); await pending;
  assert.deepEqual(tracker.snapshot(), [], "the completion arrived while the list was answered");
  // A resume seen live keeps its exact start through later list reads.
  now += 1_000; h.emit(upsert("lead", "task-1", "running", now));
  assert.equal(tracker.snapshot()[0]!.since, iso(now));
  // The directory no longer lists the parent as loaded, and nothing was heard since that walk.
  await tracker.sync([parent("lead", { status: "closed" })], now + 1);
  assert.deepEqual(tracker.snapshot(), []);
});

test("a subagent first seen live is dated by its creation only when created after the parent's latest message", async () => {
  let now = T0; const tracker = new BackgroundTracker(async id => id === "lead" && now > T0 ? [listed("new", "running", T0 - 5_000, now)] : [], () => now), h = host();
  const opened = tracker.attach(h.paseo); h.open(); await opened;
  tracker.markLive("lead"); tracker.markLive("other");
  await tracker.sync([parent("lead", { lastUserMessageAt: iso(T0 - 60_000) }), parent("other")], T0);
  h.emit(upsert("lead", "resumed", "running", T0, { createdAt: iso(T0 - 86_400_000) }));
  h.emit(upsert("lead", "new", "running", T0, { createdAt: iso(T0 - 5_000) }));
  assert.equal(tracker.snapshot()[0]!.since, null, "one of the two has an unknown start");
  h.emit({ kind: "remove", parentAgentId: "lead", subagentId: "resumed" });
  assert.equal(tracker.snapshot()[0]!.since, iso(T0 - 5_000));
  // A parent the walk does not list (a truncated walk, a project-less Agent) is kept.
  h.emit(upsert("unlisted", "task", "running", T0));
  now += 60_000; await tracker.sync([parent("lead", { lastUserMessageAt: iso(T0 - 60_000) })], now);
  assert.deepEqual(tracker.snapshot().map(row => row.agentId), ["lead", "unlisted"]);
});

test("a reconnect asks every loaded Agent again; a failed stream reports unavailable and can reopen", async () => {
  let now = T0; const asked: string[] = [];
  const tracker = new BackgroundTracker(async id => { asked.push(id); return []; }, () => now), h = host();
  const initial = tracker.read(); assert.equal(initial.mode === "full" && initial.available, false);
  const opened = tracker.attach(h.paseo); h.open(); await opened;
  tracker.markLive("a");
  await tracker.sync([parent("a")], T0); assert.deepEqual(asked, ["a"]);
  now += 1_000; h.open();
  await tracker.sync([parent("a")], now); assert.deepEqual(asked, ["a", "a"]);
  h.observers.at(-1)!.error!(new Error("closed"));
  const response = tracker.read(); assert.equal(response.mode === "full" && response.available, false);
  void tracker.attach(h.paseo); assert.equal(h.subscribed.length, 2, "a later call reopens the stream");
  await tracker.close(); assert.ok(h.released >= 1);
});

test("a stale record is never asked: after a killed daemon an unloaded Agent still reports running or idle", async () => {
  let now = T0; const asked: string[] = [];
  const tracker = new BackgroundTracker(async id => { asked.push(id); return []; }, () => now), h = host();
  const opened = tracker.attach(h.paseo); h.open(); await opened;
  const directory = [parent("stale-running", { status: "running" }), parent("stale-idle"), parent("live")];
  tracker.markLive("live");
  await tracker.sync(directory, T0);
  assert.deepEqual(asked, ["live"], "only the Agent that reported a hook is asked");
  // A subagent event proves its parent is loaded; agent.closed takes that back.
  h.emit(upsert("stale-idle", "task", "running", T0));
  assert.equal(tracker.isLive("stale-idle"), true);
  tracker.markClosed("live"); tracker.markClosed("stale-idle");
  asked.length = 0; now += 10 * 60_000 + 1; await tracker.sync(directory, now);
  assert.deepEqual(asked, [], "closed Agents are not asked again");
});

test("revisions only change with visible content", async () => {
  const tracker = new BackgroundTracker(async () => [], () => T0), h = host();
  const opened = tracker.attach(h.paseo); h.open(); await opened;
  const first = backgroundResponseSchema.parse(tracker.read());
  assert.equal(first.mode, "full");
  assert.equal(tracker.read({ revision: first.revision }).mode, "unchanged");
  h.emit(upsert("lead", "task-1", "running", T0));
  const second = tracker.read({ revision: first.revision });
  assert.equal(second.mode, "full");
  h.emit({ kind: "timeline", parentAgentId: "lead", subagentId: "task-1", timestamp: iso(T0 + 5_000) });
  assert.equal(tracker.read({ revision: second.revision }).mode, "unchanged", "output within the same minute");
  const merged = mergeBackground(undefined, second);
  assert.equal(mergeBackground(merged, { mode: "unchanged", unchanged: true, revision: second.revision }), merged);
  assert.throws(() => mergeBackground(undefined, { mode: "unchanged", unchanged: true, revision: "x" }));
});

const working: AgentBackground = { running: 1, since: null, updatedAt: "2026-10-10T02:57:00.000Z", labels: ["实现折叠"] };

test("后台执行中: a finished, unread or quiet Agent whose subagents still work is 执行中; approvals and errors stay", () => {
  const finished = normalizeAgent({ id: "lead", status: "idle", attentionReason: "finished", attentionTimestamp: "2026-10-10T02:43:56.000Z", requiresAttention: true,
    lastUserMessageAt: "2026-10-10T02:42:55.000Z", updatedAt: "2026-10-10T02:43:56.000Z" });
  assert.equal(finished.status, "completed"); assert.ok(needsAttention(finished));
  const working1 = applyBackground(finished, working);
  assert.equal(working1.status, "running"); assert.equal(working1.rawStatus, "idle"); assert.equal(ownTurnRunning(working1), false);
  assert.equal(working1.lastActivityAt, working.updatedAt); assert.equal(needsAttention(working1), false, "not an unread result while work continues");
  assert.equal(applyBackground(normalizeAgent({ id: "q", status: "idle" }), working).status, "running");
  for (const source of [{ status: "idle", pendingPermissionCount: 1 }, { status: "error" }, { status: "initializing" }, { status: "closed" }]) {
    const agent = normalizeAgent({ id: "x", ...source });
    assert.equal(applyBackground(agent, working).status, agent.status, source.status);
  }
  assert.equal(applyBackground(normalizeAgent({ id: "a", status: "idle", archivedAt: "2026-10-10T00:00:00.000Z" }), working).status, "quiet");
  const own = applyBackground(normalizeAgent({ id: "r", status: "running", activeTurn: { startedAt: "2026-10-10T02:50:00.000Z" } }), working);
  assert.equal(own.status, "running"); assert.equal(own.background, working); assert.equal(ownTurnRunning(own), true);
  assert.equal(applyBackground(finished, null), finished);
});

test("enrichment, the 执行中 filter and its section agree on background work and sessions still starting", () => {
  const agents = enrichAgents([
    normalizeAgent({ id: "own", status: "running", activeTurn: { startedAt: "2026-10-10T02:50:00.000Z" } }),
    normalizeAgent({ id: "lead", status: "idle", attentionReason: "finished", attentionTimestamp: "2026-10-10T02:43:56.000Z", requiresAttention: true }),
    normalizeAgent({ id: "starting", status: "initializing" }), normalizeAgent({ id: "idle", status: "idle" }),
  ], undefined, { agents: [{ agentId: "lead", ...working }] });
  assert.deepEqual(agents.map(agent => agent.status), ["running", "running", "initializing", "quiet"]);
  const rows = buildDashboardRows(agents, { query: "", status: "running", view: "list", sort: "attention", expanded: new Set() });
  assert.deepEqual(rows.rows.map(row => row.node.agent.id).sort(), ["lead", "own", "starting"]);
  const sections = groupDashboardRows(buildDashboardRows(agents, { query: "", status: "all", view: "tree", sort: "attention", expanded: new Set() }).rows, agent => needsAttention(agent));
  assert.deepEqual(sections.map(section => [section.group, section.threads]), [["running", 3], ["quiet", 1]]);
  assert.equal(matchesStatus("initializing", "running"), true); assert.equal(matchesStatus("running", "initializing"), false);
  assert.equal(matchesStatus("idle", "all"), true); assert.equal(matchesStatus("completed", "idle"), false);
});
