import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ScheduleIndex, registerSchedules, type ScheduleDirectory, type ScheduleIndexOptions } from "../server/schedules";
import { normalizeAgent, type AgentRecord } from "../shared/model";
import { ARCHIVE_PARTIAL_LIST, archiveReadCandidates, confirmArchive, getScheduleHeartbeats, heartbeatGuard, heartbeatWake, heartbeatsByAgent, mergeHeartbeats, type HeartbeatGuard,
  type HeartbeatSummary, type HeartbeatsState } from "../shared/schedules";

// Device-local labels below are New York times (EDT, UTC-4).
process.env.TZ = "America/New_York";
const NOW = Date.parse("2026-10-10T16:00:00.000Z"); // 10月10日 12:00 in New York
const HOUR = 3_600_000, DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function run(id: string, at: number, patch: Record<string, unknown> = {}) {
  return { id, scheduledFor: iso(at), startedAt: iso(at), endedAt: iso(at + 60_000), status: "succeeded", agentId: null, workspaceId: null, output: "进度正常", error: null, ...patch };
}
function heartbeat(id: string, agentId: string, patch: Record<string, unknown> = {}) {
  return { id, name: `心跳 ${id}`, prompt: "看一下进度", cadence: { type: "cron", expression: "0 9 * * 1-5" }, target: { type: "agent", agentId }, status: "active",
    createdAt: iso(NOW - 30 * DAY), updatedAt: iso(NOW - DAY), nextRunAt: iso(NOW + 3 * HOUR), lastRunAt: null, pausedAt: null, expiresAt: null, maxRuns: null, runs: [], ...patch };
}
async function fixture(options: Pick<ScheduleIndexOptions, "limits" | "heartbeatCaps" | "maxFileBytes"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "observatory-heartbeats-"));
  const home = join(root, "home"), data = join(root, "data");
  await mkdir(join(home, "schedules"), { recursive: true }); await mkdir(data, { recursive: true });
  const directory: ScheduleDirectory = { agents: [], digest: "d", async refresh() {} };
  let now = NOW;
  const warnings: string[] = [];
  const index = new ScheduleIndex({ home, dataDirectory: data, directory, writeDelayMs: 0, now: () => now, log: message => warnings.push(message), ...options });
  return { index, home, warnings, write: (id: string, body: unknown) => writeFile(join(home, "schedules", `${id}.json`), typeof body === "string" ? body : JSON.stringify(body)),
    advance: (ms: number) => { now += ms; }, close: async () => { await index.close(); await rm(root, { recursive: true, force: true }); } };
}
const full = (value: unknown) => { assert.equal((value as { mode: string }).mode, "full"); return value as HeartbeatsState; };

test("observatory.schedules.heartbeats lists every heartbeat by the Agent it wakes, from the schedule files only", async () => {
  const f = await fixture();
  try {
    await f.write("hb-once", heartbeat("hb-once", "duty", { cadence: { type: "cron", expression: "35 22 11 10 *", timezone: "Asia/Tokyo" }, maxRuns: 1, nextRunAt: "2026-10-11T13:35:00.000Z" }));
    await f.write("hb-daily", heartbeat("hb-daily", "duty", { runs: [run("d-1", NOW - 45 * HOUR, { status: "failed", output: null, error: "Agent duty already has an active run" }), run("d-2", NOW - 21 * HOUR, { agentId: "duty" })] }));
    await f.write("hb-paused", heartbeat("hb-paused", "builder", { status: "paused", nextRunAt: null, runs: [run("p-1", NOW - 3 * DAY)] }));
    await f.write("hb-done", heartbeat("hb-done", "builder", { status: "completed", maxRuns: 1, nextRunAt: null, runs: [run("o-1", NOW - 2 * DAY, { scheduledFor: iso(NOW - 2 * DAY - 5000) })] }));
    await f.write("hb-old", heartbeat("hb-old", "builder", { status: "completed", nextRunAt: null, runs: [run("x-1", NOW - 10 * DAY)] }));
    await f.write("s1", { ...heartbeat("s1", "unused"), target: { type: "new-agent", config: { provider: "codex", cwd: "/work/app" } } });
    const first = full(await f.index.heartbeats());
    assert.deepEqual(first.heartbeats.map(item => item.scheduleId), ["hb-daily", "hb-once", "hb-paused", "hb-done"], "active by next run, paused, finished in the last 7 days; no new-agent schedules");
    const once = first.heartbeats.find(item => item.scheduleId === "hb-once")!;
    assert.deepEqual(once, { scheduleId: "hb-once", agentId: "duty", name: "心跳 hb-once", status: "active", cadence: "一次性 · 10月11日 22:35", timezone: "Asia/Tokyo", expression: "35 22 11 10 *",
      maxRuns: 1, once: true, nextRunAt: "2026-10-11T13:35:00.000Z", onceAt: "2026-10-11T13:35:00.000Z", runs: 0, lastRun: null });
    const daily = first.heartbeats.find(item => item.scheduleId === "hb-daily")!;
    assert.equal(daily.cadence, "工作日 09:00"); assert.equal(daily.timezone, "UTC"); assert.equal(daily.runs, 2); assert.equal(daily.once, false);
    assert.deepEqual(daily.lastRun, { status: "succeeded", startedAt: iso(NOW - 21 * HOUR), endedAt: iso(NOW - 21 * HOUR + 60_000), error: null });
    assert.equal(first.heartbeats.find(item => item.scheduleId === "hb-done")!.onceAt, iso(NOW - 2 * DAY - 5000), "a finished one-shot keeps when it was due");
    // Unchanged reads are a few bytes; a change in a file shows up.
    assert.deepEqual(await f.index.heartbeats({ revision: first.revision }), { mode: "unchanged", unchanged: true, revision: first.revision });
    await f.write("hb-once", heartbeat("hb-once", "duty", { cadence: { type: "cron", expression: "35 22 11 10 *", timezone: "Asia/Tokyo" }, maxRuns: 1, status: "paused", nextRunAt: null }));
    const second = full(await f.index.heartbeats({ revision: first.revision }));
    assert.equal(second.heartbeats.find(item => item.scheduleId === "hb-once")!.status, "paused");
    assert.deepEqual(mergeHeartbeats(second, { mode: "unchanged", unchanged: true, revision: second.revision }), second);
    // Grouped for the session list and the detail card.
    const byAgent = heartbeatsByAgent(second.heartbeats);
    assert.deepEqual(byAgent.get("duty")!.map(item => item.scheduleId), ["hb-daily", "hb-once"]);
    assert.deepEqual(byAgent.get("builder")!.map(item => item.scheduleId), ["hb-paused", "hb-done"]);
    // A finished heartbeat leaves the table 7 days after its last run.
    f.advance(6 * DAY);
    assert.deepEqual(full(await f.index.heartbeats()).heartbeats.map(item => item.scheduleId), ["hb-daily", "hb-once", "hb-paused"]);
  } finally { await f.close(); }
});

test("heartbeat reads may reuse a build that is recent enough", async () => {
  const f = await fixture();
  try {
    await f.write("hb", heartbeat("hb", "duty"));
    const first = full(await f.index.heartbeats({}, 60_000));
    await f.write("hb", heartbeat("hb", "duty", { status: "paused", nextRunAt: null }));
    assert.equal((await f.index.heartbeats({ revision: first.revision }, 60_000)).mode, "unchanged", "within a minute the last build answers");
    f.advance(61_000);
    assert.equal(full(await f.index.heartbeats({ revision: first.revision }, 60_000)).heartbeats[0]!.status, "paused");
  } finally { await f.close(); }
});

function summary(patch: Partial<HeartbeatSummary>): HeartbeatSummary {
  return { scheduleId: "hb", agentId: "duty", name: "心跳", status: "active", cadence: "工作日 09:00", timezone: "UTC", expression: "0 9 * * 1-5", maxRuns: null, once: false,
    nextRunAt: null, onceAt: null, runs: 0, lastRun: null, ...patch };
}

test("the session-row mark says when the Agent wakes next, in device time", () => {
  const at = (ms: number) => summary({ nextRunAt: iso(ms) });
  assert.deepEqual(heartbeatWake([at(Date.parse("2026-10-11T02:35:00.000Z"))], NOW),
    { state: "scheduled", label: "22:35 唤醒", description: "心跳会在 10月10日 22:35 唤醒这个 Agent", at: Date.parse("2026-10-11T02:35:00.000Z"), soon: false });
  assert.equal(heartbeatWake([at(Date.parse("2026-10-11T11:35:00.000Z"))], NOW)!.label, "明天 07:35 唤醒");
  assert.equal(heartbeatWake([at(Date.parse("2026-10-13T11:35:00.000Z"))], NOW)!.label, "10月13日 07:35 唤醒");
  const soon = heartbeatWake([at(NOW + 10 * 60_000)], NOW)!;
  assert.equal(soon.label, "12:10 唤醒"); assert.equal(soon.soon, true);
  assert.equal(heartbeatWake([at(NOW - 60_000)], NOW)!.label, "即将唤醒");
  // The earliest active heartbeat wins; a one-shot says so to screen readers.
  const pair = heartbeatWake([at(NOW + 5 * HOUR), summary({ scheduleId: "once", once: true, maxRuns: 1, nextRunAt: iso(NOW + 2 * HOUR) })], NOW)!;
  assert.equal(pair.label, "14:00 唤醒"); assert.equal(pair.description, "心跳会在 10月10日 14:00 唤醒这个 Agent（一次性）");
  assert.deepEqual(heartbeatWake([summary({ nextRunAt: iso(NOW + HOUR), lastRun: { status: "running", startedAt: iso(NOW - 60_000), endedAt: null, error: null } })], NOW),
    { state: "running", label: "心跳唤醒中", description: "心跳正在唤醒这个 Agent", at: null, soon: true });
  assert.equal(heartbeatWake([summary({ status: "paused" }), summary({ status: "completed" })], NOW)!.label, "心跳已暂停");
  assert.equal(heartbeatWake([summary({ status: "completed", lastRun: { status: "succeeded", startedAt: iso(NOW - DAY), endedAt: iso(NOW - DAY), error: null } })], NOW), null, "finished heartbeats wake nobody");
  assert.equal(heartbeatWake([], NOW), null); assert.equal(heartbeatWake(undefined, NOW), null);
});

// ---------- 归档已读完成 only trusts a complete heartbeat read (codex-F16) ----------

/** A completed session whose result was read: what 归档已读完成 offers when nothing keeps it. */
const done = (id: string, patch: Partial<AgentRecord> = {}): AgentRecord => ({ ...normalizeAgent({ id, status: "completed", requiresAttention: false }), ...patch });
const offered = (agents: AgentRecord[], state: HeartbeatsState | undefined, failed = false) => archiveReadCandidates(agents, agents, heartbeatGuard(state, failed));
const ids = (list: readonly AgentRecord[]) => list.map(agent => agent.id);

test("an unreadable schedules directory is never a trusted empty heartbeat list: 归档已读完成 offers nothing and says why", async () => {
  // Regression of the codex repro (heartbeat-read-failure.ts): the schedules directory replaced by a plain file makes readdir fail.
  const f = await fixture();
  try {
    await f.write("heartbeat", heartbeat("heartbeat", "protected", { cadence: { type: "every", everyMs: HOUR } }));
    const sessions = [done("protected"), done("free")];
    const before = full(await f.index.heartbeats());
    assert.deepEqual([before.error, before.complete, before.targets, before.truncated], [null, true, ["protected"], false]);
    assert.deepEqual(ids(offered(sessions, before).candidates), ["free"], "the heartbeat's target is kept");
    await rename(join(f.home, "schedules"), join(f.home, "schedules-backup"));
    await writeFile(join(f.home, "schedules"), "not a directory");
    const after = full(await f.index.heartbeats({ revision: before.revision }));
    assert.deepEqual(after.heartbeats, []);
    assert.equal(after.error, "定时任务目录读不出来，无法确认哪些会话还有心跳。"); assert.equal(after.complete, false);
    assert.deepEqual(heartbeatGuard(after), { ready: false, reason: after.error });
    assert.deepEqual(offered(sessions, after), { candidates: [], withheld: 2, reason: after.error, sparedForChildren: 0 }, "both wait: neither can be shown to have no heartbeat");
    // The runs page keeps its own wording for the same failure.
    const list = await f.index.list(null);
    assert.equal(list.mode === "full" ? list.error : null, "定时任务目录无法读取，只显示观测台记下的运行。");
  } finally { await f.close(); }
});

test("a scan cut by its file or byte budget leaves the heartbeat targets incomplete", async () => {
  const f = await fixture({ limits: { scheduleFiles: 1 } });
  try {
    await f.write("a", heartbeat("a", "first")); await f.write("b", heartbeat("b", "second"));
    const state = full(await f.index.heartbeats());
    assert.deepEqual([state.error, state.complete], [null, false]);
    assert.deepEqual(heartbeatGuard(state), { ready: false, reason: "定时任务没有全部读到，无法确认哪些会话还有心跳。" });
    assert.deepEqual(offered([done("first"), done("second"), done("free")], state), { candidates: [], withheld: 3, reason: "定时任务没有全部读到，无法确认哪些会话还有心跳。", sparedForChildren: 0 });
  } finally { await f.close(); }
  const g = await fixture({ limits: { scheduleBytes: 800 } });
  try {
    await g.write("a", heartbeat("a", "first")); await g.write("b", heartbeat("b", "second", { prompt: "看一下进度".repeat(100) }));
    const state = full(await g.index.heartbeats());
    assert.equal(state.complete, false); assert.equal(heartbeatGuard(state).ready, false);
  } finally { await g.close(); }
});

test("the listed heartbeats may be cut, the targets that keep sessions from archiving never are", async () => {
  const f = await fixture({ heartbeatCaps: { list: 2 } });
  try {
    for (const [index, agentId] of ["alpha", "beta", "gamma"].entries()) await f.write(`hb-${agentId}`, heartbeat(`hb-${agentId}`, agentId, { nextRunAt: iso(NOW + (index + 1) * HOUR) }));
    const state = full(await f.index.heartbeats());
    assert.deepEqual(state.heartbeats.map(item => item.agentId), ["alpha", "beta"], "the most relevant (soonest) are listed");
    assert.deepEqual([state.truncated, state.complete, state.targets], [true, true, ["alpha", "beta", "gamma"]]);
    assert.equal(heartbeatsByAgent(state.heartbeats).has("gamma"), false, "the list alone would have offered gamma");
    assert.deepEqual(ids(offered([done("alpha"), done("gamma"), done("free")], state).candidates), ["free"]);
  } finally { await f.close(); }
  const g = await fixture({ heartbeatCaps: { targets: 2 } });
  try {
    for (const agentId of ["alpha", "beta", "gamma"]) await g.write(`hb-${agentId}`, heartbeat(`hb-${agentId}`, agentId));
    const state = full(await g.index.heartbeats());
    assert.deepEqual([state.complete, state.targets?.length], [false, 2], "more targets than the response carries is incomplete");
    assert.deepEqual(offered([done("free")], state), { candidates: [], withheld: 1, reason: "定时任务没有全部读到，无法确认哪些会话还有心跳。", sparedForChildren: 0 });
  } finally { await g.close(); }
});

test("paused heartbeats keep their Agent too; finished ones, other files and files Paseo would skip do not", async () => {
  const f = await fixture();
  try {
    await f.write("active", heartbeat("active", "busy-agent"));
    await f.write("paused", heartbeat("paused", "paused-agent", { status: "paused", nextRunAt: null }));
    await f.write("done", heartbeat("done", "done-agent", { status: "completed", nextRunAt: null }));
    await f.write("new-agent", { ...heartbeat("new-agent", "unused"), target: { type: "new-agent", config: { provider: "my-claude", cwd: "/home/me/app" } } });
    // A newer Paseo's cadence this plugin cannot parse: its target is still read, so the Agent is kept.
    await f.write("future", heartbeat("future", "future-agent", { cadence: { type: "once", at: iso(NOW + HOUR) } }));
    await f.write("future-done", heartbeat("future-done", "future-done-agent", { cadence: { type: "once", at: iso(NOW - HOUR) }, status: "completed" }));
    // Not JSON at all: Paseo skips such a file as well, so it wakes nobody.
    await f.write("notes", "{ half a schedule");
    const state = full(await f.index.heartbeats());
    assert.deepEqual([state.error, state.complete, state.targets], [null, true, ["busy-agent", "future-agent", "paused-agent"]]);
    assert.ok(f.warnings.includes("ignoring notes.json, which is not JSON"));
    const sessions = ["busy-agent", "paused-agent", "done-agent", "future-agent", "future-done-agent", "unused"].map(id => done(id));
    assert.deepEqual(ids(offered(sessions, state).candidates), ["done-agent", "future-done-agent", "unused"]);
  } finally { await f.close(); }
});

test("a schedule file that cannot be read, or whose target kind is unknown, makes the read untrusted with a Chinese reason", async () => {
  const f = await fixture({ maxFileBytes: 2000 });
  try {
    await f.write("small", heartbeat("small", "kept"));
    await f.write("huge", heartbeat("huge", "hidden", { prompt: "x".repeat(5000) }));
    const state = full(await f.index.heartbeats());
    assert.deepEqual([state.error, state.complete], ["有 1 个定时任务文件读不出来，无法确认哪些会话还有心跳。", false]);
    assert.deepEqual(state.heartbeats.map(item => item.agentId), ["kept"], "what could be read is still listed");
    assert.deepEqual(offered([done("hidden")], state), { candidates: [], withheld: 1, reason: state.error!, sparedForChildren: 0 });
  } finally { await f.close(); }
  const g = await fixture();
  try {
    await g.write("other", { ...heartbeat("other", "x"), target: { type: "workspace", workspaceId: "wks_1" } });
    const state = full(await g.index.heartbeats());
    assert.deepEqual([state.error, state.complete], ["有 1 个定时任务的目标类型无法识别，无法确认哪些会话还有心跳。", false]);
  } finally { await g.close(); }
});

test("a fresh read sees a heartbeat created since the last build, and the revision follows whether the read can be trusted", async () => {
  const f = await fixture({ maxFileBytes: 2000 });
  try {
    await f.write("hb", heartbeat("hb", "duty"));
    const first = full(await f.index.heartbeats({}, 60_000));
    await f.write("late", heartbeat("late", "newcomer"));
    assert.equal((await f.index.heartbeats({ revision: first.revision }, 60_000)).mode, "unchanged", "a poll may reuse the build of a minute ago");
    const fresh = full(await f.index.heartbeats({ revision: first.revision, fresh: true }, 60_000));
    assert.deepEqual(fresh.targets, ["duty", "newcomer"]);
    // Only the trust changes (an unreadable file appears): the heartbeats listed stay the same, the revision does not.
    await f.write("huge", heartbeat("huge", "hidden", { prompt: "x".repeat(5000) }));
    const untrusted = full(await f.index.heartbeats({ revision: fresh.revision, fresh: true }));
    assert.deepEqual(untrusted.heartbeats, fresh.heartbeats); assert.notEqual(untrusted.revision, fresh.revision); assert.equal(untrusted.complete, false);
  } finally { await f.close(); }
});

test("the RPC handler reads fresh on request, and its answers pass the contract the client parses", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-heartbeat-rpc-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  const handlers = new Map<string, (input: unknown, context: { paseo: unknown }) => Promise<unknown>>();
  const server = { handle(contract: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => Promise<unknown>) { handlers.set(contract.name, handler); } } as unknown as PluginServerContext;
  const schedules = registerSchedules(server, { directory: { agents: [], digest: "d", async refresh() {} } }, { debounceMs: 60_000, pollMs: 60_000, watch: () => { throw new Error("no watcher in tests"); }, log: () => {} });
  try {
    await mkdir(join(root, "schedules"), { recursive: true });
    const call = async (input: unknown) => getScheduleHeartbeats.output.parse(await handlers.get("observatory.schedules.heartbeats")!(getScheduleHeartbeats.input.parse(input), { paseo: null }));
    const first = full(await call({}));
    assert.deepEqual([first.heartbeats, first.complete, first.targets], [[], true, []], "no schedules yet: a complete, empty read");
    await writeFile(join(root, "schedules", "hb.json"), JSON.stringify(heartbeat("hb", "duty")));
    assert.equal((await call({ revision: first.revision })).mode, "unchanged", "a poll within a minute reuses the last build");
    assert.deepEqual(full(await call({ revision: first.revision, fresh: true })).targets, ["duty"]);
  } finally {
    await schedules.close();
    if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("only a complete read is a guard: a failed request, an older server's answer and a pending read are not", () => {
  const state = (patch: Partial<HeartbeatsState> = {}): HeartbeatsState => ({ mode: "full", unchanged: false, revision: "r", generatedAt: iso(NOW), heartbeats: [], truncated: false, error: null, complete: true, targets: [], ...patch });
  assert.deepEqual(heartbeatGuard(state(), true), { ready: false, reason: "心跳读取失败，暂时无法确认哪些会话还有心跳。" }, "a failed poll does not trust the data it kept");
  assert.deepEqual(heartbeatGuard(undefined), { ready: false, reason: "正在读取心跳，读到之前不能批量归档。" });
  const older = { mode: "full", unchanged: false, revision: "r", generatedAt: iso(NOW), heartbeats: [] } as HeartbeatsState;
  assert.equal(heartbeatGuard(older).ready, false, "an answer without `complete` shows nothing");
  assert.equal(heartbeatGuard(state({ targets: undefined })).ready, false);
  const guard = heartbeatGuard(state({ targets: ["listed-too"], heartbeats: [summary({ agentId: "listed-too" }), summary({ scheduleId: "p", agentId: "paused", status: "paused" }), summary({ scheduleId: "c", agentId: "finished", status: "completed" })] }));
  assert.equal(guard.ready, true);
  assert.deepEqual(guard.ready ? [...guard.targets].sort() : null, ["listed-too", "paused"], "listed live heartbeats count even when `targets` misses them");
});

test("归档已读完成 offers what it did before when the read is complete: read, settled and not running anywhere up or down", () => {
  const complete: HeartbeatsState = { mode: "full", unchanged: false, revision: "r", generatedAt: iso(NOW), heartbeats: [summary({ agentId: "woken" })], truncated: false, error: null, complete: true, targets: ["woken"] };
  const agents = [
    done("plain"),
    normalizeAgent({ id: "unread", status: "completed", requiresAttention: true, attentionReason: "finished", attentionTimestamp: iso(NOW) }),
    done("parent"), normalizeAgent({ id: "running-child", status: "running", parentAgentId: "parent" }),
    normalizeAgent({ id: "busy-parent", status: "running" }), done("child-of-busy", { parentAgentId: "busy-parent" }),
    done("woken"), done("archived", { archivedAt: iso(NOW - HOUR) }), done("limited", { stop: { kind: "quota", resetAt: null, at: iso(NOW) } }),
  ];
  assert.deepEqual(ids(archiveReadCandidates(agents, agents, heartbeatGuard(complete)).candidates), ["plain"]);
  assert.deepEqual(archiveReadCandidates(agents, agents, heartbeatGuard(complete)).withheld, 0);
  assert.deepEqual(archiveReadCandidates(agents, agents.filter(agent => agent.id !== "plain"), heartbeatGuard(complete)).candidates, [], "only the page's scope is offered");
});

test("the second tap archives only what a fresh read still allows, and nothing when that read cannot be trusted", () => {
  const sessions = [done("a"), done("b"), done("c"), normalizeAgent({ id: "d", status: "running" })];
  const marked = new Set(["a", "b", "c", "d"]);
  const fresh = heartbeatGuard({ mode: "full", unchanged: false, revision: "r", generatedAt: iso(NOW), heartbeats: [], truncated: false, error: null, complete: true, targets: ["b"] });
  assert.deepEqual(confirmArchive(marked, sessions, sessions, fresh), { ok: true, ids: ["a", "c"], spared: 1, sparedForChildren: 0, changed: 1 }, "b got a heartbeat, d started a turn");
  assert.deepEqual(confirmArchive(marked, sessions, sessions, heartbeatGuard(undefined, true)), { ok: false, reason: "心跳读取失败，暂时无法确认哪些会话还有心跳。" });
  const partial = heartbeatGuard({ mode: "full", unchanged: false, revision: "r", generatedAt: iso(NOW), heartbeats: [], truncated: false, error: null, complete: false, targets: [] });
  assert.equal(confirmArchive(marked, sessions, sessions, partial).ok, false);
});

// ---------- 归档已读完成 never takes a sub-Agent along that has to stay (r3-F1) ----------
// Paseo archives the unarchived children of an archived Agent with it, and theirs in turn (cascadeArchiveChildren), completing the
// heartbeats of each one (completeForAgent): a read parent is only offered when everything below it could be archived as well.

/** A complete heartbeat read whose active or paused heartbeats wake `targets`. */
const woken = (...targets: string[]): HeartbeatGuard => heartbeatGuard({ mode: "full", unchanged: false, revision: "r", generatedAt: iso(NOW), heartbeats: [], truncated: false, error: null, complete: true, targets });
const unreadChild = (id: string, parentAgentId: string) => normalizeAgent({ id, status: "completed", requiresAttention: true, attentionReason: "finished", attentionTimestamp: iso(NOW), parentAgentId });

test("a read parent stays when archiving it would take along a child with a heartbeat, an unread result, a stop or an unfinished turn", () => {
  // The r3 repro: the child's heartbeat (its own 「过 30 分钟回来看」 or the observatory's 恢复后续跑) would be completed by the cascade.
  const pair = [done("parent"), done("child", { parentAgentId: "parent" })];
  assert.deepEqual(archiveReadCandidates(pair, pair, woken("child")), { candidates: [], withheld: 0, sparedForChildren: 1 });
  assert.deepEqual(confirmArchive(new Set(["parent"]), pair, pair, woken("child")), { ok: true, ids: [], spared: 0, sparedForChildren: 1, changed: 0 });
  assert.deepEqual(ids(archiveReadCandidates(pair, pair, woken()).candidates), ["parent", "child"], "with nothing below that must stay both may go");
  const below: Array<[string, AgentRecord]> = [
    ["an unread result", unreadChild("child", "parent")],
    ["a limit stop", done("child", { parentAgentId: "parent", stop: { kind: "quota", resetAt: null, at: iso(NOW) } })],
    ["a running turn", normalizeAgent({ id: "child", status: "running", parentAgentId: "parent" })],
    ["an approval to answer", normalizeAgent({ id: "child", status: "running", parentAgentId: "parent", pendingPermissionCount: 1 })],
    ["an error", normalizeAgent({ id: "child", status: "error", parentAgentId: "parent" })],
    ["no known result", normalizeAgent({ id: "child", status: "closed", parentAgentId: "parent" })],
  ];
  for (const [what, child] of below) {
    const agents = [done("parent"), child];
    assert.deepEqual(archiveReadCandidates(agents, agents, woken()), { candidates: [], withheld: 0, sparedForChildren: 1 }, what);
    assert.deepEqual(confirmArchive(new Set(["parent"]), agents, agents, woken()), { ok: true, ids: [], spared: 0, sparedForChildren: 1, changed: 0 }, what);
  }
});

test("every unarchived level below counts, across the page's filters; archived children and parent-label cycles do not trap the check", () => {
  // A heartbeat two levels down keeps both levels above it.
  const tree = [done("root"), done("middle", { parentAgentId: "root" }), done("leaf", { parentAgentId: "middle" }), done("sibling", { parentAgentId: "root" })];
  assert.deepEqual(archiveReadCandidates(tree, tree, woken("leaf")), { candidates: [done("sibling", { parentAgentId: "root" })], withheld: 0, sparedForChildren: 2 });
  assert.deepEqual(confirmArchive(new Set(["root", "middle", "leaf", "sibling"]), tree, tree, woken("leaf")), { ok: true, ids: ["sibling"], spared: 1, sparedForChildren: 2, changed: 0 });
  // A child the page filters out (another workspace, an older time range) is archived all the same.
  const filtered = [done("parent", { workspaceId: "wks-a" }), unreadChild("child", "parent")];
  assert.deepEqual(archiveReadCandidates(filtered, filtered.slice(0, 1), woken()).candidates, []);
  // Paseo's cascade skips an archived child and never goes through it: what is below it stays out of the check.
  const archived = [done("parent"), done("old", { parentAgentId: "parent", archivedAt: iso(NOW - HOUR) }), done("under-old", { parentAgentId: "old" })];
  assert.deepEqual(ids(archiveReadCandidates(archived, archived, woken("under-old")).candidates), ["parent"]);
  // A cycle of parent labels across levels ends where it began, with or without a heartbeat in it.
  const cycle = [done("a", { parentAgentId: "c" }), done("b", { parentAgentId: "a" }), done("c", { parentAgentId: "b" })];
  assert.deepEqual(ids(archiveReadCandidates(cycle, cycle, woken()).candidates), ["a", "b", "c"]);
  assert.deepEqual(archiveReadCandidates(cycle, cycle, woken("b")), { candidates: [], withheld: 0, sparedForChildren: 2 });
  assert.deepEqual(confirmArchive(new Set(["a", "b", "c"]), cycle, cycle, woken("b")), { ok: true, ids: [], spared: 1, sparedForChildren: 2, changed: 0 });
  const selfParent = [done("loop", { parentAgentId: "loop" })];
  assert.deepEqual(ids(archiveReadCandidates(selfParent, selfParent, woken()).candidates), ["loop"]);
});

test("the second tap re-checks what is below each marked session, and a cut session list offers and archives nothing", () => {
  const first = [done("parent"), done("child", { parentAgentId: "parent" }), done("solo")];
  assert.deepEqual(ids(archiveReadCandidates(first, first, woken()).candidates), ["parent", "child", "solo"]);
  const marked = new Set(["parent", "child", "solo"]);
  // Since the first tap the child started a new turn: it moved on itself, its parent stays for it.
  const moved = [done("parent"), normalizeAgent({ id: "child", status: "running", parentAgentId: "parent" }), done("solo")];
  assert.deepEqual(confirmArchive(marked, moved, moved, woken()), { ok: true, ids: ["solo"], spared: 0, sparedForChildren: 1, changed: 1 });
  // A sub-Agent spawned since then, with its own heartbeat, keeps both.
  const spawned = [...first, done("late", { parentAgentId: "child" })];
  assert.deepEqual(confirmArchive(marked, spawned, spawned, woken("late")), { ok: true, ids: ["solo"], spared: 0, sparedForChildren: 2, changed: 0 });
  // While the heartbeat read cannot be trusted, sessions held by their children are not counted as waiting for it.
  const held = [done("parent"), unreadChild("child", "parent"), done("solo")];
  const reason = "正在读取心跳，读到之前不能批量归档。";
  assert.deepEqual(archiveReadCandidates(held, held, heartbeatGuard(undefined)), { candidates: [], withheld: 1, reason, sparedForChildren: 1 });
  // The directory read was cut short: any loaded session may have children that were not loaded.
  assert.deepEqual(archiveReadCandidates(first, first, woken(), { truncated: true }), { candidates: [], withheld: 3, reason: ARCHIVE_PARTIAL_LIST, sparedForChildren: 0 });
  assert.deepEqual(archiveReadCandidates(first, first, heartbeatGuard(undefined), { truncated: true }).reason, ARCHIVE_PARTIAL_LIST, "the lasting reason wins");
  assert.deepEqual(confirmArchive(marked, first, first, woken(), { truncated: true }), { ok: false, reason: ARCHIVE_PARTIAL_LIST });
  assert.deepEqual(archiveReadCandidates(first, first, woken(), { truncated: false }).withheld, 0);
});
