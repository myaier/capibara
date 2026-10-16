import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalyticsAccumulator } from "../server/analytics";
import { TelemetryStore } from "../server/telemetry";
import { analyticsResponseSchema, analyticsSnapshotSchema, buildHourlyHeatmap, coveredDuration, emptyActivityMetrics, latestUsageSamples, mergeAnalytics, sumActivityMetrics, type UsageSample } from "../shared/analytics";
import type { TelemetryEvent } from "../shared/telemetry";

const now = Date.parse("2026-09-16T12:30:00.000Z");
const agent = { id: "analytics-agent", title: "Observed worker", provider: "codex", workspaceId: "workspace-one" };
const event = (id: string, at: number, type: TelemetryEvent["type"] = "turn_completed", durationMs?: number): TelemetryEvent => ({
  id, agentId: agent.id, agentTitle: agent.title, at: new Date(at).toISOString(), type, label: "Observation",
  ...(durationMs === undefined ? {} : { durationMs }),
});

test("hourly aggregates retain all observations after the small event ledger rolls over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-analytics-"));
  const store = new TelemetryStore({ directory, now: () => now, maxEvents: 5, writeDelayMs: 60_000 });
  try {
    for (let index = 0; index < 40; index++) {
      await store.record({ type: "turn_started", agent, turnId: `turn-${index}` });
      await store.record({ type: "turn_ended", agent, turnId: `turn-${index}`, outcome: index % 4 === 0 ? "failed" : "completed" });
    }
    assert.equal((await store.snapshot()).events.length, 5);
    const snapshot = analyticsSnapshotSchema.parse(await store.analyticsSnapshot());
    assert.equal(snapshot.hours[0].eventCount, 80);
    assert.equal(snapshot.hours[0].completed, 30);
    assert.equal(snapshot.hours[0].failed, 10);
    assert.equal(snapshot.hours[0].runSamples, 40);
    assert.equal(snapshot.days[0].eventCount, 80);
    assert.equal(snapshot.agents[0].eventCount, 80);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("usage history keeps provider snapshots and peaks rather than fake cumulative totals", () => {
  const analytics = new AnalyticsAccumulator(now);
  analytics.recordUsage("sample-1", agent, new Date(now).toISOString(), { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 });
  analytics.recordUsage("sample-2", agent, new Date(now + 1000).toISOString(), { inputTokens: 200, outputTokens: 5, totalCostUsd: 0 });
  analytics.recordUsage("sample-3", agent, new Date(now + 2000).toISOString(), { inputTokens: 50, outputTokens: 10 });
  const snapshot = analytics.snapshot(now + 2000, null);
  assert.equal(snapshot.usageBasis, "provider_reported_snapshot");
  assert.equal(snapshot.usageAggregation, "peak_per_bucket");
  assert.equal(snapshot.hours[0].inputTokens, 200);
  assert.equal(snapshot.hours[0].outputTokens, 20);
  assert.equal(snapshot.hours[0].cachedTokens, 0);
  assert.equal(snapshot.hours[0].costUsd, 0);
  assert.equal(snapshot.hours[0].eventCount, 0);
  assert.deepEqual(snapshot.usage.map(sample => sample.inputTokens), [50, 200, 100]);
  assert.equal(snapshot.usage[0].costUsd, null);
  assert.equal(snapshot.usage[0].cachedTokens, null);
});

test("unknown usage remains absent and repeated sample IDs are idempotent after restore", () => {
  const analytics = new AnalyticsAccumulator(now);
  analytics.recordEvent(event("ended", now), agent);
  analytics.recordUsage("invalid", agent, new Date(now).toISOString(), { inputTokens: Infinity, outputTokens: -1 });
  assert.equal(analytics.snapshot(now, null).hours[0].inputTokens, null);
  assert.equal(analytics.snapshot(now, null).usage.length, 0);
  analytics.recordUsage("sample", agent, new Date(now).toISOString(), { inputTokens: 120 });
  const restored = new AnalyticsAccumulator(now + 1000);
  assert.equal(restored.restore(analytics.serialize()), true);
  restored.recordUsage("sample", agent, new Date(now + 1000).toISOString(), { inputTokens: 120 });
  assert.equal(restored.snapshot(now + 1000, null).usage.length, 1);
  assert.equal(restored.snapshot(now + 1000, null).hours[0].usageSamples, 1);
});

test("unknown turn durations do not dilute mean runtime and project placement is retained", () => {
  const analytics = new AnalyticsAccumulator(now);
  analytics.recordEvent(event("known", now, "turn_completed", 6000), agent, 1000);
  analytics.recordEvent(event("unknown", now + 10, "turn_failed"), agent);
  analytics.updateAttribution({ ...agent, projectId: "project-commerce", projectName: "Commerce", projectRootPath: "/repo/commerce" });
  const snapshot = analytics.snapshot(now + 10, null);
  assert.equal(snapshot.hours[0].runMs, 6000);
  assert.equal(snapshot.hours[0].runSamples, 1);
  assert.equal(snapshot.hours[0].waitMs, 1000);
  assert.equal(snapshot.agents[0].eventCount, 2);
  assert.equal(snapshot.agents[0].projectName, "Commerce");
  assert.equal(snapshot.agents[0].projectRootPath, "/repo/commerce");
});

test("seven-day UTC heatmaps distinguish unobserved, quiet and future hours", () => {
  const analytics = new AnalyticsAccumulator(now - 30 * 60_000);
  analytics.recordEvent(event("first", now), agent);
  const snapshot = analytics.snapshot(now, null);
  const heatmap = buildHourlyHeatmap(snapshot.hours, { now, startedAt: snapshot.startedAt });
  assert.equal(heatmap.length, 168);
  assert.equal(heatmap[0].day, "2026-09-10");
  assert.equal(heatmap.at(-1)?.day, "2026-09-16");
  assert.equal(heatmap.find(cell => cell.day === "2026-09-16" && cell.hour === 12)?.value, 1);
  assert.equal(heatmap.find(cell => cell.day === "2026-09-16" && cell.hour === 11)?.observed, false);
  assert.equal(heatmap.find(cell => cell.day === "2026-09-16" && cell.hour === 13)?.value, null);
  assert.equal(heatmap.find(cell => cell.day === "2026-09-16" && cell.hour === 13)?.isFuture, true);
  const tokens = buildHourlyHeatmap(snapshot.hours, { now, startedAt: snapshot.startedAt, metric: "inputTokens" });
  assert.equal(tokens.find(cell => cell.day === "2026-09-16" && cell.hour === 12)?.value, null);
});

test("retention bounds hours, days, samples and agents independently", () => {
  const analytics = new AnalyticsAccumulator(now);
  for (let day = 0; day < 35; day++) for (let hour = 0; hour < 24; hour++) {
    const at = now + day * 86_400_000 + hour * 3_600_000;
    analytics.recordEvent(event(`${day}-${hour}`, at), agent);
  }
  const latest = now + 35 * 86_400_000;
  for (let index = 0; index < 2100; index++) {
    analytics.recordUsage(`sample-${index}`, { id: `agent-${index}` }, new Date(latest).toISOString(), { inputTokens: index });
  }
  const snapshot = analytics.snapshot(latest, null);
  assert.ok(snapshot.hours.length <= 168);
  assert.ok(snapshot.days.length <= 28);
  assert.equal(snapshot.agents.length, 2000);
  assert.equal(snapshot.usage.length, 1000);
  assert.equal(snapshot.agentsTruncated, true);
});

test("combining groups adds event counts while preserving unknown or peak reported usage", () => {
  const sum = sumActivityMetrics([
    { ...emptyActivityMetrics(), completed: 2, inputTokens: 100, costUsd: null, runMs: 60, runSamples: 1 },
    { ...emptyActivityMetrics(), failed: 1, inputTokens: 200, costUsd: null, runMs: 30, runSamples: 1 },
  ]);
  assert.equal(sum.completed, 2);
  assert.equal(sum.failed, 1);
  assert.equal(sum.inputTokens, 200);
  assert.equal(sum.costUsd, null);
  assert.equal(sum.runMs / sum.runSamples, 45);
});

test("analytics and deduplicated end samples persist in the same atomic telemetry file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-analytics-save-"));
  const store = new TelemetryStore({ directory, now: () => now, writeDelayMs: 60_000 });
  let restored: TelemetryStore | null = null;
  try {
    const first = await store.recordEvent({ type: "turn_ended", agent, turnId: "once", outcome: "completed" });
    const duplicate = await store.recordEvent({ type: "turn_ended", agent, turnId: "once", outcome: "completed" });
    assert.ok(first);
    assert.equal(duplicate, null);
    await store.recordUsage(first!.id, { ...agent, projectId: "commerce", projectName: "Commerce" }, first!.at, { inputTokens: 420 });
    await store.close();
    restored = new TelemetryStore({ directory, now: () => now + 1000 });
    const snapshot = await restored.analyticsSnapshot();
    assert.equal(snapshot.hours[0].completed, 1);
    assert.equal(snapshot.hours[0].inputTokens, 420);
    assert.equal(snapshot.usage[0].projectId, "commerce");
    assert.equal(snapshot.startedAt, new Date(now).toISOString());
  } finally { await restored?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy files migrate without pretending the retained event tail is complete history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-analytics-legacy-"));
  const store = new TelemetryStore({ directory, now: () => now, writeDelayMs: 60_000 });
  let restored: TelemetryStore | null = null;
  try {
    await store.record({ type: "created", agent });
    await store.close();
    const file = join(directory, "telemetry.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    delete state.analytics;
    await writeFile(file, JSON.stringify(state));
    restored = new TelemetryStore({ directory, now: () => now + 86_400_000 });
    assert.equal((await restored.snapshot()).events.length, 1);
    assert.equal((await restored.analyticsSnapshot()).hours.length, 0);
    assert.equal((await restored.analyticsSnapshot()).startedAt, new Date(now + 86_400_000).toISOString());
  } finally { await restored?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("collector downtime remains uncovered across reload rather than becoming quiet zero hours", () => {
  const start = Date.parse("2026-09-16T00:00:00Z");
  const first = new AnalyticsAccumulator(start);
  for (let at = start + 30_000; at <= start + 3_600_000; at += 30_000) first.heartbeat(at);
  const second = new AnalyticsAccumulator(start + 3 * 3_600_000);
  assert.equal(second.restore(first.serialize()), true);
  second.heartbeat(start + 3 * 3_600_000 + 30_000);
  const snapshot = second.snapshot(start + 3 * 3_600_000 + 30_000, null);
  const cells = buildHourlyHeatmap(snapshot.hours, { now: start + 3 * 3_600_000 + 30_000, startedAt: snapshot.startedAt, coverageIntervals: snapshot.coverageIntervals });
  const atHour = (hour: number) => cells.find(cell => cell.day === "2026-09-16" && cell.hour === hour)!;
  assert.equal(atHour(0).coverage, "full"); assert.equal(atHour(0).value, 0);
  assert.equal(atHour(1).coverage, "none"); assert.equal(atHour(1).value, null);
  assert.equal(atHour(2).value, null); assert.equal(atHour(3).coverage, "full");
});

test("missed heartbeats split coverage and overlapping intervals are never double counted", () => {
  const analytics = new AnalyticsAccumulator(now);
  analytics.heartbeat(now + 30_000); analytics.heartbeat(now + 300_000); analytics.heartbeat(now + 330_000);
  const intervals = analytics.snapshot(now + 330_000, null).coverageIntervals!;
  assert.equal(intervals.length, 2); assert.equal(coveredDuration(intervals, now, now + 330_000), 60_000);
  assert.equal(coveredDuration([...intervals, ...intervals], now, now + 330_000), 60_000);
});

test("project history uses exact attributed buckets and survives late attribution plus reload", () => {
  const analytics = new AnalyticsAccumulator(now);
  analytics.recordEvent(event("unassigned", now), agent);
  analytics.updateAttribution({ ...agent, projectId: "one", projectName: "One" });
  analytics.recordEvent(event("same-hour", now + 100), { ...agent, projectId: "one" });
  analytics.recordEvent(event("other-project", now + 200), { id: "other", projectId: "two", projectName: "Two" });
  const restored = new AnalyticsAccumulator(now + 500);
  assert.equal(restored.restore(analytics.serialize()), true);
  assert.equal(restored.snapshot(now + 500, null, "one").hours[0].eventCount, 2);
  assert.equal(restored.snapshot(now + 500, null, "two").hours[0].eventCount, 1);
  assert.equal(restored.snapshot(now + 500, null).hours[0].eventCount, 3);
  restored.updateAttribution({ ...agent, projectId: "two", projectName: "Two" });
  assert.equal(restored.snapshot(now + 500, null, "one").hours[0].eventCount, 2, "historical attribution must not follow later project moves");
});

test("analytics revisions ignore heartbeat-only coverage growth and carry the open interval instead", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-analytics-revision-"));
  let clock = now;
  const store = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  try {
    await store.record({ type: "turn_started", agent, turnId: "one" });
    const first = analyticsResponseSchema.parse(await store.analyticsRead());
    assert.equal(first.mode, "full");
    clock += 30_000;
    const idle = analyticsResponseSchema.parse(await store.analyticsRead({ revision: first.revision }));
    assert.equal(idle.mode, "unchanged");
    if (idle.mode !== "unchanged") return;
    assert.equal(idle.coverageTail?.end, new Date(clock).toISOString()); assert.ok(JSON.stringify(idle).length < 220);
    const merged = mergeAnalytics(mergeAnalytics(undefined, first), idle);
    const fresh = await store.analyticsRead();
    assert.ok(fresh.mode === "full");
    assert.deepEqual(merged.coverageIntervals, fresh.coverageIntervals, "clients advance coverage without a full reply");
    await store.record({ type: "turn_ended", agent, turnId: "one", outcome: "completed" });
    assert.equal((await store.analyticsRead({ revision: first.revision })).mode, "full", "a lifecycle event changes the revision");
    const settled = await store.analyticsRead();
    clock += 120_000;
    assert.equal((await store.analyticsRead({ revision: settled.revision })).mode, "full", "a coverage gap starts a new interval");
    assert.notEqual((await store.analyticsRead({ projectId: "elsewhere" })).revision, settled.revision);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("usage replies keep exactly the samples the dashboard renders", () => {
  let seed = 3;
  const random = () => { seed = (seed * 48_271) % 2_147_483_647; return seed / 2_147_483_647; };
  const samples: UsageSample[] = Array.from({ length: 300 }, (_, index) => ({ id: `s-${index}`, agentId: `agent-${Math.floor(random() * 40)}`, provider: "codex",
    workspaceId: null, projectId: null, at: new Date(now - Math.floor(random() * 3_600_000)).toISOString(), inputTokens: index, outputTokens: null, cachedTokens: null, costUsd: null }));
  const kept = latestUsageSamples(samples);
  assert.ok(kept.length <= 80 && kept.length < samples.length);
  const firstListed = (list: UsageSample[]) => { const seen = new Map<string, UsageSample>(); for (const sample of list) if (!seen.has(sample.agentId)) seen.set(sample.agentId, sample); return [...seen.values()]; };
  const newest = (list: UsageSample[]) => { const latest = new Map<string, UsageSample>(); for (const sample of list) { const previous = latest.get(sample.agentId); if (!previous || Date.parse(sample.at) > Date.parse(previous.at)) latest.set(sample.agentId, sample); } return latest; };
  assert.deepEqual(firstListed(kept), firstListed(samples));
  assert.deepEqual(newest(kept), newest(samples));
});
