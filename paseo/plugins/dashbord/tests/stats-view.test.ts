import assert from "node:assert/strict";
import test from "node:test";
import { emptyStatsMetrics, type StatsDay, type StatsSnapshot } from "../shared/stats";
import { achievements, averageTurnMs, bigNumber, dayPart, hasContent, level, observedParallelism, parallelism, peakOf, percent, shortHours, successRate, weekdayForecast } from "../shared/stats-view";

const day = (date: string, turns: number): StatsDay => ({ ...emptyStatsMetrics(), day: date, turns });
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

test("rates and averages stay undefined without samples instead of reading as zero", () => {
  assert.equal(successRate({ completed: 0, failed: 0 }), null);
  assert.equal(successRate({ completed: 9, failed: 1 }), 0.9);
  // Canceled turns (your own interrupts) count neither way.
  const interrupted = { ...emptyStatsMetrics(), completed: 9, failed: 1, canceled: 40 };
  assert.equal(successRate(interrupted), 0.9);
  assert.equal(hasContent(emptyStatsMetrics()), false);
  assert.equal(hasContent({ ...emptyStatsMetrics(), userMessages: 1 }), true);
  assert.equal(averageTurnMs({ runMs: 0, runSamples: 0 }), null);
  assert.equal(averageTurnMs({ runMs: 90_000, runSamples: 3 }), 30_000);
  // Parallelism needs at least a minute of busy time to mean anything.
  assert.equal(parallelism({ runMs: 50_000, busyMs: 30_000 }), null);
  assert.equal(parallelism({ runMs: 300_000, busyMs: 120_000 }), 2.5);
  // Work time from before busy tracking began must not inflate concurrency.
  const hour = 3_600_000, tracked = (date: string, runMs: number, busyMs: number) => ({ ...day(date, 1), runMs, busyMs });
  assert.equal(observedParallelism([tracked("2026-09-22", 15 * hour, 0), tracked("2026-09-23", 15 * hour, 4 * 60_000)], 3), null);
  assert.equal(observedParallelism([tracked("2026-09-23", 15 * hour, 4 * 60_000), tracked("2026-09-24", 20 * hour, 10 * hour), tracked("2026-09-25", 10 * hour, 5 * hour)], 3), 2);
  assert.equal(percent(null), "—");
  assert.equal(percent(0.9876, 1), "98.8%");
});

test("numbers use 万 and 亿 above ten thousand and durations pick a readable unit", () => {
  assert.equal(bigNumber(9_999), "9,999");
  assert.equal(bigNumber(12_345), "1.2万");
  assert.equal(bigNumber(10_000), "1万");
  assert.equal(bigNumber(3_456_789), "346万");
  assert.equal(bigNumber(250_000_000), "2.5亿");
  assert.equal(bigNumber(Number.NaN), "—");
  assert.equal(shortHours(0), "0");
  assert.equal(shortHours(45_000), "45 秒");
  assert.equal(shortHours(12 * 60_000), "12 分");
  assert.equal(shortHours(3.4 * 3_600_000), "3.4 小时");
  assert.equal(shortHours(3 * 3_600_000), "3 小时");
  assert.equal(shortHours(1234 * 3_600_000), "1,234 小时");
});

test("the weekday forecast averages the same weekday over the last four weeks", () => {
  // 2026-08-24 is a Monday; Mondays run 10 turns, other days 2.
  const start = "2026-08-24";
  const daily = Array.from({ length: 28 }, (_, index) => day(addDays(start, index), index % 7 === 0 ? 10 : 2));
  const forecast = weekdayForecast(daily, entry => entry.turns);
  assert.equal(forecast.length, 7);
  assert.deepEqual(forecast[0], { day: addDays(start, 28), value: 10 });
  assert.deepEqual(forecast.slice(1).map(entry => entry.value), [2, 2, 2, 2, 2, 2]);
  // Fewer than seven active days is too little to predict from.
  const sparse = daily.map((entry, index) => ({ ...entry, turns: index < 6 ? 5 : 0 }));
  assert.deepEqual(weekdayForecast(sparse, entry => entry.turns), []);
  assert.deepEqual(weekdayForecast([], entry => entry.turns), []);
});

test("peaks ignore empty cells and day parts follow the clock", () => {
  assert.equal(peakOf([0, 0, 0]), null);
  assert.deepEqual(peakOf([0, 3, 7, 7, 1]), { index: 2, value: 7 });
  assert.deepEqual([2, 6, 9, 12, 15, 20, 23].map(dayPart), ["深夜", "清晨", "上午", "中午", "下午", "晚上", "深夜"]);
});

function snapshot(patch: Partial<StatsSnapshot> = {}): StatsSnapshot {
  const zero = emptyStatsMetrics();
  return {
    generatedAt: "2026-09-23T12:00:00.000Z", range: "30d", utcOffsetMinutes: 480, from: "2026-08-25", to: "2026-09-23",
    observedSince: null, contentSince: null, directoryTruncated: false, totals: zero, previous: zero, allTime: zero, daily: [day("2026-09-23", 0)],
    calendar: { start: "2025-09-22", sessions: [], turns: [] }, punchcard: { sessions: Array(168).fill(0), turns: Array(168).fill(0) },
    streak: { current: 0, longest: 0, longestEnd: null, activeDays: 0, activeDaysAllTime: 0 },
    records: { busiestDay: null, longestTurn: null, peakParallel: null, busiestSession: null },
    live: { open: 0, running: 0, approvals: 0, unread: 0, idle: 0 }, subagents: { parents: 0, children: 0, maxFanout: 0, maxDepth: 0 },
    models: [], providers: [], vendors: [], projects: [], tools: [], toolKinds: [], ...patch,
  };
}

test("badges unlock from all-time totals, streaks and records, and every three badges is a level", () => {
  const fresh = achievements(snapshot());
  assert.equal(fresh.length, 18);
  assert.equal(fresh.filter(badge => badge.unlocked).length, 0);
  assert.deepEqual(level(fresh), { level: 1, unlocked: 0, total: 18, progress: 0 });
  const punchcard = { sessions: Array(168).fill(0), turns: Array(168).fill(0) };
  punchcard.turns[2] = 60; // Monday 02:00
  const busy = achievements(snapshot({
    allTime: { ...emptyStatsMetrics(), sessions: 120, turns: 1500, childSessions: 3 },
    daily: [{ ...day("2026-09-23", 4), sessions: 2 }], streak: { current: 8, longest: 8, longestEnd: "2026-09-23", activeDays: 8, activeDaysAllTime: 8 },
    records: { busiestDay: null, busiestSession: null, peakParallel: { count: 6, at: "2026-09-22T10:00:00.000Z" }, longestTurn: { ms: 61 * 60_000, agentId: "a", title: "t", model: null, at: "2026-09-22T10:00:00.000Z" } },
    punchcard,
  }));
  const unlocked = new Set(busy.filter(badge => badge.unlocked).map(badge => badge.id));
  assert.deepEqual([...unlocked].sort(), ["first-light", "marathon", "night-owl", "parallel-5", "sessions-100", "streak-3", "streak-7", "today", "turns-1000"].sort());
  assert.equal(busy.find(badge => badge.id === "streak-30")!.current, 8);
  assert.equal(busy.find(badge => badge.id === "sessions-1000")!.current, 120);
  assert.deepEqual(level(busy), { level: 4, unlocked: 9, total: 18, progress: 0 });
});
