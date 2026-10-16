import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import type { PaseoApi, PaseoAgentListResult } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { buildStatsSnapshot, type StatsSnapshotInput } from "../server/stats-snapshot";
import { StatsStore } from "../server/stats-store";
import { statsHour, statsLocalDay, statsZone, type StatsAttribution, type StatsDirectoryAgent, type StatsHour, type StatsToolHour } from "../server/stats-types";
import { emptyStatsMetrics, getStats, statsMetricsSchema, statsResponseSchema, statsSnapshotSchema, statsTimeZoneSchema, statsToolSchema,
  type StatsMetrics, type StatsResponse, type StatsSnapshot, type StatsTool } from "../shared/stats";

// Days and hours must follow the device's zone, whatever zone this process runs in (the suite also runs under TZ=…).
// US/Pacific is a permanent link to the US Pacific rules (PDT −7, PST −8); Asia/Singapore is +8 without daylight saving.
const HOUR = 3_600_000, DAY = 24 * HOUR, PACIFIC = "US/Pacific", PLUS8 = "Asia/Singapore";
const iso = (at: number) => new Date(at).toISOString();
const input = (patch: Partial<StatsSnapshotInput> = {}): StatsSnapshotInput => ({
  now: Date.parse("2026-10-11T04:00:00.000Z"), range: "7d", utcOffsetMinutes: 0, hours: [], attributions: [], toolHours: [], records: [],
  running: new Map(), directory: [], observedSince: null, contentSince: null, directoryTruncated: false, ...patch,
});
const hour = (at: string, metrics: Partial<StatsMetrics> = {}): StatsHour => ({ ...emptyStatsMetrics(), hour: at, ...metrics });
const attribution = (agentId: string, at: string, metrics: Partial<StatsMetrics> = {}): StatsAttribution =>
  ({ ...emptyStatsMetrics(), agentId, hour: statsHour(Date.parse(at)), lastActiveAt: at, ...metrics });
const tool = (name: string, kind: StatsTool["kind"], calls: number): StatsTool => ({ name, kind, calls, failures: 0 });
const toolHour = (at: string, ...tools: StatsTool[]): StatsToolHour => ({ hour: at, tools, kinds: tools.map(item => ({ ...item, name: item.kind })) });
const agent = (id: string, patch: Partial<StatsDirectoryAgent> = {}): StatsDirectoryAgent => ({
  id, createdAt: "2026-01-05T00:00:00.000Z", provider: "acme", model: `model-${id}`, parentAgentId: null, projectKey: "demo", projectName: "演示项目",
  status: "idle", archivedAt: null, title: `会话 ${id}`, requiresAttention: false, attentionReason: null, pendingPermissions: 0, activeTurn: false,
  contextUsed: null, contextMax: null, sessionId: null, ...patch,
});
const row = (snapshot: StatsSnapshot, key: string) => snapshot.models.find(item => item.key === key);
/** Monday-first weekday × hour index of the punchcard. */
const cell = (day: string, localHour: number) => ((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7) * 24 + localHour;

test("review reproduction: a US Pacific evening is today in 明细, 横评 and 最忙会话, not only on the 看板", () => {
  // 21:00 PDT on 10-10 (04:00 UTC on 10-11); five turns at 18:00 PDT, already 01:00 UTC on 10-11.
  const work = "2026-10-11T01:00:00.000Z";
  for (const timeZone of [PACIFIC, undefined]) {
    const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input({ utcOffsetMinutes: -420, timeZone,
      hours: [hour(work, { turns: 5 })], attributions: [attribution("a", work, { turns: 5 })], toolHours: [toolHour(work, tool("Bash", "shell", 3))],
      directory: [agent("a", { createdAt: "2026-10-10T15:00:00.000Z" })] })));
    assert.equal(snapshot.to, "2026-10-10"); assert.equal(snapshot.timeZone, timeZone ?? null);
    assert.equal(snapshot.totals.turns, 5); assert.equal(snapshot.daily.at(-1)?.turns, 5);
    assert.equal(row(snapshot, "model-a")?.turns, 5, "明细 / 横评"); assert.equal(row(snapshot, "model-a")?.activeDays, 1);
    assert.deepEqual(snapshot.records.busiestSession, { agentId: "a", title: "会话 a", turns: 5 });
    assert.deepEqual(snapshot.tools, [tool("Bash", "shell", 3)]);
  }
});

test("the first and last local day of a 7-day window hold exactly their own hours at -420, -480 and +480", () => {
  const cases = [
    { zone: PACIFIC, offset: -420, now: "2026-10-11T04:00:00.000Z", from: "2026-10-04", to: "2026-10-10",
      before: "2026-10-04T06:00:00.000Z", first: "2026-10-04T07:00:00.000Z", last: "2026-10-11T03:00:00.000Z" },
    { zone: PACIFIC, offset: -480, now: "2026-12-01T07:30:00.000Z", from: "2026-11-24", to: "2026-11-30",
      before: "2026-11-24T07:00:00.000Z", first: "2026-11-24T08:00:00.000Z", last: "2026-12-01T07:00:00.000Z" },
    { zone: PLUS8, offset: 480, now: "2026-09-23T20:00:00.000Z", from: "2026-09-18", to: "2026-09-24",
      before: "2026-09-17T15:00:00.000Z", first: "2026-09-17T16:00:00.000Z", last: "2026-09-23T19:00:00.000Z" },
  ];
  for (const { zone, offset, now, from, to, before, first, last } of cases) for (const timeZone of [zone, undefined]) {
    const label = `${zone} ${offset} ${timeZone ? "zone" : "offset"}`;
    const snapshot = statsSnapshotSchema.parse(buildStatsSnapshot(input({ now: Date.parse(now), utcOffsetMinutes: offset, timeZone,
      hours: [hour(before, { turns: 20 }), hour(first, { turns: 3 }), hour(last, { turns: 4 })],
      attributions: [attribution("before", before, { turns: 20 }), attribution("first", first, { turns: 3 }), attribution("last", last, { turns: 4 })],
      toolHours: [toolHour(before, tool("Bash", "shell", 7)), toolHour(first, tool("Read", "read", 5)), toolHour(last, tool("Edit", "edit", 1))],
      directory: [agent("before"), agent("first"), agent("last")] })));
    assert.equal(snapshot.from, from, label); assert.equal(snapshot.to, to, label);
    assert.equal(snapshot.daily[0].turns, 3, label); assert.equal(snapshot.daily[6].turns, 4, label);
    assert.equal(snapshot.totals.turns, 7, label); assert.equal(snapshot.previous.turns, 20, label);
    assert.equal(row(snapshot, "model-first")?.turns, 3, label); assert.equal(row(snapshot, "model-last")?.turns, 4, label);
    assert.equal(row(snapshot, "model-before")?.turns, 0, label);
    assert.equal(snapshot.records.busiestSession?.agentId, "last", label);
    assert.deepEqual(snapshot.tools.map(item => [item.name, item.calls]), [["Read", 5], ["Edit", 1]], label);
    assert.deepEqual(snapshot.toolKinds.map(item => [item.kind, item.calls]), [["read", 5], ["edit", 1]], label);
  }
});

test("falling back on 2026-11-01 in US Pacific time: each hour keeps its own offset and the repeated 01:00 counts twice", () => {
  const hours = [["2026-11-01T06:00:00.000Z", 1], ["2026-11-01T07:00:00.000Z", 2], ["2026-11-01T08:00:00.000Z", 4],
    ["2026-11-01T09:00:00.000Z", 8], ["2026-11-02T07:00:00.000Z", 16], ["2026-11-02T08:00:00.000Z", 32]] as const;
  // Saturday 11-07 12:00 PST: the 7-day window starts on Sunday 11-01, the day the clocks go back.
  const args = input({ now: Date.parse("2026-11-07T20:00:00.000Z"), utcOffsetMinutes: -480,
    hours: hours.map(([at, turns]) => hour(at, { turns })), attributions: hours.map(([at, turns]) => attribution("dst", at, { turns })),
    toolHours: [toolHour("2026-11-01T07:00:00.000Z", tool("Read", "read", 3))], directory: [agent("dst")] });
  const zoned = statsSnapshotSchema.parse(buildStatsSnapshot({ ...args, timeZone: PACIFIC }));
  assert.equal(zoned.from, "2026-11-01"); assert.equal(zoned.timeZone, PACIFIC);
  // 00:00 PDT, 01:00 PDT, 01:00 PST and 23:00 PST are all Sunday 11-01; 23:00 PDT the day before is not in the window.
  assert.deepEqual(zoned.daily.slice(0, 2).map(day => [day.day, day.turns]), [["2026-11-01", 30], ["2026-11-02", 32]]);
  assert.equal(zoned.previous.turns, 1); assert.equal(row(zoned, "model-dst")?.turns, 62); assert.equal(row(zoned, "model-dst")?.activeDays, 2);
  assert.equal(zoned.punchcard.turns[cell("2026-11-01", 0)], 2); assert.equal(zoned.punchcard.turns[cell("2026-11-01", 1)], 12);
  assert.equal(zoned.punchcard.turns[cell("2026-11-01", 23)], 16); assert.equal(zoned.punchcard.turns[cell("2026-11-02", 0)], 32);
  assert.deepEqual(zoned.tools.map(item => item.calls), [3]);
  // The device's current offset alone (PST) would move Sunday's first hour to Saturday night.
  const fixed = buildStatsSnapshot(args);
  assert.equal(fixed.timeZone, null); assert.equal(fixed.daily[0].turns, 28); assert.equal(fixed.previous.turns, 3);
  assert.equal(row(fixed, "model-dst")?.turns, 60); assert.deepEqual(fixed.tools, []);
});

test("springing forward on 2027-03-14 in US Pacific time: the window starts at local midnight and 02:00 never happens", () => {
  const hours = [["2027-03-14T07:00:00.000Z", 1], ["2027-03-14T08:00:00.000Z", 2], ["2027-03-14T09:00:00.000Z", 4], ["2027-03-14T10:00:00.000Z", 8]] as const;
  const args = input({ now: Date.parse("2027-03-20T20:00:00.000Z"), utcOffsetMinutes: -420,
    hours: hours.map(([at, turns]) => hour(at, { turns })), attributions: hours.map(([at, turns]) => attribution("dst", at, { turns })), directory: [agent("dst")] });
  const zoned = buildStatsSnapshot({ ...args, timeZone: PACIFIC }), fixed = buildStatsSnapshot(args);
  assert.equal(zoned.from, "2027-03-14"); assert.equal(zoned.daily[0].turns, 14); assert.equal(zoned.previous.turns, 1); assert.equal(row(zoned, "model-dst")?.turns, 14);
  assert.deepEqual([0, 1, 2, 3].map(local => zoned.punchcard.turns[cell("2027-03-14", local)]), [2, 4, 0, 8]);
  // PDT applied to the PST hours would count 23:00 on Saturday as Sunday and invent a 02:00.
  assert.equal(fixed.daily[0].turns, 15); assert.equal(fixed.previous.turns, 0); assert.equal(row(fixed, "model-dst")?.turns, 15);
  assert.deepEqual([0, 1, 2, 3].map(local => fixed.punchcard.turns[cell("2027-03-14", local)]), [1, 2, 4, 8]);
});

test("zone names are validated, and an unknown or disagreeing zone falls back to the device offset", () => {
  for (const name of [PACIFIC, "Etc/GMT+8", "America/Argentina/Rio_Gallegos", "America/Port-au-Prince", "UTC"]) assert.ok(statsTimeZoneSchema.safeParse(name).success, name);
  for (const name of ["", "America/New York", "../etc/passwd", "/America", "America/", "America//Denver", "+08:00", `A${"b".repeat(64)}`, 42]) {
    assert.equal(statsTimeZoneSchema.safeParse(name).success, false, String(name));
  }
  assert.deepEqual(getStats.input.parse({ range: "7d", utcOffsetMinutes: -420 }), { range: "7d", utcOffsetMinutes: -420 });
  assert.equal(getStats.input.parse({ range: "7d", utcOffsetMinutes: -420, timeZone: PACIFIC }).timeZone, PACIFIC);
  assert.throws(() => getStats.input.parse({ range: "7d", utcOffsetMinutes: -420, timeZone: "America/New York" }));
  const args = input({ utcOffsetMinutes: -420, hours: [hour("2026-10-11T01:00:00.000Z", { turns: 5 })],
    attributions: [attribution("a", "2026-10-11T01:00:00.000Z", { turns: 5 })], directory: [agent("a")] });
  const plain = buildStatsSnapshot(args);
  // Unknown to this server's time zone data; a +08:00 zone while the device reports -07:00 (data out of date somewhere).
  for (const timeZone of ["Mars/Olympus_Mons", PLUS8, "../../etc", null]) assert.deepEqual(buildStatsSnapshot({ ...args, timeZone }), plain, String(timeZone));
  // Phoenix keeps -07:00 all year, so it agrees in October and its days are used.
  assert.equal(buildStatsSnapshot({ ...args, timeZone: "America/Phoenix" }).timeZone, "America/Phoenix");
  // The zone helper itself: exact offsets on both sides of a transition, the fixed offset otherwise.
  const zone = statsZone(-480, PACIFIC, Date.parse("2026-11-07T20:00:00.000Z"));
  assert.equal(zone.offsetAt(Date.parse("2026-11-01T08:59:59.000Z")), -7 * HOUR); assert.equal(zone.offsetAt(Date.parse("2026-11-01T09:00:00.000Z")), -8 * HOUR);
  assert.equal(statsLocalDay(Date.parse("2026-11-01T07:00:00.000Z"), zone), Date.parse("2026-11-01T00:00:00.000Z") / DAY);
  assert.equal(statsZone(-420, "Nowhere/Invalid").name, null); assert.equal(statsZone(330, null).offsetAt(0), 330 * 60_000);
});

// Store-level: hooks, the revisioned RPC and stats.json across the change.
type Entry = PaseoAgentListResult["entries"][number];
type Full = Extract<StatsResponse, { mode: "full" }>;
function entry(id: string, createdAt: string): Entry {
  return { agent: { id, createdAt, provider: "acme", model: `model-${id}`, cwd: "/repos/demo", title: id, labels: {}, status: "idle", archivedAt: null,
    requiresAttention: false, attentionReason: null, pendingPermissions: [], activeTurn: null, lastUsage: null }, project: null } as unknown as Entry;
}
const api = (entries: Entry[] = []): PaseoApi => ({ agents: { list: async () => ({ entries, pageInfo: { hasMore: false, nextCursor: null } }) } }) as unknown as PaseoApi;
function full(result: StatsResponse): Full {
  statsResponseSchema.parse(result); assert.equal(result.mode, "full");
  return result as Full;
}
function work(turn: number): AgentTimelineItem[] {
  return [{ type: "user_message", messageId: `u-${turn}`, text: "private prompt" },
    { type: "tool_call", callId: `t-${turn}`, name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "true", exitCode: 0 } }];
}
async function withStore(start: number, run: (store: StatsStore, clock: { now: number }, directory: string) => Promise<void>, prepare?: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-zone-")), clock = { now: start };
  await prepare?.(directory);
  const store = new StatsStore({ directory, now: () => clock.now });
  try { await store.ready; await run(store, clock, directory); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("hooks at 18:00 PDT show up in 明细 and 最忙会话 when read at 21:00 PDT", async () => {
  await withStore(Date.parse("2026-10-11T01:00:00.000Z"), async (store, clock) => {
    for (let turn = 0; turn < 5; turn++) {
      store.record({ type: "turn_started", agentId: "a" }); clock.now += 60_000;
      store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: work(turn) }); clock.now += 60_000;
    }
    clock.now = Date.parse("2026-10-11T04:00:00.000Z");
    const paseo = api([entry("a", "2026-10-10T15:00:00.000Z")]);
    for (const timeZone of [PACIFIC, undefined]) {
      const snapshot = full(await store.read({ range: "7d", utcOffsetMinutes: -420, ...(timeZone ? { timeZone } : {}) }, paseo));
      assert.equal(snapshot.to, "2026-10-10"); assert.equal(snapshot.timeZone, timeZone ?? null);
      assert.equal(snapshot.totals.turns, 5); assert.equal(snapshot.daily.at(-1)?.turns, 5); assert.equal(row(snapshot, "model-a")?.turns, 5);
      assert.equal(row(snapshot, "model-a")?.completed, 5); assert.equal(row(snapshot, "model-a")?.toolCalls, 5);
      assert.deepEqual(snapshot.records.busiestSession, { agentId: "a", title: "a", turns: 5 });
      assert.deepEqual(snapshot.tools, [{ name: "Bash", kind: "shell", calls: 5, failures: 0 }]);
    }
  });
});

test("the zone is part of the revision and the memo: another zone or its local midnight never reuses a reply", async () => {
  // 23:59:58 PDT on 10-10.
  await withStore(Date.parse("2026-10-11T06:59:58.000Z"), async (store, clock) => {
    store.record({ type: "turn_ended", agentId: "a", outcome: "completed", timeline: [] });
    const paseo = api([entry("a", "2026-10-10T15:00:00.000Z")]), pacific = { range: "7d", utcOffsetMinutes: -420, timeZone: PACIFIC } as const;
    const first = full(await store.read(pacific, paseo));
    assert.equal(first.to, "2026-10-10"); assert.equal((await store.read({ ...pacific, revision: first.revision }, paseo)).mode, "unchanged");
    // Same offset in October, another zone: a full reply in that zone, then the Pacific projection is reused as is.
    const phoenix = full(await store.read({ ...pacific, timeZone: "America/Phoenix", revision: first.revision }, paseo));
    assert.notEqual(phoenix.revision, first.revision); assert.equal(phoenix.timeZone, "America/Phoenix");
    const again = full(await store.read(pacific, paseo));
    assert.equal(again.revision, first.revision); assert.strictEqual(again.daily, first.daily); assert.equal(again.timeZone, PACIFIC);
    // Without the zone the reply is the offset's own, even with identical numbers.
    assert.notEqual(full(await store.read({ range: "7d", utcOffsetMinutes: -420, revision: first.revision }, paseo)).timeZone, PACIFIC);
    const plus8 = full(await store.read({ range: "7d", utcOffsetMinutes: 480, timeZone: PLUS8, revision: first.revision }, paseo));
    assert.equal(plus8.to, "2026-10-11"); assert.equal(plus8.daily.at(-1)?.completed, 1);
    // Local midnight in the zone changes the revision even though nothing else happened.
    clock.now += 3_000;
    const rollover = full(await store.read({ ...pacific, revision: first.revision }, paseo));
    assert.equal(rollover.to, "2026-10-11"); assert.equal(rollover.daily.at(-2)?.completed, 1); assert.equal(rollover.daily.at(-1)?.completed, 0);
  });
});

// The stats.json contract of 2.12.0, to prove an older version still loads what this one writes.
const legacy = z.object({ version: z.literal(1), change: z.number().int().nonnegative(), backfilled: z.boolean(), observedSince: z.iso.datetime().nullable(), contentSince: z.iso.datetime(),
  hours: z.array(statsMetricsSchema.extend({ hour: z.iso.datetime() })).max(92 * 24),
  attributions: z.array(statsMetricsSchema.extend({ agentId: z.string().min(1).max(256), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), lastActiveAt: z.iso.datetime() })).max(20_000),
  toolDays: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tools: z.array(statsToolSchema).max(60), kinds: z.array(statsToolSchema).max(8).optional() })).max(92),
  records: z.array(z.object({ agentId: z.string(), lastKey: z.string().nullable(), maxTurnMs: z.number(), maxTurnAt: z.iso.datetime().nullable(), updatedAt: z.number() })).max(2_000),
  running: z.array(z.tuple([z.string(), z.number()])), permissions: z.array(z.object({ agentId: z.string(), requests: z.array(z.tuple([z.string(), z.number()])) })) });

test("a 2.12.0 stats.json migrates its per-UTC-day lists to hours, and an older version still reads the result", async () => {
  const metrics = (patch: Partial<StatsMetrics>) => ({ ...emptyStatsMetrics(), ...patch });
  const old = { version: 1, change: 41, backfilled: true, observedSince: "2026-06-01T00:00:00.000Z", contentSince: "2026-06-01T00:00:00.000Z",
    // UTC day 10-10: six tool calls at 02:00 (19:00 PDT on 10-09) and four at 20:00 (13:00 PDT on 10-10).
    hours: [{ hour: "2026-10-10T02:00:00.000Z", ...metrics({ turns: 1, toolCalls: 6 }) }, { hour: "2026-10-10T20:00:00.000Z", ...metrics({ turns: 1, toolCalls: 4 }) }],
    attributions: [
      { agentId: "a", day: "2026-10-10", lastActiveAt: "2026-10-10T20:30:00.000Z", ...metrics({ turns: 1, completed: 1 }) },
      { agentId: "b", day: "2026-10-10", lastActiveAt: "2026-10-10T02:15:00.000Z", ...metrics({ turns: 1, completed: 1 }) },
      // A latest activity outside its own day cannot be trusted: UTC noon.
      { agentId: "c", day: "2026-10-08", lastActiveAt: "2026-10-01T00:00:00.000Z", ...metrics({ turns: 2 }) },
      // Older than the 92-day window.
      { agentId: "gone", day: "2026-06-01", lastActiveAt: "2026-06-01T10:00:00.000Z", ...metrics({ turns: 9 }) },
    ],
    toolDays: [
      { day: "2026-10-10", tools: [tool("Bash", "shell", 6), tool("Read", "read", 4)], kinds: [tool("shell", "shell", 6), tool("read", "read", 4)] },
      { day: "2026-10-09", tools: [tool("Grep", "search", 2)] },
    ],
    records: [], running: [], permissions: [] };
  assert.ok(legacy.safeParse(old).success);
  await withStore(Date.parse("2026-10-11T04:00:00.000Z"), async (store, _clock, directory) => {
    const read = async () => JSON.parse(await readFile(join(directory, "stats.json"), "utf8")) as Record<string, unknown> & { agentHours: Array<Record<string, unknown>>; toolHours: StatsToolHour[] };
    await store.flush(); const migrated = await read();
    assert.deepEqual(migrated.agentHours.map(item => [item.agentId, item.hour, item.turns]).sort(), [
      ["a", "2026-10-10T20:00:00.000Z", 1], ["b", "2026-10-10T02:00:00.000Z", 1], ["c", "2026-10-08T12:00:00.000Z", 2]]);
    assert.equal(migrated.agentHours.find(item => item.agentId === "a")?.lastActiveAt, "2026-10-10T20:30:00.000Z");
    // The tool day goes to the hour where its calls reach half: 02:00, i.e. 10-09 in Pacific time; without hours, noon.
    assert.deepEqual(migrated.toolHours, [
      { hour: "2026-10-10T02:00:00.000Z", tools: [tool("Bash", "shell", 6), tool("Read", "read", 4)], kinds: [tool("shell", "shell", 6), tool("read", "read", 4)] },
      { hour: "2026-10-09T12:00:00.000Z", tools: [tool("Grep", "search", 2)], kinds: [tool("search", "search", 2)] }]);
    assert.deepEqual([migrated.attributions, migrated.toolDays], [[], []]);
    assert.ok(migrated.change as number > 41, "a migration is written back");
    // 2.12.0 strips the new fields and finds valid, empty per-day lists: it keeps the hours instead of quarantining the file.
    const downgraded = legacy.parse(migrated);
    assert.deepEqual(downgraded.hours, old.hours); assert.deepEqual([downgraded.attributions, downgraded.toolDays], [[], []]);
    const paseo = api(["a", "b", "c"].map(id => entry(id, "2026-09-01T00:00:00.000Z")));
    const snapshot = full(await store.read({ range: "7d", utcOffsetMinutes: -420, timeZone: PACIFIC }, paseo));
    assert.deepEqual(snapshot.daily.slice(-3).map(day => [day.day, day.turns]), [["2026-10-08", 0], ["2026-10-09", 1], ["2026-10-10", 1]]);
    assert.deepEqual(["a", "b", "c"].map(id => row(snapshot, `model-${id}`)?.turns), [1, 1, 2]);
    assert.equal(snapshot.records.busiestSession?.agentId, "c"); assert.equal(row(snapshot, "model-gone"), undefined);
    assert.deepEqual(snapshot.tools.map(item => [item.name, item.calls]), [["Bash", 6], ["Read", 4], ["Grep", 2]]);
  }, async directory => { await writeFile(join(directory, "stats.json"), JSON.stringify(old)); });
});

test("the hour layout survives a restart unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-stats-zone-restart-")); let now = Date.parse("2026-10-11T01:10:00.000Z");
  let store = new StatsStore({ directory, now: () => now });
  try {
    await store.ready;
    for (let turn = 0; turn < 3; turn++) { store.record({ type: "turn_started", agentId: `agent-${turn}` }); now += 50 * 60_000; store.record({ type: "turn_ended", agentId: `agent-${turn}`, outcome: "failed", timeline: work(turn) }); }
    await store.flush(); const before = await readFile(join(directory, "stats.json"), "utf8");
    await store.close(); store = new StatsStore({ directory, now: () => now }); await store.ready;
    const restored = full(await store.read({ range: "30d", utcOffsetMinutes: -420, timeZone: PACIFIC }, api()));
    assert.equal(restored.totals.failed, 3); assert.equal(restored.toolKinds[0].calls, 3);
    await store.flush(true);
    const after = JSON.parse(await readFile(join(directory, "stats.json"), "utf8")), first = JSON.parse(before);
    assert.deepEqual(after.agentHours, first.agentHours); assert.deepEqual(after.toolHours, first.toolHours);
    assert.ok(first.agentHours.length >= 3 && first.agentHours.every((item: { hour: string }) => item.hour === statsHour(Date.parse(item.hour))));
    assert.equal(iso(Date.parse(first.toolHours[0].hour)), first.toolHours[0].hour);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
