import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerHistory, restoreArchivedSession, RestoreJobs, type HistoryTransport } from "../server/history";
import { fetchTrajectory, summarizeTrajectoryRow } from "../server/trajectory";
import { normalizeTimelinePage } from "../shared/timeline";
import { followRestore, RESTORE_POLL_MS, RESTORE_STILL_RUNNING, restoreFailureText, type RestoreFlow, type RestoreSessionResult } from "../shared/history";

function restoreFixture(options: { active?: boolean; missingPersistence?: boolean; workspaceActive?: boolean; workspaceRecoverable?: boolean; race?: boolean } = {}) {
  let archived = !options.active; let reads = 0;
  const messages: Record<string, unknown>[] = [];
  const snapshot = () => ({ id: "agent-a", workspaceId: "workspace-a", provider: "codex", title: "Original", status: "closed",
    lastUserMessageAt: "2026-09-15T11:00:00Z",
    archivedAt: archived ? "2026-09-15T12:00:00Z" : null, persistence: options.missingPersistence ? null : { provider: "codex", sessionId: "original-session" },
    activeTurn: options.race && reads > 1 ? { turnId: "active", startedAt: "2026-09-16T12:00:00Z" } : null });
  const paseo = { agents: { ref() { return { async refresh() { reads++; return { agent: snapshot(), project: null }; } }; } },
    workspaces: { ref() { return { async refresh() { return options.workspaceActive ? { id: "workspace-a" } : null; } }; } } } as unknown as PaseoApi;
  const transport: HistoryTransport = { async request(message) {
    messages.push(message);
    if (message.type === "workspace.recovery.inspect.request") return { state: options.workspaceRecoverable === false
      ? { kind: "unavailable", reason: "workspace_directory_missing", message: "directory missing" }
      : { kind: "recoverable", action: "unarchive" } };
    if (message.type === "workspace.recovery.restore.request") return { accepted: true };
    if (message.type === "refresh_agent_request") { archived = false; return { status: "agent_refreshed", agentId: "agent-a" }; }
    throw new Error("Unexpected mutation");
  } };
  return { paseo, transport, messages };
}
test("restore active session is a no-op", async () => {
  const f = restoreFixture({ active: true }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "already_active"); assert.equal(f.messages.length, 0);
});
test("restore without original persistence never creates a replacement agent", async () => {
  const f = restoreFixture({ missingPersistence: true }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "needs_native"); assert.equal(f.messages.length, 0);
});
test("restore reuses exact agent and workspace without a prompt or sibling mutation", async () => {
  const f = restoreFixture();
  const origins: object[] = [];
  const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport, async origin => {
    assert.equal(f.messages.length, 0, "archive read provenance must be recorded before unarchiving mutates state");
    origins.push(origin); return origin;
  });
  assert.deepEqual(origins, [{ agentId: "agent-a", archivedAt: "2026-09-15T12:00:00Z", lastUserMessageAt: "2026-09-15T11:00:00Z" }]);
  assert.equal(result.status, "restored"); assert.equal(result.workspaceRestored, true);
  assert.deepEqual(f.messages, [
    { type: "workspace.recovery.inspect.request", workspaceId: "workspace-a" },
    { type: "workspace.recovery.restore.request", workspaceId: "workspace-a" },
    { type: "refresh_agent_request", agentId: "agent-a" },
  ]);
});
test("active workspace does not need workspace recovery", async () => {
  const f = restoreFixture({ workspaceActive: true }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "restored"); assert.equal(result.workspaceRestored, false);
  assert.deepEqual(f.messages, [{ type: "refresh_agent_request", agentId: "agent-a" }]);
});
test("unrecoverable workspace leaves archived session untouched", async () => {
  const f = restoreFixture({ workspaceRecoverable: false }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "needs_native"); assert.equal(f.messages.length, 1);
});
test("restore rechecks liveness and never refreshes a newly active turn", async () => {
  const f = restoreFixture({ workspaceActive: true, race: true }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "needs_native"); assert.equal(f.messages.length, 0);
});

// 恢复会话 as a job (opus-F73): the host gives a plugin RPC 30 s, a worktree rebuild and a session reopen can take minutes.
function deferred<T = void>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
/** The fixture's host, with one request type held until the test lets it through (or fails it). */
function slowTransport(base: HistoryTransport, type: string) {
  const gate = deferred<void>(), sent: string[] = [];
  return { gate, sent, transport: { async request(message, responseType) { sent.push(String(message.type)); if (message.type === type) await gate.promise; return base.request(message, responseType); } } as HistoryTransport };
}
async function ended(jobs: RestoreJobs, jobId: string) {
  for (let index = 0; index < 200; index++) { const view = jobs.status(jobId); if (view?.status !== "pending") return view; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error("the restore did not end");
}
test("a slow restore answers pending at once, stays pending past the host's 30 s and is then read as restored (opus-F73)", async () => {
  let now = Date.parse("2026-10-12T12:00:00Z");
  const f = restoreFixture(), slow = slowTransport(f.transport, "workspace.recovery.restore.request");
  const jobs = new RestoreJobs({ now: () => now, quickMs: 20 });
  const run = (progress: Parameters<typeof restoreArchivedSession>[4]) => restoreArchivedSession(f.paseo, "agent-a", slow.transport, undefined, progress);
  const started = Date.now(), first = await jobs.start("agent-a", run);
  assert.ok(Date.now() - started < 1000, "the RPC answers within the quick window, far below the host's 30 s");
  assert.equal(first.status, "pending"); assert.ok(first.jobId); assert.equal(first.message, "正在恢复关联工作区");
  now += 45_000;
  assert.deepEqual([jobs.status(first.jobId!)?.status, jobs.status(first.jobId!)?.message], ["pending", "正在恢复关联工作区"]);
  // A second tap (or the client after a dropped answer) joins the running restore instead of starting another.
  const again = await jobs.start("agent-a", () => { throw new Error("a second restore must not start"); });
  assert.deepEqual([again.status, again.jobId], ["pending", first.jobId]);
  slow.gate.resolve();
  const done = await ended(jobs, first.jobId!);
  assert.deepEqual([done?.status, done?.jobId, done?.workspaceRestored, done?.message], ["restored", first.jobId, true, "关联工作区与原会话已恢复，未发送新任务。"]);
  assert.deepEqual(slow.sent, ["workspace.recovery.inspect.request", "workspace.recovery.restore.request", "refresh_agent_request"]);
  // The outcome stays readable for ten minutes, then the job is forgotten.
  now += 9 * 60_000; assert.equal(jobs.status(first.jobId!)?.status, "restored");
  now += 2 * 60_000; assert.equal(jobs.status(first.jobId!), null);
  // Once it ended, a new tap starts a new restore (here: already active).
  const later = await jobs.start("agent-a", run);
  assert.equal(later.status, "already_active"); assert.notEqual(later.jobId, first.jobId);
});
test("a quick restore answers its outcome directly, with a job id (opus-F73)", async () => {
  const f = restoreFixture({ active: true }), jobs = new RestoreJobs({ quickMs: 1000 });
  const answer = await jobs.start("agent-a", progress => restoreArchivedSession(f.paseo, "agent-a", f.transport, undefined, progress));
  assert.equal(answer.status, "already_active"); assert.ok(answer.jobId); assert.equal(jobs.status(answer.jobId!)?.status, "already_active");
});
test("restore failures are Chinese: a host that does not answer, English host errors, unrecoverable workspaces (opus-F73)", async () => {
  const jobs = new RestoreJobs({ quickMs: 5 });
  const failing = (error: Error, type = "refresh_agent_request") => { const f = restoreFixture({ workspaceActive: true });
    return { async request(message, responseType) { if (message.type === type) throw error; return f.transport.request(message, responseType); } } as HistoryTransport; };
  const outcome = async (transport: HistoryTransport, options: Parameters<typeof restoreFixture>[0] = { workspaceActive: true }) => {
    const f = restoreFixture(options), answer = await jobs.start(`agent-${Math.random()}`, progress => restoreArchivedSession(f.paseo, "agent-a", transport, undefined, progress));
    return answer.status === "pending" ? (await ended(jobs, answer.jobId!))! : answer;
  };
  const silent = await outcome(failing(new Error("宿主未响应子任务请求。可重试，或确认 Paseo 宿主支持子任务观察。")));
  assert.deepEqual([silent.status, silent.message], ["failed", RESTORE_STILL_RUNNING]);
  const english = await outcome(failing(new Error("Agent agent-a not found")));
  assert.deepEqual([english.status, english.message], ["failed", "会话恢复失败（宿主返回：Agent agent-a not found）"]);
  const rebuild = await outcome(failing(new Error("Recreated worktree diverged from /home/me/app"), "workspace.recovery.restore.request"), {});
  assert.equal(rebuild.message, "关联工作区恢复失败：Recreated worktree diverged from /home/me/app");
  const missing = restoreFixture({ workspaceRecoverable: false });
  const unrecoverable = await restoreArchivedSession(missing.paseo, "agent-a", missing.transport);
  assert.deepEqual([unrecoverable.status, unrecoverable.message], ["needs_native", "工作区目录已不存在，又不是可以重建的 worktree，无法恢复。"]);
  for (const text of ["Plugin RPC timed out: agent-observatory.invoke requestType=plugin.rpc.invoke.request", "Transport not connected (status: disconnected)", "Daemon client closed"])
    assert.equal(/[A-Za-z]{4}/.test(restoreFailureText(new Error(text))), false, text);
});
test("plugin shutdown stops a running restore before its next host request (opus-F73)", async () => {
  const f = restoreFixture(), slow = slowTransport(f.transport, "workspace.recovery.restore.request"), jobs = new RestoreJobs({ quickMs: 5 });
  const steps: string[] = [];
  let outcome: Promise<unknown> = Promise.resolve();
  const answer = await jobs.start("agent-a", progress => (outcome = restoreArchivedSession(f.paseo, "agent-a", slow.transport, undefined, { ...progress, onStep: step => { steps.push(step); progress.onStep?.(step); } })) as ReturnType<typeof restoreArchivedSession>);
  assert.equal(answer.status, "pending");
  jobs.close(); slow.gate.resolve();
  assert.deepEqual(await outcome.then(value => (value as { status: string }).status), "failed");
  assert.deepEqual(slow.sent, ["workspace.recovery.inspect.request", "workspace.recovery.restore.request"], "refresh_agent_request is never sent after shutdown");
  assert.equal(jobs.status(answer.jobId!), null);
  assert.equal((await jobs.start("agent-a", async () => { throw new Error("no restore after shutdown"); })).status, "failed");
  assert.deepEqual(steps, ["正在读取会话状态", "正在检查关联工作区", "正在恢复关联工作区"]);
});
test("the plugin answers observatory.history.restore at once and observatory.history.restore.status by job id (opus-F73)", async () => {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const server = { handle(contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) { handlers.set(contract.name, handler); } } as unknown as PluginServerContext;
  const f = restoreFixture(), gate = deferred<void>(), sent: string[] = [];
  const bridge = { async request(message: Record<string, unknown>, responseType: string, timeout?: number) { sent.push(`${String(message.type)}:${timeout}`); if (message.type === "workspace.recovery.restore.request") await gate.promise; return f.transport.request(message, responseType); } };
  const origins: unknown[] = [];
  const close = registerHistory(server, bridge, { quickMs: 10, rememberOrigin: async origin => { origins.push(origin); return origin; } });
  try {
    const first = await handlers.get("observatory.history.restore")!({ agentId: "agent-a" }, { paseo: f.paseo }) as RestoreSessionResult;
    assert.equal(first.status, "pending");
    assert.equal((await handlers.get("observatory.history.restore.status")!({ jobId: first.jobId }, { paseo: f.paseo }) as RestoreSessionResult).status, "pending");
    gate.resolve();
    let view: RestoreSessionResult | null = first;
    for (let index = 0; index < 200 && view?.status === "pending"; index++) { await new Promise(resolve => setTimeout(resolve, 2)); view = await handlers.get("observatory.history.restore.status")!({ jobId: first.jobId }, { paseo: f.paseo }) as RestoreSessionResult | null; }
    assert.equal(view?.status, "restored"); assert.equal(origins.length, 1, "the archived read's origin is recorded before unarchiving");
    assert.ok(sent.every(entry => entry.endsWith(":120000")), "each host step may still take two minutes");
    assert.equal(await handlers.get("observatory.history.restore.status")!({ jobId: "unknown" }, { paseo: f.paseo }), null);
  } finally { close(); gate.resolve(); }
});

/** The client side, with the RPCs and the wait as fakes: `wait` resolves at once, so the test runs in milliseconds. */
function flow(overrides: Partial<RestoreFlow> & Pick<RestoreFlow, "start">) {
  const progress: string[] = [], waits: number[] = [];
  const value: RestoreFlow = { agentId: "agent-a", status: async () => null, wait: async ms => { waits.push(ms); return true; }, onProgress: message => { progress.push(message); }, ...overrides };
  return { value, progress, waits };
}
const view = (status: RestoreSessionResult["status"], message: string, jobId: string | null = "job-1"): RestoreSessionResult =>
  ({ status, agentId: "agent-a", workspaceId: "workspace-a", workspaceRestored: false, workspaceAction: null, message, jobId });
test("the client follows a pending restore every 2.5 s until it ends, reporting each step (opus-F73)", async () => {
  const answers = [view("pending", "正在重建关联的 worktree，可能要一两分钟"), view("pending", "正在重新打开原会话"), view("restored", "原会话已恢复，未发送新任务。")];
  const f = flow({ start: async () => view("pending", "正在检查关联工作区"), status: async jobId => { assert.equal(jobId, "job-1"); return answers.shift()!; } });
  const result = await followRestore(f.value);
  assert.deepEqual([result.status, result.message], ["restored", "原会话已恢复，未发送新任务。"]);
  assert.deepEqual(f.progress, ["正在检查关联工作区", "正在重建关联的 worktree，可能要一两分钟", "正在重新打开原会话"]);
  assert.deepEqual(f.waits, [RESTORE_POLL_MS, RESTORE_POLL_MS, RESTORE_POLL_MS]); assert.equal(RESTORE_POLL_MS, 2500);
  // A quick outcome needs no polling at all.
  const quick = flow({ start: async () => view("needs_native", "会话仍有活动任务，请在原生会话中处理，避免中断执行。") });
  assert.equal((await followRestore(quick.value)).status, "needs_native"); assert.deepEqual(quick.waits, []);
});
test("the client never shows the host's English: an RPC timeout or a lost connection reads as still restoring (opus-F73)", async () => {
  const timeout = new Error("Plugin RPC timed out: agent-observatory.invoke requestType=plugin.rpc.invoke.request");
  const started = await followRestore(flow({ start: async () => { throw timeout; } }).value);
  assert.deepEqual([started.status, started.message], ["pending", RESTORE_STILL_RUNNING]);
  const dropped = await followRestore(flow({ start: async () => { throw new Error("Transport not connected (status: disconnected)"); } }).value);
  assert.equal(dropped.status, "pending"); assert.equal(/[A-Za-z]{4}/.test(dropped.message), false);
  const invalid = await followRestore(flow({ start: async () => { throw new Error("Invalid input"); } }).value);
  assert.deepEqual([invalid.status, invalid.message], ["failed", "会话恢复失败（宿主返回：Invalid input）"]);
  // Two slow reads in a row are retried; the third gives up as still restoring, never as an English failure.
  let reads = 0;
  const flaky = await followRestore(flow({ start: async () => view("pending", "正在重新打开原会话"), status: async () => { if (++reads <= 2) throw timeout; return view("restored", "原会话已恢复，未发送新任务。"); } }).value);
  assert.deepEqual([flaky.status, reads], ["restored", 3]);
  reads = 0;
  const gone = await followRestore(flow({ start: async () => view("pending", "正在重新打开原会话"), status: async () => { reads++; throw timeout; } }).value);
  assert.deepEqual([gone.status, gone.message, reads], ["pending", RESTORE_STILL_RUNNING, 3]);
});
test("when the server no longer knows the restore, the session's own archived state decides; leaving the view stops following (opus-F73)", async () => {
  const pending = async () => view("pending", "正在重新打开原会话");
  const restored = await followRestore(flow({ start: pending, archived: async () => false }).value);
  assert.deepEqual([restored.status, restored.message], ["already_active", "原会话已恢复，可直接打开。"]);
  const archived = await followRestore(flow({ start: pending, archived: async () => true }).value);
  assert.equal(archived.status, "failed"); assert.match(archived.message, /再点一次「恢复会话」/);
  const unknown = await followRestore(flow({ start: pending, archived: async () => { throw new Error("offline"); } }).value);
  assert.deepEqual([unknown.status, unknown.message], ["pending", RESTORE_STILL_RUNNING]);
  let reads = 0;
  const left = await followRestore(flow({ start: pending, wait: async () => false, status: async () => { reads++; return null; } }).value);
  assert.deepEqual([left.status, left.message, reads], ["pending", RESTORE_STILL_RUNNING, 0]);
  // Following ends after ten minutes of pending reads; the restore itself goes on.
  let clock = 0;
  const long = await followRestore(flow({ start: pending, now: () => clock, wait: async () => { clock += 61_000; return true; }, status: pending }).value);
  assert.deepEqual([long.status, long.message], ["pending", RESTORE_STILL_RUNNING]); assert.ok(clock >= 10 * 60_000);
});

test("the plugin reloading under the poll reads as the server having lost the restore, never as an English failure", async () => {
  const pending = async () => view("pending", "正在重新打开原会话");
  // The host answers for the plugin while it reloads (plugins/runtime.js invoke): the new process knows no job.
  const unavailable = () => { throw new Error("Plugin is not available: agent-observatory"); };
  const missingRpc = () => { throw new Error("Plugin agent-observatory does not contribute RPC observatory.history.restore.status"); };
  let archivedReads = 0;
  const reopened = await followRestore(flow({ start: pending, status: async () => unavailable(), archived: async () => { archivedReads++; return false; } }).value);
  assert.deepEqual([reopened.status, reopened.message, archivedReads], ["already_active", "原会话已恢复，可直接打开。", 1]);
  const stopped = await followRestore(flow({ start: pending, status: async () => missingRpc(), archived: async () => true }).value);
  assert.deepEqual([stopped.status, stopped.message], ["failed", "恢复没有完成（观测台可能重新加载过），可以再点一次「恢复会话」。"]);
  const unknown = await followRestore(flow({ start: pending, status: async () => unavailable(), archived: async () => null }).value);
  assert.deepEqual([unknown.status, unknown.message], ["pending", RESTORE_STILL_RUNNING]);
  // A tap while it reloads never reached the plugin: nothing started, said in Chinese.
  const tapped = await followRestore(flow({ start: async () => unavailable() }).value);
  assert.deepEqual([tapped.status, tapped.message], ["failed", "观测台正在重新加载，恢复没有开始，稍后再点一次「恢复会话」。"]);
  for (const error of [new Error("Plugin is not available: agent-observatory"), new Error("Plugin agent-observatory does not contribute RPC observatory.history.restore")])
    assert.equal(/[A-Za-z]{4}/.test(restoreFailureText(error)), false, error.message);
});

const row = (seq: number, type: string, text: string) => ({ seqStart: seq, seqEnd: seq, timestamp: `2026-09-16T12:00:${String(seq).padStart(2, "0")}Z`, item: { type, text } });
function trajectoryFixture(pages: unknown[], status = "closed", checkout: Record<string, unknown> = { cwd: "/project" }) {
  const requests: Array<Record<string, unknown>> = []; let index = 0;
  const agent = { id: "a", title: "History", provider: "codex", status, archivedAt: "2026-09-15T12:00:00Z", cwd: "/project" };
  const paseo = { agents: { ref() { return { refresh: async () => ({ agent, project: { projectKey: "p", projectName: "Project", checkout } }),
    current: () => agent, timeline: { async refetch(options: Record<string, unknown>) { requests.push(options); const next = pages[Math.min(index++, pages.length - 1)]; if (next instanceof Error) throw next; return next; } } }; } } } as unknown as PaseoApi;
  return { paseo, requests };
}
test("trajectory fetches real cursor history and does not equate closed with complete", async () => {
  const f = trajectoryFixture([
    { epoch: "e", entries: [row(3, "user_message", "second"), row(4, "assistant_message", "answer")], hasOlder: true, startCursor: { epoch: "e", seq: 3 } },
    { epoch: "e", entries: [row(1, "user_message", "first"), row(2, "assistant_message", "answer")], hasOlder: false, hasNewer: true, startCursor: { epoch: "e", seq: 1 } },
  ]);
  const result = await fetchTrajectory(f.paseo, "a");
  assert.equal(result.counts.userTurns, 2); assert.equal(result.coverage.complete, true);
  assert.equal(result.completionEvidence.kind, "none"); assert.equal(result.rows[0].ref, "a:e:1-1");
  assert.deepEqual(f.requests[1].cursor, { epoch: "e", seq: 3 });
  assert.equal(result.agent.archivedAt, "2026-09-15T12:00:00Z");
});
test("trajectory budget preserves newest evidence and declares partial coverage", async () => {
  const f = trajectoryFixture([{ epoch: "e", entries: [row(1, "user_message", "a".repeat(900)), row(2, "assistant_message", "b".repeat(900))], hasOlder: false }]);
  const result = await fetchTrajectory(f.paseo, "a", { maxCharacters: 1000 });
  assert.ok(result.coverage.characters <= 1000); assert.equal(result.rows.length, 2);
  assert.ok(result.rows[0].text.startsWith("a")); assert.ok(result.rows.at(-1)?.text.endsWith("b"));
  assert.equal(result.coverage.truncated, true); assert.equal(result.coverage.complete, false);
});
test("earlier-page failure retains usable sampled evidence", async () => {
  const f = trajectoryFixture([{ epoch: "e", entries: [row(3, "user_message", "recent")], hasOlder: true, startCursor: { epoch: "e", seq: 3 } }, new Error("offline")]);
  const result = await fetchTrajectory(f.paseo, "a");
  assert.equal(result.rows.length, 1); assert.equal(result.coverage.complete, false); assert.match(result.coverage.reason ?? "", /offline/);
});
test("trajectory project identity favors main repository over child worktree", async () => {
  const f = trajectoryFixture([{ epoch: "e", entries: [row(1, "user_message", "inspect")], hasOlder: false }], "idle",
    { mainRepoRoot: "/main/project", worktreeRoot: "/worktrees/task", cwd: "/worktrees/task/subdir" });
  assert.equal((await fetchTrajectory(f.paseo, "a")).project?.rootPath, "/main/project");
});
test("tool evidence summarizes giant embedded scripts and preserves failure signals", () => {
  const raw = normalizeTimelinePage({ epoch: "e", rows: [{ seq: 1, item: { type: "tool_call", name: "exec", status: "failed",
    detail: { type: "shell", command: "python - <<'PY'\n" + "embedded-code\n".repeat(10000) + "\nPY",
      output: "beginning\n" + "ordinary log\n".repeat(2000) + "ERROR: missing fixture\n" + "later log\n".repeat(2000) + "terminal failure end", exitCode: 1 } } }] });
  const summary = summarizeTrajectoryRow(raw.rows[0]);
  assert.ok(summary.text.length <= 6000); assert.equal(summary.truncated, true);
  assert.match(summary.text, /python/); assert.match(summary.text, /missing fixture/); assert.match(summary.text, /terminal failure end/);
});
test("giant recent tool output does not prevent acquiring earlier user turns", async () => {
  const recent = normalizeTimelinePage({ epoch: "e", rows: [{ seq: 10, item: { type: "tool_call", name: "exec", status: "completed", detail: { type: "shell", command: "inspect", output: "large\n".repeat(100000) } } }], hasOlder: true, startCursor: { epoch: "e", seq: 10 } });
  const f = trajectoryFixture([
    { epoch: "e", entries: recent.rows.map(item => ({ seqStart: item.seqStart, seqEnd: item.seqEnd, item: item.item })), hasOlder: true, startCursor: { epoch: "e", seq: 10 } },
    { epoch: "e", entries: [row(1, "user_message", "first user intent"), row(2, "user_message", "second user intent")], hasOlder: false },
  ]);
  const result = await fetchTrajectory(f.paseo, "a", { maxCharacters: 2000 });
  assert.equal(result.counts.userTurns, 2); assert.equal(result.coverage.pages, 2);
  assert.ok(result.rows.some(item => item.text.includes("first user intent")));
  assert.ok(result.coverage.characters <= 2000); assert.equal(result.coverage.truncated, true);
});
