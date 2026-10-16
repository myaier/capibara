import assert from "node:assert/strict";
import test from "node:test";
import { createAgentDirectory, type AgentDirectoryApi, type AgentDirectoryPage, type AgentDirectorySubscription, type AgentDirectoryUpdate } from "../shared/directory-store";
import { completionReadState } from "../shared/model";

const date = "2026-09-16T12:00:00.000Z";
const later = "2026-09-16T12:01:00.000Z";
const page = (ids: string[], nextCursor: string | null = null): AgentDirectoryPage => ({ entries: ids.map((id) => ({ agent: { id, status: "idle", updatedAt: date } })), pageInfo: { nextCursor, hasMore: nextCursor !== null } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Observer = Parameters<AgentDirectorySubscription["subscribe"]>[0];
function fakeApi(list: AgentDirectoryApi["list"], observe?: () => Promise<void>) {
  let observer: Observer | null = null;
  let unsubscribed = 0, observations = 0;
  const api: AgentDirectoryApi = {
    list: options => options.filter.requiresAttention ? Promise.resolve(page([])) : list(options),
    async observe(options) {
      assert.equal(options.page.limit, 1, "live delivery needs no second full page");
      observations += 1; await observe?.();
      return { subscribe(next) { observer = next; next.snapshot({ entries: [] }); return () => { observer = null; }; },
        async release() { observer = null; unsubscribed += 1; } };
    },
  };
  return { api, emit: (event: AgentDirectoryUpdate) => observer?.update({ type: "agent_update", payload: event }),
    restore: () => observer?.snapshot({ entries: [] }), fail: (error: Error) => observer?.error?.(error),
    get subscribed() { return observer !== null; }, get unsubscribed() { return unsubscribed; }, get observations() { return observations; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("subscribes before reads and paginates through the full directory", async () => {
  const cursors: Array<string | undefined> = [];
  const fake = fakeApi(async (options) => {
    assert.ok(fake.subscribed, "live delivery is established before the first page is read");
    assert.equal("subscribe" in options, false, "complete reads never allocate another observation");
    cursors.push(options.page.cursor);
    return options.page.cursor ? page(["b"]) : page(["a"], "next");
  });
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  await store.refresh();
  assert.deepEqual(cursors, [undefined, "next"]);
  assert.deepEqual(store.getSnapshot().agents.map((a) => a.id), ["a", "b"]);
  assert.equal(store.getSnapshot().truncated, false);
  assert.ok(store.getSnapshot().lastSyncedAt);
  store.stop();
  assert.equal(fake.unsubscribed, 1);
});

test("live updates and tombstones during a read cannot be overwritten by stale pages", async () => {
  const pending = deferred<AgentDirectoryPage>();
  const fake = fakeApi(() => pending.promise);
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  const refresh = store.refresh();
  await settle(); // live delivery is established; the page read is still pending
  fake.emit({ kind: "upsert", agent: { id: "a", status: "running", updatedAt: later } });
  fake.emit({ kind: "remove", agentId: "removed" });
  fake.emit({ kind: "upsert", agent: { id: "created-during-read", status: "running", updatedAt: later } });
  pending.resolve(page(["a", "removed"]));
  await refresh;
  assert.equal(store.getSnapshot().agents.find((a) => a.id === "a")?.status, "running");
  assert.equal(store.getSnapshot().agents.some((a) => a.id === "removed"), false);
  assert.equal(store.getSnapshot().agents.some((a) => a.id === "created-during-read"), true);
  store.stop();
});

test("concurrent refresh calls share one request and don't clear each other's live journal", async () => {
  const pending = deferred<AgentDirectoryPage>();
  let calls = 0;
  const fake = fakeApi(() => { calls += 1; return pending.promise; });
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  const first = store.refresh();
  const second = store.refresh();
  assert.equal(first, second);
  pending.resolve(page(["a"]));
  await first;
  assert.equal(calls, 1);
  store.stop();
});

test("incomplete failed refresh preserves prior agents and reports stale sync time", async () => {
  let run = 0;
  const fake = fakeApi(async (options) => {
    if (run === 0) return page(["existing", "retained"]);
    if (options.page.cursor) throw new Error("Network disconnected");
    return page(["new"], "next");
  });
  const store = createAgentDirectory(fake.api, { includeArchived: false, now: () => Date.parse(date) });
  store.start();
  await store.refresh();
  run = 1;
  await store.refresh();
  assert.deepEqual(store.getSnapshot().agents.map((a) => a.id).sort(), ["existing", "new", "retained"]);
  assert.equal(store.getSnapshot().lastSyncedAt, date);
  assert.equal(store.getSnapshot().error, "Network disconnected");
  assert.equal(store.getSnapshot().isRefreshing, false);
  store.stop();
});

test("page bounds and repeated cursors produce explicit partial results", async () => {
  const fake = fakeApi(async () => page(["a", "b"], "stuck"));
  const store = createAgentDirectory(fake.api, { includeArchived: true, maxAgents: 2 });
  store.start();
  await store.refresh();
  assert.equal(store.getSnapshot().agents.length, 2);
  assert.equal(store.getSnapshot().truncated, true);
  store.stop();
  let calls = 0;
  const loop = fakeApi(async () => { calls += 1; return page(["a"], "same-cursor"); });
  const other = createAgentDirectory(loop.api, { includeArchived: false });
  other.start();
  await other.refresh();
  assert.equal(calls, 2);
  assert.equal(other.getSnapshot().truncated, true);
  other.stop();
});

test("archiving removes a live row in active view and is visible when archives are included", async () => {
  const fake = fakeApi(async () => page(["a"]));
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  await store.refresh();
  fake.emit({ kind: "upsert", agent: { id: "a", status: "idle", updatedAt: later, archivedAt: later } });
  assert.equal(store.getSnapshot().agents.length, 0);
  store.stop();
});

test("an older archive event cannot remove a newer restored visible row", async () => {
  const fake = fakeApi(async () => ({ entries: [{ agent: { id: "restored", status: "idle", updatedAt: later, archivedAt: null } }],
    pageInfo: { nextCursor: null, hasMore: false } }));
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  try {
    await store.refresh();
    fake.emit({ kind: "upsert", agent: { id: "restored", status: "closed", updatedAt: date, archivedAt: date } });
    assert.equal(store.getSnapshot().agents[0]?.id, "restored");
    assert.equal(store.getSnapshot().agents[0]?.archivedAt, null);
    assert.equal(store.getSnapshot().agents[0]?.updatedAt, later);
  } finally { store.stop(); }
});

test("archive tombstones reject stale resurrection and accept a genuinely newer restore", async () => {
  const restoredAt = "2026-09-16T12:02:00.000Z";
  const fake = fakeApi(async () => ({ entries: [{ agent: { id: "task", workspaceId: "ws", cwd: "/repo", status: "idle", updatedAt: date },
    project: { projectKey: "project", projectName: "Known Project", workspaceName: "Workspace", checkout: { cwd: "/repo" } } }],
    pageInfo: { nextCursor: null, hasMore: false } }));
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  try {
    await store.refresh();
    fake.emit({ kind: "upsert", agent: { id: "task", workspaceId: "ws", cwd: "/repo", status: "closed", updatedAt: later, archivedAt: later } });
    assert.equal(store.getSnapshot().agents.length, 0);
    fake.emit({ kind: "upsert", agent: { id: "task", workspaceId: "ws", cwd: "/repo", status: "idle", updatedAt: date, archivedAt: null } });
    assert.equal(store.getSnapshot().agents.length, 0, "an older active event must not resurrect the archive");
    fake.emit({ kind: "upsert", agent: { id: "task", workspaceId: "ws", cwd: "/repo", status: "idle", updatedAt: restoredAt, archivedAt: null } });
    assert.equal(store.getSnapshot().agents[0]?.id, "task");
    assert.equal(store.getSnapshot().agents[0]?.updatedAt, restoredAt);
    assert.equal(store.getSnapshot().agents[0]?.projectName, "Known Project", "restoration preserves remembered placement metadata");
  } finally { store.stop(); }
});

test("archive ordering survives a completed refresh and rejects stale later pages", async () => {
  let phase = 0;
  const fake = fakeApi(async options => {
    if (phase === 0) return page(["archived"]);
    if (phase === 1) return page([]);
    return options.page.cursor ? page(["archived"]) : page(["other"], "older-page");
  });
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  try {
    await store.refresh();
    fake.emit({ kind: "upsert", agent: { id: "archived", status: "closed", updatedAt: later, archivedAt: later } });
    phase = 1;
    await store.refresh();
    fake.emit({ kind: "upsert", agent: { id: "archived", status: "idle", updatedAt: date, archivedAt: null } });
    assert.equal(store.getSnapshot().agents.length, 0);
    phase = 2;
    await store.refresh();
    assert.deepEqual(store.getSnapshot().agents.map(agent => agent.id), ["other"]);
  } finally { store.stop(); }
});

test("a stale archived page cannot hide a newer restored row", async () => {
  let phase = 0;
  const fake = fakeApi(async () => ({ entries: [{ agent: phase === 0
    ? { id: "task", status: "idle", updatedAt: later, archivedAt: null }
    : { id: "task", status: "closed", updatedAt: date, archivedAt: date } }], pageInfo: { nextCursor: null, hasMore: false } }));
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  try {
    await store.refresh();
    phase = 1;
    await store.refresh();
    assert.equal(store.getSnapshot().agents[0]?.archivedAt, null);
    assert.equal(store.getSnapshot().agents[0]?.updatedAt, later);
  } finally { store.stop(); }
});

test("a newer restored page wins over an earlier archive event from the same refresh", async () => {
  const pending = deferred<AgentDirectoryPage>();
  const fake = fakeApi(() => pending.promise);
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  try {
    const refresh = store.refresh();
    await settle();
    fake.emit({ kind: "upsert", agent: { id: "task", status: "closed", updatedAt: date, archivedAt: date } });
    pending.resolve({ entries: [{ agent: { id: "task", status: "idle", updatedAt: later, archivedAt: null } }], pageInfo: { nextCursor: null, hasMore: false } });
    await refresh;
    assert.equal(store.getSnapshot().agents[0]?.archivedAt, null);
    assert.equal(store.getSnapshot().agents[0]?.updatedAt, later);
    fake.emit({ kind: "upsert", agent: { id: "task", status: "closed", updatedAt: date, archivedAt: date } });
    assert.equal(store.getSnapshot().agents[0]?.id, "task", "the accepted page also advances the remembered version");
  } finally { store.stop(); }
});

test("at equal versions a concurrent archive event wins over its in-flight page", async () => {
  const pending = deferred<AgentDirectoryPage>();
  const fake = fakeApi(() => pending.promise);
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  try {
    const refresh = store.refresh();
    await settle();
    fake.emit({ kind: "upsert", agent: { id: "task", status: "closed", updatedAt: date, archivedAt: date } });
    pending.resolve(page(["task"]));
    await refresh;
    assert.equal(store.getSnapshot().agents.length, 0);
    fake.emit({ kind: "upsert", agent: { id: "task", status: "idle", updatedAt: date, archivedAt: null } });
    assert.equal(store.getSnapshot().agents[0]?.id, "task", "later explicit equal-timestamp events retain arrival order");
  } finally { store.stop(); }
});

test("archive-inclusive directories also reject stale transitions while keeping genuine archives", async () => {
  const fake = fakeApi(async () => page(["task"]));
  const store = createAgentDirectory(fake.api, { includeArchived: true });
  store.start();
  try {
    await store.refresh();
    fake.emit({ kind: "upsert", agent: { id: "task", status: "closed", updatedAt: later, archivedAt: later } });
    fake.emit({ kind: "upsert", agent: { id: "task", status: "idle", updatedAt: date, archivedAt: null } });
    assert.equal(store.getSnapshot().agents[0]?.archivedAt, later);
    assert.equal(store.getSnapshot().agents[0]?.updatedAt, later);
  } finally { store.stop(); }
});

test("project metadata survives status events and updates independently from workspace names", async () => {
  const fake = fakeApi(async () => ({
    entries: [{ agent: { id: "a", workspaceId: "workspace-1", cwd: "/repo/commerce", status: "idle", updatedAt: date },
      project: { projectKey: "project-1", projectName: "Commerce", workspaceName: "Checkout v2", checkout: { cwd: "/repo/commerce" } } }],
    pageInfo: { nextCursor: null, hasMore: false },
  }));
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  await store.refresh();
  fake.emit({ kind: "upsert", agent: { id: "a", workspaceId: "workspace-1", cwd: "/repo/commerce", status: "running", updatedAt: later } });
  let agent = store.getSnapshot().agents[0]!;
  assert.equal(agent.projectName, "Commerce");
  assert.equal(agent.projectId, "project-1");
  assert.equal(agent.projectRootPath, "/repo/commerce");
  assert.equal(agent.workspaceName, "Checkout v2");
  fake.emit({ kind: "upsert", agent: { id: "a", workspaceId: "workspace-1", cwd: "/repo/commerce", status: "running", updatedAt: later },
    project: { projectKey: "project-1", projectName: "Commerce Platform", workspaceName: "Hotfix", checkout: { cwd: "/repo/commerce" } } });
  agent = store.getSnapshot().agents[0]!;
  assert.equal(agent.projectName, "Commerce Platform", "project rename does not require Agent updatedAt to change");
  assert.equal(agent.workspaceName, "Hotfix");
  store.stop();
});

test("native acknowledgement and later refresh preserve completed proof after attention is cleared", async () => {
  const prompt = "2026-09-16T11:59:00Z";
  const unread = { id: "done", status: "idle", lastUserMessageAt: prompt, updatedAt: date, requiresAttention: true, attentionReason: "finished", attentionTimestamp: date };
  const cleared = { ...unread, updatedAt: later, requiresAttention: false, attentionReason: null, attentionTimestamp: null };
  let phase = 0;
  const fake = fakeApi(async () => ({ entries: [{ agent: phase ? cleared : unread }], pageInfo: { nextCursor: null, hasMore: false } }));
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  try {
    await store.refresh();
    assert.equal(completionReadState(store.getSnapshot().agents[0]!), "unread");
    fake.emit({ kind: "upsert", agent: cleared });
    let agent = store.getSnapshot().agents[0]!;
    assert.equal(agent.status, "completed");
    assert.equal(agent.completionAt, date);
    assert.equal(agent.attentionReason, null);
    assert.equal(agent.attentionTimestamp, null);
    assert.equal(completionReadState(agent), "read");
    phase = 1;
    await store.refresh();
    agent = store.getSnapshot().agents[0]!;
    assert.equal(agent.status, "completed");
    assert.equal(agent.lastExecutionAt, date);
    assert.equal(completionReadState(agent), "read");
    fake.emit({ kind: "upsert", agent: { ...cleared, updatedAt: "2026-09-16T12:02:00Z", lastUserMessageAt: "2026-09-16T12:02:00Z" } });
    assert.equal(store.getSnapshot().agents[0]?.status, "quiet", "new user message invalidates retained completion");
  } finally { store.stop(); }
});

test("directory read preservation cannot invent completion on startup or mask newer failures", async () => {
  const prompt = "2026-09-16T11:59:00Z";
  const fake = fakeApi(async () => ({ entries: [{ agent: { id: "done", status: "idle", updatedAt: date, lastUserMessageAt: prompt, requiresAttention: false } }], pageInfo: { nextCursor: null, hasMore: false } }));
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  try {
    await store.refresh();
    assert.equal(store.getSnapshot().agents[0]?.status, "quiet");
    fake.emit({ kind: "upsert", agent: { id: "done", status: "idle", updatedAt: date, lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: date } });
    assert.equal(store.getSnapshot().agents[0]?.status, "completed");
    fake.emit({ kind: "upsert", agent: { id: "done", status: "idle", updatedAt: later, lastUserMessageAt: prompt, requiresAttention: false, lastError: "A newer failure" } });
    assert.notEqual(store.getSnapshot().agents[0]?.status, "completed");
    fake.emit({ kind: "upsert", agent: { id: "done", status: "running", updatedAt: "2026-09-16T12:02:00Z", lastUserMessageAt: prompt } });
    assert.equal(store.getSnapshot().agents[0]?.status, "running");
  } finally { store.stop(); }
});

test("checkout metadata survives missing placement, applies explicit branch null and follows workspace changes", async () => {
  let omitPlacement = false;
  const snapshot = { id: "task", workspaceId: "workspace-1", cwd: "/trees/payments-v2", status: "idle", updatedAt: date };
  const fake = fakeApi(async () => ({ entries: [{ agent: snapshot,
    project: omitPlacement ? null : { projectKey: "commerce", projectName: "Commerce", workspaceName: "Checkout v2", checkout: {
      cwd: "/trees/payments-v2", isGit: true, isPaseoOwnedWorktree: true, currentBranch: "feature/payments-v2", mainRepoRoot: "/repos/commerce", worktreeRoot: "/trees/payments-v2",
    } } }], pageInfo: { nextCursor: null, hasMore: false } }));
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  await store.refresh();
  assert.equal(store.getSnapshot().agents[0]?.worktreeName, "payments-v2");
  fake.emit({ kind: "upsert", agent: { ...snapshot, status: "running", updatedAt: later }, project: null });
  let agent = store.getSnapshot().agents[0]!;
  assert.equal(agent.checkoutKind, "worktree");
  assert.equal(agent.worktreePath, "/trees/payments-v2");
  assert.equal(agent.branch, "feature/payments-v2");
  omitPlacement = true;
  await store.refresh();
  assert.equal(store.getSnapshot().agents[0]?.branch, "feature/payments-v2", "a null placement page must not erase known checkout metadata");
  fake.emit({ kind: "upsert", agent: { ...snapshot, updatedAt: later }, project: { workspaceName: "Renamed review", checkout: { currentBranch: null } } });
  agent = store.getSnapshot().agents[0]!;
  assert.equal(agent.workspaceName, "Renamed review");
  assert.equal(agent.worktreeName, "payments-v2");
  assert.equal(agent.branch, null);
  fake.emit({ kind: "upsert", agent: { ...snapshot, cwd: "/repos/commerce", workspaceId: "workspace-main", updatedAt: later }, project: { projectKey: "commerce", projectName: "Commerce", workspaceName: "Main", checkout: { isGit: true, currentBranch: "main", isPaseoOwnedWorktree: false, mainRepoRoot: null, worktreeRoot: "/repos/commerce" } } });
  agent = store.getSnapshot().agents[0]!;
  assert.equal(agent.checkoutKind, "main");
  assert.equal(agent.worktreeName, null);
  assert.equal(agent.worktreePath, null);
  assert.equal(agent.branch, "main");
  store.stop();
});

test("stop ignores late responses; Strict Mode restart establishes a new generation", async () => {
  const old = deferred<AgentDirectoryPage>();
  let calls = 0;
  const fake = fakeApi(async () => { calls += 1; return calls === 1 ? old.promise : page(["new-session"]); });
  const store = createAgentDirectory(fake.api, { includeArchived: false });
  store.start();
  const oldRefresh = store.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  store.stop();
  store.start();
  await store.refresh();
  old.resolve(page(["old-session"]));
  await oldRefresh;
  assert.deepEqual(store.getSnapshot().agents.map((a) => a.id), ["new-session"]);
  store.stop();
  assert.equal(fake.unsubscribed, 2);
});

test("foreground activation refreshes and background stops automatic polling", async () => {
  let calls = 0;
  const fake = fakeApi(async () => { calls += 1; return page(["a"]); });
  const store = createAgentDirectory(fake.api, { includeArchived: false, pollIntervalMs: 10 });
  store.start(false);
  assert.equal(calls, 0);
  store.setActive(true);
  await store.refresh();
  assert.equal(calls, 1);
  store.setActive(false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  store.setActive(true);
  await store.refresh();
  assert.equal(calls, 2);
  store.stop();
});

test("attention is fetched first so older unread results survive the recent-directory cap", async () => {
  const recent = Array.from({ length: 2000 }, (_, index) => ({ id: `recent-${index}`, status: "idle", updatedAt: later }));
  const unread = { id: "old-unread", status: "idle", updatedAt: date, attentionReason: "finished", attentionTimestamp: date, requiresAttention: true };
  const all = [...recent, unread];
  const queries: boolean[] = [];
  const store = createAgentDirectory({ async list(options) {
    const attention = options.filter.requiresAttention === true; queries.push(attention);
    const candidates = attention ? [unread] : all;
    const start = Number(options.page.cursor ?? 0), end = start + options.page.limit;
    return { entries: candidates.slice(start, end).map(agent => ({ agent })), pageInfo: { hasMore: end < candidates.length, nextCursor: end < candidates.length ? String(end) : null } };
  } }, { includeArchived: false });
  store.start();
  try {
    await store.refresh();
    assert.equal(queries[0], true); assert.equal(queries[1], false);
    assert.equal(store.getSnapshot().agents.length, 2000);
    assert.equal(store.getSnapshot().agents.find(agent => agent.id === "old-unread")?.status, "completed");
    assert.equal(store.getSnapshot().truncated, true);
  } finally { store.stop(); }
});

test("backgrounding during a page stops subsequent reads and does not publish partial success", async () => {
  let phase = 0, readsAfterPause = 0, now = Date.parse(date);
  const pending = deferred<AgentDirectoryPage>();
  const started = deferred<AgentDirectoryPage>();
  const fake = fakeApi(async options => {
    if (phase === 0) return page(["prior"]);
    if (phase === 2) return page(["prior", "new"]);
    readsAfterPause += 1;
    started.resolve(page([]));
    if (options.page.cursor) throw new Error("must not request another page in background");
    return pending.promise;
  });
  const store = createAgentDirectory(fake.api, { includeArchived: false, now: () => now });
  store.start();
  try {
    await store.refresh();
    const synced = store.getSnapshot().lastSyncedAt;
    phase = 1;
    const refresh = store.refresh(); await started.promise;
    store.setActive(false); now += 60_000;
    pending.resolve(page(["new"], "next")); await refresh;
    assert.equal(readsAfterPause, 1);
    assert.deepEqual(store.getSnapshot().agents.map(agent => agent.id), ["prior"]);
    assert.equal(store.getSnapshot().lastSyncedAt, synced);
    assert.equal(store.getSnapshot().isRefreshing, false);
    phase = 2; store.setActive(true); await store.refresh();
    assert.equal(store.getSnapshot().agents.length, 2);
    assert.notEqual(store.getSnapshot().lastSyncedAt, synced);
  } finally { store.stop(); }
});

test("owned observation delivers live updates, releases while hidden and resubscribes on foreground", async () => {
  let reads = 0;
  const fake = fakeApi(async () => { reads += 1; return page(["a"]); });
  const store = createAgentDirectory(fake.api, { includeArchived: false, pollIntervalMs: 10, reconcileIntervalMs: 60_000 });
  store.start();
  try {
    await store.refresh(); await settle();
    assert.equal(store.getSnapshot().live, true);
    fake.emit({ kind: "upsert", agent: { id: "b", status: "running", updatedAt: later } });
    assert.deepEqual(store.getSnapshot().agents.map(agent => agent.id).sort(), ["a", "b"]);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(reads, 1, "a live observation relaxes periodic reads to the reconcile interval");
    store.setActive(false);
    assert.equal(fake.unsubscribed, 1); assert.equal(fake.subscribed, false); assert.equal(store.getSnapshot().live, false);
    store.setActive(true); await store.refresh(); await settle();
    assert.equal(fake.observations, 2); assert.equal(store.getSnapshot().live, true); assert.equal(reads, 2);
  } finally { store.stop(); }
  assert.equal(fake.unsubscribed, 2);
});

test("a reconnect snapshot re-reads the directory; a lost observation polls and retries", async () => {
  let reads = 0;
  const fake = fakeApi(async () => { reads += 1; return page(reads >= 2 ? ["a", "missed-while-offline"] : ["a"]); });
  const store = createAgentDirectory(fake.api, { includeArchived: false, pollIntervalMs: 15, reconcileIntervalMs: 60_000, retryDelaysMs: [30] });
  store.start();
  try {
    await store.refresh(); await settle();
    fake.restore(); await settle();
    assert.equal(reads, 2);
    assert.ok(store.getSnapshot().agents.some(agent => agent.id === "missed-while-offline"));
    fake.fail(new Error("Subscription released"));
    assert.equal(store.getSnapshot().live, false);
    await new Promise(resolve => setTimeout(resolve, 22)); await settle();
    assert.ok(reads >= 3, "falls back to polling while no observation is available");
    await new Promise(resolve => setTimeout(resolve, 40)); await settle();
    assert.equal(fake.observations, 2); assert.equal(store.getSnapshot().live, true);
  } finally { store.stop(); }
});

test("an observation that cannot be established leaves polling reads working", async () => {
  let reads = 0;
  const fake = fakeApi(async () => { reads += 1; return page(["a"]); }, async () => { throw new Error("capability unavailable"); });
  const store = createAgentDirectory(fake.api, { includeArchived: false, pollIntervalMs: 15, retryDelaysMs: [1_000] });
  store.start();
  try {
    await store.refresh(); await settle();
    assert.equal(store.getSnapshot().live, false); assert.equal(store.getSnapshot().error, null);
    assert.deepEqual(store.getSnapshot().agents.map(agent => agent.id), ["a"]);
    await new Promise(resolve => setTimeout(resolve, 25)); await settle();
    assert.ok(reads >= 2);
  } finally { store.stop(); }
});

test("a burst of live updates is one notification and one rebuild; reads always see the latest state", async () => {
  const fake = fakeApi(async () => page(["a", "b", "c"]));
  const store = createAgentDirectory(fake.api, { includeArchived: false, notifyDelayMs: 20 });
  store.start();
  await store.refresh();
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  const before = store.getSnapshot().agents;
  for (let index = 0; index < 30; index++) {
    fake.emit({ kind: "upsert", agent: { id: "b", status: "running", updatedAt: new Date(Date.parse(later) + index * 1000).toISOString(),
      lastUsage: { contextWindowUsedTokens: 1000 + index, contextWindowMaxTokens: 200_000 } } });
  }
  assert.equal(notified, 0, "listeners hear about the burst once, after the delay");
  // A read in between is current anyway: the list is rebuilt lazily.
  assert.equal(store.getSnapshot().agents.find(agent => agent.id === "b")?.usage.contextUsed, 1029);
  assert.notEqual(store.getSnapshot().agents, before);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(notified, 1);
  // An update that cannot move the row (same priority, activity and title) replaces it in place.
  const snapshot = store.getSnapshot().agents, index = snapshot.findIndex(agent => agent.id === "b");
  const current = snapshot[index]!;
  fake.emit({ kind: "upsert", agent: { id: "b", status: "running", updatedAt: current.updatedAt!, lastUsage: { contextWindowUsedTokens: 5, contextWindowMaxTokens: 200_000 } } });
  const next = store.getSnapshot().agents;
  assert.equal(next[index]!.id, "b"); assert.equal(next[index]!.usage.contextUsed, 5);
  assert.deepEqual(next.map(agent => agent.id), snapshot.map(agent => agent.id));
  store.stop();
});
