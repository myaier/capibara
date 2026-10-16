import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardRows, needsAttention } from "../shared/dashboard-model";
import { acknowledgement, applyArchiveReadOrigin, applyReadReceipt, applyTelemetry, buildAgentForest, classifyAgentStatus, completionReadState, filterAgentForest, flattenAgentForest, formatDuration, formatRelativeTime, formatTokens, heldBySnooze, isUnreadCompletion, knownCompletionAt, normalizeAgent, observedRound, preserveCompletionEvidence, resultSource, sameResultSource, stopUnseen, type AgentRecord, type LifecycleOutcome } from "../shared/model";
import { isCompletionSnoozed } from "../shared/preferences";

const time = "2026-09-16T12:00:00.000Z";
const later = "2026-09-16T12:05:00.000Z";

test("idle is distinct from observed completion, and live work overrides old outcomes", () => {
  assert.equal(classifyAgentStatus({ status: "idle" }), "quiet");
  assert.equal(classifyAgentStatus({ status: "idle", attentionReason: "finished" }), "completed");
  assert.equal(classifyAgentStatus({ status: "idle", attentionReason: "finished", attentionTimestamp: time, lastUserMessageAt: later }), "quiet");
  const outcome = { outcome: "completed" as const, turnEndedAt: time };
  assert.equal(classifyAgentStatus({ status: "running", attentionReason: "finished" }, outcome), "running");
  assert.equal(classifyAgentStatus({ status: "idle", lastUserMessageAt: later }, outcome), "quiet");
  assert.equal(classifyAgentStatus({ status: "idle" }, outcome), "completed");
  assert.equal(classifyAgentStatus({ status: "idle" }, { outcome: "canceled", turnEndedAt: time }), "canceled");
  assert.equal(classifyAgentStatus({ status: "idle" }, { outcome: "failed", turnEndedAt: time }), "error");
});

test("待回复 needs a final reply that asks the user, newer than their latest message", () => {
  const asked = { outcome: "completed" as const, turnStartedAt: "2026-09-16T11:50:00Z", turnEndedAt: time, replyAt: time, replyAsks: true };
  assert.equal(classifyAgentStatus({ status: "idle", lastUserMessageAt: "2026-09-16T11:49:00Z" }, asked), "idle");
  assert.equal(classifyAgentStatus({ status: "idle", lastUserMessageAt: later }, asked), "quiet", "answered: a newer message retires the question");
  assert.equal(classifyAgentStatus({ status: "running", lastUserMessageAt: later }, asked), "running");
  assert.equal(classifyAgentStatus({ status: "idle", lastUserMessageAt: "2026-09-16T11:49:00Z" }, { ...asked, replyAsks: false }), "completed");
  assert.equal(classifyAgentStatus({ status: "idle", attentionReason: "finished", attentionTimestamp: later, requiresAttention: true }, { ...asked, turnEndedAt: null, outcome: null }), "idle", "native completion plus a question");
  assert.equal(classifyAgentStatus({ status: "idle", pendingPermissionCount: 1 }, asked), "waiting");
});

test("a question stays 待回复 through read state: unread it needs attention, read it only waits", () => {
  const lifecycle = { outcome: "completed" as const, turnStartedAt: "2026-09-16T11:50:00Z", turnEndedAt: time, replyAt: time, replyAsks: true };
  const unread = applyTelemetry(normalizeAgent({ id: "q", status: "idle", lastUserMessageAt: "2026-09-16T11:49:00Z", requiresAttention: true, attentionReason: "finished", attentionTimestamp: time }), lifecycle);
  assert.equal(unread.status, "idle"); assert.equal(unread.completionAt, null); assert.equal(isUnreadCompletion(unread), false); assert.equal(needsAttention(unread), true);
  const read = applyTelemetry(normalizeAgent({ id: "q", status: "idle", lastUserMessageAt: "2026-09-16T11:49:00Z", requiresAttention: false }), lifecycle);
  assert.equal(read.status, "idle"); assert.equal(needsAttention(read), false);
  assert.equal(applyReadReceipt(read, { agentId: "q", completionAt: time, lastUserMessageAt: "2026-09-16T11:49:00Z", readAt: later }).status, "idle", "a receipt cannot turn a question into a result");
  assert.equal(preserveCompletionEvidence(normalizeAgent({ id: "q", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: time }), read).status, "idle");
});

test("permissions win, but old error text and dismissed attention do not invent current errors", () => {
  assert.equal(classifyAgentStatus({ status: "running", pendingPermissions: [{}] }), "waiting");
  assert.equal(classifyAgentStatus({ status: "idle", pendingPermissionCount: 2 }), "waiting");
  assert.equal(classifyAgentStatus({ status: "idle", attentionReason: "permission", requiresAttention: false }), "quiet");
  assert.equal(classifyAgentStatus({ status: "idle", lastError: "A previous run failed" }), "quiet");
  assert.equal(classifyAgentStatus({ status: "initializing" }), "initializing");
  assert.equal(classifyAgentStatus({ status: "closed" }), "closed");
});

test("normalization preserves missing metrics and parent labels without inventing token totals", () => {
  const agent = normalizeAgent({ id: "child", status: "idle", cwd: "/repo/project", labels: { "paseo.parent-agent-id": " parent " }, createdAt: "invalid", updatedAt: time, lastUsage: { inputTokens: 200, cachedInputTokens: 100, totalCostUsd: 0, contextWindowMaxTokens: Infinity } });
  assert.equal(agent.parentAgentId, "parent");
  assert.equal(agent.workspaceName, "project");
  assert.equal(agent.createdAt, null);
  assert.equal(agent.lastActivityAt, time);
  assert.equal(agent.usage.totalTokens, null);
  assert.equal(agent.usage.outputTokens, null);
  assert.equal(agent.usage.costUsd, 0);
  assert.equal(agent.usage.contextTotal, null);
  const counted = normalizeAgent({ id: "x", lastUsage: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 50 } });
  assert.equal(counted.usage.totalTokens, 250, "cached input must not be counted twice");
});

test("renamed project identity remains distinct from a workspace title and worktree slug", () => {
  const agent = normalizeAgent({ id: "a", status: "running", workspaceName: "Payment hotfix", cwd: "/home/user/.paseo/worktrees/abc/bright-river" }, {
    project: { projectKey: "project-123", projectName: "Commerce Platform", workspaceName: "Checkout v2", checkout: { cwd: "/home/user/.paseo/worktrees/abc/bright-river", worktreeRoot: "/home/user/.paseo/worktrees/abc/bright-river", mainRepoRoot: "/repos/commerce-platform" } },
  });
  assert.equal(agent.projectId, "project-123");
  assert.equal(agent.projectName, "Commerce Platform");
  assert.equal(agent.workspaceName, "Checkout v2");
  assert.equal(agent.projectRootPath, "/repos/commerce-platform");
  assert.equal(agent.cwd, "/home/user/.paseo/worktrees/abc/bright-river");
});

test("missing project metadata uses directory identity and never a workspace's custom title", () => {
  const agent = normalizeAgent({ id: "a", cwd: "/repos/commerce-platform", workspaceName: "My release workspace" });
  assert.equal(agent.projectName, "commerce-platform");
  assert.equal(agent.projectId, null);
  assert.equal(agent.projectRootPath, "/repos/commerce-platform");
  assert.equal(normalizeAgent({ id: "b", workspaceName: "Misleading title" }).projectName, "未关联项目");
  assert.equal(normalizeAgent({ id: "c", cwd: "/home/user/.paseo/worktrees/abc/bright-river", workspaceName: "My worktree" }).projectName, "未关联项目");
  assert.equal(normalizeAgent({ id: "d", projectName: "Renamed project", projectId: "p4", projectRootPath: "/repo/legacy-name", cwd: "/checkout/task" }).projectName, "Renamed project");
});

test("worktree labels come from actual checkout roots, separate from project and workspace titles", () => {
  const agent = normalizeAgent({ id: "task", cwd: "/worktrees/payments-v2/src", workspaceName: "User's review workspace" }, {
    project: { projectKey: "commerce", projectName: "Commerce Platform", workspaceName: "Checkout v2", checkout: {
      cwd: "/worktrees/payments-v2/src", isGit: true, currentBranch: "feature/payments-v2", isPaseoOwnedWorktree: true,
      mainRepoRoot: "/repos/commerce", worktreeRoot: "/worktrees/payments-v2",
    } },
  });
  assert.equal(agent.checkoutKind, "worktree");
  assert.equal(agent.worktreeName, "payments-v2");
  assert.equal(agent.worktreePath, "/worktrees/payments-v2");
  assert.equal(agent.branch, "feature/payments-v2");
  assert.equal(agent.workspaceName, "Checkout v2");
  assert.equal(agent.projectName, "Commerce Platform");
  assert.equal(agent.projectRootPath, "/repos/commerce");
  const external = normalizeAgent({ id: "external", cwd: "/trees/fix" }, { project: { checkout: {
    isGit: true, isPaseoOwnedWorktree: false, mainRepoRoot: "/repos/main", worktreeRoot: "/trees/fix", currentBranch: "fix/edge",
  } } });
  assert.equal(external.checkoutKind, "worktree", "external worktrees have real separated roots too");
  assert.equal(external.worktreeName, "fix");
});

test("main Git roots, local directories and missing metadata never invent worktree names", () => {
  const main = normalizeAgent({ id: "main", cwd: "/repos/main/src" }, { project: { checkout: {
    cwd: "/repos/main/src", isGit: true, isPaseoOwnedWorktree: false, mainRepoRoot: "/repos/main/", worktreeRoot: "/repos/main", currentBranch: "main",
  } } });
  assert.equal(main.checkoutKind, "main");
  assert.equal(main.worktreeName, null);
  assert.equal(main.worktreePath, null);
  assert.equal(main.branch, "main");
  const subdirectory = normalizeAgent({ id: "sub", cwd: "/repos/main/src" }, { project: { checkout: { isGit: true, mainRepoRoot: "/repos/main", cwd: "/repos/main/src" } } });
  assert.equal(subdirectory.checkoutKind, "main", "cwd under a repository does not prove another worktree");
  const directory = normalizeAgent({ id: "local", cwd: "/notes", checkoutKind: "worktree", worktreePath: "/old/tree", branch: "old" }, { project: { checkout: { isGit: false, currentBranch: null, worktreeRoot: null, mainRepoRoot: null } } });
  assert.equal(directory.checkoutKind, "directory");
  assert.equal(directory.worktreeName, null);
  assert.equal(directory.worktreePath, null);
  assert.equal(directory.branch, null);
  const unknown = normalizeAgent({ id: "unknown", cwd: "/repos/project", workspaceName: "My worktree" });
  assert.equal(unknown.checkoutKind, "unknown");
  assert.equal(unknown.worktreeName, null);
});

test("branch null means detached or unreported, while partial metadata preserves known branch", () => {
  const initial = { id: "task", cwd: "/trees/review", checkoutKind: "worktree" as const, worktreePath: "/trees/review", branch: "review" };
  const detached = normalizeAgent(initial, { project: { checkout: { currentBranch: null } } });
  assert.equal(detached.branch, null);
  assert.equal(detached.worktreeName, "review");
  const renamed = normalizeAgent(initial, { project: { workspaceName: "Renamed workspace" } });
  assert.equal(renamed.branch, "review");
  assert.equal(renamed.worktreeName, "review");
  assert.equal(renamed.workspaceName, "Renamed workspace");
});

test("completion read state distinguishes native unread, read, unknown, stale and active states", () => {
  const source = { id: "done", status: "idle", lastUserMessageAt: time, attentionReason: "finished", attentionTimestamp: later, requiresAttention: true };
  const unread = normalizeAgent(source);
  assert.equal(completionReadState(unread), "unread");
  assert.equal(isUnreadCompletion(unread), true);
  assert.equal(knownCompletionAt(unread), later);
  assert.equal(completionReadState(normalizeAgent({ ...source, requiresAttention: false })), "read");
  assert.equal(completionReadState(normalizeAgent({ ...source, requiresAttention: undefined })), "unknown");
  assert.equal(completionReadState(normalizeAgent({ ...source, attentionTimestamp: undefined, status: "completed" })), "unknown");
  assert.equal(completionReadState(normalizeAgent({ ...source, status: "completed", lastUserMessageAt: "2026-09-16T12:06:00Z" })), "unknown");
  assert.equal(completionReadState(normalizeAgent({ ...source, status: "running" })), "not_completed");
  assert.equal(completionReadState(normalizeAgent({ ...source, pendingPermissionCount: 1 })), "not_completed");
  assert.equal(isUnreadCompletion(normalizeAgent({ ...source, status: "closed", archivedAt: "2026-09-16T12:06:00Z" })), false);
  assert.equal(completionReadState(normalizeAgent({ ...source, status: "closed", archivedAt: "2026-09-16T12:06:00Z", requiresAttention: false })), "unknown", "native archive clears attention without marking the result read");
  assert.equal(completionReadState({ ...unread, pendingPermissionCount: 1, requiresAttention: false }), "unknown");
});

test("native completion tokens remain authoritative over later hook observation times and read receipts", () => {
  const nativeAt = "2026-09-17T04:03:36.882Z";
  const hookAt = "2026-09-17T04:03:36.887Z";
  const prompt = "2026-09-17T04:00:00Z";
  const outcome = { outcome: "completed" as const, turnStartedAt: prompt, turnEndedAt: hookAt };
  const source = { id: "timing", status: "idle", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: nativeAt };
  const withHook = applyTelemetry(normalizeAgent(source), outcome);
  assert.equal(withHook.completionAt, nativeAt);
  assert.equal(knownCompletionAt(withHook), nativeAt);
  assert.equal(completionReadState(withHook), "unread");
  assert.equal(normalizeAgent(source, { lifecycle: outcome }).completionAt, nativeAt);
  const cleared = normalizeAgent({ ...source, requiresAttention: false, attentionReason: null, attentionTimestamp: null });
  const retained = applyTelemetry(preserveCompletionEvidence(withHook, cleared), outcome);
  assert.equal(retained.completionAt, nativeAt);
  assert.equal(completionReadState(retained), "read");
  const receipt = { completionAt: nativeAt, lastUserMessageAt: prompt, readAt: "2026-09-17T04:03:37Z" };
  const reloaded = applyReadReceipt(applyTelemetry(cleared, outcome), receipt);
  assert.equal(reloaded.completionAt, nativeAt, "an explicit receipt refines the observed hook time back to the exact native token");
  assert.equal(reloaded.completionReadFor, nativeAt);
  assert.equal(completionReadState(reloaded), "read");
});

test("archived completed results become read only with a matching explicit acknowledgement", () => {
  const archived = normalizeAgent({ id: "archived", status: "closed", lastUserMessageAt: time, attentionReason: "finished", attentionTimestamp: later, requiresAttention: false, archivedAt: "2026-09-16T12:07:00Z" });
  assert.equal(completionReadState(archived), "unknown");
  const read = applyReadReceipt(archived, { completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:06:00Z" });
  assert.equal(completionReadState(read), "read");
  assert.equal(isUnreadCompletion(read), false);
});

test("archive-origin attention clearing remains unknown after restore and across origin reload", () => {
  const source = { id: "restore", status: "idle", lastUserMessageAt: time, updatedAt: later, attentionReason: "finished", attentionTimestamp: later, requiresAttention: true };
  const unread = normalizeAgent(source);
  const archivedAt = "2026-09-16T12:06:00Z";
  const archived = preserveCompletionEvidence(unread, normalizeAgent({ ...source, status: "closed", archivedAt, updatedAt: archivedAt, attentionReason: null, attentionTimestamp: null, requiresAttention: false }));
  const restoredSource = { ...source, updatedAt: "2026-09-16T12:07:00Z", attentionReason: null, attentionTimestamp: null, requiresAttention: false };
  const restored = preserveCompletionEvidence(archived, normalizeAgent(restoredSource));
  assert.equal(restored.status, "completed"); assert.equal(restored.archiveReadOriginAt, archivedAt);
  assert.equal(completionReadState(restored), "unknown", "unarchiving does not prove the result was viewed");
  const reloaded = applyArchiveReadOrigin(normalizeAgent(restoredSource, { lifecycle: { outcome: "completed", turnEndedAt: later } }), { agentId: "restore", archivedAt, lastUserMessageAt: time });
  assert.equal(completionReadState(reloaded), "unknown");
  const read = applyReadReceipt(reloaded, { agentId: "restore", completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:30Z" });
  assert.equal(completionReadState(read), "read");
  const newCompletion = applyArchiveReadOrigin(normalizeAgent({ ...source, lastUserMessageAt: "2026-09-16T12:08:00Z", attentionTimestamp: "2026-09-16T12:09:00Z" }), { agentId: "restore", archivedAt, lastUserMessageAt: time });
  assert.equal(newCompletion.archiveReadOriginAt, null); assert.equal(isUnreadCompletion(newCompletion), true);
});

test("explicit receipts restore cleared completion without fabricating native attention fields", () => {
  const cleared = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time, requiresAttention: false, attentionReason: null, attentionTimestamp: null });
  const receipt = { agentId: "done", completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:01Z" };
  assert.equal(cleared.status, "quiet", "without prior observation or receipt a native clear does not prove completion");
  const restored = applyReadReceipt(cleared, receipt);
  assert.equal(restored.status, "completed");
  assert.equal(restored.completionAt, later);
  assert.equal(restored.lastExecutionAt, later);
  assert.equal(completionReadState(restored), "read");
  assert.equal(restored.requiresAttention, false);
  assert.equal(restored.attentionReason, null);
  assert.equal(restored.attentionTimestamp, null);
  const unknown = applyReadReceipt({ ...cleared, requiresAttention: undefined }, receipt);
  assert.equal(completionReadState(unknown), "read", "an explicit successful receipt provides read evidence even if native flag is omitted");
});

test("matching receipts suppress only the exact acknowledged native completion token", () => {
  const unread = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time, requiresAttention: true, attentionReason: "finished", attentionTimestamp: later });
  const receipt = { agentId: "done", completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:01Z" };
  const read = applyReadReceipt(unread, receipt);
  assert.equal(completionReadState(read), "read");
  assert.equal(read.requiresAttention, true, "receipt hints must not overwrite the native snapshot");
  const newer = { ...read, attentionTimestamp: "2026-09-16T12:06:00Z" };
  assert.equal(completionReadState(newer), "unread");
  assert.equal(applyReadReceipt(newer, receipt), newer, "newer native completion always wins");
  const wrongAgent = { ...receipt, agentId: "different" };
  assert.equal(applyReadReceipt(unread, wrongAgent), unread);
});

test("old receipts cannot override new prompts, starts, errors or permissions", () => {
  const receipt = { completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:01Z" };
  for (const source of [
    { status: "idle", lastUserMessageAt: "2026-09-16T12:06:00Z" },
    { status: "running", lastUserMessageAt: time },
    { status: "idle", lastUserMessageAt: time, activeTurn: { startedAt: "2026-09-16T12:06:00Z" } },
    { status: "error", lastUserMessageAt: time },
    { status: "idle", lastUserMessageAt: time, pendingPermissionCount: 1 },
    { status: "closed", lastUserMessageAt: time, attentionReason: "error", attentionTimestamp: "2026-09-16T12:06:00Z" },
  ]) {
    const agent = normalizeAgent({ id: "done", ...source });
    assert.equal(applyReadReceipt(agent, receipt), agent);
  }
  const agent = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time });
  assert.equal(applyReadReceipt(agent, { ...receipt, readAt: time }), agent, "receipt cannot predate completion");
});

test("native acknowledgement retains observed completion but fresh plugin state stays honest", () => {
  const previous = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time, requiresAttention: true, attentionReason: "finished", attentionTimestamp: later });
  const cleared = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time, requiresAttention: false, attentionReason: null, attentionTimestamp: null });
  const retained = preserveCompletionEvidence(previous, cleared);
  assert.equal(retained.status, "completed");
  assert.equal(retained.completionAt, later);
  assert.equal(retained.lastExecutionAt, later);
  assert.equal(completionReadState(retained), "read");
  assert.equal(preserveCompletionEvidence(undefined, cleared).status, "quiet");
  assert.equal(applyTelemetry(retained, { outcome: "failed", turnStartedAt: time, turnEndedAt: "2026-09-16T12:01:00Z" }).status, "completed", "older lifecycle failure cannot erase newer proven completion");
  const starting = applyTelemetry(retained, { outcome: null, turnStartedAt: "2026-09-16T12:06:00Z", turnEndedAt: null });
  assert.equal(starting.status, "quiet", "a newer observed start invalidates old completion before the native running snapshot arrives");
  assert.equal(applyReadReceipt(starting, { completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:01Z" }), starting);
});

test("telemetry enriches a matching terminal turn without overriding live work", () => {
  const lifecycle = { outcome: "completed" as const, turnEndedAt: time, turnStartedAt: "2026-09-16T11:50:00Z" };
  assert.equal(applyTelemetry(normalizeAgent({ id: "a", status: "idle" }), lifecycle).status, "completed");
  assert.equal(applyTelemetry(normalizeAgent({ id: "a", status: "running" }), lifecycle).status, "running");
  assert.equal(applyTelemetry(normalizeAgent({ id: "a", status: "idle", lastUserMessageAt: later }), lifecycle).status, "quiet");
});
test("archived closed sessions keep proven completion independently of archival state", () => {
  const archived = "2026-09-17T00:00:00Z";
  const source = { id: "history", status: "closed", archivedAt: archived, updatedAt: archived,
    createdAt: "2026-09-01T00:00:00Z", lastUserMessageAt: "2026-09-16T11:00:00Z" };
  const known = normalizeAgent(source, { lifecycle: { outcome: "completed", turnEndedAt: time } });
  assert.equal(known.status, "completed"); assert.equal(known.rawStatus, "closed"); assert.equal(known.archivedAt, archived);
  assert.equal(known.lastActivityAt, time);
  assert.equal(applyTelemetry(normalizeAgent(source), { outcome: "completed", turnEndedAt: time }).status, "completed");
  assert.equal(applyTelemetry(normalizeAgent(source), { outcome: "failed", turnEndedAt: time }).status, "error");
  assert.equal(applyTelemetry(normalizeAgent(source), { outcome: "canceled", turnEndedAt: time }).status, "canceled");
  assert.equal(normalizeAgent(source).status, "closed", "closed without outcome is not completion");
});
test("closed snapshots accept current terminal evidence but reject newer prompt or start conflicts", () => {
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", attentionTimestamp: time }), "completed");
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", attentionTimestamp: time, lastUserMessageAt: later }), "closed");
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", lastUserMessageAt: later }), "closed", "undated attention cannot disprove a newer prompt");
  assert.equal(classifyAgentStatus({ status: "closed", activeTurn: { startedAt: later } }, { outcome: "completed", turnEndedAt: time }), "closed");
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", attentionTimestamp: time }, { outcome: "completed", turnEndedAt: time, turnStartedAt: later }), "closed");
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", attentionTimestamp: time }, { outcome: "failed", turnEndedAt: later }), "error", "newer terminal evidence takes precedence");
});
test("archival metadata does not overwrite historical execution activity", () => {
  const archivedAt = "2026-09-17T00:00:00Z";
  const agent = normalizeAgent({ id: "a", status: "closed", createdAt: "2026-08-01T00:00:00Z", lastUserMessageAt: time, updatedAt: archivedAt, archivedAt });
  assert.equal(agent.updatedAt, archivedAt); assert.equal(agent.lastActivityAt, time); assert.equal(agent.lastExecutionAt, time);
  const enriched = applyTelemetry(agent, { outcome: "completed", turnEndedAt: later });
  assert.equal(enriched.lastExecutionAt, later); assert.equal(enriched.lastActivityAt, later);
  const unknown = normalizeAgent({ id: "unknown", status: "closed", createdAt: time, archivedAt, updatedAt: archivedAt });
  assert.equal(unknown.lastActivityAt, time);
});

test("tree is cycle safe, deduplicated, and retains orphan agents", () => {
  const agents = [
    normalizeAgent({ id: "a", title: "A", parentAgentId: "b", status: "idle", updatedAt: time }),
    normalizeAgent({ id: "b", title: "B", parentAgentId: "c", status: "idle" }),
    normalizeAgent({ id: "c", title: "C", parentAgentId: "a", status: "idle" }),
    normalizeAgent({ id: "orphan", parentAgentId: "gone", status: "running" }),
    normalizeAgent({ id: "self", parentAgentId: "self", status: "idle" }),
    normalizeAgent({ id: "a", title: "Newest A", parentAgentId: "b", status: "idle", updatedAt: later }),
  ];
  const tree = buildAgentForest(agents);
  const flattened = flattenAgentForest(tree);
  assert.equal(flattened.length, 5);
  assert.equal(new Set(flattened.map(({ node }) => node.agent.id)).size, 5);
  assert.equal(flattened.find(({ node }) => node.agent.id === "a")?.node.agent.title, "Newest A");
  assert.equal(tree.find((node) => node.agent.id === "orphan")?.orphaned, true);
  assert.equal(flattened.filter(({ node }) => node.cycleBroken).length, 4);
  assert.ok(tree.some((node) => node.agent.id === "a"));
});

test("tree filtering keeps a matching child's ancestry without unrelated siblings", () => {
  const forest = buildAgentForest([
    normalizeAgent({ id: "root", title: "Build app", status: "idle" }),
    normalizeAgent({ id: "match", title: "Payment regression", parentAgentId: "root", status: "running" }),
    normalizeAgent({ id: "sibling", title: "Docs", parentAgentId: "root", status: "completed" }),
    normalizeAgent({ id: "unrelated", title: "Other work", status: "running" }),
  ]);
  assert.deepEqual(flattenAgentForest(filterAgentForest(forest, { query: "payment" })).map(({ node }) => node.agent.id), ["root", "match"]);
  assert.equal(flattenAgentForest(filterAgentForest(forest, { query: "Build app" })).length, 3, "matching parent retains child context");
  assert.equal(flattenAgentForest(filterAgentForest(forest, { query: "nothing" })).length, 0);
});

test("deep nested trees are iterative and safe for corrupt long parent chains", () => {
  const agents = Array.from({ length: 5_000 }, (_, index) => normalizeAgent({ id: `${index}`, parentAgentId: index ? `${index - 1}` : null, status: "idle", title: index === 4_999 ? "needle" : "node" }));
  const result = flattenAgentForest(filterAgentForest(buildAgentForest(agents), { query: "needle" }));
  assert.equal(result.length, 5_000);
  assert.equal(result.at(-1)?.depth, 4_999);
});

test("formatters handle unknown values, clock skew and units", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(-100), "0秒");
  assert.equal(formatDuration(61_000), "1分 1秒");
  assert.equal(formatRelativeTime("bad"), "—");
  assert.equal(formatRelativeTime(later, Date.parse(time)), "刚刚");
  assert.equal(formatRelativeTime(time, Date.parse(later)), "5分钟前");
  assert.equal(formatTokens(null), "—");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(1_250), "1.3k");
});

test("a second completion after another prompt is unread while native attention still holds the first (edge-triggered)", () => {
  // T1: a turn finished, nobody looked (attention set at T1). T2: a heartbeat prompts again. T3: that turn finishes too.
  const t1 = "2026-10-10T10:00:00.000Z", t2 = "2026-10-10T11:00:00.000Z", t3 = "2026-10-10T11:05:00.000Z";
  const agent = applyTelemetry(normalizeAgent({ id: "beat", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: t1,
    lastUserMessageAt: t2, updatedAt: t3 }), { outcome: "completed", turnStartedAt: t2, turnEndedAt: t3 });
  assert.equal(agent.status, "completed");
  assert.equal(knownCompletionAt(agent), t3, "the observed end is the token");
  assert.equal(completionReadState(agent), "unread");
  assert.equal(needsAttention(agent), true);
  // Once the user opens it, native attention clears: read.
  assert.equal(completionReadState({ ...agent, requiresAttention: false }), "read");
  // Without native attention evidence it stays unknown, as before.
  assert.equal(completionReadState({ ...agent, attentionTimestamp: null }), "unknown");
});

test("pending requests are summarised by kind: questions with choices, plans by title, tools by command", () => {
  const agent = normalizeAgent({ id: "w", status: "running", pendingPermissions: [
    { id: "q", kind: "question", name: "AskUserQuestion", input: { questions: [{ question: "要合并到 main 吗？", header: "合并", options: [{ label: "合并" }, { label: "先不合" }] }] } },
  ] });
  assert.deepEqual(agent.pending, [{ kind: "question", title: "要合并到 main 吗？", detail: "合并", options: ["合并", "先不合"] }]);
  const plan = normalizeAgent({ id: "p", status: "running", pendingPermissions: [{ id: "p", kind: "plan", name: "ExitPlanMode", input: { plan: "## 重构存储层\n\n1. …" } }] });
  assert.equal(plan.pending?.[0]?.title, "重构存储层");
  const tool = normalizeAgent({ id: "t", status: "running", pendingPermissions: [{ id: "t", kind: "tool", name: "Bash", title: "Run command", detail: { type: "shell", command: "npm test" } }] });
  assert.deepEqual(tool.pending?.[0], { kind: "tool", title: "Run command", detail: "npm test", options: [] });
});

test("a turn's stop reason enriches its record until the next prompt", () => {
  const ended = "2026-10-10T12:00:00.000Z", stop = { kind: "quota" as const, resetAt: "2026-10-10T17:00:00.000Z", at: ended };
  const base = normalizeAgent({ id: "q", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: ended, lastUserMessageAt: "2026-10-10T11:50:00.000Z", updatedAt: ended });
  assert.deepEqual(applyTelemetry(base, { outcome: "completed", turnStartedAt: "2026-10-10T11:50:00.000Z", turnEndedAt: ended, stop }).stop, stop);
  const prompted = normalizeAgent({ id: "q", status: "idle", lastUserMessageAt: "2026-10-10T12:30:00.000Z", updatedAt: "2026-10-10T12:31:00.000Z" });
  assert.equal(applyTelemetry(prompted, { outcome: "completed", turnStartedAt: "2026-10-10T11:50:00.000Z", turnEndedAt: ended, stop }).stop ?? null, null, "a newer prompt started another turn");
});

test("the reply's 快捷回复 category and a guessed reset reach the record only for the current turn (opus-B26, grok-F2)", () => {
  const prompt = "2026-10-12T03:50:00.000Z", ended = "2026-10-12T04:00:00.000Z";
  const lifecycle = { outcome: "completed" as const, turnStartedAt: prompt, turnEndedAt: ended, replyAt: ended, replyAsks: false, replyNudge: "keep-going" as const,
    stop: { kind: "quota" as const, resetAt: "2026-10-12T09:00:00.000Z", resetGuessed: true, at: ended } };
  const source = { id: "n", status: "idle", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: ended };
  const record = applyTelemetry(normalizeAgent(source), lifecycle);
  assert.equal(record.replyNudge, "keep-going");
  assert.equal(record.stop?.resetGuessed, true);
  // The user wrote since: neither belongs to the turn now running or waiting.
  const answered = applyTelemetry(normalizeAgent({ ...source, lastUserMessageAt: "2026-10-12T04:10:00.000Z", requiresAttention: false }), lifecycle);
  assert.equal(answered.replyNudge ?? null, null);
  assert.equal(answered.stop ?? null, null);
  assert.equal(applyTelemetry(normalizeAgent({ ...source, status: "running", activeTurn: { startedAt: "2026-10-12T04:10:00.000Z" } }), lifecycle).replyNudge, undefined, "live work shows none");
  // A stale category on a record is cleared when the lifecycle no longer has one.
  assert.equal(applyTelemetry({ ...record }, { ...lifecycle, replyNudge: null }).replyNudge, null);
});

// P2-3: an Agent the host has not loaded keeps a failed turn's error attention after 知道了 (clearing would load it). The stop
// that turn ended on decides, as it does for 需要处理: seen, nothing is left to acknowledge.
test("知道了 on a failed turn's limit is the last word on that turn, even while its error attention stays raised (P2-3)", () => {
  const ended = "2026-10-12T04:00:00.000Z", prompt = "2026-10-12T03:50:00.000Z";
  const failed = applyTelemetry(normalizeAgent({ id: "f", status: "closed", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "error", attentionTimestamp: ended }),
    { outcome: "failed", turnStartedAt: prompt, turnEndedAt: ended, stop: { kind: "quota", resetAt: null, at: ended } });
  assert.deepEqual([failed.status, stopUnseen(failed), acknowledgement(failed), needsAttention(failed)], ["error", true, "problem", true]);
  const seen = { ...failed, stop: { ...failed.stop!, seenAt: "2026-10-12T04:05:00.000Z" } };
  assert.deepEqual([stopUnseen(seen), acknowledgement(seen), needsAttention(seen)], [false, null, false], "before: 知道了 again, for the same turn");
  // A failure without a stop still waits for 知道了 while its attention is raised.
  const plain = { ...failed, stop: null };
  assert.equal(acknowledgement(plain), "problem");
  assert.equal(acknowledgement({ ...plain, requiresAttention: false }), null);
});

test("a receipt the server kept for an unloaded Agent's raised token reads as read; for 待回复 as opened, for a failure as seen (P2-4)", () => {
  const prompt = "2026-10-12T03:50:00.000Z", ended = "2026-10-12T04:00:00.000Z", readAt = "2026-10-12T04:10:00.000Z";
  const receipt = { agentId: "q", completionAt: ended, lastUserMessageAt: prompt, readAt };
  // 待回复 on a closed session, never opened: the receipt names exactly its token and prompt.
  const asking = applyTelemetry(normalizeAgent({ id: "q", status: "closed", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: ended }),
    { outcome: "completed", turnStartedAt: prompt, turnEndedAt: ended, replyAt: ended, replyAsks: true });
  assert.deepEqual([asking.status, acknowledgement(asking), needsAttention(asking)], ["idle", "question", true]);
  const opened = applyReadReceipt(asking, receipt);
  assert.deepEqual([opened.status, opened.requiresAttention, acknowledgement(opened), needsAttention(opened)], ["idle", false, null, false]);
  // Any other token, prompt or a later turn: not this question, left as it is.
  for (const other of [{ ...receipt, completionAt: "2026-10-12T03:59:00.000Z" }, { ...receipt, lastUserMessageAt: "2026-10-12T03:40:00.000Z" }, { ...receipt, readAt: "2026-10-12T03:59:59.000Z" }])
    assert.equal(applyReadReceipt(asking, other), asking, JSON.stringify(other));
  assert.equal(applyReadReceipt({ ...asking, lastExecutionAt: "2026-10-12T04:20:00.000Z" }, receipt).requiresAttention, true, "activity after the read");
  assert.equal(applyReadReceipt({ ...asking, pendingPermissionCount: 1 }, receipt).requiresAttention, true);
  // A failure acknowledged the same way (知道了): seen, still 异常.
  const failed = applyTelemetry(normalizeAgent({ id: "q", status: "closed", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "error", attentionTimestamp: ended }),
    { outcome: "failed", turnStartedAt: prompt, turnEndedAt: ended });
  assert.deepEqual([failed.status, acknowledgement(failed), needsAttention(failed)], ["error", "problem", true]);
  const seen = applyReadReceipt(failed, receipt);
  assert.deepEqual([seen.status, acknowledgement(seen), needsAttention(seen)], ["error", null, false]);
  assert.equal(applyReadReceipt(failed, { ...receipt, lastUserMessageAt: "2026-10-12T03:40:00.000Z" }), failed, "another prompt's");
  // A result with an edge-triggered token older than the prompt: the receipt for the newer completion settles both.
  const t1 = "2026-10-12T03:00:00.000Z";
  const result = applyTelemetry(normalizeAgent({ id: "r", status: "closed", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: t1 }),
    { outcome: "completed", turnStartedAt: prompt, turnEndedAt: ended });
  assert.deepEqual([completionReadState(result), knownCompletionAt(result)], ["unread", ended]);
  const read = applyReadReceipt(result, { agentId: "r", completionAt: ended, lastUserMessageAt: prompt, readAt });
  assert.deepEqual([read.completionReadFor, completionReadState(read), isUnreadCompletion(read), needsAttention(read)], [ended, "read", false, false]);
  assert.equal(completionReadState(applyReadReceipt(result, { agentId: "r", completionAt: t1, lastUserMessageAt: prompt, readAt })), "unread", "the old token's own receipt predates the prompt");
});

test("稍后处理 holds a result back from 未读 by one rule for the chip and its list: never while its stop is unseen (P3-1)", () => {
  const ended = "2026-10-12T04:00:00.000Z", prompt = "2026-10-12T03:50:00.000Z";
  const result = applyTelemetry(normalizeAgent({ id: "s", status: "idle", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: ended }),
    { outcome: "completed", turnStartedAt: prompt, turnEndedAt: ended });
  const limited = { ...result, stop: { kind: "quota" as const, resetAt: null, at: ended } };
  assert.equal(isUnreadCompletion(limited), true); assert.equal(stopUnseen(limited), true);
  // r1 snooze-chip: both snoozed, one with its stop unseen. The chip counted that one 未读 while the list it opens left it out.
  const agents = [limited, { ...result, id: "plain" }], snoozed = () => true;
  const chip = agents.filter(agent => isUnreadCompletion(agent) && !heldBySnooze(agent, snoozed())).length;
  // client/dashboard.tsx: the 未读 list keeps what the chip counts (tests/attention-wiring.test.ts checks it uses this rule).
  const listed = buildDashboardRows(agents.filter(agent => !heldBySnooze(agent, snoozed())), { query: "", status: "all", view: "list", sort: "attention", expanded: new Set(), readFilter: "unread" }).rows.map(row => row.node.agent.id);
  assert.deepEqual([chip, listed], [1, ["s"]]);
  assert.equal(heldBySnooze(limited, true), false, "the stop shows");
  assert.equal(heldBySnooze(result, true), true);
  assert.equal(heldBySnooze(result, false), false);
  assert.equal(heldBySnooze({ ...limited, stop: { ...limited.stop, seenAt: "2026-10-12T04:05:00.000Z" } }, true), true, "a seen stop no longer outranks the snooze");
});

// codex-obs-attn-F1: Paseo 0.11.1 starts a heartbeat's turn with a system notification (schedule/service.js), which records no
// user message: `lastUserMessageAt` stays T0. While the first result is unread, the host's attention is edge-triggered and
// keeps T1 (agent-manager.js `checkAndSetAttention`). Only the turn the plugin saw start at T2 and end at T3 tells the rounds apart.
const [h0, h1, h2, h3, h4, h5] = [0, 1, 2, 3, 4, 5].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
const heartbeatHost = { id: "beat", status: "idle", createdAt: "2026-10-11T23:00:00.000Z", lastUserMessageAt: h0, updatedAt: h3, requiresAttention: true, attentionReason: "finished", attentionTimestamp: h1 };
const heartbeat = (turnStartedAt: string | null, turnEndedAt: string | null, extra: Partial<LifecycleOutcome> = {}, host: Record<string, unknown> = {}) =>
  applyTelemetry(normalizeAgent({ ...heartbeatHost, ...host }), { outcome: turnEndedAt ? "completed" : null, turnStartedAt, turnEndedAt, ...extra });
const hostTokens = (agent: AgentRecord) => [agent.lastUserMessageAt, agent.attentionTimestamp];

test("heartbeat rounds keep the prompt and the host's first stamp: the turn observed after it is the completion, unread, and its own round (codex-obs-attn-F1)", () => {
  // Round 1, the user's: the host's stamp T1 is its completion (the hook stamps start and end a moment later).
  const first = heartbeat("2026-10-12T00:00:00.020Z", "2026-10-12T01:00:00.005Z");
  assert.deepEqual([first.status, knownCompletionAt(first), observedRound(first), completionReadState(first), acknowledgement(first)], ["completed", h1, null, "unread", "result"]);
  // Round 2, a heartbeat: before, the completion stayed T1 (the receipt named it, the result cache and its check did not change).
  const second = heartbeat(h2, h3);
  assert.deepEqual(hostTokens(second), hostTokens(first), "the host's tokens cannot tell the rounds apart");
  assert.deepEqual([second.status, knownCompletionAt(second), observedRound(second), completionReadState(second), acknowledgement(second), needsAttention(second)], ["completed", h3, h3, "unread", "result", true]);
  // Round 3: its own again.
  const third = heartbeat(h4, h5, {}, { updatedAt: h5 });
  assert.deepEqual([knownCompletionAt(third), observedRound(third), completionReadState(third)], [h5, h5, "unread"]);
  // Identity (codex cache-key.mts): the detail's result key and a result's source differ per round; an earlier round's result
  // fails the later round's check, the round's own passes.
  const key = (agent: AgentRecord) => ["observatory-result", agent.id, agent.lastUserMessageAt, knownCompletionAt(agent), observedRound(agent)];
  assert.notDeepEqual(key(first), key(second)); assert.notDeepEqual(key(second), key(third));
  assert.deepEqual(resultSource(second), { lastUserMessageAt: h0, attentionTimestamp: h1, completionAt: h3, roundEndedAt: h3 });
  assert.equal(sameResultSource(second, resultSource(first)), false, "round 1's result cannot confirm round 2");
  assert.equal(sameResultSource(third, resultSource(second)), false);
  for (const agent of [first, second, third]) assert.equal(sameResultSource(agent, resultSource(agent)), true);
  assert.equal(sameResultSource(second, null), false);
  // A heartbeat's turn still running, or whose end was not observed: no completion and no round yet.
  const open = heartbeat(h4, null);
  assert.deepEqual([open.status, knownCompletionAt(open), observedRound(open), acknowledgement(open)], ["quiet", null, null, null]);
});

test("heartbeat rounds: a receipt settles its own round only, and 稍后处理 holds back only the round it was set on (codex-obs-attn-F1)", () => {
  const second = heartbeat(h2, h3), third = heartbeat(h4, h5, {}, { updatedAt: h5 }), readAt = "2026-10-12T03:10:00.000Z";
  // The server keeps the receipt for T3 on an Agent the host has not loaded: its flag (T1) stays raised.
  const receipt = { agentId: "beat", completionAt: h3, lastUserMessageAt: h0, readAt };
  const read = applyReadReceipt(second, receipt);
  assert.deepEqual([read.completionReadFor, completionReadState(read), isUnreadCompletion(read), needsAttention(read), acknowledgement(read)], [h3, "read", false, false, null]);
  assert.equal(completionReadState(applyReadReceipt(third, receipt)), "unread", "the next round is a new result");
  // What the server stored before for round 2 (the host's stamp): it does not prove round 2 was read.
  assert.equal(completionReadState(applyReadReceipt(second, { ...receipt, completionAt: h1 })), "unread");
  // 稍后处理 is tied to the completion: round 3 shows again.
  const snoozes = [{ agentId: "beat", completionAt: knownCompletionAt(second)!, until: "2026-10-12T09:00:00.000Z" }];
  assert.deepEqual([isCompletionSnoozed(second, snoozes, Date.parse(h4)), isCompletionSnoozed(third, snoozes, Date.parse(h5))], [true, false]);
});

test("heartbeat rounds that end asking you (待回复): the result's round tells them apart too (codex-obs-attn-F1)", () => {
  const asked = (start: string, end: string) => heartbeat(start, end, { replyAt: end, replyAsks: true }, { updatedAt: end });
  const second = asked(h2, h3), third = asked(h4, h5);
  assert.deepEqual([second.status, acknowledgement(second), knownCompletionAt(second), observedRound(second)], ["idle", "question", null, h3]);
  assert.deepEqual(hostTokens(second), hostTokens(third));
  assert.equal(sameResultSource(third, resultSource(second)), false, "the earlier question's result cannot mark the later one read");
  assert.equal(sameResultSource(third, resultSource(third)), true);
});

test("one turn: the host's stamp names it, so the observed turn changes nothing, however late the page's telemetry is (codex-obs-attn-F1)", () => {
  const host = { id: "one", status: "idle", createdAt: h0, lastUserMessageAt: h2, updatedAt: h3, requiresAttention: true, attentionReason: "finished", attentionTimestamp: h3 };
  const fresh = applyTelemetry(normalizeAgent(host), { outcome: "completed", turnStartedAt: "2026-10-12T02:00:00.040Z", turnEndedAt: "2026-10-12T03:00:00.006Z" });
  const lagging = applyTelemetry(normalizeAgent(host), { outcome: "completed", turnStartedAt: "2026-10-12T00:00:00.040Z", turnEndedAt: "2026-10-12T01:00:00.006Z" });
  const none = normalizeAgent(host);
  for (const agent of [fresh, lagging, none]) {
    assert.deepEqual([knownCompletionAt(agent), observedRound(agent), completionReadState(agent), acknowledgement(agent)], [h3, null, "unread", "result"]);
    assert.deepEqual(resultSource(agent), { lastUserMessageAt: h2, attentionTimestamp: h3, completionAt: h3, roundEndedAt: null });
  }
  assert.equal(sameResultSource(lagging, resultSource(fresh)), true, "a page whose telemetry has not caught up still accepts the result");
  // A source from an older server (or the preview) carries only the host's tokens: judged by them, as before.
  assert.equal(sameResultSource(fresh, { lastUserMessageAt: h2, attentionTimestamp: h3 }), true);
  assert.equal(sameResultSource(fresh, { lastUserMessageAt: h2, attentionTimestamp: h1 }), false);
  // The original codex-F5 shape (a newer prompt at T2 while T1 is unread) is unchanged: the observed end T3.
  const prompted = applyTelemetry(normalizeAgent({ ...heartbeatHost, lastUserMessageAt: h2 }), { outcome: "completed", turnStartedAt: h2, turnEndedAt: h3 });
  assert.deepEqual([knownCompletionAt(prompted), completionReadState(prompted)], [h3, "unread"]);
});

test("a fast turn whose start hook is stamped after the host's stamp stays consistent: unread, then read by the receipt for its observed end (codex-obs-attn-F1)", () => {
  // The hooks wait for a label lookup; a turn shorter than that lookup is stamped after the host's own attention.
  const native = "2026-10-12T02:00:00.100Z", started = "2026-10-12T02:00:00.140Z", ended = "2026-10-12T02:00:00.150Z";
  const agent = applyTelemetry(normalizeAgent({ id: "fast", status: "closed", createdAt: h0, lastUserMessageAt: h2, requiresAttention: true, attentionReason: "finished", attentionTimestamp: native }),
    { outcome: "completed", turnStartedAt: started, turnEndedAt: ended });
  assert.deepEqual([completionReadState(agent), knownCompletionAt(agent)], ["unread", ended]);
  const read = applyReadReceipt(agent, { agentId: "fast", completionAt: ended, lastUserMessageAt: h2, readAt: "2026-10-12T02:01:00.000Z" });
  assert.deepEqual([completionReadState(read), needsAttention(read)], ["read", false], "never stuck unread while the host keeps its flag");
});
