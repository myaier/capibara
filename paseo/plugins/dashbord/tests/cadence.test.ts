import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_RUN_FILTER, cadenceLabel, cadenceText, dayWord, filterRuns, normalizeRunQuery, parseCron, runQuota, searchFold, type ScheduleRunRow } from "../shared/schedules";

// The device of these tests is in New York (EDT, UTC-4, until 1 November 2026); local times below are New York times.
process.env.TZ = "America/New_York";
const DEVICE = "America/New_York";
const cron = (expression: string, timezone?: string) => ({ type: "cron" as const, expression, timezone });

test("cadences in Paseo's cron dialect read as Chinese: lists, ranges with steps, days of the month, weekday sets", () => {
  const cases: Array<[string, string]> = [
    ["0 9,18 * * *", "每天 09:00、18:00"],
    ["*/15 9-18 * * 1-5", "工作日 9–18 点每 15 分钟"],
    ["0,30 9-17 * * *", "9–17 点每 30 分钟"],
    ["0-59/15 * * * *", "每 15 分钟"],
    ["* * * * *", "每分钟"],
    ["0 * * * *", "每小时"],
    ["5 * * * *", "每小时（整点后 5 分）"],
    ["30 */6 * * *", "每 6 小时（整点后 30 分）"],
    ["0 9 1,15 * *", "每月 1、15 日 09:00"],
    ["0 9 1-7 * *", "每月 1–7 日 09:00"],
    ["0 9 * * 1,3,5", "每周一、三、五 09:00"],
    ["0 9 * * 0,3", "每周三、日 09:00"],
    ["0 10 * * 6,0", "周末 10:00"],
    ["0 9 * * 1-3", "周一至周三 09:00"],
    ["0 9 * 12 *", "12 月每天 09:00"],
    ["0 9 * 12 1-5", "12 月工作日 09:00"],
    ["0 9 1 1,4,7,10 *", "每年 1、4、7、10 月 1 日 09:00"],
    ["0 0 1 1 *", "每年 1月1日 00:00"],
    ["0 8,12 * * 1-5", "工作日 08:00、12:00"],
    ["5,10,20 9,12,15 * * *", "5,10,20 9,12,15 * * *"],
  ];
  for (const [expression, label] of cases) assert.equal(cadenceLabel(cron(expression)), label, expression);
});

test("a day of the month together with a weekday is shown as written: Paseo requires both, standard cron either", () => {
  assert.equal(cadenceLabel(cron("0 9 1 * 1")), "0 9 1 * 1");
  assert.equal(cadenceLabel(cron("0 9 1 * 1"), 1), "一次性 · 0 9 1 * 1");
  assert.equal(parseCron("0 9 1 * 1")!.weekday.values.join(","), "1");
});

test("what Paseo rejects (names, L, weekday 7, padded or zero steps) stays as written; a single value ignores its step like in Paseo", () => {
  for (const expression of ["0 9 * * 7", "0 9 * * MON", "@daily", "61 * * * *", "0 9 L * *", "*/0 * * * *", "*/05 * * * *", "0 9 * *", "5/x * * * *"]) {
    assert.equal(parseCron(expression), null, expression);
    assert.equal(cadenceLabel(cron(expression)), expression.trim(), expression);
  }
  assert.deepEqual(parseCron("5/10 * * * *")!.minute.values, [5]);
  assert.equal(cadenceLabel(cron("5/10 * * * *")), "每小时（整点后 5 分）");
  const long = `${Array.from({ length: 59 }, (_, minute) => minute).join(",")} * * * *`;
  assert.equal(cadenceLabel(cron(long)).length, 160, "an unreadable label is cut to what the ledger keeps");
});

test("a one-shot (maxRuns 1) says so; an interval one-shot has only its time, which the card adds", () => {
  assert.equal(cadenceLabel(cron("35 22 11 10 *"), 1), "一次性 · 10月11日 22:35");
  assert.equal(cadenceLabel(cron("35 22 11 10 *")), "每年 10月11日 22:35", "without a run limit a fixed date comes back every year");
  assert.equal(cadenceLabel(cron("0 9 * * 1-5"), 1), "一次性 · 工作日 09:00");
  assert.equal(cadenceLabel(cron("0 9 * * *"), 1), "一次性 · 09:00");
  assert.equal(cadenceLabel(cron("*/10 * * * *"), 1), "一次性");
  assert.equal(cadenceLabel({ type: "every", everyMs: 30 * 60_000 }, 1), "一次性");
  assert.equal(cadenceLabel(cron("0 9 * * *"), 5), "每天 09:00", "a larger limit is the card's 共 5 次");
});

test("a one-shot in another zone gives the device's time of its run, with the date when it is not the cron's", () => {
  const tokyo = { cadence: "一次性 · 10月11日 22:35", timezone: "Asia/Tokyo", expression: "35 22 11 10 *", maxRuns: 1, onceAt: "2026-10-11T13:35:00.000Z" };
  assert.equal(cadenceText(tokyo, DEVICE), "一次性 · 10月11日 22:35（东京时间）· 本地 09:35");
  assert.equal(cadenceText(tokyo, null), "一次性 · 10月11日 22:35（东京时间）· 本地 09:35", "an unknown device zone keeps both");
  assert.equal(cadenceText({ ...tokyo, onceAt: null }, DEVICE), "一次性 · 10月11日 22:35（东京时间）", "no absolute time: the cron's own");
  const early = { cadence: "一次性 · 10月12日 02:00", timezone: "Asia/Tokyo", expression: "0 2 12 10 *", maxRuns: 1, onceAt: "2026-10-11T17:00:00.000Z" };
  assert.equal(cadenceText(early, DEVICE), "一次性 · 10月12日 02:00（东京时间）· 本地 10月11日 13:00");
  const home = { cadence: "一次性 · 10月11日 22:35", timezone: DEVICE, expression: "35 22 11 10 *", maxRuns: 1, onceAt: "2026-10-12T02:35:00.000Z" };
  assert.equal(cadenceText(home, DEVICE), "一次性 · 10月11日 22:35", "the device's own zone needs no conversion");
});

test("a one-shot without a fixed date reads as its device time; run limits and zones as before", () => {
  const now = Date.parse("2026-10-10T16:00:00.000Z"); // 10月10日 12:00 in New York
  assert.equal(cadenceText({ cadence: "一次性 · 09:00", timezone: "Asia/Tokyo", expression: "0 9 * * *", maxRuns: 1, onceAt: "2026-10-11T00:00:00.000Z" }, DEVICE, now), "一次性 · 本地 今天 20:00");
  assert.equal(cadenceText({ cadence: "一次性", timezone: null, expression: null, maxRuns: 1, onceAt: "2026-10-11T12:00:00.000Z" }, DEVICE, now), "一次性 · 明天 08:00");
  assert.equal(cadenceText({ cadence: "每天 09:00", timezone: "Asia/Tokyo", maxRuns: 5 }, DEVICE), "每天 09:00（东京时间）· 共 5 次");
  assert.equal(cadenceText({ cadence: "每天 02:00", timezone: "UTC" }, "Etc/UTC"), "每天 02:00");
  assert.equal(cadenceText({ cadence: "每天 07:00", timezone: DEVICE, maxRuns: null }, DEVICE), "每天 07:00");
});

test("run counts read 第 k/N 次 under a limit", () => {
  assert.equal(runQuota(0, 1), "还没运行");
  assert.equal(runQuota(1, 1), "第 1/1 次");
  assert.equal(runQuota(2, 5), "第 2/5 次");
  assert.equal(runQuota(7, null), "共 7 次");
  assert.equal(runQuota(7, undefined), "共 7 次");
});

test("day words follow the device's calendar, across the end of daylight saving time too", () => {
  const now = Date.parse("2026-10-31T16:00:00.000Z"); // Saturday 12:00 EDT; clocks go back on Sunday
  assert.equal(dayWord(Date.parse("2026-10-31T23:00:00.000Z"), now), "今天");
  assert.equal(dayWord(Date.parse("2026-11-01T17:00:00.000Z"), now), "明天");
  assert.equal(dayWord(Date.parse("2026-10-30T17:00:00.000Z"), now), "昨天");
  assert.equal(dayWord(Date.parse("2026-11-02T17:00:00.000Z"), now), "11月2日");
});

test("search folds width and case, keeps Chinese as substrings, and caps the query", () => {
  assert.equal(searchFold("ＡＢＣ１２３　Ｘ"), "abc123 x");
  assert.equal(normalizeRunQuery("  巡检   ＭＲ  巡检 "), "巡检 mr");
  assert.equal(normalizeRunQuery("   "), "");
  assert.equal(normalizeRunQuery(`https://example.com/${"x".repeat(300)}`).length, 200, "a long word is cut to a prefix, never dropped");
  assert.equal(normalizeRunQuery(Array.from({ length: 12 }, (_, index) => `w${index}`).join(" ")), "w0 w1 w2 w3 w4 w5 w6 w7", "at most 8 words");
  const row: ScheduleRunRow = { id: "r", scheduleId: "s", scheduleName: "订单服务巡检", kind: "new-agent", status: "succeeded", source: "schedule", scheduledFor: null, startedAt: "2026-10-10T10:00:00.000Z",
    endedAt: null, preview: "证书还有 3 天到期", hasOutput: true, error: null, agent: null, workspace: { id: "w", name: null, branch: "Release/ORDERS", archivedAt: null }, projectName: null, link: null };
  assert.equal(filterRuns([row], { ...EMPTY_RUN_FILTER, query: "ｏｒｄｅｒｓ 巡检" }).length, 1);
  assert.equal(filterRuns([row], { ...EMPTY_RUN_FILTER, query: "服务巡" }).length, 1, "Chinese matches inside words");
  assert.equal(filterRuns([row], { ...EMPTY_RUN_FILTER, query: "orders 不在" }).length, 0);
});
