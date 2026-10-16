import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi, PaseoAgentListResult } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { StatsDirectory } from "../server/stats-directory";
import { StatsStore, type StatsStoreOptions } from "../server/stats-store";
import type { StatsAgentRecord, StatsHour, StatsToolHour } from "../server/stats-types";
import { analyticsSnapshotSchema, emptyActivityMetrics, type AnalyticsSnapshot } from "../shared/analytics";
import { statsResponseSchema, statsSnapshotSchema, type StatsMetrics, type StatsResponse } from "../shared/stats";
import { telemetrySnapshotSchema, type TelemetrySnapshot } from "../shared/telemetry";

const HOUR = 3_600_000, DAY = 24 * HOUR, NOW = Date.parse("2026-09-23T12:00:00.000Z");
const input = { range: "7d", utcOffsetMinutes: 0 } as const;
type Entry = PaseoAgentListResult["entries"][number];
type Full = Extract<StatsResponse, { mode: "full" }>;
interface Saved {
  version: number; backfilled: boolean; observedSince: string | null; contentSince: string;
  /** Agent-hours are written sparsely: zero metrics are absent. */
  hours: StatsHour[]; agentHours: Array<Partial<StatsMetrics> & { agentId: string; hour: string; lastActiveAt: string }>; toolHours: StatsToolHour[];
  /** Per-UTC-day lists of 2.12.0, always written empty. */
  attributions: unknown[]; toolDays: unknown[]; records: StatsAgentRecord[];
  running: Array<[string, number]>; permissions: Array<{ agentId: string; requests: Array<[string, number]> }>;
}
const iso = (at: number) => new Date(at).toISOString();
function entry(id: string, agent: Record<string, unknown> = {}, project: Record<string, unknown> | null = null): Entry {
  return { agent: { id, createdAt: iso(NOW), provider: "codex", model: "gpt-test", cwd: "/repos/demo", title: id,
    labels: {}, status: "idle", archivedAt: null, requiresAttention: false, attentionReason: null, pendingPermissions: [], activeTurn: null,
    lastUsage: null, ...agent }, project } as unknown as Entry;
}
function page(entries: Entry[] = [], nextCursor: string | null = null): PaseoAgentListResult {
  return { entries, pageInfo: { hasMore: nextCursor !== null, nextCursor } } as PaseoAgentListResult;
}
function api(list: (...args: unknown[]) => Promise<PaseoAgentListResult> = async () => page()): PaseoApi {
  return { agents: { list } } as unknown as PaseoApi;
}
function full(result: StatsResponse): Full {
  statsResponseSchema.parse(result);
  assert.equal(result.mode, "full");
  return result as Full;
}
function content(id = "one", name = "edit"): AgentTimelineItem[] {
  return [{ type: "user_message", messageId: `u-${id}`, text: "private prompt" },
    { type: "tool_call", callId: `t-${id}`, name, status: "completed", error: null,
      detail: { type: "edit", filePath: "private/path.ts", oldString: "old\n", newString: "new\nline\n" } },
    { type: "assistant_message", messageId: `a-${id}`, text: "private response" }];
}
async function saved(store: StatsStore, directory: string): Promise<Saved> {
  await store.flush();
  return JSON.parse(await readFile(join(directory, "stats.json"), "utf8")) as Saved;
}
async function withStore(run: (store: StatsStore, clock: { now: number }, directory: string) => Promise<void>,
  start = NOW, options: Omit<StatsStoreOptions, "directory" | "now"> = {}): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-")), clock = { now: start };
  const store = new StatsStore({ directory, now: () => clock.now, ...options });
  try { await store.ready; await run(store, clock, directory); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("synchronous hooks put duration, permissions and content into hourly and agent-day buckets", async () => {
  await withStore(async (store, clock, directory) => {
    assert.equal(store.record({ type: "turn_started", agentId: "a" }), undefined);
    clock.now += 100; store.record({ type: "permission_requested", agentId: "a", requestId: "secret-request" });
    clock.now += 100; store.record({ type: "permission_requested", agentId: "a", requestId: "secret-request" });
    clock.now += 100; store.record({ type: "permission_resolved", agentId: "a", requestId: "secret-request" });
    clock.now += 200; store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: content() });
    const state = await saved(store, directory), hour = state.hours[0], attribution = state.agentHours[0];
    for (const row of [hour, attribution]) {
      assert.equal(row.turns, 1); assert.equal(row.completed, 1); assert.equal(row.runMs, 500); assert.equal(row.runSamples, 1);
      assert.equal(row.busyMs, 500); assert.equal(row.peakParallel, 1); assert.equal(row.approvals, 1); assert.equal(row.waitMs, 200);
      assert.equal(row.userMessages, 1); assert.equal(row.assistantMessages, 1); assert.equal(row.toolCalls, 1);
      assert.equal(row.edits, 1); assert.equal(row.linesAdded, 2); assert.equal(row.linesRemoved, 1); assert.equal(row.filesChanged, 1);
    }
    assert.equal(hour.hour, "2026-09-23T12:00:00.000Z"); assert.equal(attribution.agentId, "a"); assert.equal(attribution.hour, "2026-09-23T12:00:00.000Z");
    assert.equal(attribution.lastActiveAt, iso(clock.now)); assert.ok(!("sessions" in attribution), "zero metrics are not written");
    assert.deepEqual([state.attributions, state.toolDays], [[], []]);
    assert.equal(state.records[0].maxTurnMs, 500); assert.equal(state.records[0].maxTurnAt, iso(clock.now));
    assert.equal(state.records[0].lastKey, "msg:a-one"); assert.deepEqual(state.running, []); assert.deepEqual(state.permissions, []);
    assert.deepEqual(state.toolHours, [{ hour: "2026-09-23T12:00:00.000Z", tools: [{ name: "edit", kind: "edit", calls: 1, failures: 0 }], kinds: [{ name: "edit", kind: "edit", calls: 1, failures: 0 }] }]);
    const serialized = await readFile(join(directory, "stats.json"), "utf8");
    for (const secret of ["private prompt", "private response", "private/path.ts", "secret-request"]) assert.ok(!serialized.includes(secret));
    const snapshot = full(await store.read(input, api(async () => page([entry("a")]))));
    assert.equal(snapshot.totals.sessions, 1); assert.equal(snapshot.models[0].turns, 1); assert.equal(snapshot.projects[0].key, "demo");
    statsSnapshotSchema.parse(snapshot);
  });
});

test("overlapping turns share wall time and split busy/peak accounting at UTC hour and day boundaries", async () => {
  const start = Date.parse("2026-09-22T23:59:50.000Z");
  await withStore(async (store, clock, directory) => {
    store.record({ type: "turn_started", agentId: "a" });
    clock.now = start + 5_000; store.record({ type: "turn_started", agentId: "b" });
    clock.now = start + 15_000; store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    clock.now = start + 20_000; store.record({ type: "turn_ended", agentId: "b", outcome: "failed", timeline: [] });
    const state = await saved(store, directory);
    assert.deepEqual(state.hours.map(row => [row.hour, row.busyMs, row.peakParallel]), [
      ["2026-09-22T23:00:00.000Z", 10_000, 2], ["2026-09-23T00:00:00.000Z", 10_000, 2],
    ]);
    assert.equal(state.hours.reduce((sum, row) => sum + row.runMs, 0), 30_000);
    assert.equal(state.agentHours.reduce((sum, row) => sum + (row.busyMs ?? 0), 0), 20_000);
    assert.equal(state.agentHours.filter(row => row.agentId === "a").reduce((sum, row) => sum + (row.busyMs ?? 0), 0), 10_000);
    assert.equal(state.agentHours.filter(row => row.agentId === "b").reduce((sum, row) => sum + (row.busyMs ?? 0), 0), 10_000);
    assert.ok(state.agentHours.every(row => row.peakParallel === 2));
    // Each Agent has its own bucket on both sides of the UTC hour (and day) boundary.
    assert.deepEqual(state.agentHours.map(row => [row.agentId, row.hour]).sort(), [["a", "2026-09-22T23:00:00.000Z"], ["a", "2026-09-23T00:00:00.000Z"], ["b", "2026-09-22T23:00:00.000Z"], ["b", "2026-09-23T00:00:00.000Z"]]);
  }, start);
});

test("partial RPC advances are committed once and subsequent reads and ends do not double count", async () => {
  await withStore(async (store, clock, directory) => {
    store.record({ type: "turn_started", agentId: "a" }); const paseo = api();
    clock.now = NOW + 1_000;
    const first = full(await store.read(input, paseo)); assert.equal(first.totals.busyMs, 1_000);
    assert.deepEqual(await store.read({ ...input, revision: first.revision }, paseo), { mode: "unchanged", unchanged: true, revision: first.revision });
    clock.now += 500;
    const second = full(await store.read({ ...input, revision: first.revision }, paseo)); assert.equal(second.totals.busyMs, 1_500);
    clock.now += 500; store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    const last = full(await store.read(input, paseo)); assert.equal(last.totals.busyMs, 2_000); assert.equal(last.totals.runMs, 2_000);
    assert.equal((await saved(store, directory)).hours[0].busyMs, 2_000);
  });
});

test("unobserved turns expire exactly after twelve hours instead of charging the whole gap", async () => {
  await withStore(async (store, clock, directory) => {
    store.record({ type: "turn_started", agentId: "a" }); clock.now += 13 * HOUR;
    const snapshot = full(await store.read(input, api()));
    assert.equal(snapshot.totals.busyMs, 12 * HOUR); assert.equal(snapshot.totals.peakParallel, 1);
    store.record({ type: "turn_ended", agentId: "a", outcome: "canceled", timeline: [] });
    const state = await saved(store, directory);
    assert.deepEqual(state.running, []); assert.equal(state.hours.reduce((sum, row) => sum + row.busyMs, 0), 12 * HOUR);
    assert.equal(state.hours.reduce((sum, row) => sum + row.runSamples, 0), 0); assert.equal(state.records[0].maxTurnAt, null);
  });
});

test("unknown turn starts and permission resolutions preserve outcomes without invented durations", async () => {
  await withStore(async (store, _clock, directory) => {
    for (const outcome of ["completed", "failed", "canceled"] as const) store.record({ type: "turn_ended", agentId: "a", outcome, timeline: [] });
    store.record({ type: "permission_resolved", agentId: "a", requestId: "missing" });
    const row = (await saved(store, directory)).hours[0];
    assert.equal(row.completed, 1); assert.equal(row.failed, 1); assert.equal(row.canceled, 1); assert.equal(row.turns, 0);
    assert.equal(row.runSamples, 0); assert.equal(row.runMs, 0); assert.equal(row.approvals, 0); assert.equal(row.waitMs, 0);
  });
});

test("backfill uses hours once, uncovered days at noon and agent totals at their last known activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-backfill-"));
  const historical = { ...emptyActivityMetrics(), started: 2, completed: 1, failed: 1, runMs: 100, runSamples: 2, waitMs: 20 };
  const analytics: AnalyticsSnapshot = analyticsSnapshotSchema.parse({ startedAt: iso(NOW - 20 * DAY), updatedAt: iso(NOW), persistenceError: null,
    usageBasis: "provider_reported_snapshot", usageAggregation: "peak_per_bucket", agentsTruncated: false,
    hours: [{ ...historical, bucketStart: "2026-09-22T10:00:00.000Z" }],
    days: [{ ...historical, started: 999, bucketStart: "2026-09-22T00:00:00.000Z" }, { ...historical, started: 3, bucketStart: "2026-09-21T00:00:00.000Z" }],
    agents: ["a", "b"].map(agentId => ({ ...historical, agentId, provider: "codex", workspaceId: null, projectId: null, projectName: null, projectRootPath: null })),
    usage: [{ id: "usage", agentId: "a", provider: "codex", workspaceId: null, projectId: null, at: "2026-09-20T03:00:00.000Z", inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null }],
  });
  const telemetry: TelemetrySnapshot = telemetrySnapshotSchema.parse({ startedAt: analytics.startedAt, persistenceError: null,
    agents: [{ agentId: "a", turnStartedAt: "2026-09-18T00:00:00.000Z", turnEndedAt: "2026-09-18T01:00:00.000Z", outcome: "completed", completedTurns: 1,
      failedTurns: 0, canceledTurns: 0, totalRunMs: 1, permissionWaitMs: 0 }],
    events: [{ id: "event", agentId: "a", agentTitle: "a", at: "2026-09-19T02:00:00.000Z", type: "turn_completed", label: "end" }],
  });
  let reads = 0;
  const source = { analyticsSnapshot: async () => { reads++; return analytics; }, snapshot: async () => { reads++; return telemetry; } };
  let store = new StatsStore({ directory, now: () => NOW, telemetry: source });
  try {
    await store.ready; const first = await saved(store, directory);
    assert.equal(reads, 2); assert.equal(first.observedSince, analytics.startedAt); assert.equal(first.contentSince, iso(NOW));
    assert.equal(first.hours.reduce((sum, row) => sum + row.turns, 0), 5);
    assert.deepEqual(first.hours.map(row => row.hour).sort(), ["2026-09-21T12:00:00.000Z", "2026-09-22T10:00:00.000Z"]);
    // Each Agent's history lands on the hour of its last known activity (b has none: the analytics update time).
    assert.equal(first.agentHours.find(row => row.agentId === "a")?.hour, "2026-09-20T03:00:00.000Z");
    assert.equal(first.agentHours.find(row => row.agentId === "b")?.hour, "2026-09-23T12:00:00.000Z");
    assert.ok(first.hours.every(row => row.userMessages === 0 && row.toolCalls === 0));
    await store.close(); store = new StatsStore({ directory, now: () => NOW + 1_000, telemetry: source }); await store.ready;
    const restored = await saved(store, directory); assert.equal(reads, 2); assert.equal(restored.backfilled, true);
    assert.deepEqual(restored.hours, first.hours); assert.deepEqual(restored.agentHours, first.agentHours); assert.equal(restored.contentSince, first.contentSince);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("persistence keeps the content marker and pending permission clocks across reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-reload-")); let now = NOW;
  let store = new StatsStore({ directory, now: () => now });
  try {
    await store.ready; store.record({ type: "turn_started", agentId: "a" }); now += 1_000;
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: content() });
    store.record({ type: "permission_requested", agentId: "a", requestId: "permission" });
    await store.close(); now += 2_000; store = new StatsStore({ directory, now: () => now }); await store.ready;
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: content() });
    store.record({ type: "permission_resolved", agentId: "a", requestId: "permission" });
    const state = await saved(store, directory), row = state.hours[0];
    assert.equal(row.completed, 2); assert.equal(row.runSamples, 1); assert.equal(row.toolCalls, 1); assert.equal(row.userMessages, 1);
    assert.equal(row.waitMs, 2_000); assert.equal(row.approvals, 1); assert.equal(state.records[0].lastKey, "msg:a-one");
    assert.deepEqual(state.permissions, []); assert.ok((await readdir(directory)).every(name => !name.endsWith(".tmp")));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("restored running turns do not charge process downtime as busy time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-downtime-")); let now = NOW;
  let store = new StatsStore({ directory, now: () => now });
  try {
    await store.ready; store.record({ type: "turn_started", agentId: "a" }); now += 1_000; await store.close();
    now += 5_000; store = new StatsStore({ directory, now: () => now }); await store.ready; now += 1_000;
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    const row = (await saved(store, directory)).hours[0]; assert.equal(row.busyMs, 2_000); assert.equal(row.runMs, 7_000); assert.equal(row.runSamples, 1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("invalid JSON and invalid saved schemas are quarantined before collecting fresh observations", async () => {
  for (const bad of ["{not-json", JSON.stringify({ version: 1, backfilled: true, hours: [{}] })]) {
    const directory = await mkdtemp(join(tmpdir(), "observatory-stats-corrupt-")); await writeFile(join(directory, "stats.json"), bad);
    const store = new StatsStore({ directory, now: () => NOW });
    try {
      await store.ready; assert.equal(await readFile(join(directory, "stats.json.corrupt"), "utf8"), bad);
      store.record({ type: "turn_ended", agentId: "fresh", outcome: "failed", timeline: [] });
      const result = full(await store.read(input, api())); assert.equal(result.totals.failed, 1); assert.equal(result.totals.sessions, 0);
      assert.equal((await saved(store, directory)).backfilled, true);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("normal writes are deferred, close flushes, and clean flushes do not replace the file", async () => {
  await withStore(async (store, _clock, directory) => {
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    await assert.rejects(stat(join(directory, "stats.json")), { code: "ENOENT" });
    await store.close(); const first = await stat(join(directory, "stats.json")); await store.flush(); const second = await stat(join(directory, "stats.json"));
    assert.equal(first.ino, second.ino); assert.equal(first.mtimeMs, second.mtimeMs);
    assert.equal((JSON.parse(await readFile(join(directory, "stats.json"), "utf8")) as Saved).hours[0].completed, 1);
  });
});

test("unchanged revisions short-circuit while full replies reuse the memoized projection", async () => {
  await withStore(async (store, clock) => {
    let calls = 0; const paseo = api(async () => { calls++; return page([entry("a")]); });
    const first = full(await store.read(input, paseo)); clock.now += 1_000;
    const unchanged = await store.read({ ...input, revision: first.revision }, paseo);
    assert.deepEqual(unchanged, { mode: "unchanged", unchanged: true, revision: first.revision });
    const again = full(await store.read(input, paseo)); assert.strictEqual(again.daily, first.daily); assert.strictEqual(again.models, first.models); assert.equal(calls, 1);
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    const changed = full(await store.read({ ...input, revision: first.revision }, paseo)); assert.notEqual(changed.revision, first.revision); assert.equal(changed.totals.completed, 1);
  });
});

test("directory refresh is single-flight with a sixty-second cache and the bounded list contract", async () => {
  let now = NOW, calls = 0, finish: (value: PaseoAgentListResult) => void = () => {};
  const requested: unknown[][] = [], pending = new Promise<PaseoAgentListResult>(resolve => { finish = resolve; });
  const paseo = api(async (...args) => { requested.push(args); calls++; return calls === 1 ? pending : page([entry("a")]); });
  const cache = new StatsDirectory(() => now), first = cache.refresh(paseo), second = cache.refresh(paseo);
  assert.strictEqual(first, second); assert.equal(calls, 1); finish(page([entry("a")])); await first;
  now += 59_999; await cache.refresh(paseo); assert.equal(calls, 1); now += 1; await cache.refresh(paseo); assert.equal(calls, 2);
  assert.deepEqual(requested[0][0], { filter: { includeArchived: true }, sort: [{ key: "created_at", direction: "desc" }], page: { limit: 200 }, timeout: 15_000 });
  assert.equal(cache.loaded, true); assert.equal(cache.truncated, false);
});

test("directory follows pagination, compacts descriptors and replaces duplicate entries", async () => {
  const calls: unknown[][] = [];
  const paseo = api(async (...args) => {
    calls.push(args);
    return calls.length === 1 ? page([entry("a", { title: "old" }), entry("b", { provider: " claude ", model: null, cwd: "/work/fallback", labels: { "paseo.parent-agent-id": "a" },
      pendingPermissions: [{ id: "p1" }, { id: "p2" }], lastUsage: { contextWindowUsedTokens: 12.9, contextWindowMaxTokens: -1 }, activeTurn: { id: "turn" }, secret: "not retained" })], "next")
      : page([entry("a", { title: "new", model: "gpt-other" }, { projectKey: "explicit", projectName: "Project" })]);
  });
  const cache = new StatsDirectory(() => NOW); await cache.refresh(paseo);
  assert.equal(cache.agents.length, 2); assert.equal(cache.agents.find(agent => agent.id === "a")?.title, "new");
  assert.equal(cache.agents.find(agent => agent.id === "a")?.projectKey, "explicit");
  const b = cache.agents.find(agent => agent.id === "b")!;
  assert.equal(b.provider, "claude"); assert.equal(b.projectKey, "fallback"); assert.equal(b.parentAgentId, "a");
  assert.equal(b.pendingPermissions, 2); assert.equal(b.activeTurn, true); assert.equal(b.contextUsed, 12); assert.equal(b.contextMax, null);
  assert.ok(!JSON.stringify(cache.agents).includes("not retained"));
  assert.deepEqual((calls[1][0] as { page: unknown }).page, { limit: 200, cursor: "next" });
});

test("directory stops after twenty pages and stops repeated cursors instead of looping", async () => {
  let calls = 0; const cache = new StatsDirectory(() => NOW);
  await cache.refresh(api(async () => { calls++; return page([entry(`a-${calls}`)], `cursor-${calls}`); }));
  assert.equal(calls, 20); assert.equal(cache.agents.length, 20); assert.equal(cache.truncated, true);
  let repeats = 0; const repeated = new StatsDirectory(() => NOW);
  await repeated.refresh(api(async () => { repeats++; return page([entry(`b-${repeats}`)], "same"); }));
  assert.equal(repeats, 2); assert.equal(repeated.truncated, true);
});

test("directory failure retains the last complete walk and does not publish a partial refresh", async () => {
  let now = NOW; const cache = new StatsDirectory(() => now); await cache.refresh(api(async () => page([entry("good")])));
  const previous = cache.agents, digest = cache.digest; now += 60_000; let calls = 0;
  await cache.refresh(api(async () => { calls++; if (calls === 1) return page([entry("partial")], "next"); throw new Error("offline"); }));
  assert.strictEqual(cache.agents, previous); assert.equal(cache.digest, digest); assert.equal(cache.loaded, true);
  const empty = new StatsDirectory(() => now); await empty.refresh(api(async () => { throw new Error("offline"); }));
  assert.deepEqual(empty.agents, []); assert.equal(empty.loaded, false);
  await withStore(async store => {
    store.record({ type: "turn_ended", agentId: "observed", outcome: "completed", timeline: [] });
    const snapshot = full(await store.read(input, api(async () => { throw new Error("offline"); })));
    assert.equal(snapshot.totals.sessions, 0); assert.equal(snapshot.totals.completed, 1); assert.equal(snapshot.models[0].key, "unknown");
  });
});

test("directory live and context changes invalidate the store revision without new hooks", async () => {
  await withStore(async (store, clock) => {
    let current = entry("a", { lastUsage: { contextWindowUsedTokens: 10, contextWindowMaxTokens: 100 } });
    const paseo = api(async () => page([current])); const first = full(await store.read(input, paseo));
    assert.equal(first.live.idle, 0, "stopped without a question is not 待回复"); assert.equal(first.models[0].contextUsed, 10);
    clock.now += 60_000; current = entry("a", { status: "running", activeTurn: { id: "active" }, lastUsage: { contextWindowUsedTokens: 10, contextWindowMaxTokens: 100 } });
    const running = full(await store.read({ ...input, revision: first.revision }, paseo)); assert.notEqual(running.revision, first.revision); assert.equal(running.live.running, 1);
    clock.now += 60_000; current = entry("a", { requiresAttention: true, attentionReason: "finished", pendingPermissions: [{ id: "p" }], lastUsage: { contextWindowUsedTokens: 10, contextWindowMaxTokens: 100 } });
    const attention = full(await store.read({ ...input, revision: running.revision }, paseo)); assert.equal(attention.live.unread, 1); assert.equal(attention.live.approvals, 1); assert.equal(attention.live.idle, 0);
    clock.now += 60_000; current = entry("a", { requiresAttention: true, attentionReason: "finished", pendingPermissions: [{ id: "p" }], lastUsage: { contextWindowUsedTokens: 20, contextWindowMaxTokens: 200 } });
    const context = full(await store.read({ ...input, revision: attention.revision }, paseo)); assert.notEqual(context.revision, attention.revision); assert.equal(context.models[0].contextUsed, 20); assert.equal(context.models[0].contextMax, 200);
    clock.now += 60_000; current = entry("a", { archivedAt: iso(clock.now) });
    const archived = full(await store.read({ ...input, revision: context.revision }, paseo)); assert.equal(archived.live.open, 0); assert.equal(archived.totals.sessions, 1);
  });
});

test("待回复 counts come from the reply ledger and change the revision without new hooks", async () => {
  let asking = new Set<string>();
  const telemetry = { analyticsSnapshot: async () => { throw new Error("unused"); }, snapshot: async () => ({ startedAt: iso(NOW), persistenceError: null, agents: [], events: [] }),
    awaitingAgents: (agents: Iterable<{ id: string }>) => new Set([...agents].map(agent => agent.id).filter(id => asking.has(id))) };
  await withStore(async (store, clock) => {
    const paseo = api(async () => page([entry("a"), entry("b")]));
    const before = full(await store.read(input, paseo)); assert.equal(before.live.idle, 0);
    asking = new Set(["b"]); clock.now += 1_000;
    const after = full(await store.read({ ...input, revision: before.revision }, paseo));
    assert.notEqual(after.revision, before.revision); assert.equal(after.live.idle, 1);
  }, NOW, { telemetry: telemetry as unknown as StatsStoreOptions["telemetry"] });
});

test("看板 执行中 stays current between walks: an ended turn leaves, background subagents count", async () => {
  const walks: number[] = []; let working = new Set<string>();
  const background = { sync: async (_agents: unknown, walkedAt: number) => { walks.push(walkedAt); }, runningIds: () => new Set(working) };
  await withStore(async (store, clock) => {
    const paseo = api(async () => page([entry("a", { status: "running", activeTurn: { id: "t" } }), entry("b", { requiresAttention: true, attentionReason: "finished" })]));
    store.record({ type: "turn_started", agentId: "a" });
    const first = full(await store.read(input, paseo));
    assert.equal(first.live.running, 1); assert.equal(first.live.unread, 1); assert.deepEqual(walks, [NOW]);
    clock.now += 5_000; store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    working = new Set(["b"]);
    const second = full(await store.read({ ...input, revision: first.revision }, paseo));
    assert.equal(second.live.running, 1, "a ended after the cached walk; b works in the background");
    assert.equal(second.live.unread, 0, "a parent still working is not an unread result");
    assert.equal((await store.read({ ...input, revision: second.revision }, paseo)).mode, "unchanged");
    working = new Set();
    assert.equal(full(await store.read({ ...input, revision: second.revision }, paseo)).live.running, 0, "the background state is part of the revision");
  }, NOW, { background: background as unknown as StatsStoreOptions["background"] });
});

test("cached idle descriptors cannot end newer hooks but a fresh idle directory clears running state", async () => {
  await withStore(async (store, clock, directory) => {
    const paseo = api(async () => page([entry("a")])); await store.read(input, paseo); clock.now++;
    store.record({ type: "turn_started", agentId: "a" }); clock.now += 1_000; await store.read(input, paseo);
    assert.equal((await saved(store, directory)).running.length, 1);
    clock.now += 60_000; await store.read(input, paseo); assert.deepEqual((await saved(store, directory)).running, []);
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    assert.equal((await saved(store, directory)).hours.reduce((sum, row) => sum + row.runSamples, 0), 0);
  });
});

test("local day rollover changes only the affected timezone revision and UTC+8 re-buckets new turns", async () => {
  const start = Date.parse("2026-09-23T15:59:59.000Z");
  await withStore(async (store, clock) => {
    const paseo = api(async () => page([entry("a", { createdAt: iso(start) })]));
    store.record({ type: "turn_started", agentId: "a" }); store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    const utc = full(await store.read(input, paseo)), east = full(await store.read({ ...input, utcOffsetMinutes: 480 }, paseo));
    assert.equal(utc.to, "2026-09-23"); assert.equal(east.to, "2026-09-23"); assert.notEqual(utc.revision, east.revision);
    clock.now += 2_000;
    assert.equal((await store.read({ ...input, revision: utc.revision }, paseo)).mode, "unchanged");
    const rollover = full(await store.read({ ...input, utcOffsetMinutes: 480, revision: east.revision }, paseo));
    assert.equal(rollover.to, "2026-09-24"); assert.equal(rollover.daily.at(-2)?.turns, 1); assert.equal(rollover.daily.at(-1)?.turns, 0);
    store.record({ type: "turn_started", agentId: "a" }); store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    const nextUtc = full(await store.read(input, paseo)), nextEast = full(await store.read({ ...input, utcOffsetMinutes: 480 }, paseo));
    assert.equal(nextUtc.daily.at(-1)?.turns, 2); assert.equal(nextEast.daily.at(-2)?.turns, 1); assert.equal(nextEast.daily.at(-1)?.turns, 1);
    const range = full(await store.read({ range: "30d", utcOffsetMinutes: 0, revision: nextUtc.revision }, paseo)); assert.equal(range.daily.length, 30);
  }, start);
});

test("record LRU and the Agent-hour bound evict the least recent data, whole hours first", async () => {
  await withStore(async (store, clock, directory) => {
    for (let i = 0; i < 2_000; i++) store.record({ type: "turn_ended", agentId: `lru-${i}`, outcome: "completed", timeline: [] });
    clock.now++; store.record({ type: "turn_ended", agentId: "lru-0", outcome: "completed", timeline: [] });
    clock.now++; store.record({ type: "turn_ended", agentId: "lru-2000", outcome: "completed", timeline: [] });
    const lru = (await saved(store, directory)).records; assert.equal(lru.length, 2_000); assert.ok(lru.some(row => row.agentId === "lru-0")); assert.ok(!lru.some(row => row.agentId === "lru-1"));
    // 2,001 Agent-hours at NOW, then 30 hours × 1,000 Agents: the 30,000 cap drops the whole oldest hour.
    for (let hour = 1; hour <= 30; hour++) {
      clock.now = NOW + hour * HOUR;
      for (let agent = 0; agent < 1_000; agent++) store.record({ type: "turn_ended", agentId: `bounded-${agent}`, outcome: "completed", timeline: [] });
    }
    let state = await saved(store, directory); assert.equal(state.agentHours.length, 30_000); assert.ok(state.records.length <= 2_000);
    assert.ok(state.agentHours.every(row => row.hour >= iso(NOW + HOUR)));
    clock.now = NOW + 31 * HOUR; store.record({ type: "turn_ended", agentId: "bounded-0", outcome: "completed", timeline: [] });
    state = await saved(store, directory); assert.equal(state.agentHours.length, 29_001);
    assert.ok(state.agentHours.every(row => row.hour >= iso(NOW + 2 * HOUR))); assert.equal(state.agentHours.at(-1)?.hour, iso(NOW + 31 * HOUR));
    // The 看板 hours are not affected by the Agent-hour bound.
    assert.equal(state.hours.reduce((sum, row) => sum + row.completed, 0), 32_003);
  });
});

test("tool names stay within sixty an hour and thirty thousand in all while per-kind totals survive", async () => {
  await withStore(async (store, clock, directory) => {
    const timeline = (hour: number): AgentTimelineItem[] => [{ type: "user_message", messageId: `u-${hour}`, text: "work" },
      ...Array.from({ length: 61 }, (_, index): AgentTimelineItem => ({ type: "tool_call", callId: `t-${hour}-${index}`,
        name: `tool-${index}`, status: "completed", error: null, detail: { type: "read", filePath: "private/path.ts" } }))];
    for (let hour = 0; hour <= 500; hour++) { clock.now = NOW + hour * HOUR; store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: timeline(hour) }); }
    const state = await saved(store, directory), named = state.toolHours.filter(hour => hour.tools.length);
    // 501 hours × 60 names exceed 30,000 by one hour: the oldest hour keeps only its totals.
    assert.equal(state.toolHours.length, 501); assert.equal(named.length, 500); assert.equal(named.reduce((sum, hour) => sum + hour.tools.length, 0), 30_000);
    assert.deepEqual(state.toolHours[0], { hour: iso(NOW), tools: [], kinds: [{ name: "read", kind: "read", calls: 61, failures: 0 }] });
    assert.ok(named.every(hour => hour.kinds?.[0].calls === 61 && !hour.tools.some(tool => tool.name === "tool-60")));
    assert.ok(!JSON.stringify(state).includes("private/path.ts"));
  });
});

test("hourly and tool-day retention stay within 92 days while tool-kind totals survive the sixty-name cap", async () => {
  await withStore(async (store, clock, directory) => {
    const start = clock.now;
    for (let hour = 0; hour < 93 * 24; hour++) {
      clock.now = start + hour * HOUR; store.record({ type: "turn_started", agentId: "a" });
      const timeline: AgentTimelineItem[] = hour % 24 === 0 ? [{ type: "user_message", messageId: `u-${hour}`, text: "work" },
        ...Array.from({ length: 65 }, (_, index): AgentTimelineItem => ({ type: "tool_call", callId: `t-${hour}-${index}`, name: `tool-${index}`,
          status: "completed", error: null, detail: { type: "shell", command: "true", exitCode: index === 64 ? 1 : 0 } }))] : [];
      store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline });
    }
    const state = await saved(store, directory); assert.equal(state.hours.length, 92 * 24); assert.equal(state.toolHours.length, 92);
    assert.ok(state.toolHours.every(hour => hour.tools.length === 60 && hour.kinds?.[0].calls === 65 && hour.kinds[0].failures === 1));
    // Agent-hours share the same 92-day window (a busy Agent's 93rd day is gone).
    assert.equal(state.agentHours.length, 92 * 24); assert.ok(state.agentHours.every(row => Date.parse(row.hour) >= start + 24 * HOUR));
    const snapshot = full(await store.read({ range: "90d", utcOffsetMinutes: 0 }, api()));
    assert.equal(snapshot.toolKinds.find(row => row.kind === "shell")?.calls, 90 * 65);
    assert.equal(snapshot.toolKinds.find(row => row.kind === "shell")?.failures, 90);
  }, Math.floor(NOW / DAY) * DAY);
});

test("cursor LRU eviction does not discard an active turn or permission clock", async () => {
  await withStore(async (store, clock, directory) => {
    store.record({ type: "turn_started", agentId: "active" });
    store.record({ type: "permission_requested", agentId: "active", requestId: "pending" });
    for (let i = 0; i < 2_001; i++) store.record({ type: "turn_ended", agentId: `other-${i}`, outcome: "completed", timeline: [] });
    clock.now += 500;
    store.record({ type: "permission_resolved", agentId: "active", requestId: "pending" });
    store.record({ type: "turn_ended", agentId: "active", outcome: "completed", timeline: [] });
    const state = await saved(store, directory), row = state.agentHours.find(item => item.agentId === "active")!;
    assert.equal(row.runMs, 500); assert.equal(row.runSamples, 1); assert.equal(row.waitMs, 500); assert.equal(row.busyMs, 500);
    assert.equal(state.records.length, 2_000); assert.deepEqual(state.running, []); assert.deepEqual(state.permissions, []);
  });
});

test("a restored constructor accepts lifecycle events immediately before its ready promise is awaited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-immediate-")); let now = NOW;
  let store = new StatsStore({ directory, now: () => now });
  try {
    await store.ready; store.record({ type: "turn_started", agentId: "a" }); now += 100;
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: content("first") }); await store.close();
    now += 1_000;
    store = new StatsStore({ directory, now: () => now });
    // Deliberately no await or microtask yield between restoration and these hooks.
    store.record({ type: "turn_started", agentId: "a" }); now += 200;
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: content("second") });
    await store.ready;
    const state = await saved(store, directory), row = state.hours[0];
    assert.equal(row.turns, 2); assert.equal(row.completed, 2); assert.equal(row.runSamples, 2); assert.equal(row.runMs, 300);
    assert.equal(row.busyMs, 300); assert.equal(row.toolCalls, 2); assert.equal(row.userMessages, 2);
    assert.equal(state.records[0].lastKey, "msg:a-second"); assert.equal(state.contentSince, iso(NOW));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a delayed first telemetry seed starts content coverage at readiness and preserves historical observation coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-delayed-seed-")); let now = NOW;
  const analytics = analyticsSnapshotSchema.parse({ startedAt: iso(NOW - DAY), updatedAt: iso(NOW), persistenceError: null,
    usageBasis: "provider_reported_snapshot", usageAggregation: "peak_per_bucket", agentsTruncated: false, hours: [], days: [], agents: [], usage: [] });
  const telemetry = telemetrySnapshotSchema.parse({ startedAt: analytics.startedAt, persistenceError: null, agents: [], events: [] });
  let finish: (value: AnalyticsSnapshot) => void = () => {};
  const pending = new Promise<AnalyticsSnapshot>(resolve => { finish = resolve; });
  const store = new StatsStore({ directory, now: () => now,
    telemetry: { analyticsSnapshot: () => pending, snapshot: async () => telemetry } });
  try {
    now += 90_000; finish(analytics); await store.ready;
    const snapshot = full(await store.read(input, api()));
    assert.equal(snapshot.contentSince, iso(now)); assert.equal(snapshot.observedSince, iso(NOW - DAY)); assert.equal(snapshot.totals.busyMs, 0);
    store.record({ type: "turn_started", agentId: "a" }); now += 1_000;
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    const state = await saved(store, directory); assert.equal(state.contentSince, iso(NOW + 90_000)); assert.equal(state.hours[0].busyMs, 1_000);
  } finally { finish(analytics); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("non-parse filesystem failures preserve the unreadable path while collecting memory statistics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-unreadable-")), file = join(directory, "stats.json"); let now = NOW;
  await mkdir(file); await writeFile(join(file, "sentinel"), "preserve original path");
  const store = new StatsStore({ directory, now: () => now });
  try {
    await store.ready; store.record({ type: "turn_started", agentId: "memory" }); now += 50;
    store.record({ type: "turn_ended", agentId: "memory", outcome: "completed", timeline: content("memory") });
    const snapshot = full(await store.read(input, api()));
    assert.equal(snapshot.totals.completed, 1); assert.equal(snapshot.totals.toolCalls, 1); assert.equal(snapshot.totals.busyMs, 50);
    await store.flush(); await store.close();
    assert.equal((await stat(file)).isDirectory(), true); assert.equal(await readFile(join(file, "sentinel"), "utf8"), "preserve original path");
    await assert.rejects(stat(`${file}.corrupt`), { code: "ENOENT" }); assert.deepEqual(await readdir(directory), ["stats.json"]);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a failed atomic rename retains dirty observations for a later durable retry", async () => {
  await withStore(async (store, _clock, directory) => {
    const file = join(directory, "stats.json");
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    // A test-owned directory blocks rename without changing the store's readable startup state.
    await mkdir(file); await store.flush(); assert.equal((await stat(file)).isDirectory(), true);
    assert.ok((await readdir(directory)).every(name => !name.endsWith(".tmp")));
    store.record({ type: "turn_ended", agentId: "a", outcome: "failed", timeline: [] });
    await rm(file, { recursive: true }); await store.flush(true);
    const state = JSON.parse(await readFile(file, "utf8")) as Saved;
    assert.equal(state.hours[0].completed, 1); assert.equal(state.hours[0].failed, 1); assert.deepEqual(await readdir(directory), ["stats.json"]);
  });
});
