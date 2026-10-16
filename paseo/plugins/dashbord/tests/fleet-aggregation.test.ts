import assert from "node:assert/strict";
import test from "node:test";
import { buildStatsSnapshot, type StatsSnapshotInput } from "../server/stats-snapshot";
import { emptyStatsMetrics } from "../shared/stats";
import { buildTokenSnapshot } from "../server/tokens/snapshot";
import { buildTokenLive } from "../server/tokens/live";
import { StatsDirectory } from "../server/stats-directory";
import { addCall, emptyData, excludeCall } from "../server/tokens/data";
import { copyFingerprint, sameTokenCall } from "../shared/token-copies";
import { emptyTokenCounts, outputSpeed } from "../shared/tokens";
import { mergeFleetRead, mergeFleetStats, mergeFleetTokens } from "../shared/fleet-merge";
import { hostEntityId } from "../shared/fleet-scope";
import { qualifyFleetResult } from "../shared/fleet-entities";
import { withFleetReads } from "../server/fleet-rpc";
import { readFleetSnapshot, readFleetPart } from "../shared/fleet-rpc";
import { createHostRegistry, primaryHostId } from "../client/host-registry";
import { createFleetReader } from "../client/fleet-reader";
import { HOST_DATA_VERSION } from "../shared/host-data";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const now = Date.parse("2026-10-15T12:00:00Z"), stamp = new Date(now).toISOString();
const agent = (id: string, model = "model", projectKey = "project") => ({ id, createdAt: stamp, provider: "codex", model, parentAgentId: null, projectKey, projectName: "Same project",
  status: "idle", archivedAt: null, title: id, requiresAttention: false, attentionReason: null, pendingPermissions: 0, activeTurn: false, contextUsed: null, contextMax: null, sessionId: id, cwd: "/project" });
const stats = (patch: Partial<StatsSnapshotInput> = {}) => buildStatsSnapshot({ complete: true, now, range: "7d", utcOffsetMinutes: 0,
  hours: [], attributions: [], toolHours: [], records: [], running: new Map(), directory: [], observedSince: stamp, contentSince: stamp, directoryTruncated: false, ...patch });
const identity = (serverId: string) => ({ serverId, hostname: serverId, protocol: 1 as const, version: HOST_DATA_VERSION, capabilities: ["fleet-read-v1"], now: stamp, nonce: "" });

test("global rankings receive every row before merging, including models below each host's top 24", () => {
  const directory = Array.from({ length: 40 }, (_, i) => agent(String(i), `model-${i}`));
  const mac = stats({ directory }), win = stats({ directory: [agent("same", "model-39")] });
  assert.equal(mac.models.length, 40);
  const result = mergeFleetStats([{ hostId: "mac", label: "Mac", data: mac }, { hostId: "win", label: "Windows", data: win }]);
  assert.equal(result.totals.sessions, 41); assert.equal(result.models[0].key, "model-39"); assert.equal(result.models[0].sessions, 2);
  assert.equal(result.streak.activeDays, 1); assert.equal(result.models[0].activeDays, 1);
  assert.equal(result.projects.length, 2); assert.notEqual(result.projects[0].key, result.projects[1].key);
});

test("averages use summed samples, and historical host peaks are not presented as exact fleet concurrency", () => {
  const mac = stats({ hours: [{ ...emptyStatsMetrics(), hour: stamp, turns: 1, runMs: 100, runSamples: 1, peakParallel: 2 }] });
  const win = stats({ hours: [{ ...emptyStatsMetrics(), hour: stamp, turns: 9, runMs: 9000, runSamples: 9, peakParallel: 3 }] });
  const result = mergeFleetStats([{ hostId: "mac", label: "Mac", data: mac }, { hostId: "win", label: "Win", data: win }]);
  assert.equal(result.totals.runMs / result.totals.runSamples, 910);
  assert.equal(result.totals.peakParallel, 3); assert.equal(result.fleetDetails?.concurrency, "host_lower_bound");
});

test("backend filters session and attribution records before counting; unavailable historical detail stays explicit", () => {
  const result = stats({ directory: [agent("a", "chosen"), agent("b", "excluded")], hours: [{ ...emptyStatsMetrics(), hour: stamp, turns: 100 }],
    attributions: ["a", "b"].map(agentId => ({ ...emptyStatsMetrics(), agentId, hour: stamp, lastActiveAt: stamp, turns: agentId === "a" ? 2 : 9 })),
    filters: { projects: [], providers: [], models: ["chosen"] } });
  assert.equal(result.totals.sessions, 1); assert.equal(result.totals.turns, 2);
  assert.equal(result.fleetDetails?.toolNamesComplete, false); assert.equal(result.fleetDetails?.concurrency, "unavailable");
});

test("Token counters, weighted speed and speed distributions merge across full ledgers", () => {
  const make = (id: string, output: number, duration: number) => {
    const data = emptyData(); addCall(data, { key: id, source: "codex", sessionId: id, cwd: "/project", at: now - 1000, start: now - 1000 - duration,
      model: "model", input: 10, cacheWrite: 0, cacheRead: 20, output, reasoning: 0, subagent: false }, null, now);
    const directory = new StatsDirectory(); directory.agents = [agent(id)];
    return buildTokenSnapshot(data, { complete: true, range: "7d", utcOffsetMinutes: 0 }, now, directory,
      { earliestAt: stamp, latestAt: stamp, roots: [], backfill: { done: true, files: 1, filesDone: 1, bytes: 100, bytesDone: 100 } });
  };
  const mac = make("a", 100, 1000), win = make("b", 900, 9000);
  const result = mergeFleetTokens([{ hostId: "mac", label: "Mac", data: mac }, { hostId: "win", label: "Win", data: win }]);
  assert.equal(result.totals.output, 1000); assert.equal(outputSpeed(result.totals), 100); assert.ok(result.speed.p50! > 95 && result.speed.p50! < 105);
  assert.equal(result.coverage.backfill.files, 2); assert.equal(result.sessions.length, 2);
  assert.equal(result.daily.at(-1)?.calls, 2);
});

test("references are source-qualified while report text, tool arguments and provider IDs are unchanged", () => {
  const raw = { jobs: [{ id: "job", agentId: "same", provider: "codex", text: "same", arguments: { agentId: "raw" } }], events: [{ id: "event", agentId: "same" }] };
  const result = qualifyFleetResult(raw, "win");
  assert.equal(result.jobs[0].id, hostEntityId("win", "job")); assert.equal(result.jobs[0].agentId, hostEntityId("win", "same"));
  assert.deepEqual(result.jobs[0].arguments, raw.jobs[0].arguments); assert.equal(result.jobs[0].text, "same"); assert.equal(result.jobs[0].provider, "codex");
});

test("one shared account is read once from its newest source, never added as two quotas", () => {
  const result = mergeFleetRead("observatory.quota.get", ["mac", "win"].map((hostId, i) => ({ hostId, label: hostId, data: { mode: "full", accounts: [{ key: "codex:account-hash", readingAt: String(i), windows: [{ usedPct: 30 + i }] }] } })), { hosts: [] });
  assert.equal(result.accounts.length, 1); assert.equal(result.accounts[0].windows[0].usedPct, 31);
});

test("primary registration remains stable when a second machine joins and hands over only on removal", () => {
  const registry = createHostRegistry(), release = registry.register(identity("mac"), async () => ({} as never));
  registry.register(identity("win"), async () => ({} as never)); assert.equal(primaryHostId(registry.getSnapshot()), "mac");
  release(); assert.equal(primaryHostId(registry.getSnapshot()), "win");
});

test("chunked reads preserve an immutable snapshot, reject writes and expire cleanly", async () => {
  let clock = 0, message = "中文".repeat(40000);
  const handlers = new Map<string, any>(), host = { handle(contract: any, handler: any) { handlers.set(contract.name, handler); } };
  const fleet = withFleetReads(host as any, () => clock);
  fleet.server.handle(defineRpc({ name: "observatory.stats.get", input: z.object({}), output: z.any() }), () => ({ message }));
  const first = await handlers.get(readFleetSnapshot.name)({ method: "observatory.stats.get", input: {} }, {});
  message = "changed"; const parts = [first.json];
  for (let i = 1; i < first.parts; i++) parts.push(handlers.get(readFleetPart.name)({ snapshotId: first.snapshotId, index: i }).json);
  assert.equal(JSON.parse(parts.join("")).message, "中文".repeat(40000));
  await assert.rejects(handlers.get(readFleetSnapshot.name)({ method: "observatory.read-state.mark", input: {} }, {}), /does not support/);
  clock = 120001; assert.throws(() => handlers.get(readFleetPart.name)({ snapshotId: first.snapshotId, index: 0 }), /expired/); fleet.close();
});

test("the plugin directory keeps native paging and reads only its own daemon connection", async () => {
  const handlers = new Map<string, any>(), requests: any[] = [];
  const fleet = withFleetReads({ handle(contract: any, handler: any) { handlers.set(contract.name, handler); } } as any);
  const context = { paseo: { agents: {
    list: async (input: any) => {
      requests.push(input);
      return { entries: [{ agent: { id: "same", title: "会话" } }], pageInfo: { nextCursor: "page-2", hasMore: true } };
    },
  } } };
  const part = await handlers.get(readFleetSnapshot.name)({ method: "observatory.agents.list", input: { filter: { includeArchived: true }, page: { limit: 100, cursor: "page-1" }, serverId: "another-host" }, maxPartBytes: 40000 }, context);
  assert.deepEqual(JSON.parse(part.json).pageInfo, { nextCursor: "page-2", hasMore: true });
  assert.deepEqual(requests, [{ filter: { includeArchived: true }, page: { limit: 100, cursor: "page-1" }, sort: [{ key: "updated_at", direction: "desc" }], timeout: 30000 }]);
  fleet.close();
});

test("a missing machine produces partial coverage and cannot silently borrow another host's data", async () => {
  const registry = createHostRegistry();
  registry.register(identity("mac"), async contract => ({ snapshotId: "one", index: 0, parts: 1, json: JSON.stringify({ mode: "full", revision: "r1", agents: [{ agentId: "same" }], available: true }) }) as any);
  let coverage: any;
  const result = await createFleetReader(registry).read("observatory.background.get", {}, [{ serverId: "mac", label: "Mac", status: "online" }, { serverId: "win", label: "Win", status: "offline" }], next => { coverage = next; });
  assert.equal(result.agents.length, 1); assert.equal(result.agents[0].agentId, hostEntityId("mac", "same"));
  assert.equal(result.available, false); assert.equal(coverage.hosts.find((host: any) => host.id === "win").state, "missing");
});

test("removing a proven copied call changes only the isolated view and all affected token buckets", () => {
  const call = { key: "0123456789abcdef", source: "codex" as const, sessionId: "same", cwd: "/project", at: now - 1000, start: now - 2000,
    model: "model", input: 10, cacheWrite: 2, cacheRead: 5, output: 100, reasoning: 0, subagent: false };
  const original = emptyData(); addCall(original, call, null, now);
  const projection = structuredClone(original); excludeCall(projection, call, now);
  assert.equal(original.hours.size, 1); assert.equal(projection.hours.size, 0); assert.equal(projection.sessionHours.size, 0);
  assert.equal(projection.projectHours.size, 0); assert.equal(projection.recent.size, 0);
  assert.ok(sameTokenCall(call, { ...call })); assert.ok(!sameTokenCall(call, { ...call, output: 101 }));
  assert.notEqual(copyFingerprint(call), copyFingerprint({ ...call, output: 101 }));
});

test("fleet Token totals remove only verified copies and retain the independent host ledger", async () => {
  const make = (output: number) => {
    const data = emptyData(); if (output) addCall(data, { key: "0123456789abcdef", source: "codex", sessionId: "same", cwd: "/project", at: now - 1000, start: now - 2000,
      model: "model", input: 10, cacheWrite: 2, cacheRead: 5, output, reasoning: 0, subagent: false }, null, now);
    const snapshot = buildTokenSnapshot(data, { complete: true, range: "7d", utcOffsetMinutes: 0 }, now, new StatsDirectory(),
      { earliestAt: stamp, latestAt: stamp, roots: [], backfill: { done: true, files: 1, filesDone: 1, bytes: 1, bytesDone: 1 } });
    snapshot.fleetDetails!.dedupeKeys = output ? ["0123456789abcdef"] : []; return { ...snapshot, mode: "full", revision: "1" };
  };
  const native = make(100), registry = createHostRegistry(), excluded: string[] = [];
  for (const id of ["mac", "win"]) registry.register(identity(id), (async (contract: any, input: any) => {
    if (contract.name === "observatory.tokens.exclude") { excluded.push(id); assert.ok(input.expected["0123456789abcdef"]); return { id: "projection", missing: [] }; }
    const result = input.method === "observatory.tokens.copies" ? { calls: [{ key: "0123456789abcdef", source: "codex", at: now - 1000, start: now - 2000, model: "model", input: 10, cacheWrite: 2, cacheRead: 5, output: 100, reasoning: 0 }], missing: [] }
      : input.input.exclusionId ? make(0) : native;
    return { snapshotId: "one", index: 0, parts: 1, json: JSON.stringify(result) };
  }) as any);
  const result = await createFleetReader(registry).read("observatory.tokens.get", { range: "7d", utcOffsetMinutes: 0 }, ["mac", "win"].map(serverId => ({ serverId, label: serverId, status: "online" })));
  assert.equal(result.totals.output, 100); assert.deepEqual(excluded, ["win"]); assert.equal(native.totals.output, 100);
});

test("copied live calls contribute once to fleet throughput, sparklines and per-agent rates", () => {
  const data = emptyData(); addCall(data, { key: "0123456789abcdef", source: "codex", sessionId: "same", cwd: "/project", at: now - 1000, start: now - 2000,
    model: "model", input: 10, cacheWrite: 2, cacheRead: 5, output: 100, reasoning: 0, subagent: false }, null, now);
  const directory = new StatsDirectory(); directory.agents = [agent("same")];
  const one = buildTokenLive(data, { complete: true, windowMinutes: 30, utcOffsetMinutes: 0, detail: "full" }, now, directory);
  const result = mergeFleetRead("observatory.tokens.live", ["mac", "win"].map(hostId => ({ hostId, label: hostId, data: one })), { hosts: [] });
  assert.equal(result.now.outputPerSec, one.now.outputPerSec); assert.equal(result.now.callsPerMin, 1);
  assert.equal(result.agents.length, 1); assert.deepEqual(result.output, one.output); assert.equal(result.agents[0].agentId, hostEntityId("mac", "same"));
});
