import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardRows, groupDashboardRows, needsAttention, type DashboardRowOptions } from "../shared/dashboard-model";
import { normalizeAgent } from "../shared/model";
import { threadAttention } from "../shared/attention";

const defaults: DashboardRowOptions = { query: "", status: "all", view: "tree", sort: "attention", expanded: new Set() };
const date = "2026-09-16T12:00:00Z";
const later = "2026-09-16T12:01:00Z";
const ids = (result: ReturnType<typeof buildDashboardRows>) => result.rows.map((row) => row.node.agent.id);

test("attention sorting prioritizes decisions; recent sorting prioritizes activity at every tree level", () => {
  const agents = [
    normalizeAgent({ id: "recent-root", status: "running", updatedAt: later }),
    normalizeAgent({ id: "waiting-root", status: "running", pendingPermissionCount: 1, updatedAt: date }),
    normalizeAgent({ id: "recent-child", parentAgentId: "waiting-root", status: "idle", updatedAt: later }),
    normalizeAgent({ id: "error-child", parentAgentId: "waiting-root", status: "error", updatedAt: date }),
  ];
  const expanded = new Set(["waiting-root"]);
  assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, expanded })), ["waiting-root", "error-child", "recent-child", "recent-root"]);
  assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, expanded, sort: "recent" })), ["recent-root", "waiting-root", "recent-child", "error-child"]);
});

test("collapsed browsing hides descendants without changing matching totals", () => {
  const agents = [
    normalizeAgent({ id: "root", status: "idle" }),
    normalizeAgent({ id: "child", parentAgentId: "root", status: "running" }),
    normalizeAgent({ id: "grandchild", parentAgentId: "child", status: "running" }),
  ];
  const closed = buildDashboardRows(agents, defaults);
  assert.deepEqual(ids(closed), ["root"]);
  assert.equal(closed.matchingCount, 3);
  assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, expanded: new Set(["root"]) })), ["root", "child"]);
  const open = buildDashboardRows(agents, { ...defaults, expanded: new Set(["root", "child"]) });
  assert.deepEqual(open.rows.map((row) => row.depth), [0, 1, 2]);
});

test("search exposes matching descendants through collapsed parents and marks context accurately", () => {
  const agents = [
    normalizeAgent({ id: "root", title: "Release", status: "idle" }),
    normalizeAgent({ id: "child", title: "Testing", parentAgentId: "root", status: "idle" }),
    normalizeAgent({ id: "grandchild", title: "API regression", parentAgentId: "child", status: "running" }),
    normalizeAgent({ id: "sibling", title: "Docs", parentAgentId: "root", status: "idle" }),
  ];
  const result = buildDashboardRows(agents, { ...defaults, query: "  API REGRESSION  " });
  assert.deepEqual(ids(result), ["root", "child", "grandchild"]);
  assert.deepEqual(result.rows.map((row) => row.context), [true, true, false]);
  assert.equal(result.matchingCount, 1);
  assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, query: "missing" })), []);
});

test("status filters include ancestry in tree and only direct matches in list", () => {
  const agents = [
    normalizeAgent({ id: "root", status: "idle" }),
    normalizeAgent({ id: "child", parentAgentId: "root", status: "running", pendingPermissionCount: 1 }),
  ];
  const tree = buildDashboardRows(agents, { ...defaults, status: "waiting" });
  assert.deepEqual(ids(tree), ["root", "child"]);
  assert.equal(tree.matchingCount, 1);
  const list = buildDashboardRows(agents, { ...defaults, status: "waiting", view: "list" });
  assert.deepEqual(ids(list), ["child"]);
  assert.equal(list.rows[0]?.context, false);
  assert.equal(list.rows[0]?.depth, 0);
});

test("search matches renamed project identity independently of workspace labels", () => {
  const agents = [normalizeAgent({ id: "task", title: "Fix retry", status: "idle", workspaceName: "Release branch", cwd: "/checkout/task" },
    { project: { projectKey: "project-commerce", projectName: "Commerce Platform", workspaceName: "Checkout v2", checkout: { cwd: "/checkout/task", mainRepoRoot: "/repos/commerce" } } })];
  for (const query of ["Commerce Platform", "project-commerce", "/repos/commerce", "Checkout v2"]) {
    assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, query })), ["task"], query);
  }
});

test("search finds actual worktree name, path and branch independently of workspace title", () => {
  const agent = normalizeAgent({ id: "task", title: "Fix payments", status: "idle", workspaceName: "Custom review title", cwd: "/trees/payments-v2/src" }, {
    project: { checkout: { isGit: true, isPaseoOwnedWorktree: true, worktreeRoot: "/trees/payments-v2", mainRepoRoot: "/repos/commerce", currentBranch: "feature/idempotency" } },
  });
  for (const query of ["payments-v2", "/trees/payments-v2", "feature/idempotency", "Custom review title"]) {
    assert.deepEqual(ids(buildDashboardRows([agent], { ...defaults, query })), ["task"], query);
  }
});

test("read filters preserve ancestors but never count unknown completed agents as unread or read", () => {
  const agents = [
    normalizeAgent({ id: "parent", title: "Coordinator", status: "idle" }),
    normalizeAgent({ id: "unread", parentAgentId: "parent", title: "Result", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: date }),
    normalizeAgent({ id: "read", parentAgentId: "parent", status: "completed", requiresAttention: false }),
    normalizeAgent({ id: "unknown", parentAgentId: "parent", status: "completed" }),
  ];
  const unread = buildDashboardRows(agents, { ...defaults, readFilter: "unread" });
  assert.deepEqual(ids(unread), ["parent", "unread"]);
  assert.deepEqual(unread.rows.map(row => row.context), [true, false]);
  assert.equal(unread.matchingCount, 1);
  assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, readFilter: "read" })), ["parent", "read"]);
  assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, readFilter: "unread", view: "list" })), ["unread"]);
});

test("attention sorting promotes unread completions and their collapsed ancestors above running work", () => {
  const agents = [
    normalizeAgent({ id: "running", status: "running", updatedAt: later }),
    normalizeAgent({ id: "parent", status: "idle", updatedAt: date }),
    normalizeAgent({ id: "result", parentAgentId: "parent", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: date, updatedAt: date }),
    normalizeAgent({ id: "waiting", status: "running", pendingPermissionCount: 1 }),
    normalizeAgent({ id: "error", status: "error" }),
    normalizeAgent({ id: "read", status: "completed", requiresAttention: false }),
  ];
  assert.deepEqual(ids(buildDashboardRows(agents, defaults)), ["waiting", "error", "parent", "running", "read"]);
  const flat = ids(buildDashboardRows(agents, { ...defaults, view: "list" }));
  assert.ok(flat.indexOf("result") < flat.indexOf("running"));
  const recent = ids(buildDashboardRows(agents, { ...defaults, sort: "recent" }));
  assert.ok(recent.indexOf("running") < recent.indexOf("parent"), "recent sorting remains based on activity instead of unread status");
});

test("deduplication and missing timestamps produce stable finite sorting", () => {
  const agents = [
    normalizeAgent({ id: "b", status: "idle", updatedAt: "bad" }),
    normalizeAgent({ id: "a", status: "idle" }),
    normalizeAgent({ id: "fresh", status: "idle", updatedAt: later }),
    normalizeAgent({ id: "fresh", status: "idle", updatedAt: date }),
  ];
  const result = buildDashboardRows(agents, { ...defaults, sort: "recent" });
  assert.deepEqual(ids(result), ["fresh", "a", "b"]);
  assert.equal(result.matchingCount, 3);
  assert.equal(result.rows[0]?.node.agent.updatedAt, later);
});

test("cycles and orphaned parent links retain all agents once", () => {
  const agents = [
    normalizeAgent({ id: "a", parentAgentId: "b", status: "idle" }),
    normalizeAgent({ id: "b", parentAgentId: "a", status: "idle" }),
    normalizeAgent({ id: "orphan", parentAgentId: "gone", status: "idle" }),
  ];
  const result = buildDashboardRows(agents, { ...defaults, expanded: new Set(["a", "b"]) });
  assert.equal(result.rows.length, 3);
  assert.equal(new Set(ids(result)).size, 3);
  assert.equal(result.rows.find((row) => row.node.agent.id === "orphan")?.node.orphaned, true);
});

test("deep matches expose 5000 ancestors iteratively without mutating inputs", () => {
  const agents = Array.from({ length: 5000 }, (_, index) => normalizeAgent({ id: `${index}`, title: index === 4999 ? "needle" : "parent", parentAgentId: index > 0 ? `${index - 1}` : null, status: "idle" }));
  const originalIds = agents.map((agent) => agent.id);
  const result = buildDashboardRows(agents, { ...defaults, query: "needle" });
  assert.equal(result.rows.length, 5000);
  assert.equal(result.rows.at(-1)?.depth, 4999);
  assert.equal(result.matchingCount, 1);
  assert.deepEqual(agents.map((agent) => agent.id), originalIds);
});

const unreadResult = (id: string, extra: Record<string, unknown> = {}) => normalizeAgent({ id, status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: date, updatedAt: date, ...extra });

test("needsAttention covers approvals, errors and unread results unless snoozed or archived", () => {
  assert.equal(needsAttention(normalizeAgent({ id: "w", status: "running", pendingPermissionCount: 2 })), true);
  assert.equal(needsAttention(normalizeAgent({ id: "e", status: "error" })), true);
  assert.equal(needsAttention(unreadResult("u")), true);
  assert.equal(needsAttention(unreadResult("u"), true), false, "a snoozed result waits until the snooze ends");
  assert.equal(needsAttention(normalizeAgent({ id: "e", status: "error", archivedAt: date })), false);
  assert.equal(needsAttention(normalizeAgent({ id: "r", status: "running" })), false);
  assert.equal(needsAttention(normalizeAgent({ id: "read", status: "completed", requiresAttention: false })), false);
});

test("a seen error stays red but leaves 需要处理; a subagent's finished turn counts only when the setting says so", () => {
  // Opening the Agent in Paseo (or 知道了 here) clears native attention: the failure was seen.
  assert.equal(needsAttention(normalizeAgent({ id: "seen", status: "error", requiresAttention: false })), false);
  assert.equal(needsAttention(normalizeAgent({ id: "unseen", status: "error", requiresAttention: true, attentionReason: "error", attentionTimestamp: date })), true);
  // A failed turn after an older unread result: native attention stays set (edge-triggered), so it still counts.
  assert.equal(needsAttention(normalizeAgent({ id: "edge", status: "error", requiresAttention: true, attentionReason: "finished", attentionTimestamp: date })), true);
  const child = unreadResult("child", { parentAgentId: "lead" });
  assert.equal(needsAttention(child), false, "the parent has the result already");
  assert.equal(needsAttention(child, false, { childCompletions: true }), true);
  assert.equal(needsAttention(normalizeAgent({ id: "child-approval", parentAgentId: "lead", status: "running", pendingPermissionCount: 1 })), true, "approvals always count");
  assert.equal(needsAttention(normalizeAgent({ id: "child-error", parentAgentId: "lead", status: "error" })), true, "errors always count");
});

test("a stop the user has not seen counts; once seen it only colours the row", () => {
  const stop = { kind: "unfinished" as const, resetAt: null, at: later };
  const quiet = { ...normalizeAgent({ id: "q", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: date, lastUserMessageAt: date }), status: "quiet" as const, stop };
  assert.equal(needsAttention(quiet), true);
  assert.equal(needsAttention({ ...quiet, requiresAttention: false }), false);
});

test("focus keeps accepted agents with tree ancestry, counts only direct matches, and lists only matches flat", () => {
  const agents = [
    normalizeAgent({ id: "root", status: "running" }),
    normalizeAgent({ id: "child", parentAgentId: "root", status: "error" }),
    normalizeAgent({ id: "other", status: "idle" }),
  ];
  const tree = buildDashboardRows(agents, { ...defaults, focus: agent => needsAttention(agent) });
  assert.deepEqual(ids(tree), ["root", "child"]);
  assert.deepEqual(tree.rows.map(row => row.context), [true, false]);
  assert.equal(tree.matchingCount, 1);
  assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, focus: agent => needsAttention(agent), view: "list" })), ["child"]);
  assert.deepEqual(ids(buildDashboardRows(agents, { ...defaults, focus: () => false })), []);
});

test("grouping moves whole threads into 需要处理 → 执行中 → 待回复 → 已完成 → 空闲 → 已关闭 and classifies collapsed descendants", () => {
  const agents = [
    normalizeAgent({ id: "idle-parent", status: "idle", updatedAt: later }),
    unreadResult("unread-child", { parentAgentId: "idle-parent" }),
    normalizeAgent({ id: "runner", status: "running", updatedAt: later }),
    normalizeAgent({ id: "runner-child", parentAgentId: "runner", status: "idle" }),
    normalizeAgent({ id: "quiet", status: "idle", updatedAt: date }),
    normalizeAgent({ id: "failed", status: "error", updatedAt: date }),
  ];
  const collapsed = buildDashboardRows(agents, { ...defaults, sort: "recent" }).rows;
  // With 「子 Agent 完成计入需要处理」 on; by default a subagent's finished turn does not count (see below).
  const counted = { childCompletions: true };
  const sections = groupDashboardRows(collapsed, agent => needsAttention(agent, false, counted));
  assert.deepEqual(sections.map(section => section.group), ["attention", "running", "quiet"]);
  assert.deepEqual(sections.map(section => section.rows.map(row => row.node.agent.id)), [["idle-parent", "failed"], ["runner"], ["quiet"]]);
  assert.deepEqual(sections.map(section => section.threads), [2, 1, 1]);
  const expanded = buildDashboardRows(agents, { ...defaults, sort: "recent", expanded: new Set(["idle-parent", "runner"]) }).rows;
  const open = groupDashboardRows(expanded, agent => needsAttention(agent, false, counted));
  assert.deepEqual(open[0]?.rows.map(row => row.node.agent.id), ["idle-parent", "unread-child", "failed"]);
  assert.deepEqual(open[1]?.rows.map(row => [row.node.agent.id, row.depth]), [["runner", 0], ["runner-child", 1]]);
  assert.equal(open[0]?.threads, 2);
  const snoozed = groupDashboardRows(collapsed, agent => needsAttention(agent, agent.id === "unread-child", counted));
  assert.deepEqual(snoozed.map(section => [section.group, section.rows.map(row => row.node.agent.id)]), [["attention", ["failed"]], ["running", ["runner"]], ["quiet", ["idle-parent", "quiet"]]]);
  assert.deepEqual(groupDashboardRows([], () => true), []);
});

test("settled threads group by the top-level session's own state, in a fixed order", () => {
  const agents = [
    normalizeAgent({ id: "closed", status: "closed", updatedAt: later }),
    { ...normalizeAgent({ id: "canceled", status: "idle", updatedAt: later }), status: "canceled" as const },
    { ...normalizeAgent({ id: "quiet", status: "idle", updatedAt: later }), status: "quiet" as const },
    { ...unreadResult("read", {}), completionReadState: "read" as const },
    // A reply that asks you (待回复).
    { ...normalizeAgent({ id: "asks", status: "idle", updatedAt: date }), status: "idle" as const },
    // A closed parent whose subagent still works is 执行中.
    normalizeAgent({ id: "closed-lead", status: "closed", updatedAt: date }),
    normalizeAgent({ id: "worker", parentAgentId: "closed-lead", status: "running" }),
  ];
  const sections = groupDashboardRows(buildDashboardRows(agents, { ...defaults, sort: "recent" }).rows, () => false);
  assert.deepEqual(sections.map(section => [section.group, section.rows.map(row => row.node.agent.id).sort()]),
    [["running", ["closed-lead"]], ["waiting", ["asks"]], ["done", ["read"]], ["quiet", ["quiet"]], ["closed", ["canceled", "closed"]]]);
});

// P3-3 (r1): a collapsed thread pulled into 需要处理 by a descendant must say why on its parent row, which can read 已完成.
test("a thread's parent row counts the descendants that need you, with the most urgent phase, and no descendant twice (P3-3)", () => {
  const ended = "2026-10-12T04:00:00.000Z";
  const agents = [
    normalizeAgent({ id: "lead", status: "idle", requiresAttention: false, updatedAt: later }),
    // A limit on a subagent (counted whatever the setting), closed by the host mid-turn on another, an approval on a grandchild.
    { ...unreadResult("limited", { parentAgentId: "lead" }), stop: { kind: "quota" as const, resetAt: null, at: later } },
    { ...normalizeAgent({ id: "cut", parentAgentId: "lead", status: "closed", lastUserMessageAt: date }), stop: { kind: "unfinished" as const, resetAt: null, at: ended, closedMidTurn: true } },
    normalizeAgent({ id: "asks", parentAgentId: "cut", status: "running", pendingPermissions: [{ id: "p", kind: "tool", name: "Bash" }] }),
    // A subagent's plain unread result: counted only when the setting says so.
    unreadResult("result", { parentAgentId: "lead" }),
  ];
  const [row] = buildDashboardRows(agents, defaults).rows;
  assert.equal(row!.node.agent.id, "lead", "collapsed");
  const off = (agent: Parameters<typeof needsAttention>[0]) => needsAttention(agent, false, { childCompletions: false });
  assert.deepEqual(groupDashboardRows([row!], off).map(section => section.group), ["attention"]);
  assert.deepEqual(threadAttention(row!.node, off), { count: 3, phase: "approval", unread: 1 }, "the limit (an unread result too) counts once, under 需要处理; the plain result as 未读");
  // With the setting on the result needs you too: counted there, not again as 未读.
  assert.deepEqual(threadAttention(row!.node, agent => needsAttention(agent, false, { childCompletions: true })), { count: 4, phase: "approval", unread: 0 });
  // Without the approval, the limit is the most urgent; nothing waiting: nothing to say.
  const calmer = buildDashboardRows(agents.filter(agent => agent.id !== "asks"), defaults).rows[0]!;
  assert.deepEqual(threadAttention(calmer.node, off), { count: 2, phase: "quota", unread: 1 });
  assert.deepEqual(threadAttention(calmer.node, () => false), { count: 0, phase: null, unread: 2 });
});

test("执行中 rows keep their places while they stream: grouped order uses the turn's start, 按最近活动 the latest activity", () => {
  const running = (id: string, startedAt: string, lastActivityAt: string) => ({ ...normalizeAgent({ id, status: "running", activeTurn: { startedAt }, updatedAt: lastActivityAt }), lastActivityAt });
  const agents = [running("older-turn", date, "2026-09-16T12:05:00Z"), running("newer-turn", later, "2026-09-16T12:02:00Z")];
  assert.deepEqual(ids(buildDashboardRows(agents, defaults)), ["newer-turn", "older-turn"]);
  // Another token on the older turn changes nothing.
  const streamed = [running("older-turn", date, "2026-09-16T12:09:00Z"), agents[1]!];
  assert.deepEqual(ids(buildDashboardRows(streamed, defaults)), ["newer-turn", "older-turn"]);
  assert.deepEqual(ids(buildDashboardRows(streamed, { ...defaults, sort: "recent" })), ["older-turn", "newer-turn"]);
});
