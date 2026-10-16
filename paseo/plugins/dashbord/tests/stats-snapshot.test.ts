import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { buildStatsSnapshot, type StatsSnapshotInput } from "../server/stats-snapshot";
import { statsHour, type StatsAgentRecord, type StatsAttribution, type StatsDirectoryAgent, type StatsHour } from "../server/stats-types";
import { emptyStatsMetrics, statsSnapshotSchema, TOOL_KINDS, type StatsMetrics } from "../shared/stats";

const DAY = 86_400_000, HOUR = 3_600_000, now = Date.parse("2026-09-23T12:30:00.000Z");
const input = (patch: Partial<StatsSnapshotInput> = {}): StatsSnapshotInput => ({
  now, range: "7d", utcOffsetMinutes: 0, hours: [], attributions: [], toolHours: [], records: [], running: new Map(), directory: [],
  observedSince: null, contentSince: null, directoryTruncated: false, ...patch,
});
const hour = (at: string, metrics: Partial<StatsMetrics> = {}): StatsHour => ({ ...emptyStatsMetrics(), hour: at, ...metrics });
/** One Agent-hour: `at` is a day (its UTC noon) or an ISO time (its UTC hour); the last activity defaults to the hour. */
const attribution = (agentId: string, at: string, metrics: Partial<StatsMetrics> = {}, lastActiveAt?: string): StatsAttribution => {
  const hour = statsHour(Date.parse(at.length === 10 ? `${at}T12:00:00.000Z` : at));
  return { ...emptyStatsMetrics(), agentId, hour, lastActiveAt: lastActiveAt ?? hour, ...metrics };
};
const agent = (id: string, patch: Partial<StatsDirectoryAgent> = {}): StatsDirectoryAgent => ({
  id, createdAt: "2026-09-23T01:00:00.000Z", provider: "codex", model: "gpt-5.5", parentAgentId: null,
  projectKey: "project", projectName: "项目", status: "idle", archivedAt: null, title: `会话 ${id}`,
  requiresAttention: false, attentionReason: null, pendingPermissions: 0, activeTurn: false, contextUsed: null, contextMax: null, sessionId: null, ...patch,
});
const record = (agentId: string, maxTurnMs: number, maxTurnAt: string | null): StatsAgentRecord => ({ agentId, maxTurnMs, maxTurnAt, updatedAt: now, lastKey: null });

test("empty statistics retain the full contract and a Monday-aligned contribution calendar", () => {
  const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input()));
  assert.equal(snapshot.from, "2026-09-17"); assert.equal(snapshot.to, "2026-09-23");
  assert.equal(snapshot.daily.length, 7); assert.deepEqual(snapshot.totals, emptyStatsMetrics());
  assert.deepEqual(snapshot.previous, emptyStatsMetrics()); assert.deepEqual(snapshot.allTime, emptyStatsMetrics());
  assert.equal(snapshot.calendar.start, "2025-09-22"); assert.equal(snapshot.calendar.sessions.length, 367);
  assert.equal(snapshot.calendar.turns.length, snapshot.calendar.sessions.length);
  assert.equal(snapshot.punchcard.sessions.length, 168); assert.equal(snapshot.punchcard.turns.length, 168);
  assert.deepEqual(snapshot.streak, { current: 0, longest: 0, longestEnd: null, activeDays: 0, activeDaysAllTime: 0 });
  assert.deepEqual(snapshot.records, { busiestDay: null, longestTurn: null, peakParallel: null, busiestSession: null });
  assert.deepEqual(snapshot.models, []); assert.deepEqual(snapshot.toolKinds, []);
});

test("each selected range has one daily row and compares the equally long preceding period", () => {
  for (const [range, count] of [["7d", 7], ["30d", 30], ["90d", 90]] as const) {
    const first = Math.floor(now / DAY) * DAY - (count - 1) * DAY;
    const selected = new Date(first).toISOString(), previous = new Date(first - DAY).toISOString(), older = new Date(first - (count + 1) * DAY).toISOString();
    const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input({ range,
      hours: [hour(selected, { turns: 2, runMs: 10, runSamples: 1, peakParallel: 2 }), hour(previous, { turns: 3, peakParallel: 3 }), hour(older, { turns: 5, peakParallel: 1 })],
      directory: [agent("selected", { createdAt: selected }), agent("previous", { createdAt: previous, archivedAt: previous }), agent("older", { createdAt: older })],
    })));
    assert.equal(snapshot.daily.length, count); assert.equal(snapshot.daily[0].day, selected.slice(0, 10));
    assert.equal(snapshot.daily.at(-1)?.day, "2026-09-23");
    assert.equal(snapshot.totals.turns, 2); assert.equal(snapshot.totals.sessions, 1); assert.equal(snapshot.totals.peakParallel, 2);
    assert.equal(snapshot.previous.turns, 3); assert.equal(snapshot.previous.sessions, 1); assert.equal(snapshot.previous.peakParallel, 3);
    assert.equal(snapshot.allTime.turns, 10); assert.equal(snapshot.allTime.sessions, 3); assert.equal(snapshot.allTime.peakParallel, 3);
  }
});

test("UTC+8 rebuckets UTC hours and exact session timestamps across local midnight", () => {
  const args = input({ now: Date.parse("2026-09-23T20:30:00.000Z"),
    hours: [hour("2026-09-23T15:00:00.000Z", { turns: 2 }), hour("2026-09-23T16:00:00.000Z", { turns: 3 })],
    directory: [agent("before", { createdAt: "2026-09-23T15:59:59.999Z" }), agent("after", { createdAt: "2026-09-23T16:00:00.000Z" })],
  });
  const utc = buildStatsSnapshot(args), east = statsSnapshotSchema.parse(buildStatsSnapshot({ ...args, utcOffsetMinutes: 480 }));
  assert.equal(utc.to, "2026-09-23"); assert.equal(utc.daily.at(-1)?.turns, 5); assert.equal(utc.daily.at(-1)?.sessions, 2);
  assert.equal(east.to, "2026-09-24"); assert.equal(east.daily.at(-2)?.turns, 2); assert.equal(east.daily.at(-1)?.turns, 3);
  assert.equal(east.daily.at(-2)?.sessions, 1); assert.equal(east.daily.at(-1)?.sessions, 1);
  assert.equal(east.punchcard.turns[2 * 24 + 23], 2); assert.equal(east.punchcard.turns[3 * 24], 3);
  assert.equal(east.punchcard.sessions[2 * 24 + 23], 1); assert.equal(east.punchcard.sessions[3 * 24], 1);
});

test("negative and fractional-hour offsets use local days and Monday-first weekday indexes", () => {
  const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input({ now: Date.parse("2026-09-21T03:00:00.000Z"), utcOffsetMinutes: -210,
    hours: [hour("2026-09-21T03:00:00.000Z", { turns: 4 })],
    directory: [agent("sunday", { createdAt: "2026-09-21T03:00:00.000Z" })],
  })));
  assert.equal(snapshot.to, "2026-09-20"); assert.equal(snapshot.calendar.sessions.length, 371);
  assert.equal(snapshot.punchcard.sessions[6 * 24 + 23], 1); assert.equal(snapshot.punchcard.turns[6 * 24 + 23], 4);
  for (const utcOffsetMinutes of [-840, 840]) statsSnapshotSchema.parse(buildStatsSnapshot(input({ utcOffsetMinutes })));
});

test("session counts come solely from deduplicated directory entries and include archived children", () => {
  const descriptor = agent("child", { parentAgentId: "parent", archivedAt: "2026-09-23T11:00:00.000Z" });
  const snapshot = buildStatsSnapshot(input({ directory: [descriptor, descriptor],
    hours: [hour("2026-09-23T01:00:00.000Z", { sessions: 100, childSessions: 100, turns: 2 })],
    attributions: [attribution("child", "2026-09-23", { sessions: 100, childSessions: 100, turns: 2 })],
  }));
  assert.equal(snapshot.totals.sessions, 1); assert.equal(snapshot.totals.childSessions, 1);
  assert.equal(snapshot.models[0].sessions, 1); assert.equal(snapshot.models[0].childSessions, 1); assert.equal(snapshot.models[0].turns, 2);
  assert.equal(snapshot.live.open, 0);
});

test("streaks count sessions or turns, retain old history, and allow an inactive today", () => {
  const snapshot = buildStatsSnapshot(input({ hours: [
    hour("2026-09-10T00:00:00.000Z", { turns: 1 }), hour("2026-09-11T00:00:00.000Z", { turns: 1 }), hour("2026-09-12T00:00:00.000Z", { turns: 1 }),
    hour("2026-09-21T00:00:00.000Z", { turns: 2 }), hour("2026-09-22T00:00:00.000Z", { turns: 5 }), hour("2026-09-23T00:00:00.000Z", { toolCalls: 100 }),
  ], directory: [agent("older", { createdAt: "2024-01-01T00:00:00.000Z" })] }));
  assert.deepEqual(snapshot.streak, { current: 2, longest: 3, longestEnd: "2026-09-12", activeDays: 2, activeDaysAllTime: 6 });
  assert.deepEqual(snapshot.records.busiestDay, { day: "2026-09-22", sessions: 0, turns: 5 });
  assert.equal(snapshot.allTime.sessions, 1); assert.equal(snapshot.calendar.sessions.reduce((sum, n) => sum + n, 0), 0);
  const activeToday = buildStatsSnapshot(input({ directory: [agent("today")], hours: [hour("2026-09-22T00:00:00.000Z", { turns: 1 })] }));
  assert.equal(activeToday.streak.current, 2); assert.equal(activeToday.streak.longestEnd, "2026-09-23");
});

test("records use all retained turns and hours but only selected-range session turns", () => {
  const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input({
    directory: [agent("known", { title: "已归档会话", archivedAt: "2026-09-23T10:00:00.000Z" })],
    hours: [hour("2026-08-01T12:00:00.000Z", { peakParallel: 8 }), hour("2026-09-23T02:00:00.000Z", { peakParallel: 8 })],
    records: [record("known", 500, "2026-08-01T13:00:00.000Z"), record("gone", 1000, "2026-08-01T12:00:00.000Z"), record("unused", 0, null)],
    attributions: [attribution("known", "2026-09-23", { turns: 4 }), attribution("gone", "2026-09-22", { turns: 3 }), attribution("gone", "2026-09-23", { turns: 2 }), attribution("old", "2026-09-16", { turns: 100 })],
  })));
  assert.deepEqual(snapshot.records.longestTurn, { agentId: "gone", title: "未命名 Agent", model: null, ms: 1000, at: "2026-08-01T12:00:00.000Z" });
  assert.deepEqual(snapshot.records.peakParallel, { count: 8, at: "2026-08-01T12:00:00.000Z" });
  assert.deepEqual(snapshot.records.busiestSession, { agentId: "gone", title: "未命名 Agent", turns: 5 });
  const known = buildStatsSnapshot(input({ directory: [agent("known", { title: "有名字", model: "gpt-5.5" })], records: [record("known", 0, "2026-09-23T01:00:00.000Z")] }));
  assert.equal(known.records.longestTurn?.title, "有名字"); assert.equal(known.records.longestTurn?.model, "gpt-5.5"); assert.equal(known.records.longestTurn?.ms, 0);
});

test("live 执行中 follows hooks and background subagents between directory walks", () => {
  const walkedAt = now - 30_000;
  const snapshot = buildStatsSnapshot(input({ walkedAt, directory: [
    agent("stale-running", { status: "running" }), agent("hook-running"),
    agent("background", { requiresAttention: true, attentionReason: "finished" }), agent("asking"),
    agent("unread", { requiresAttention: true, attentionReason: "finished" }),
  ], running: new Map([["hook-running", now - 10_000], ["new-agent", now - 5_000], ["gone", walkedAt - 60_000]]),
  ended: new Set(["stale-running"]), background: new Set(["background"]), awaiting: new Set(["asking", "background"]) }));
  // The ended turn is over although the walk shows it running; a background parent is 执行中, not 未读 or 待回复;
  // an Agent newer than the walk counts, a hook-only turn older than it does not.
  assert.deepEqual(snapshot.live, { open: 6, running: 3, approvals: 0, unread: 1, idle: 1 });
  assert.equal(snapshot.models.find(row => row.key === "gpt-5.5")?.running, 2);
  assert.equal(snapshot.models.find(row => row.key === "unknown")?.running, 1);
});

test("live counts follow non-archived directory state, including active turns, unread completion and 待回复", () => {
  const snapshot = buildStatsSnapshot(input({ directory: [
    agent("running", { status: "running", pendingPermissions: 3 }), agent("active", { activeTurn: true }),
    agent("unread", { requiresAttention: true, attentionReason: "finished" }),
    agent("question", { requiresAttention: true, attentionReason: "finished" }), agent("read-question"),
    agent("attention", { requiresAttention: true, attentionReason: "permission", pendingPermissions: 1 }),
    agent("archived", { status: "running", pendingPermissions: 1, archivedAt: "2026-09-23T01:00:00.000Z" }),
  ], running: new Map([["hook-only", now]]), awaiting: new Set(["question", "read-question"]) }));
  // A question counts once, as 待回复, whether or not it was opened; a stopped Agent without one is neither.
  assert.deepEqual(snapshot.live, { open: 6, running: 2, approvals: 2, unread: 1, idle: 2 });
  assert.equal(snapshot.models.find(row => row.key === "gpt-5.5")?.running, 2);
  assert.equal(snapshot.models.find(row => row.key === "unknown")?.running, 1);
});

test("subagent fanout uses children created in range and follows older or missing parents", () => {
  const snapshot = buildStatsSnapshot(input({ directory: [
    agent("root", { createdAt: "2026-08-01T00:00:00.000Z" }), agent("a", { parentAgentId: "root" }), agent("b", { parentAgentId: "root" }),
    agent("c", { parentAgentId: "a" }), agent("orphan", { parentAgentId: "missing" }), agent("older-child", { createdAt: "2026-08-01T00:00:00.000Z", parentAgentId: "root" }),
  ] }));
  assert.deepEqual(snapshot.subagents, { parents: 3, children: 4, maxFanout: 2, maxDepth: 2 });
  assert.equal(snapshot.totals.childSessions, 4); assert.equal(snapshot.allTime.childSessions, 5);
});

test("subagent ancestry terminates for cycles and is bounded at 32 ancestors", () => {
  const cyclic = buildStatsSnapshot(input({ directory: [agent("self", { parentAgentId: "self" }), agent("a", { parentAgentId: "b" }), agent("b", { parentAgentId: "a" })] }));
  assert.equal(cyclic.subagents.maxDepth, 1); assert.equal(cyclic.subagents.children, 3);
  const chain = Array.from({ length: 40 }, (_, index) => agent(String(index), { parentAgentId: index ? String(index - 1) : null }));
  assert.equal(buildStatsSnapshot(input({ directory: chain })).subagents.maxDepth, 32);
});

test("breakdowns join attribution, distinguish harness and vendor, and preserve unknown agents", () => {
  const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input({ directory: [
    agent("claude", { provider: "codex", model: "claude-sonnet-4", contextUsed: 10, contextMax: 100 }),
    agent("gpt", { provider: "codex", model: null, createdAt: "2026-08-01T00:00:00.000Z", status: "running", contextUsed: 20, contextMax: 200 }),
  ], attributions: [
    attribution("claude", "2026-09-22", { turns: 2, busyMs: 20, peakParallel: 2 }), attribution("claude", "2026-09-23", { turns: 3, busyMs: 40, peakParallel: 3 }),
    attribution("gpt", "2026-09-22", { turns: 4, busyMs: 30, peakParallel: 3 }), attribution("unknown-agent", "2026-09-23", { turns: 6, toolCalls: 2 }),
    attribution("unknown-old", "2026-09-16", { turns: 100 }),
  ] })));
  assert.equal(snapshot.models[0].key, "unknown"); assert.equal(snapshot.models[0].label, "未知");
  const claude = snapshot.models.find(row => row.key === "claude-sonnet-4")!;
  assert.equal(claude.vendor, "anthropic"); assert.equal(claude.turns, 5); assert.equal(claude.sessions, 1); assert.equal(claude.activeDays, 2);
  assert.equal(claude.lastActiveAt, "2026-09-23T12:00:00.000Z"); assert.equal(claude.busyMs, 60); assert.equal(claude.peakParallel, 3);
  const harness = snapshot.providers.find(row => row.key === "codex")!;
  assert.equal(harness.turns, 9); assert.equal(harness.sessions, 1); assert.equal(harness.vendor, "openai");
  assert.equal(harness.open, 2); assert.equal(harness.running, 1); assert.equal(harness.contextUsed, 30); assert.equal(harness.contextMax, 300);
  assert.equal(snapshot.models.find(row => row.key === "codex")?.sessions, 0);
  assert.equal(snapshot.vendors.find(row => row.key === "anthropic")?.turns, 5); assert.equal(snapshot.vendors.find(row => row.key === "unknown")?.turns, 6);
  assert.equal(snapshot.projects.find(row => row.key === "project")?.vendor, null); assert.equal(snapshot.projects.find(row => row.key === "unknown")?.toolCalls, 2);
  assert.equal(snapshot.models.find(row => row.key === "unknown")?.contextUsed, null);
});

test("breakdown activity days follow the local day of each Agent-hour (UTC+8)", () => {
  const snapshot = buildStatsSnapshot(input({ now: Date.parse("2026-09-23T20:00:00.000Z"), utcOffsetMinutes: 480,
    directory: [agent("one", { createdAt: "2026-09-23T17:00:00.000Z" })],
    // 02:00 on 09-24 and on 09-23 in UTC+8, although both are the 18:00 hour of the UTC day before.
    attributions: [attribution("one", "2026-09-23T18:00:00.000Z", { turns: 3 }), attribution("one", "2026-09-22T18:00:00.000Z", { turns: 2 })],
  }));
  assert.equal(snapshot.to, "2026-09-24"); assert.equal(snapshot.models[0].activeDays, 2); assert.equal(snapshot.models[0].turns, 5);
  assert.equal(snapshot.models[0].lastActiveAt, "2026-09-23T18:00:00.000Z");
});

test("breakdown overflow reserves its final row, sums metrics, and unions active days", () => {
  const directory = Array.from({ length: 30 }, (_, index) => agent(`agent-${index}`, { provider: `harness-${index}`, model: `model-${String(index).padStart(2, "0")}`,
    projectKey: `project-${index}`, projectName: `项目 ${index}`, contextUsed: index, contextMax: 100 }));
  const attributions = directory.map((entry, index) => attribution(entry.id, "2026-09-23", { turns: 30 - index, peakParallel: index % 5 }));
  const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input({ directory, attributions })));
  for (const dimension of ["models", "providers", "projects"] as const) {
    const rows = snapshot[dimension], overflow = rows.at(-1)!;
    assert.equal(rows.length, 24); assert.equal(overflow.key, "__other__"); assert.equal(overflow.label, "其他");
    assert.equal(rows.reduce((sum, row) => sum + row.turns, 0), 465); assert.equal(rows.reduce((sum, row) => sum + row.sessions, 0), 30);
    assert.equal(overflow.sessions, 7); assert.equal(overflow.turns, 28); assert.equal(overflow.activeDays, 1); assert.equal(overflow.open, 7);
    assert.equal(overflow.contextUsed, 182); assert.equal(overflow.contextMax, 700); assert.equal(overflow.peakParallel, 4);
  }
  assert.equal(snapshot.projects.at(-1)?.vendor, null);
});

test("tool names aggregate across days, top 24 retains all kind totals, and ties are deterministic", () => {
  const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input({ toolHours: [
    { hour: "2026-09-23T03:00:00.000Z", tools: Array.from({ length: 60 }, (_, index) => ({ name: `tool-${String(index).padStart(2, "0")}`, kind: TOOL_KINDS[index % TOOL_KINDS.length], calls: index + 1, failures: index % 2 })) },
    { hour: "2026-09-22T12:00:00.000Z", tools: [{ name: " tool-00 ", kind: "web", calls: 100, failures: 2 }] },
    { hour: "2026-09-16T23:00:00.000Z", tools: [{ name: "old", kind: "shell", calls: 1000, failures: 0 }] },
  ] })));
  assert.equal(snapshot.tools.length, 24); assert.equal(snapshot.tools[0].name, "tool-00"); assert.equal(snapshot.tools[0].calls, 101); assert.equal(snapshot.tools[0].kind, "web");
  assert.equal(snapshot.toolKinds.length, 8); assert.equal(snapshot.toolKinds.reduce((sum, tool) => sum + tool.calls, 0), 1930);
  assert.equal(snapshot.toolKinds.reduce((sum, tool) => sum + tool.failures, 0), 32); assert.ok(!snapshot.tools.some(tool => tool.name === "old"));
  const ties = buildStatsSnapshot(input({ toolHours: [{ hour: "2026-09-23T00:00:00.000Z", tools: [{ name: "b", kind: "read", calls: 1, failures: 0 }, { name: "a", kind: "shell", calls: 1, failures: 0 }] }] }));
  assert.deepEqual(ties.tools.map(tool => tool.name), ["a", "b"]);
});

test("snapshot projection does not mutate source buckets, descriptors, records, or running map", () => {
  const args = input({ directory: [agent("one")], hours: [hour("2026-09-23T00:00:00.000Z", { turns: 2, busyMs: 100 })],
    attributions: [attribution("one", "2026-09-23", { turns: 2, busyMs: 100 })], records: [record("one", 20, "2026-09-23T01:00:00.000Z")], running: new Map([["one", now - 100]]),
    observedSince: "2026-01-01T00:00:00.000Z", contentSince: "2026-09-01T00:00:00.000Z", directoryTruncated: true,
  });
  const before = JSON.stringify(args), runningBefore = [...args.running];
  for (const collection of [args.directory, args.hours, args.attributions, args.records]) for (const item of collection) Object.freeze(item);
  const first = buildStatsSnapshot(args), second = buildStatsSnapshot(args);
  assert.deepEqual(first, second); assert.equal(JSON.stringify(args), before); assert.deepEqual([...args.running], runningBefore);
  assert.equal(first.observedSince, args.observedSince); assert.equal(first.contentSince, args.contentSince); assert.equal(first.directoryTruncated, true);
  first.daily[6].turns = 1000; first.models[0].turns = 1000;
  assert.equal(args.hours[0].turns, 2); assert.equal(args.attributions[0].turns, 2);
});

test("exact tool-kind counters survive name-map overflow without being counted twice", () => {
  const snapshot = buildStatsSnapshot(input({ toolHours: [{ hour: "2026-09-23T12:00:00.000Z",
    tools: [{ name: "retained", kind: "shell", calls: 3, failures: 1 }],
    kinds: [{ name: "shell", kind: "shell", calls: 100, failures: 7 }, { name: "web", kind: "web", calls: 20, failures: 2 }],
  }] }));
  assert.equal(snapshot.tools[0].calls, 3);
  assert.deepEqual(snapshot.toolKinds, [{ name: "shell", kind: "shell", calls: 100, failures: 7 }, { name: "web", kind: "web", calls: 20, failures: 2 }]);
});

function realisticFixture(): StatsSnapshotInput {
  const fixtureNow = Date.parse("2026-09-23T23:59:59.000Z"), first = Math.floor(fixtureNow / DAY) * DAY - 89 * DAY;
  const modelFamilies = ["claude-sonnet", "gpt-5", "gemini-pro", "grok", "kimi", "deepseek", "doubao", "qwen", "glm", "custom-model"];
  const directory = Array.from({ length: 2000 }, (_, index) => {
    const model = (index * 17 + Math.floor(index / 90)) % 40;
    return agent(`agent-${index}`, {
      createdAt: new Date(first + index % 90 * DAY + index % 24 * HOUR).toISOString(),
      provider: `harness-${String(index % 31).padStart(2, "0")}`, model: `${modelFamilies[Math.floor(model / 4)]}-${model % 4}`,
      projectKey: `project-${index % 61}`, projectName: `工作项目 ${index % 61}`, parentAgentId: index % 5 === 0 ? `agent-${Math.max(0, index - 1)}` : null,
      archivedAt: index % 3 === 0 ? "2026-09-23T23:00:00.000Z" : null, status: index % 13 === 0 ? "running" : "idle", contextUsed: 125_000 + index, contextMax: 1_000_000,
    });
  });
  const attributions = directory.map((entry, index) => attribution(entry.id, entry.createdAt, {
    turns: 25 + index % 76, completed: 22 + index % 76, failed: 2, canceled: 1, runMs: 23_456 * (25 + index % 76), runSamples: 25 + index % 76,
    busyMs: 25_000, peakParallel: 1 + index % 12, approvals: 10 + index % 20, waitMs: 54_321, userMessages: 25 + index % 76, assistantMessages: 100 + index % 300,
    toolCalls: 1200, toolFailures: 12, edits: 100, linesAdded: 10_000, linesRemoved: 6000, filesChanged: 50, shellCalls: 300, webCalls: 100, subagentCalls: 10,
    errors: index % 5, compactions: index % 3,
  }));
  // Retained observations can outlive a directory entry; this exercises the reachable eleventh vendor group.
  attributions.push(attribution("deleted-agent", "2026-09-23", { turns: 100, completed: 100, runMs: 2_345_600, runSamples: 100, toolCalls: 1200 }, "2026-09-23T14:00:00.000Z"));
  const hoursByDay = new Map<string, StatsHour>();
  for (const item of attributions) {
    const key = `${item.hour.slice(0, 10)}T12:00:00.000Z`, bucket = hoursByDay.get(key) ?? hour(key);
    for (const metric of Object.keys(emptyStatsMetrics()) as (keyof StatsMetrics)[]) bucket[metric] = metric === "peakParallel" ? Math.max(bucket[metric], item[metric]) : bucket[metric] + item[metric];
    hoursByDay.set(key, bucket);
  }
  return input({ now: fixtureNow, range: "90d", directory, attributions, hours: [...hoursByDay.values()],
    records: directory.map((entry, index) => record(entry.id, 23_456 * (25 + index % 76), entry.createdAt)),
    toolHours: Array.from({ length: 90 }, (_, day) => ({ hour: new Date(first + day * DAY + 12 * HOUR).toISOString(), tools: Array.from({ length: 60 }, (_, index) => ({
      name: `mcp__integration__operation_${String(index).padStart(2, "0")}`, kind: TOOL_KINDS[index % TOOL_KINDS.length], calls: 100 + index % 50, failures: index % 17 === 0 ? 3 : 0,
    })) })), observedSince: new Date(first).toISOString(), contentSince: new Date(first).toISOString(),
  });
}

test("worst-case 2000-agent / 60-tool fixture fills reachable breakdown caps and meets raw payload budgets", context => {
  const fixture = realisticFixture();
  assert.equal(fixture.directory.length, 2000); assert.equal(fixture.toolHours.length, 90);
  for (const hour of fixture.toolHours) assert.equal(new Set(hour.tools.map(tool => tool.name)).size, 60);
  const vendors = ["anthropic", "openai", "google", "xai", "moonshot", "deepseek", "bytedance", "alibaba", "zhipu", "other", "unknown"];
  for (const [range, length] of [["7d", 7], ["30d", 30], ["90d", 90]] as const) {
    const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot({ ...fixture, range })), json = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(json), gzipBytes = gzipSync(json).byteLength;
    context.diagnostic(`Fixed-contract ${range} / 2000-agent / 60-tool fixture: ${bytes} raw JSON bytes; ${gzipBytes} gzip bytes.`);
    assert.equal(snapshot.daily.length, length); assert.equal(snapshot.allTime.sessions, 2000);
    if (range === "90d") assert.equal(snapshot.totals.sessions, 2000);
    assert.equal(snapshot.models.length, 24); assert.equal(snapshot.providers.length, 24); assert.equal(snapshot.projects.length, 24);
    for (const dimension of ["models", "providers", "projects"] as const) {
      assert.equal(snapshot[dimension].at(-1)?.key, "__other__");
      assert.ok(snapshot[dimension].every(row => row.turns > 0));
    }
    // vendorOf has ten possible outputs; deleted-directory attribution adds "unknown", so a twelfth row is unreachable.
    assert.equal(snapshot.vendors.length, 11); assert.deepEqual(new Set(snapshot.vendors.map(row => row.key)), new Set(vendors));
    assert.ok(snapshot.vendors.every(row => row.turns > 0));
    assert.equal(snapshot.tools.length, 24); assert.equal(snapshot.toolKinds.length, 8); assert.ok(snapshot.calendar.sessions.length <= 371);
    assert.ok(!json.includes("createdAt")); assert.ok(!json.includes("parentAgentId")); assert.ok(!json.includes("lastKey"));
    if (range === "90d") assert.ok(bytes < 100_000, `90d raw JSON payload ${bytes} must be < 100,000 bytes`);
    if (range === "30d") assert.ok(bytes < 80_000, `30d raw JSON payload ${bytes} must be < 80,000 bytes`);
  }
});
