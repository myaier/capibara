import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "../server/paseo-types";
import { CONFIRM_DROP_MS, GAP_MS, historyPoints, maskAccount, quotaAccountKey, quotaErrorKind, quotaForecast, quotaSourceName, QuotaRecorder, registerQuota, RETAIN_MS,
  windowInstances, type QuotaPoint, type QuotaSample } from "../server/quota";
import { getQuota, mergeQuota, QUOTA_FRESH_MS, quotaAccountCurrent, quotaChipSummary, quotaForecastText, quotaResponseSchema, quotaSnapshotSchema, quotaTone, quotaWhen, quotaWindowDuration, quotaWindowLabel,
  quotaWindowReset, tightestQuota, type QuotaSnapshot, type QuotaWindow } from "../shared/quota";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-05T16:00:00.000Z");
const isoAt = (at: number) => new Date(at).toISOString();
interface WindowInput { id: string; used: number | null; resetsAt: number | null; label?: string; summary?: boolean }
interface RowInput { provider?: string; name?: string; status?: "available" | "unavailable" | "error"; plan?: string | null; fetchedAt?: number; windows?: WindowInput[] }
/** A `paseo.providers.listUsage()` reply as 0.11 hosts send it: one fetch time for the list, one row per login. */
function reply(at: number, rows: RowInput[]) {
  return { requestId: "request", fetchedAt: isoAt(at), providers: rows.map(row => ({ providerId: row.provider ?? "claude", displayName: row.name ?? "Claude (alice@example.com)",
    status: row.status ?? "available", planLabel: row.plan === undefined ? "Max" : row.plan, ...(row.fetchedAt ? { fetchedAt: isoAt(row.fetchedAt) } : {}),
    windows: (row.windows ?? []).map(window => ({ id: window.id, label: window.label ?? window.id, ...(window.summary ? { summary: true } : {}), usedPct: window.used,
      remainingPct: window.used === null ? null : 100 - window.used, resetsAt: window.resetsAt === null ? null : isoAt(window.resetsAt) })) })) };
}
const five = (used: number, resetsAt: number): WindowInput => ({ id: "five_hour", label: "Session", summary: true, used, resetsAt });
const weekly = (used: number, resetsAt: number): WindowInput => ({ id: "weekly", label: "Weekly", summary: true, used, resetsAt });
async function recorder(run: (recorder: QuotaRecorder, clock: { now: number }, directory: string, logs: string[]) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "observatory-quota-")), clock = { now: T0 }, logs: string[] = [];
  const instance = new QuotaRecorder({ directory, now: () => clock.now, timers: false, log: message => logs.push(message), readTimeoutMs: 40, pageWaitMs: 40 });
  // The recorder's timers are unref'd (they never hold the daemon's plugin process open); a test holds the loop itself.
  const alive = setInterval(() => {}, 1000);
  try { await instance.loaded; await run(instance, clock, directory, logs); }
  finally { clearInterval(alive); await instance.close(); await rm(directory, { recursive: true, force: true }); }
}
const only = (instance: QuotaRecorder) => { const accounts = [...instance.accounts.values()]; assert.equal(accounts.length, 1); return accounts[0]!; };
const pcts = (samples: readonly QuotaSample[], id = "five_hour") => samples.map(sample => sample.values.get(id)?.pct ?? null);
const view = (instance: QuotaRecorder, at: number) => quotaSnapshotSchema.parse(instance.snapshot(at));
const fakePaseo = (listUsage: () => Promise<unknown>) => ({ providers: { listUsage } }) as unknown as PaseoApi;

test("a reading is stored when it changes, plus a 10-minute heartbeat; older readings are refused", () => recorder(async (instance, clock) => {
  const reset = T0 + 3 * HOUR;
  instance.ingest(reply(T0, [{ windows: [five(10, reset)] }]), T0);
  instance.ingest(reply(T0 + 5 * MIN, [{ windows: [five(10, reset)] }]), T0 + 5 * MIN);
  assert.deepEqual(pcts(only(instance).samples), [10], "an unchanged reading within 10 minutes is not stored");
  instance.ingest(reply(T0 + 10 * MIN, [{ windows: [five(10, reset)] }]), T0 + 10 * MIN);
  assert.deepEqual(pcts(only(instance).samples), [10, 10], "the heartbeat stores it after 10 minutes");
  instance.ingest(reply(T0 + 12 * MIN, [{ windows: [five(12.04, reset)] }]), T0 + 12 * MIN);
  assert.deepEqual(pcts(only(instance).samples), [10, 10, 12], "a change is stored at once (values to 0.1)");
  // A host's cached list can carry an older fetch time than what is held: it adds nothing.
  instance.ingest(reply(T0 + 11 * MIN, [{ windows: [five(30, reset)] }]), T0 + 14 * MIN);
  assert.deepEqual(pcts(only(instance).samples), [10, 10, 12]);
  // A new window or a vanished one is a change too.
  // (A row's own fetch time, when a host sends one, wins over the list's oldest one.)
  instance.ingest(reply(T0 + 11 * MIN, [{ fetchedAt: T0 + 13 * MIN, windows: [five(12, reset), weekly(40, T0 + 3 * DAY)] }]), T0 + 14 * MIN);
  assert.equal(only(instance).samples.length, 4);
  assert.deepEqual(only(instance).order, ["five_hour", "weekly"]);
  clock.now = T0 + 14 * MIN;
  assert.equal(view(instance, clock.now).accounts[0]!.readingAt, isoAt(T0 + 13 * MIN));
}));

test("a lower reading within one window is refused until it has held for 30 minutes; reset jitter is one window", () => recorder(async instance => {
  const reset = T0 + 4 * HOUR;
  instance.ingest(reply(T0, [{ windows: [five(50, reset)] }]), T0);
  // Recomputed reset 30 s later, value lower: a stale cache, refused (the held 50 % and reset stay).
  instance.ingest(reply(T0 + 10 * MIN, [{ windows: [five(40, reset + 30_000)] }]), T0 + 10 * MIN);
  instance.ingest(reply(T0 + 20 * MIN, [{ windows: [five(40, reset - 45_000)] }]), T0 + 20 * MIN);
  assert.deepEqual(pcts(only(instance).samples), [50, 50, 50]);
  assert.ok(only(instance).samples.every(sample => sample.values.get("five_hour")!.resetsAt === reset), "jitter within ±2 minutes keeps the held reset instant");
  instance.ingest(reply(T0 + 10 * MIN + CONFIRM_DROP_MS, [{ windows: [five(40, reset)] }]), T0 + 10 * MIN + CONFIRM_DROP_MS);
  assert.deepEqual(pcts(only(instance).samples), [50, 50, 50, 40], "after 30 minutes the provider's correction is taken");
  // Other windows of the same reading are not held back by one refused window.
  instance.ingest(reply(T0 + 50 * MIN, [{ windows: [five(30, reset), weekly(20, T0 + 2 * DAY)] }]), T0 + 50 * MIN);
  assert.equal(only(instance).samples.at(-1)!.values.get("five_hour")!.pct, 40);
  assert.equal(only(instance).samples.at(-1)!.values.get("weekly")!.pct, 20);
}));

test("only a later reset starts a new window instance; a reading after the reset belongs to the next one", () => {
  const sample = (at: number, pct: number, resetsAt: number | null): QuotaSample => ({ at, values: new Map([["five_hour", { pct, resetsAt }]]) });
  const reset = T0 + HOUR;
  const instances = windowInstances([
    sample(T0, 80, reset), sample(T0 + 10 * MIN, 82, reset - 5 * MIN), // an earlier reset is a revision of the same window
    sample(T0 + 20 * MIN, 85, reset - 5 * MIN + 90_000),
    sample(reset - 5 * MIN + 90_000 + MIN, 85, reset - 5 * MIN + 90_000), // after the reset but still the same instant: a late copy of that window
    sample(reset + 2 * MIN, 0, null), // after the reset, before the next window starts
    sample(reset + 30 * MIN, 3, reset + 5 * HOUR), sample(reset + 40 * MIN, 4, reset + 5 * HOUR + 60_000),
  ], "five_hour");
  assert.deepEqual(instances.map(instance => instance.points.map(point => point.pct)), [[80, 82, 85, 85], [0], [3, 4]]);
  assert.equal(instances[0]!.resetsAt, reset - 5 * MIN + 90_000);
});

test("gaps: over 15 minutes without a reading breaks the line; reads that changed nothing do not", () => recorder(async instance => {
  const reset = T0 + 4 * HOUR;
  for (const [minute, used] of [[0, 10], [3, 11], [10, 11], [20, 11]] as const) instance.ingest(reply(T0 + minute * MIN, [{ windows: [five(used, reset)] }]), T0 + minute * MIN);
  const times = only(instance).samples.map(sample => (sample.at - T0) / MIN);
  assert.deepEqual(times, [0, 3, 10, 20], "the unstored read at minute 10 is stored when the heartbeat at 20 would otherwise leave a 17-minute hole");
  instance.ingest(reply(T0 + 60 * MIN, [{ windows: [five(14, reset)] }]), T0 + 60 * MIN);
  const window = view(instance, T0 + 60 * MIN).accounts[0]!.windows[0]!;
  assert.deepEqual(window.history.map(point => point[2]), [false, false, false, false, true], "nothing was read for 40 minutes before the last point");
  assert.equal(GAP_MS, 15 * MIN);
  // The mini chart keeps at most 36 points and the gap marks of what it folds.
  const points: QuotaPoint[] = Array.from({ length: 300 }, (_, index) => ({ at: T0 + index * 5 * MIN + (index >= 150 ? HOUR : 0), pct: index / 3, resetsAt: null }));
  const folded = historyPoints(points, [T0, T0 + 26 * HOUR]);
  assert.ok(folded.length <= 36); assert.equal(folded.at(-1)![0], points.at(-1)!.at);
  assert.equal(folded.filter(point => point[2]).length, 1);
}));

test("5-hour windows: the rate over the last 30 minutes says when they run out, only before the reset", () => {
  const reset = T0 + 3 * HOUR, points = (values: number[], step = 10 * MIN): QuotaPoint[] => values.map((pct, index) => ({ at: T0 + index * step, pct, resetsAt: reset }));
  // 45 % → 60 % over the last 30 minutes = 30 points an hour; 40 points left take 80 minutes.
  assert.deepEqual(quotaForecast(points([40, 45, 50, 55, 60]), reset, 5 * HOUR, T0 + 40 * MIN), { kind: "exhaust", at: isoAt(T0 + 40 * MIN + 80 * MIN), method: "rate" });
  // Slower: it would run out after the reset, so it says where it ends instead.
  assert.deepEqual(quotaForecast(points([40, 41, 42, 43]), reset, 5 * HOUR, T0 + 30 * MIN), { kind: "projected", pct: 43 + 6 * 2.5, method: "rate" });
  // Change-only samples: a single reading long before the cutoff still anchors a flat rate.
  assert.deepEqual(quotaForecast([{ at: T0, pct: 20, resetsAt: reset }, { at: T0 + 50 * MIN, pct: 20, resetsAt: reset }], reset, 5 * HOUR, T0 + 50 * MIN), { kind: "idle" });
  assert.equal(quotaForecast(points([40, 45, 50]), reset, 5 * HOUR, T0 + 20 * MIN), null, "under 30 minutes of history: no rate yet");
  assert.equal(quotaForecast(points([40, 45, 50, 55, 60]).map(point => ({ ...point, resetsAt: null })), null, 5 * HOUR, T0 + 40 * MIN), null, "without a reset time nothing is said");
  assert.deepEqual(quotaForecast(points([90, 100]), reset, 5 * HOUR, T0 + 10 * MIN), { kind: "exhausted" });
  // A window of unknown length gets a rate only when its reset is near.
  assert.equal(quotaForecast(points([40, 45, 50, 55, 60]), T0 + 30 * HOUR, null, T0 + 40 * MIN), null);
  assert.equal(quotaForecast(points([40, 45, 50, 55, 60]), reset, null, T0 + 40 * MIN)?.kind, "exhaust");
});

test("weekly windows extrapolate this week's average pace, not before a tenth of it has passed", () => {
  const week = 7 * DAY, reset = T0 + 3.5 * DAY, at = (pct: number, time = T0): QuotaPoint[] => [{ at: time, pct, resetsAt: reset }];
  assert.deepEqual(quotaForecast(at(39), reset, week, T0), { kind: "projected", pct: 78, method: "pace" }, "39 % at half time ends near 78 %");
  const start = reset - week;
  assert.deepEqual(quotaForecast(at(60), reset, week, T0), { kind: "exhaust", at: isoAt(Math.round(start + 3.5 * DAY * 100 / 60)), method: "pace" });
  assert.equal(quotaForecast(at(5, start + 0.09 * week), reset, week, start + 0.09 * week), null, "under 10 % of the week elapsed");
  assert.equal(quotaWindowDuration("weekly_model_opus"), week); assert.equal(quotaWindowDuration("code_review:weekly"), week);
});

test("the page view: pace marker, tones, alarms, and windows past their reset", () => recorder(async instance => {
  const reset = T0 + 2 * HOUR, weekReset = T0 + 3.5 * DAY;
  for (const [minute, used] of [[0, 40], [10, 50], [20, 60], [30, 70], [40, 80]] as const)
    instance.ingest(reply(T0 + minute * MIN, [{ windows: [five(used, reset), weekly(20, weekReset), { id: "weekly_model_opus", label: "Weekly · Opus", used: 92, resetsAt: weekReset }] }]), T0 + minute * MIN);
  const now = T0 + 40 * MIN, account = view(instance, now).accounts[0]!;
  assert.equal(account.name, "Claude"); assert.equal(account.hint, null); assert.equal(account.plan, "Max"); assert.equal(account.stale, false);
  const [short, week, opus] = account.windows;
  assert.equal(short!.label, "5 小时"); assert.equal(short!.tone, "warning"); assert.equal(short!.durationMs, 5 * HOUR);
  // 3 h 40 min of the 5-hour window have passed: even use would be at 73.3 %; 80 % is ahead of it.
  assert.equal(short!.pace, 0.733); assert.equal(short!.ahead, true);
  assert.equal(short!.forecast?.kind, "exhaust"); assert.equal(short!.alarm, true);
  assert.deepEqual(short!.span, [reset - 5 * HOUR, reset]);
  assert.equal(week!.label, "每周"); assert.equal(week!.tone, "ok"); assert.equal(week!.ahead, false); // 20 % with 3.5 days and 40 minutes of the week gone: about 39.7 % at the reset.
  assert.deepEqual(week!.forecast, { kind: "projected", pct: Math.round(20 / ((3.5 * DAY + 40 * MIN) / (7 * DAY)) * 10) / 10, method: "pace" });
  assert.equal(opus!.label, "每周 · Opus"); assert.equal(opus!.tone, "danger"); assert.equal(opus!.summary, false);
  assert.deepEqual(tightestQuota(view(instance, now), now)?.window.id, "five_hour", "the alarm wins over a fuller weekly window");
  // Past the reset with no newer reading: 已重置.
  const later = view(instance, reset + MIN).accounts[0]!.windows[0]!;
  assert.equal(later.state, "reset"); assert.equal(later.tone, "neutral"); assert.equal(later.forecast, null); assert.equal(later.pace, null); assert.equal(later.alarm, false);
  assert.equal(quotaWindowReset(later, reset + MIN), true);
  assert.equal(tightestQuota(view(instance, reset + MIN), reset + MIN)?.window.id, "weekly_model_opus");
}));

test("failed reads keep the last values with their time; the host's 'Update the host' means a lost session", () => recorder(async (instance, clock, _directory, logs) => {
  instance.ingest(reply(T0, [{ windows: [five(30, T0 + 3 * HOUR)] }]), T0);
  clock.now = T0 + 20 * MIN;
  await instance.sample(fakePaseo(async () => { throw new Error("Update the host to list provider usage. (alice@example.com)"); }));
  let snapshot = view(instance, clock.now);
  assert.deepEqual(snapshot.error, { kind: "disconnected", at: isoAt(T0 + 20 * MIN) });
  assert.equal(snapshot.accounts[0]!.windows[0]!.usedPct, 30); assert.equal(snapshot.accounts[0]!.stale, true); assert.equal(snapshot.accounts[0]!.readingAt, isoAt(T0));
  assert.ok(logs.every(line => !line.includes("alice") && !line.includes("Update")), "only the kind is logged");
  await instance.sample(fakePaseo(() => new Promise(() => {})));
  assert.equal(instance.error?.kind, "timeout");
  await instance.sample({} as PaseoApi);
  assert.equal(instance.error?.kind, "unsupported");
  // One account failing keeps its values; the read itself succeeded.
  instance.ingest(reply(T0 + 30 * MIN, [{ status: "error", windows: [] }]), T0 + 30 * MIN);
  snapshot = view(instance, T0 + 30 * MIN);
  assert.equal(snapshot.error, null); assert.equal(snapshot.accounts[0]!.status, "error"); assert.equal(snapshot.accounts[0]!.stale, true);
  assert.equal(snapshot.accounts[0]!.windows[0]!.usedPct, 30);
  for (const [message, kind] of [["Connection lost", "disconnected"], ["client disposed", "disconnected"], ["Usage fetch timed out", "timeout"], ["boom", "failed"]] as const) assert.equal(quotaErrorKind(new Error(message)), kind);
}));

test("malformed rows and windows drop only themselves", () => recorder(async instance => {
  const good = reply(T0, [{ windows: [five(10, T0 + HOUR), { id: "", used: 3, resetsAt: null }] }]);
  const windows = good.providers[0]!.windows as unknown[];
  windows.push({ id: "weekly", usedPct: "high" }, { id: "weekly", label: "Weekly", usedPct: 7, resetsAt: "not a time" });
  instance.ingest({ ...good, providers: [...good.providers, { providerId: 5 }, null, { providerId: "codex", displayName: "Codex", status: "available", planLabel: null, windows: [{ id: "five_hour", usedPct: 1 }] }] }, T0);
  const snapshot = view(instance, T0);
  assert.deepEqual(snapshot.accounts.map(account => account.provider), ["claude", "codex"]);
  assert.deepEqual(snapshot.accounts[0]!.windows.map(window => [window.id, window.usedPct, window.resetsAt]), [["five_hour", 10, isoAt(T0 + HOUR)], ["weekly", 7, null]]);
  instance.ingest({ providers: "nope" }, T0 + MIN);
  assert.equal(instance.error?.kind, "failed");
}));

test("account keys and the history file never hold the account name; several accounts of one source are told apart", () => recorder(async (instance, clock, directory) => {
  const key = quotaAccountKey("claude", "Claude (alice@example.com)");
  assert.match(key, /^claude:[0-9a-f]{32}$/); assert.ok(!key.includes("alice"));
  assert.equal(maskAccount("Claude (alice@example.com)"), "a***@e***"); assert.equal(maskAccount("Claude (work)"), "w***"); assert.equal(maskAccount("Codex"), null);
  assert.equal(quotaSourceName("Claude (alice@example.com)", "claude"), "Claude"); assert.equal(quotaSourceName("bob@example.com", "relay"), "relay");
  assert.equal(quotaSourceName("weird/../path", "codex"), "Codex");
  instance.ingest(reply(T0, [{ windows: [five(10, T0 + HOUR)] }, { name: "Claude (bob@example.org)", plan: "Pro", windows: [five(20, T0 + 2 * HOUR)] }, { provider: "codex", name: "Codex", plan: "plus", windows: [weekly(5, T0 + 2 * DAY)] }]), T0);
  const names = view(instance, T0).accounts.map(account => [account.name, account.hint, account.plan]);
  assert.deepEqual(names, [["Claude 账号 1", "a***@e***", "Max"], ["Claude 账号 2", "b***@e***", "Pro"], ["Codex", null, "plus"]]);
  await instance.flush();
  const text = await readFile(join(directory, "quota-history.json"), "utf8");
  for (const secret of ["alice", "bob", "example", "a***"]) assert.ok(!text.includes(secret), secret);
  clock.now = T0 + MIN;
}));

test("history is written atomically (0600) and read back; 40 days, account caps and corrupt files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-quota-store-"));
  let now = T0;
  const make = () => new QuotaRecorder({ directory, now: () => now, timers: false, log: () => {} });
  try {
    let instance = make(); await instance.loaded;
    instance.ingest(reply(T0 - 41 * DAY, [{ windows: [weekly(5, T0 - 38 * DAY)] }]), T0 - 41 * DAY);
    for (let minute = 0; minute <= 60; minute += 10) instance.ingest(reply(T0 + minute * MIN, [{ windows: [five(10 + minute / 2, T0 + 4 * HOUR), weekly(30, T0 + 3 * DAY)] }]), T0 + minute * MIN);
    now = T0 + 60 * MIN;
    const before = view(instance, now);
    await instance.close();
    const file = join(directory, "quota-history.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), []);
    instance = make(); await instance.loaded;
    assert.deepEqual(view(instance, now).accounts, before.accounts, "the reloaded history projects the same view");
    assert.ok(only(instance).samples.every(sample => sample.at >= now - RETAIN_MS), "readings older than 40 days are dropped");
    // At most 16 accounts survive a write: the most recently seen.
    for (let index = 0; index < 20; index++) instance.ingest(reply(now, [{ provider: "relay", name: `Relay (${index})`, windows: [five(index, now + HOUR)] }]), now + index);
    await instance.flush(); await instance.close();
    instance = make(); await instance.loaded;
    assert.equal(instance.accounts.size, 16);
    await instance.close();
    await writeFile(file, "{ not json");
    instance = make(); await instance.loaded;
    assert.equal(instance.accounts.size, 0);
    assert.deepEqual((await readdir(directory)).filter(name => name.includes(".corrupt")), ["quota-history.corrupt.json"], "a corrupt file is set aside, not overwritten");
    instance.ingest(reply(now, [{ windows: [five(1, now + HOUR)] }]), now);
    await instance.close();
    assert.equal(JSON.parse(await readFile(file, "utf8")).accounts.length, 1);
    // Damaged again: the newer copy replaces the older one, so backups never pile up.
    await writeFile(file, "{ broken again");
    now += MIN; instance = make(); await instance.loaded; await instance.close();
    assert.deepEqual((await readdir(directory)).filter(name => name.includes(".corrupt")), ["quota-history.corrupt.json"]);
    assert.equal(await readFile(join(directory, "quota-history.corrupt.json"), "utf8"), "{ broken again");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pages read at most every 5 minutes, wait briefly, and get revisioned replies", () => recorder(async (instance, clock) => {
  let calls = 0, release: (() => void) | null = null;
  const paseo = fakePaseo(async () => { calls++; return reply(clock.now, [{ windows: [five(10 + calls, clock.now + HOUR)] }]); });
  const first = quotaResponseSchema.parse(await instance.request(paseo));
  assert.equal(first.mode, "full"); assert.equal(calls, 1);
  if (first.mode !== "full") throw new Error("full expected");
  assert.equal(first.accounts[0]!.windows[0]!.usedPct, 11);
  assert.deepEqual(await instance.request(paseo, first.revision), { mode: "unchanged", unchanged: true, revision: first.revision });
  assert.equal(calls, 1, "within 5 minutes the daemon's cache would answer anyway");
  clock.now += 5 * MIN;
  const second = await instance.request(paseo, first.revision);
  assert.equal(calls, 2); assert.equal(second.mode, "full");
  assert.equal(mergeQuota(mergeQuota(undefined, first), second).accounts[0]!.windows[0]!.usedPct, 12);
  // A slow host: the page gets what is held, marked refreshing, and asks again.
  clock.now += 5 * MIN;
  const slow = fakePaseo(() => new Promise(resolve => { release = () => resolve(reply(clock.now, [{ windows: [five(40, clock.now + HOUR)] }])); }));
  const waiting = await instance.request(slow);
  assert.equal(waiting.mode === "full" && waiting.refreshing, true);
  release!(); await instance.sample();
  const done = await instance.request(slow);
  assert.equal(done.mode === "full" && done.refreshing, false);
  assert.equal(done.mode === "full" && done.accounts[0]!.windows[0]!.usedPct, 40);
}));

test("registerQuota answers the RPC and registers no agent hooks (opus-F41)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-quota-register-"));
  const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => unknown>(), hooks = new Map<string, Array<(event: unknown, context: { paseo: PaseoApi }) => void>>();
  let calls = 0;
  const server = { handle: (contract: { name: string }, handler: never) => { handlers.set(contract.name, handler); },
    on: (name: string, handler: never) => { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; } };
  const paseo = fakePaseo(async () => { calls++; return reply(Date.now(), [{ windows: [five(10, Date.now() + HOUR)] }]); });
  const remove = registerQuota(server as never, { directory, timers: false, log: () => {} });
  try {
    // Heartbeats, schedules and background Agents fire lifecycle hooks all day; none of them may start a vendor read.
    assert.deepEqual([...hooks.keys()], []);
    const result = quotaResponseSchema.parse(await handlers.get(getQuota.name)!({}, { paseo }));
    assert.equal(result.mode, "full"); assert.equal(calls, 1);
  } finally { await remove(); await rm(directory, { recursive: true, force: true }); }
});

test("the sampler runs only while pages read: never before, every 10 minutes after, stopping 30 minutes after the last read (opus-F41)", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-quota-watch-"));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  let calls = 0;
  const paseo = fakePaseo(async () => { calls++; return reply(Date.now(), [{ windows: [weekly(10 + calls, T0 + 3 * DAY)] }]); });
  const instance = new QuotaRecorder({ directory, now: () => Date.now(), timers: true, log: () => {}, readTimeoutMs: 40, pageWaitMs: 40 });
  // Timer callbacks finish on promises: let them settle after each minute of mocked time.
  const advance = async (ms: number) => { for (let left = ms; left > 0; left -= MIN) { t.mock.timers.tick(Math.min(MIN, left)); for (let turn = 0; turn < 3; turn++) await new Promise(resolve => setImmediate(resolve)); } };
  try {
    await instance.loaded;
    // A daemon handle alone (as the old agent hooks gave it) starts nothing, however long the Agents keep working.
    instance.attach(paseo);
    await advance(3 * HOUR);
    assert.equal(calls, 0, "no read before a page asks");
    // A page read: read at once, then every 10 minutes while it is within 30 minutes of that read.
    await instance.request(paseo);
    assert.equal(calls, 1);
    await advance(10 * MIN); assert.equal(calls, 2);
    await advance(10 * MIN); assert.equal(calls, 3);
    assert.equal(instance.watched(), true);
    await advance(10 * MIN);
    assert.equal(instance.watched(), false); assert.equal(calls, 3, "30 minutes after the last read the sampler stops");
    await advance(4 * HOUR);
    assert.equal(calls, 3, "and stays stopped while nobody looks");
    // Back on the page: a fresh read at once (the chart shows the pause as a gap), and sampling again.
    const back = quotaResponseSchema.parse(await instance.request(paseo));
    assert.equal(calls, 4);
    assert.equal(back.mode === "full" && back.accounts[0]!.windows[0]!.history.at(-1)![2], true, "the pause is drawn as a gap");
    await advance(10 * MIN); assert.equal(calls, 5);
    // Reads every 5 minutes (a page left open) keep it going past 30 minutes from the first one.
    for (let step = 0; step < 6; step++) { await advance(5 * MIN); await instance.request(paseo); }
    assert.equal(instance.watched(), true);
  } finally { await instance.close(); t.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
});

test("codex-F8: a failed account's old exhaustion forecast is no current alarm, and the chip names the reading", () => recorder(async (instance, clock) => {
  const reset = T0 + 3 * HOUR;
  // 40 % at the first reading, 80 % half an hour later (forecast to run out 15 minutes after that), then the account fails.
  instance.ingest(reply(T0, [{ windows: [five(40, reset)] }]), T0);
  instance.ingest(reply(T0 + 30 * MIN, [{ windows: [five(80, reset)] }]), T0 + 30 * MIN);
  instance.ingest(reply(T0 + HOUR, [{ status: "error", windows: [] }]), T0 + HOUR);
  clock.now = T0 + HOUR;
  const snapshot = view(instance, clock.now), account = snapshot.accounts[0]!, window = account.windows[0]!;
  assert.equal(account.status, "error"); assert.equal(account.stale, true); assert.equal(account.readingAt, isoAt(T0 + 30 * MIN));
  assert.deepEqual(window.forecast, { kind: "exhaust", at: isoAt(T0 + 45 * MIN), method: "rate" });
  assert.equal(quotaAccountCurrent(account, clock.now), false);
  const pick = tightestQuota(snapshot, clock.now)!;
  assert.equal(pick.stale, true, "only an older reading is left");
  const chip = quotaChipSummary(pick, snapshot.accounts.length, clock.now);
  assert.equal(chip.alarm, false, "no pulsing alarm from an old forecast");
  assert.deepEqual(chip.tail, { text: `读数 ${quotaWhen(T0 + 30 * MIN, clock.now)}`, kind: "stale" });
  assert.equal(chip.tone, "warning", "80 % drops to amber, not red"); assert.equal(chip.value, "80%");
  assert.match(chip.accessibilityLabel, /不是当前读数/);
  // The card's forecast says which reading it came from, and is a warning rather than an alarm.
  const line = quotaForecastText(window, clock.now, { at: T0 + 30 * MIN, current: false })!;
  assert.equal(line.kind, "warning"); assert.equal(line.text, `据 ${quotaWhen(T0 + 30 * MIN, clock.now)} 的读数，按当前速度推算可能已经用完`);
  // While the reading was current the same window was the alarm.
  const before = view(instance, T0 + 31 * MIN);
  const currentPick = tightestQuota({ accounts: [{ ...before.accounts[0]!, status: "available", stale: false }] }, T0 + 31 * MIN)!;
  assert.equal(currentPick.stale, false); assert.equal(quotaChipSummary(currentPick, 1, T0 + 31 * MIN).alarm, true);
  assert.deepEqual(quotaChipSummary(currentPick, 1, T0 + 31 * MIN).tail, { text: `${quotaWhen(T0 + 45 * MIN, T0 + 31 * MIN)} 用完`, kind: "alarm" });
}));

test("codex-F8: unavailable, timed-out and over-15-minute readings are stale; a current account wins over an older alarm", () => recorder(async (instance, clock) => {
  const reset = T0 + 3 * HOUR;
  for (const [minute, used] of [[0, 50], [30, 95]] as const) instance.ingest(reply(T0 + minute * MIN, [{ windows: [five(used, reset)] }, { provider: "codex", name: "Codex", plan: "plus", windows: [weekly(20, T0 + 3 * DAY)] }]), T0 + minute * MIN);
  clock.now = T0 + 30 * MIN;
  let snapshot = view(instance, clock.now);
  assert.equal(tightestQuota(snapshot, clock.now)?.window.id, "five_hour"); assert.equal(tightestQuota(snapshot, clock.now)?.stale, false);
  // The cached answer is read again 16 minutes later (the app slept): nothing in it is current any more.
  const later = clock.now + 16 * MIN;
  assert.ok(snapshot.accounts.every(account => !quotaAccountCurrent(account, later)));
  assert.equal(tightestQuota(snapshot, later)?.stale, true); assert.equal(quotaChipSummary(tightestQuota(snapshot, later)!, 2, later).alarm, false);
  assert.equal(view(instance, later).accounts[0]!.stale, true, "the server marks it stale after 15 minutes too");
  // Claude unavailable (its 95 % reading forecast to run out), Codex current at 20 %: the chip shows Codex, calm.
  clock.now = T0 + 40 * MIN;
  instance.ingest(reply(clock.now, [{ status: "unavailable", windows: [] }, { provider: "codex", name: "Codex", plan: "plus", windows: [weekly(20, T0 + 3 * DAY)] }]), clock.now);
  snapshot = view(instance, clock.now);
  assert.deepEqual(snapshot.accounts.map(account => [account.provider, account.status, account.stale]), [["claude", "unavailable", true], ["codex", "available", false]]);
  const pick = tightestQuota(snapshot, clock.now)!;
  assert.equal(pick.account.provider, "codex"); assert.equal(pick.stale, false); assert.equal(quotaChipSummary(pick, 2, clock.now).alarm, false);
  // A read that times out marks every account stale: only older readings are left, ranked by tone (95 % first), no alarm.
  clock.now = T0 + 45 * MIN;
  await instance.sample(fakePaseo(() => new Promise(() => {})));
  snapshot = view(instance, clock.now);
  assert.equal(snapshot.error?.kind, "timeout"); assert.ok(snapshot.accounts.every(account => account.stale));
  const stale = tightestQuota(snapshot, clock.now)!;
  assert.equal(stale.stale, true); assert.equal(stale.account.provider, "claude"); assert.equal(stale.window.id, "five_hour");
  const chip = quotaChipSummary(stale, 2, clock.now);
  assert.equal(chip.alarm, false); assert.equal(chip.tone, "warning"); assert.equal(chip.tail?.kind, "stale");
  // A stale account without a reading time says so plainly.
  assert.deepEqual(quotaChipSummary({ ...stale, account: { ...stale.account, readingAt: null } }, 1, clock.now).tail, { text: "读数已过期", kind: "stale" });
}));

test("window names, durations, tones and the chip's tightest window", () => {
  assert.equal(quotaWindowLabel("five_hour", "Session"), "5 小时"); assert.equal(quotaWindowLabel("weekly", "Weekly"), "每周");
  assert.equal(quotaWindowLabel("weekly_model_opus", "Weekly · Opus"), "每周 · Opus"); assert.equal(quotaWindowLabel("weekly_model_fable", "Weekly"), "每周 · fable");
  assert.equal(quotaWindowLabel("code_review:five_hour", "Code review · 5-hour"), "Code review · 5 小时"); assert.equal(quotaWindowLabel("86400s", "1-day"), "1 天");
  assert.equal(quotaWindowLabel("unknown_primary", "Primary limit"), "主要额度"); assert.equal(quotaWindowLabel("plan_usage", "Plan usage"), "Plan usage");
  assert.equal(quotaWindowDuration("five_hour"), 5 * HOUR); assert.equal(quotaWindowDuration("limit:gpt%3Acodex:five_hour"), 5 * HOUR);
  assert.equal(quotaWindowDuration("3600s"), HOUR); assert.equal(quotaWindowDuration("unknown_primary"), null); assert.equal(quotaWindowDuration("monthly"), null);
  assert.deepEqual([null, 0, 69.9, 70, 90, 90.1].map(quotaTone), ["neutral", "ok", "ok", "warning", "warning", "danger"]);
  const window = (patch: Partial<QuotaWindow>): QuotaWindow => ({ id: "w", label: "w", summary: true, usedPct: 10, resetsAt: isoAt(T0 + HOUR), durationMs: 5 * HOUR, pace: 0.5, ahead: false,
    state: "live", forecast: null, tone: "ok", alarm: false, history: [], span: [T0, T0 + HOUR], ...patch });
  const snapshot = (windows: QuotaWindow[]): Pick<QuotaSnapshot, "accounts"> => ({ accounts: [{ key: "k", provider: "claude", name: "Claude", hint: null, plan: null, status: "available", readingAt: isoAt(T0 - 2 * MIN), stale: false, windows }] });
  assert.equal(QUOTA_FRESH_MS, 15 * MIN);
  assert.equal(tightestQuota(snapshot([]), T0), null);
  assert.equal(tightestQuota(snapshot([window({ id: "five", usedPct: 20 })]), T0)?.stale, false);
  assert.equal(tightestQuota(snapshot([window({ id: "week", durationMs: 7 * DAY, usedPct: 50 }), window({ id: "five", usedPct: 20 })]), T0)?.window.id, "five", "same tone: the shorter window");
  assert.equal(tightestQuota(snapshot([window({ id: "week", durationMs: 7 * DAY, usedPct: 75, tone: "warning" }), window({ id: "five", usedPct: 20 })]), T0)?.window.id, "week", "a warning beats a calm short window");
  assert.equal(tightestQuota(snapshot([window({ id: "five", usedPct: 20, resetsAt: isoAt(T0 - 1) })]), T0), null, "past its reset: no chip");
});
