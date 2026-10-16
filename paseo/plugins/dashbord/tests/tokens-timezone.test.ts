import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getTokenLive, getTokens, tokenLiveSchema, tokenResponseSchema, tokenSnapshotSchema, tokenTotal, type TokenSnapshot } from "../shared/tokens";
import { StatsDirectory } from "../server/stats-directory";
import { addCall, emptyData, pruneData, type TokenData } from "../server/tokens/data";
import { buildTokenLive } from "../server/tokens/live";
import { buildTokenSnapshot } from "../server/tokens/snapshot";
import { registerTokens } from "../server/tokens";
import { TokenStore } from "../server/tokens/store";
import { iso, type LedgerCall } from "../server/tokens/types";

// Days and hours follow the device's zone, whatever zone this process runs in. US/Pacific is a permanent link to the US
// Pacific rules (PDT −7, PST −8; 2026-11-01 02:00 PDT → 01:00 PST, 2027-03-14 02:00 PST → 03:00 PDT), America/New_York
// the Eastern ones, Asia/Singapore +8 without daylight saving.
const PACIFIC = "US/Pacific", EASTERN = "America/New_York", PLUS8 = "Asia/Singapore";
const coverage: TokenSnapshot["coverage"] = { earliestAt: null, latestAt: null, backfill: { done: true, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 }, roots: [] };
let serial = 0;
function call(at: string, patch: Partial<LedgerCall> = {}): LedgerCall {
  const end = Date.parse(at);
  return { key: (serial++).toString(16).padStart(16, "0"), source: "claude", sessionId: "my-session", cwd: "/home/me/app", at: end, start: end - 2000,
    model: "example-model", input: 10, cacheWrite: 0, cacheRead: 0, output: 100, reasoning: 0, subagent: false, ...patch };
}
function ledger(now: number, ...ats: string[]): TokenData {
  const data = emptyData();
  for (const at of ats) addCall(data, call(at), null, now);
  return data;
}
const snapshot = (data: TokenData, now: number, utcOffsetMinutes: number, timeZone?: string, range: "7d" | "30d" | "90d" = "7d") =>
  tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range, utcOffsetMinutes, timeZone }, now, new StatsDirectory(), coverage));
const calls = (result: TokenSnapshot) => Object.fromEntries(result.daily.filter(day => day.calls).map(day => [day.day, day.calls]));

test("review reproduction (codex token-dst): 00:30 PDT on Oct 31 stays on Oct 31 when read in November's PST", () => {
  const now = Date.parse("2026-11-03T20:00:00Z"), data = ledger(now, "2026-10-31T07:30:00Z");
  const zoned = snapshot(data, now, -480, PACIFIC);
  assert.equal(zoned.timeZone, PACIFIC); assert.deepEqual(calls(zoned), { "2026-10-31": 1 });
  // Without the zone (an older client, or a zone this server does not know) the fixed offset is all there is.
  const fixed = snapshot(data, now, -480);
  assert.equal(fixed.timeZone, null); assert.deepEqual(calls(fixed), { "2026-10-30": 1 });
});

test("the night daylight saving ends: both 1 o'clocks are Nov 1, and each local midnight holds exactly its own hours", () => {
  const now = Date.parse("2026-11-03T20:00:00Z");
  const data = ledger(now,
    "2026-11-01T06:59:00Z", // Oct 31 23:59 PDT
    "2026-11-01T07:00:00Z", // Nov 1 00:00 PDT
    "2026-11-01T08:30:00Z", // 01:30 PDT
    "2026-11-01T09:30:00Z", // 01:30 PST, the repeated hour
    "2026-11-02T07:59:00Z", // Nov 1 23:59 PST
    "2026-11-02T08:00:00Z", // Nov 2 00:00 PST
  );
  const zoned = snapshot(data, now, -480, PACIFIC), per = tokenTotal(call("2026-11-01T00:00:00Z"));
  assert.deepEqual(calls(zoned), { "2026-10-31": 1, "2026-11-01": 4, "2026-11-02": 1 });
  assert.equal(zoned.hours[1], 2 * per, "01:00 PDT and 01:00 PST are both 1 o'clock"); assert.equal(zoned.hours[0], 2 * per); assert.equal(zoned.hours[23], 2 * per);
  // The fixed PST offset moves every summer hour back by one: midnight PDT lands on the previous day.
  assert.deepEqual(calls(snapshot(data, now, -480)), { "2026-10-31": 2, "2026-11-01": 3, "2026-11-02": 1 });
});

test("the day daylight saving starts: the window opens at 00:00 PST, 2 o'clock does not exist, the next midnight is PDT", () => {
  const now = Date.parse("2027-03-16T20:00:00Z");
  const data = ledger(now,
    "2027-03-14T07:59:00Z", // Mar 13 23:59 PST
    "2027-03-14T08:00:00Z", // Mar 14 00:00 PST
    "2027-03-14T09:30:00Z", // 01:30 PST
    "2027-03-14T10:30:00Z", // 03:30 PDT
    "2027-03-15T06:59:00Z", // Mar 14 23:59 PDT
    "2027-03-15T07:00:00Z", // Mar 15 00:00 PDT
  );
  const zoned = snapshot(data, now, -420, PACIFIC), per = tokenTotal(call("2027-03-14T00:00:00Z"));
  assert.deepEqual(calls(zoned), { "2027-03-13": 1, "2027-03-14": 4, "2027-03-15": 1 });
  assert.equal(zoned.hours[2], 0); assert.equal(zoned.hours[1], per); assert.equal(zoned.hours[3], per);
  assert.deepEqual(calls(snapshot(data, now, -420)), { "2027-03-14": 5, "2027-03-15": 1 }, "the fixed PDT offset pulls 23:59 PST into Mar 14");
});

test("the first day of a range starts at its own local midnight, not the current offset's", () => {
  // In November (PST) a 7-day window opens on Oct 28, a PDT day: its midnight is 07:00 UTC, not 08:00.
  const now = Date.parse("2026-11-03T20:00:00Z"), data = ledger(now, "2026-10-28T06:30:00Z", "2026-10-28T07:00:00Z");
  const zoned = snapshot(data, now, -480, PACIFIC);
  assert.equal(zoned.from, "2026-10-28"); assert.equal(zoned.daily[0]!.calls, 1); assert.equal(zoned.totals.calls, 1); assert.equal(zoned.previous.calls, 1);
  const fixed = snapshot(data, now, -480);
  assert.equal(fixed.totals.calls, 0); assert.equal(fixed.previous.calls, 2, "the fixed offset moves the window's first hour into the previous period");
});

test("today (the hero, 看板's 今日 Token and the live view) starts at local midnight on the day the clocks go back", () => {
  // 10:00 PST on Nov 1; the day began at 00:00 PDT (07:00 UTC), an offset the device no longer has.
  const now = Date.parse("2026-11-01T18:00:00Z"), data = ledger(now, "2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z", "2026-11-01T17:00:00Z");
  assert.equal(snapshot(data, now, -480, PACIFIC).daily.at(-1)!.calls, 2);
  assert.equal(snapshot(data, now, -480).daily.at(-1)!.calls, 1);
  const live = (timeZone?: string) => tokenLiveSchema.parse(buildTokenLive(data, { windowMinutes: 30, utcOffsetMinutes: -480, timeZone, detail: "agents" }, now, new StatsDirectory())).today.calls;
  assert.equal(live(PACIFIC), 2); assert.equal(live(), 1);
});

test("Eastern time and a zone without daylight saving", () => {
  const now = Date.parse("2026-11-02T12:00:00Z"), data = ledger(now, "2026-11-01T04:30:00Z"); // Nov 1 00:30 EDT
  assert.deepEqual(calls(snapshot(data, now, -300, EASTERN)), { "2026-11-01": 1 });
  assert.deepEqual(calls(snapshot(data, now, -300)), { "2026-10-31": 1 });
  const east = Date.parse("2026-09-23T20:00:00Z"), plus8 = ledger(east, "2026-09-23T15:59:00Z", "2026-09-23T16:01:00Z");
  const zoned = snapshot(plus8, east, 480, PLUS8);
  assert.equal(zoned.timeZone, PLUS8); assert.deepEqual(calls(zoned), calls(snapshot(plus8, east, 480))); assert.deepEqual(calls(zoned), { "2026-09-23": 1, "2026-09-24": 1 });
});

test("a zone this server does not know, or one that disagrees with the device's offset now, falls back to the offset", () => {
  const now = Date.parse("2026-11-03T20:00:00Z"), data = ledger(now, "2026-10-31T07:30:00Z");
  for (const [offset, zone] of [[-480, "Mars/Olympus_Mons"], [480, PACIFIC]] as const) {
    const result = snapshot(data, now, offset, zone);
    assert.equal(result.timeZone, null, zone); assert.deepEqual(result, snapshot(data, now, offset));
  }
  assert.equal(getTokens.input.safeParse({ range: "7d", utcOffsetMinutes: 0, timeZone: "../etc" }).success, false);
  assert.equal(getTokens.input.safeParse({ range: "7d", utcOffsetMinutes: -480, timeZone: PACIFIC }).success, true);
  assert.equal(getTokens.input.safeParse({ range: "7d", utcOffsetMinutes: -480 }).success, true, "older clients send no zone");
  assert.equal(getTokenLive.input.safeParse({ windowMinutes: 30, utcOffsetMinutes: -480, timeZone: PACIFIC, detail: "full" }).success, true);
});

test("older than 91 days, a UTC day bucket counts on the local day of its midday", () => {
  // 13:00 PDT on May 8 is 20:00 UTC on May 8: a US working day, kept since as the UTC day May 8. A 90-day range in
  // November starts on Aug 6, so its previous period starts on May 8; the bucket's start (May 7, 17:00 PDT) would miss it.
  const now = Date.parse("2026-11-03T20:00:00Z"), data = ledger(now, "2026-05-08T20:00:00Z", "2026-05-07T20:00:00Z");
  pruneData(data, now);
  assert.equal(data.hours.size, 0); assert.equal(data.days.size, 2);
  const result = snapshot(data, now, -480, PACIFIC, "90d");
  assert.equal(result.from, "2026-08-06"); assert.equal(result.previous.calls, 1, "May 8 is in, May 7 is not"); assert.equal(result.allTime.calls, 2);
});

test("the store's revision follows the applied zone and its local today", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-zone-")), logs = join(root, "logs");
  await mkdir(logs);
  let now = Date.parse("2026-11-02T07:30:00Z"); // Nov 1 23:30 PST
  await writeFile(join(logs, "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: iso(Date.parse("2026-11-01T07:30:00Z")), sessionId: "s", cwd: "/home/me/app", requestId: "r",
    message: { id: "m", model: "example-model", usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } } }) + "\n");
  const store = new TokenStore({ directory: join(root, "data"), roots: [{ source: "claude", path: logs }], now: () => now, poll: false });
  try {
    await store.ready;
    const read = async (timeZone?: string, revision?: string) => tokenResponseSchema.parse(await store.read({ range: "7d", utcOffsetMinutes: -480, timeZone, revision }));
    const pacific = await read(PACIFIC);
    if (pacific.mode !== "full") throw new Error("full expected");
    assert.equal(pacific.timeZone, PACIFIC); assert.equal(pacific.to, "2026-11-01"); assert.equal(pacific.daily.at(-1)!.calls, 1);
    assert.equal((await read(PACIFIC, pacific.revision)).mode, "unchanged");
    // Same offset now, other rules (no daylight saving): another projection, never the cached one.
    const pitcairn = await read("Pacific/Pitcairn", pacific.revision);
    if (pitcairn.mode !== "full") throw new Error("full expected");
    assert.notEqual(pitcairn.revision, pacific.revision); assert.equal(pitcairn.timeZone, "Pacific/Pitcairn"); assert.equal(pitcairn.daily.at(-1)!.calls, 0);
    const fixed = await read(undefined, pacific.revision);
    assert.notEqual(fixed.revision, pacific.revision);
    // Past local midnight the same zone answers in full again.
    now = Date.parse("2026-11-02T08:30:00Z");
    const next = await read(PACIFIC, pacific.revision);
    if (next.mode !== "full") throw new Error("full expected");
    assert.equal(next.to, "2026-11-02");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("the Token RPCs tell the device zone to the plugin and answer in it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-zone-rpc-")), handlers = new Map<string, (input: unknown, context: { paseo: unknown }) => unknown>(), noted: unknown[] = [];
  const server = { handle: (contract: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => unknown) => { handlers.set(contract.name, handler); } } as unknown as Parameters<typeof registerTokens>[0];
  const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, config: { get: async () => { throw new Error("not in this test"); } } };
  const module = registerTokens(server, { directory: new StatsDirectory(), zones: { note: zone => { noted.push(zone); } },
    store: { directory: join(root, "data"), roots: [{ source: "claude", path: join(root, "logs") }], poll: false, now: () => Date.parse("2026-11-03T20:00:00Z") } });
  try {
    const tokens = tokenResponseSchema.parse(await handlers.get(getTokens.name)!(getTokens.input.parse({ range: "7d", utcOffsetMinutes: -480, timeZone: PACIFIC }), { paseo }));
    if (tokens.mode !== "full") throw new Error("full expected");
    assert.equal(tokens.timeZone, PACIFIC); assert.equal(tokens.to, "2026-11-03");
    tokenLiveSchema.parse(await handlers.get(getTokenLive.name)!(getTokenLive.input.parse({ windowMinutes: 30, utcOffsetMinutes: -480, timeZone: PACIFIC, detail: "agents" }), { paseo }));
    assert.deepEqual(noted, [PACIFIC, PACIFIC]);
  } finally { await module.close(); await rm(root, { recursive: true, force: true }); }
});
