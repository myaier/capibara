import assert from "node:assert/strict";
import test from "node:test";
import { createMultiHostDirectory, hostRecordKey, hostedAgents, openHostedAgent, type HostApi, type ObservatoryHost } from "../shared/multi-host";
import type { AgentDirectoryPage, AgentDirectorySubscription } from "../shared/directory-store";
import type { AgentSource } from "../shared/model";
import { buildDashboardRows } from "../shared/dashboard-model";

const mac: ObservatoryHost = { serverId: "mac", label: "Mac", status: "online" };
const windows: ObservatoryHost = { serverId: "win", label: "Windows", status: "online" };
const at = "2026-10-15T12:00:00Z";
const agent = (id: string, extra: Partial<AgentSource> = {}): AgentSource => ({ id, title: id, status: "idle", updatedAt: at, cwd: "/project", ...extra });
const page = (agents: AgentSource[], nextCursor: string | null = null): AgentDirectoryPage => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: nextCursor !== null, nextCursor } });
function fake(initial: AgentSource[]) {
  let agents = initial, failure = false;
  const observers = new Set<Parameters<AgentDirectorySubscription["subscribe"]>[0]>();
  const requests: Parameters<HostApi["list"]>[0][] = [];
  let released = 0;
  const api: HostApi = {
    async list(options) {
      requests.push(options);
      if (failure) throw new Error("Read failed");
      if (options.filter.requiresAttention) return page([]);
      const start = Number(options.page.cursor ?? 0), end = start + options.page.limit;
      const filtered = agents.filter(item => options.filter.includeArchived || !item.archivedAt);
      return page(filtered.slice(start, end), end < filtered.length ? String(end) : null);
    },
    async observe() {
      return { subscribe(observer) { observers.add(observer); observer.snapshot({}); return () => { observers.delete(observer); }; }, async release() { released++; } };
    },
  };
  return { api, requests, get released() { return released; }, replace(next: AgentSource[]) { agents = next; }, fail(value: boolean) { failure = value; },
    update(value: AgentSource) { for (const observer of observers) observer.update({ type: "agent_update", payload: { kind: "upsert", agent: value } }); } };
}

test("two hosts with identical IDs and projects stay distinct, including their child trees", async t => {
  const a = fake([agent("same"), agent("child", { parentAgentId: "same" })]), b = fake([agent("same"), agent("child", { parentAgentId: "same" })]);
  const store = createMultiHostDirectory(id => id === "mac" ? a.api : b.api, { includeArchived: false });
  t.after(() => store.stop()); store.setHosts([mac, windows]); store.start(); await store.refresh();
  const records = hostedAgents(store.getSnapshot());
  assert.equal(records.length, 4);
  assert.equal(new Set(records.map(row => row.agent.id)).size, 4);
  assert.equal(new Set(records.map(row => row.agent.projectId)).size, 2);
  const { rows } = buildDashboardRows(records.map(row => row.agent), { query: "", status: "all", view: "tree", sort: "recent", expanded: new Set(records.map(row => row.agent.id)) });
  assert.equal(rows.filter(row => row.depth === 0).length, 2);
  assert.equal(rows.filter(row => row.depth === 1).length, 2);
  for (const row of rows.filter(row => row.depth === 1)) {
    const owner = records.find(record => record.agent.id === row.node.agent.id)!;
    assert.equal(row.node.agent.parentAgentId, hostRecordKey(owner.serverId, "same"));
  }
  assert.notEqual(hostRecordKey("a:b", "c"), hostRecordKey("a", "b:c"));
});

test("each host is fully paged and a failed host does not hide the other host", async t => {
  const a = fake(Array.from({ length: 405 }, (_, i) => agent(`a-${i}`))), b = fake([agent("b")]);
  b.fail(true);
  const store = createMultiHostDirectory(id => id === "mac" ? a.api : b.api, { includeArchived: false });
  t.after(() => store.stop()); store.setHosts([mac, windows]); store.start(); await store.refresh();
  assert.equal(hostedAgents(store.getSnapshot()).length, 405);
  assert.deepEqual(a.requests.filter(request => !request.filter.requiresAttention).map(request => request.page.cursor), [undefined, "200", "400"]);
  assert.match(store.getSnapshot().hosts.find(item => item.host.serverId === "win")!.directory.error!, /Read failed/);
  b.fail(false); await store.refresh();
  assert.equal(hostedAgents(store.getSnapshot()).length, 406);
});

test("offline hosts retain labelled caches but do not count as online results or open on another host", async t => {
  const a = fake([agent("same")]), b = fake([agent("same")]);
  let acquired = 0;
  const store = createMultiHostDirectory(id => { acquired++; return id === "mac" ? a.api : b.api; }, { includeArchived: false });
  t.after(() => store.stop()); store.setHosts([mac, windows]); store.start(); await store.refresh();
  store.setHosts([mac, { ...windows, status: "offline" }]);
  const state = store.getSnapshot();
  assert.equal(hostedAgents(state).length, 1);
  assert.equal(hostedAgents(state, "win").length, 1);
  assert.equal(b.released, 1);
  const opened: unknown[] = [], navigation = { openAgent: (input: unknown) => { opened.push(input); } };
  assert.equal(openHostedAgent({ serverId: "win", agentId: "same" }, state.hosts.map(item => item.host), navigation), "offline");
  assert.deepEqual(opened, []);
  store.setHosts([mac, windows]); await store.refresh();
  assert.equal(hostedAgents(store.getSnapshot()).length, 2);
  assert.equal(openHostedAgent({ serverId: "win", agentId: "same" }, [mac, windows], navigation), "opened");
  assert.deepEqual(opened, [{ serverId: "win", agentId: "same" }]);
  const before = acquired;
  store.setActive(false); await store.refresh();
  assert.equal(acquired, before, "background pages do not acquire clients or poll");
});

test("connection replacement at online status releases the old subscription and reads the new API", async t => {
  const first = fake([agent("old")]), second = fake([agent("new")]);
  let api = first.api;
  const store = createMultiHostDirectory(() => api, { includeArchived: false });
  t.after(() => store.stop()); store.setHosts([mac]); store.start(); await store.refresh();
  api = second.api; await store.refresh();
  assert.equal(first.released, 1);
  assert.deepEqual(hostedAgents(store.getSnapshot()).map(item => item.agentId), ["new"]);
  first.update(agent("leaked"));
  assert.deepEqual(hostedAgents(store.getSnapshot()).map(item => item.agentId), ["new"]);
});

test("a removed host's pending response cannot resurrect it", async t => {
  let resolve!: (value: AgentDirectoryPage) => void;
  const pending = new Promise<AgentDirectoryPage>(done => { resolve = done; });
  const api: HostApi = { list: async options => options.filter.requiresAttention ? page([]) : pending };
  const store = createMultiHostDirectory(() => api, { includeArchived: false });
  t.after(() => store.stop()); store.setHosts([windows]); store.start();
  const loading = store.refresh();
  await new Promise(done => setImmediate(done));
  store.setHosts([]); resolve(page([agent("late")])); await loading;
  assert.deepEqual(store.getSnapshot().hosts, []);
  assert.deepEqual(hostedAgents(store.getSnapshot()), []);
});

test("archive scope is explicitly propagated to every host", async t => {
  const a = fake([agent("active"), agent("archived", { archivedAt: at })]);
  const store = createMultiHostDirectory(() => a.api, { includeArchived: true });
  t.after(() => store.stop()); store.setHosts([mac]); store.start(); await store.refresh();
  assert.equal(hostedAgents(store.getSnapshot()).length, 2);
  assert.ok(a.requests.every(request => request.filter.includeArchived));
});

test("host acquisition failures are explicit and do not become a successful zero", async t => {
  const store = createMultiHostDirectory(() => { throw new Error("Connection changed"); }, { includeArchived: false });
  t.after(() => store.stop()); store.setHosts([mac]); store.start(); await store.refresh();
  const state = store.getSnapshot().hosts[0]!;
  assert.equal(state.directory.lastSyncedAt, null);
  assert.equal(state.directory.error, "Connection changed");
  assert.equal(openHostedAgent({ serverId: "missing", agentId: "a" }, [mac], { openAgent() { assert.fail("must not fall back"); } }), "offline");
});

test("live updates affect only their host and foreground resumes a changed directory", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const a = fake([agent("same")]), b = fake([agent("same")]);
  const store = createMultiHostDirectory(id => id === "mac" ? a.api : b.api, { includeArchived: false });
  t.after(() => store.stop()); store.setHosts([mac, windows]); store.start(); await store.refresh();
  b.update(agent("same", { title: "Windows changed", status: "running", updatedAt: "2026-10-15T12:01:00Z" }));
  t.mock.timers.tick(201);
  let rows = hostedAgents(store.getSnapshot());
  assert.equal(rows.find(row => row.serverId === "win")!.agent.title, "Windows changed");
  assert.equal(rows.find(row => row.serverId === "mac")!.agent.title, "same");
  store.setActive(false);
  const calls = a.requests.length + b.requests.length;
  b.replace([agent("new-after-background")]);
  t.mock.timers.tick(60_000);
  assert.equal(a.requests.length + b.requests.length, calls);
  store.setActive(true); await store.refresh();
  rows = hostedAgents(store.getSnapshot());
  assert.ok(rows.some(row => row.agentId === "new-after-background"));
  store.setHosts([mac]);
  assert.ok(hostedAgents(store.getSnapshot()).every(row => row.serverId === "mac"));
});
