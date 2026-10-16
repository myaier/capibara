import assert from "node:assert/strict";
import test from "node:test";
import { AnalyticsAccumulator, deviceZone, zoneOffsets } from "../server/analytics";
import { analyticsDayStart, analyticsLocalDay, analyticsResponseSchema, analyticsSnapshotSchema, analyticsZoneLabel, buildDailySeries, buildHourlyHeatmap, getAnalytics,
  type AnalyticsSnapshot } from "../shared/analytics";
import type { TelemetryEvent } from "../shared/telemetry";

// 明细 → 观测 in the device's clock (opus-F40): local days and hours, exact across daylight-saving changes.
const HOUR = 3_600_000, DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const worker = { id: "zone-agent", provider: "my-claude", workspaceId: "workspace-one" };
let counter = 0;
const event = (time: number, type: TelemetryEvent["type"] = "turn_completed", agent: { id: string } = worker): TelemetryEvent =>
  ({ id: `event-${++counter}`, agentId: agent.id, agentTitle: "Worker", at: new Date(time).toISOString(), type, label: "Observation" });
/** What a device in US/Pacific sends at `now`: its zone and the offset in force then. */
const pacific = (now: number) => ({ timeZone: "US/Pacific", utcOffsetMinutes: Math.round(deviceZone("US/Pacific", null, now)!.offsetAt(now) / 60_000) });
const day = (snapshot: AnalyticsSnapshot, text: string) => snapshot.days.find(bucket => bucket.day === text);
function heatmap(snapshot: AnalyticsSnapshot, now: number) {
  return buildHourlyHeatmap(snapshot.hours, { now, startedAt: snapshot.startedAt, zone: snapshot.zone, hourlyFrom: snapshot.hourlyFrom });
}
const cell = (cells: ReturnType<typeof heatmap>, text: string, hour: number) => cells.find(item => item.day === text && item.hour === hour)!;

test("the device zone is found by name alone or checked against the device's offset; unknown zones give UTC", () => {
  const summer = at("2026-10-12T20:00:00Z"), winter = at("2026-11-03T20:00:00Z");
  assert.equal(deviceZone("US/Pacific", null, summer)?.name, "US/Pacific");
  assert.equal(deviceZone("US/Pacific", null, summer)!.offsetAt(summer), -7 * HOUR);
  assert.equal(deviceZone("US/Pacific", null, winter)!.offsetAt(winter), -8 * HOUR);
  assert.equal(deviceZone("US/Pacific", -420, summer)?.name, "US/Pacific", "zone and offset agree");
  assert.equal(deviceZone("US/Pacific", 330, summer)?.name, null, "they disagree: the device's offset wins");
  assert.equal(deviceZone("US/Pacific", 330, summer)!.offsetAt(summer), 330 * 60_000);
  assert.equal(deviceZone("Mars/Olympus_Mons", null, summer), null);
  assert.equal(deviceZone(null, null, summer), null);
  assert.equal(deviceZone("Asia/Kathmandu", null, summer)!.offsetAt(summer), (5 * 60 + 45) * 60_000);
  // Only the changes travel: one offset for a fixed zone, two across the US fall-back night. The first holds from 0, so
  // the list (and the reply's revision) does not move with the clock.
  assert.deepEqual(zoneOffsets(deviceZone("Asia/Singapore", null, summer)!, summer - 2 * DAY, summer), [[0, 480]]);
  const across = zoneOffsets(deviceZone("US/Pacific", null, winter)!, at("2026-10-30T00:00:00Z"), winter);
  assert.deepEqual(across, [[0, -420], [at("2026-11-01T09:00:00Z"), -480]]);
  assert.deepEqual(zoneOffsets(deviceZone("US/Pacific", null, winter)!, at("2026-10-30T05:00:00Z"), winter + 3 * 3_600_000), across);
});

test("US/Pacific fall-back night 2026-11-01: the repeated hour holds both, and days follow each hour's own offset", () => {
  const analytics = new AnalyticsAccumulator(at("2026-10-20T00:00:00Z"));
  // 2026-10-31 00:30 PDT: a fixed −08:00 offset (the one in force when it is viewed) would put it on 10-30.
  analytics.recordEvent(event(at("2026-10-31T07:30:00Z")), worker);
  // 01:30 PDT and 01:30 PST, one hour apart in UTC, the same local hour.
  analytics.recordEvent(event(at("2026-11-01T08:30:00Z")), worker);
  analytics.recordEvent(event(at("2026-11-01T09:30:00Z")), worker);
  analytics.recordEvent(event(at("2026-11-01T09:40:00Z"), "turn_failed"), worker);
  // 23:30 PST on 11-01 (07:30 UTC on 11-02).
  analytics.recordEvent(event(at("2026-11-02T07:30:00Z")), worker);
  const now = at("2026-11-03T20:00:00Z");
  const snapshot = analyticsSnapshotSchema.parse(analytics.snapshot(now, null, undefined, pacific(now)));
  assert.equal(snapshot.zone?.name, "US/Pacific");
  assert.equal(day(snapshot, "2026-10-31")?.eventCount, 1);
  assert.equal(day(snapshot, "2026-10-30"), undefined);
  assert.equal(day(snapshot, "2026-11-01")?.eventCount, 4);
  assert.equal(day(snapshot, "2026-11-01")?.bucketStart, "2026-11-01T07:00:00.000Z", "11-01 starts at PDT midnight");
  assert.equal(day(snapshot, "2026-11-02"), undefined);
  assert.equal(snapshot.days.at(-1)?.day ?? null, "2026-11-01");
  // What the fixed offset of the viewing day (2.13's Token page, the old insight overview) does with the same history.
  const fixed = analytics.snapshot(now, null, undefined, { utcOffsetMinutes: -480 });
  assert.equal(day(fixed, "2026-10-30")?.eventCount, 1); assert.equal(day(fixed, "2026-10-31"), undefined);
  const cells = heatmap(snapshot, now);
  assert.equal(cells.length, 7 * 24); assert.equal(cells[0]!.day, "2026-10-28"); assert.equal(cells.at(-1)!.day, "2026-11-03");
  const repeated = cell(cells, "2026-11-01", 1);
  assert.equal(repeated.utcHours, 2); assert.equal(repeated.value, 3, "01:00–02:00 happened twice: both hours summed");
  assert.equal(repeated.metrics?.failed, 1); assert.equal(repeated.bucketStart, "2026-11-01T08:00:00.000Z");
  assert.equal(cell(cells, "2026-11-01", 2).bucketStart, "2026-11-01T10:00:00.000Z");
  assert.equal(cell(cells, "2026-11-01", 23).value, 1, "the 23:30 PST turn is on 11-01, not 11-02");
  assert.equal(cell(cells, "2026-10-31", 0).value, 1);
  assert.ok(cells.every(item => item.exists), "no hour is skipped in the fall");
  // The local day itself is 25 hours long.
  const series = buildDailySeries(snapshot, { now, count: 7 });
  const fallBack = series.find(item => item.day === "2026-11-01")!;
  assert.equal(fallBack.end - fallBack.start, 25 * HOUR); assert.equal(series.at(-1)!.day, "2026-11-03"); assert.equal(series.length, 7);
});

test("US/Pacific spring-forward day 2027-03-14: the skipped hour does not exist (no invented zero) and the day has 23 hours", () => {
  const analytics = new AnalyticsAccumulator(at("2027-03-01T00:00:00Z"));
  analytics.recordEvent(event(at("2027-03-14T09:30:00Z")), worker); // 01:30 PST
  analytics.recordEvent(event(at("2027-03-14T10:30:00Z")), worker); // 03:30 PDT: 02:xx never happened
  analytics.recordEvent(event(at("2027-03-15T06:30:00Z")), worker); // 23:30 PDT on 03-14
  const now = at("2027-03-16T18:00:00Z");
  const snapshot = analytics.snapshot(now, null, undefined, pacific(now));
  assert.equal(day(snapshot, "2027-03-14")?.eventCount, 3);
  const cells = heatmap(snapshot, now);
  const skipped = cell(cells, "2027-03-14", 2);
  assert.equal(skipped.exists, false); assert.equal(skipped.value, null); assert.equal(skipped.bucketStart, null); assert.equal(skipped.utcHours, 0);
  assert.equal(cell(cells, "2027-03-14", 1).value, 1); assert.equal(cell(cells, "2027-03-14", 3).value, 1); assert.equal(cell(cells, "2027-03-14", 23).value, 1);
  assert.equal(cell(cells, "2027-03-14", 4).value, 0, "an observed quiet hour is a zero");
  assert.equal(cells.filter(item => !item.exists).length, 1);
  const spring = buildDailySeries(snapshot, { now, count: 7 }).find(item => item.day === "2027-03-14")!;
  assert.equal(spring.end - spring.start, 23 * HOUR);
});

test("half- and three-quarter-hour zones: a UTC hour belongs to the local day and hour its start falls on", () => {
  const analytics = new AnalyticsAccumulator(at("2026-10-01T00:00:00Z"));
  // 18:40 UTC is 00:10 IST on 10-12, but its bucket starts at 18:00 UTC = 23:30 IST on 10-11.
  analytics.recordEvent(event(at("2026-10-11T18:40:00Z")), worker);
  analytics.recordEvent(event(at("2026-10-11T19:05:00Z")), worker); // bucket 19:00 UTC = 00:30 IST on 10-12
  const now = at("2026-10-12T12:00:00Z");
  const kolkata = analyticsSnapshotSchema.parse(analytics.snapshot(now, null, undefined, { timeZone: "Asia/Kolkata", utcOffsetMinutes: 330 }));
  assert.equal(day(kolkata, "2026-10-11")?.eventCount, 1); assert.equal(day(kolkata, "2026-10-12")?.eventCount, 1);
  assert.equal(day(kolkata, "2026-10-12")?.bucketStart, "2026-10-11T19:00:00.000Z", "the local day runs from 00:30 to 00:30");
  const cells = heatmap(kolkata, now);
  assert.deepEqual([cell(cells, "2026-10-11", 23).minute, cell(cells, "2026-10-11", 23).value], [30, 1]);
  assert.deepEqual([cell(cells, "2026-10-12", 0).minute, cell(cells, "2026-10-12", 0).value], [30, 1]);
  assert.ok(cells.every(item => item.exists && item.utcHours === 1));
  const kathmandu = heatmap(analytics.snapshot(now, null, undefined, { timeZone: "Asia/Kathmandu", utcOffsetMinutes: 345 }), now);
  assert.deepEqual([cell(kathmandu, "2026-10-12", 0).minute, cell(kathmandu, "2026-10-12", 0).value], [45, 1], "18:00 UTC is 23:45, 19:00 UTC is 00:45 the next day");
  assert.equal(cell(kathmandu, "2026-10-11", 23).value, 1);
  assert.equal(analyticsDayStart(analyticsLocalDay(now, kolkata.zone), kolkata.zone), at("2026-10-11T19:00:00Z"));
});

test("without the device's clock the page is UTC and says so; a bare offset is a fixed zone", () => {
  const analytics = new AnalyticsAccumulator(at("2026-10-01T00:00:00Z"));
  analytics.recordEvent(event(at("2026-10-11T23:30:00Z")), worker);
  const now = at("2026-10-12T12:00:00Z");
  const utc = analytics.snapshot(now, null);
  assert.equal(utc.zone, null); assert.equal(analyticsZoneLabel(utc.zone), "UTC（没有取得本机时区）");
  assert.equal(day(utc, "2026-10-11")?.eventCount, 1); assert.equal(day(utc, "2026-10-11")?.bucketStart, "2026-10-11T00:00:00.000Z");
  assert.equal(cell(heatmap(utc, now), "2026-10-11", 23).value, 1);
  const fixed = analytics.snapshot(now, null, undefined, { utcOffsetMinutes: -420 });
  assert.equal(fixed.zone?.name, null); assert.deepEqual(fixed.zone?.offsets.map(([, minutes]) => minutes), [-420]);
  assert.equal(analyticsZoneLabel(fixed.zone, now), "本机时区 UTC−07:00（固定偏移）");
  assert.equal(day(fixed, "2026-10-11")?.eventCount, 1, "16:30 at −07:00 is still 10-11");
  assert.equal(analyticsZoneLabel(analytics.snapshot(now, null, undefined, { timeZone: "America/New_York", utcOffsetMinutes: -240 }).zone), "本机时区 America/New_York");
  // The RPC takes the clock like observatory.stats.get, and older clients without it still validate.
  assert.ok(getAnalytics.input.safeParse({ timeZone: "US/Pacific", utcOffsetMinutes: -420 }).success);
  assert.ok(getAnalytics.input.safeParse({}).success);
  assert.equal(getAnalytics.input.safeParse({ timeZone: "../etc" }).success, false);
  assert.equal(getAnalytics.input.safeParse({ utcOffsetMinutes: 900 }).success, false);
});

test("29 days of hours cover 28 local days; replies carry the heatmap's hours and 28 local days only", () => {
  const start = at("2026-09-01T00:00:00Z"), analytics = new AnalyticsAccumulator(start);
  for (let hour = 0; hour < 40 * 24; hour++) analytics.recordEvent(event(start + hour * HOUR + 5 * 60_000), worker);
  const now = start + 40 * DAY - 30 * 60_000;
  const state = analytics.serialize();
  assert.ok(state.hours.length <= 29 * 24 && state.hours.length >= 28 * 24 + 1, `kept ${state.hours.length} hours`);
  assert.ok(state.days.length <= 29);
  const snapshot = analyticsSnapshotSchema.parse(analytics.snapshot(now, null, undefined, pacific(now)));
  assert.equal(snapshot.days.length, 28);
  assert.ok(snapshot.days.every(bucket => !bucket.approximate));
  // Every local day of the 28 is complete: 24 hours (none of them is a daylight-saving day in September and October).
  assert.ok(snapshot.days.slice(0, -1).every(bucket => bucket.eventCount === 24), JSON.stringify(snapshot.days.map(bucket => bucket.eventCount)));
  assert.ok(snapshot.hours.length <= 7 * 24 && snapshot.hours.length > 6 * 24);
  assert.ok(Date.parse(snapshot.hours[0]!.bucketStart) >= analyticsDayStart(analyticsLocalDay(now, snapshot.zone) - 6, snapshot.zone));
  // An hour later with nothing new the layout is the same (the revision ignores coverage), so polls stay "unchanged".
  const layout = (view: AnalyticsSnapshot) => JSON.stringify({ zone: view.zone, days: view.days.map(({ coveredMs: _c, ...bucket }) => bucket), hours: view.hours.map(({ coveredMs: _c, ...bucket }) => bucket) });
  assert.equal(layout(analytics.snapshot(now + HOUR, null, undefined, pacific(now))), layout(snapshot));
  // The reply's revision follows the zone: the same data in another clock is another reply.
  assert.notDeepEqual(analytics.snapshot(now, null, undefined, { timeZone: "Asia/Singapore", utcOffsetMinutes: 480 }).days.map(bucket => bucket.bucketStart), snapshot.days.map(bucket => bucket.bucketStart));
  assert.ok(analyticsResponseSchema.safeParse({ ...snapshot, mode: "full", unchanged: false, revision: "r" }).success);
});

test("data from 2.13 (168 hours, UTC days) counts every event once; older days are approximate except in UTC", () => {
  const start = at("2026-10-01T00:00:00Z"), analytics = new AnalyticsAccumulator(start);
  // Two events in UTC 10-04, one at 00:30 UTC on 10-08 (before the hours 2.13 still held), the rest within them.
  const times = ["2026-10-04T05:00:00Z", "2026-10-04T23:30:00Z", "2026-10-08T00:30:00Z", "2026-10-08T02:00:00Z", "2026-10-08T15:00:00Z", "2026-10-09T03:00:00Z", "2026-10-11T18:00:00Z"].map(at);
  for (const time of times) analytics.recordEvent(event(time), worker);
  const saved = analytics.serialize(), lastSeen = at("2026-10-15T00:10:00Z"), edge = at("2026-10-08T01:00:00Z");
  // As 2.13 saved it: no hourlyFrom, hours pruned to the 168 before its last heartbeat (10-08 01:00 UTC on).
  const legacy = { ...saved, hourlyFrom: undefined, updatedAt: new Date(lastSeen).toISOString(), coverageIntervals: [{ start: saved.startedAt, end: new Date(lastSeen).toISOString() }],
    hours: saved.hours.filter(bucket => Date.parse(bucket.bucketStart) >= edge),
    attributedBuckets: saved.attributedBuckets.filter(bucket => bucket.period === "day" || Date.parse(bucket.bucketStart) >= edge) };
  const restored = new AnalyticsAccumulator(lastSeen + HOUR);
  assert.equal(restored.restore(JSON.parse(JSON.stringify(legacy))), true);
  assert.equal(restored.serialize().hourlyFrom, "2026-10-08T01:00:00.000Z", "hours are complete only from 167 hours before the last heartbeat's hour");
  const now = at("2026-10-15T12:00:00Z");
  const days = (snapshot: AnalyticsSnapshot) => snapshot.days.map(bucket => [bucket.day, bucket.eventCount, bucket.approximate === true]);
  // US/Pacific: 10-08 02:00 UTC is 10-07 19:00 by the clock (hourly, exact). 10-08 00:30 UTC predates hourly history, so
  // it rides with the UTC day of 10-08 (approximate); nothing is lost or counted twice.
  assert.deepEqual(days(restored.snapshot(now, null, undefined, pacific(now))), [["2026-10-04", 2, true], ["2026-10-07", 1, false], ["2026-10-08", 3, true], ["2026-10-11", 1, false]]);
  assert.deepEqual(days(restored.snapshot(now, null, undefined, { timeZone: "Asia/Singapore", utcOffsetMinutes: 480 })),
    [["2026-10-04", 2, true], ["2026-10-08", 3, true], ["2026-10-09", 1, false], ["2026-10-12", 1, false]]);
  // In UTC the UTC days are the local days: exact.
  const utc = restored.snapshot(now, null);
  assert.deepEqual(days(utc), [["2026-10-04", 2, false], ["2026-10-08", 3, false], ["2026-10-09", 1, false], ["2026-10-11", 1, false]]);
  // The heatmap does not show hours before hourly history as quiet ones.
  const cells = buildHourlyHeatmap(utc.hours, { now, startedAt: utc.startedAt, hourlyFrom: "2026-10-10T05:00:00.000Z", coverageIntervals: utc.coverageIntervals });
  assert.ok(cells.filter(item => item.bucketStart! < "2026-10-10T05:00:00.000Z").every(item => item.value === null && !item.observed));
  assert.equal(cell(cells, "2026-10-10", 5).value, 0); assert.equal(cell(cells, "2026-10-11", 18).value, 1);
});

test("project hours are kept per project, not per Agent, and late attribution still lands in local days", () => {
  const start = at("2026-10-01T00:00:00Z"), analytics = new AnalyticsAccumulator(start), noon = at("2026-10-10T19:10:00Z");
  analytics.recordEvent(event(noon), { id: "one", projectId: "app" });
  analytics.recordEvent(event(noon + 60_000, "turn_completed", { id: "two" }), { id: "two", projectId: "app" });
  analytics.recordEvent(event(noon + 120_000, "turn_completed", { id: "three" }), { id: "three" });
  const hourly = () => analytics.serialize().attributedBuckets.filter(bucket => bucket.period === "hour");
  assert.deepEqual(hourly().map(bucket => [bucket.agentId, bucket.projectId, bucket.eventCount]), [["", "app", 2], ["three", null, 1]]);
  analytics.updateAttribution({ id: "three", projectId: "app", projectName: "App" });
  assert.deepEqual(hourly().map(bucket => [bucket.agentId, bucket.projectId, bucket.eventCount]), [["", "app", 3]]);
  const now = at("2026-10-12T20:00:00Z"), view = analytics.snapshot(now, null, "app", pacific(now));
  assert.equal(day(view, "2026-10-10")?.eventCount, 3); assert.equal(view.agents.length, 3);
  assert.equal(cell(heatmap(view, now), "2026-10-10", 12).value, 3, "19:10 UTC is 12:10 PDT");
  // A reload keeps the per-project buckets as they are.
  const restored = new AnalyticsAccumulator(now);
  assert.equal(restored.restore(analytics.serialize()), true);
  assert.equal(day(restored.snapshot(now, null, "app", pacific(now)), "2026-10-10")?.eventCount, 3);
});
