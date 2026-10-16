import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addCall, bucketKey, emptyData, pruneData, RECORD_DEPTH, settleCall, type TokenData } from "../server/tokens/data";
import { TokenIngester } from "../server/tokens/ingester";
import { TokenPersistence } from "../server/tokens/persistence";
import { DAY, HOUR, iso, type LedgerCall } from "../server/tokens/types";

const T = Date.parse("2026-09-23T12:00:00Z"), NOW = T + 2 * HOUR;
const call = (key: string, at: number, start: number, output = 200): LedgerCall => ({ key: key.padStart(16, "0"), at, start, output,
  source: "claude", sessionId: "s", cwd: "/repo", model: "claude-opus-4", input: 10, cacheWrite: 0, cacheRead: 0, reasoning: 0, subagent: false });
const line = (row: unknown) => JSON.stringify(row) + "\n";
const response = (id: string, at: number, output = 200) => ({ type: "assistant", timestamp: iso(at), sessionId: "s", cwd: "/repo", requestId: id,
  message: { id, model: "claude-opus-4", usage: { input_tokens: 10, output_tokens: output } } });

test("late blocks recalculate firstAt and coverage from settled and mutable calls", () => {
  const data = emptyData(), a = call("a", T + 60_000, T), b = call("b", T + 120_000, T);
  addCall(data, a, null, NOW); addCall(data, b, null, NOW); settleCall(data, b, NOW);
  addCall(data, { ...a, at: T + 180_000 }, a, NOW);
  assert.equal([...data.hours.values()][0].firstAt, b.at);
  assert.equal([...data.sessionHours.values()][0].firstAt, b.at);
  assert.equal([...data.sessions.values()][0].firstAt, b.at);
  assert.equal(data.earliestAt, b.at); assert.equal(data.latestAt, T + 180_000);
});

test("moving the latest open call to another hour repairs every old bucket's lastAt", () => {
  const data = emptyData(), a = call("a", T + 59 * 60_000, T + 58 * 60_000), b = call("b", T + 58 * 60_000, T + 57 * 60_000);
  addCall(data, b, null, NOW); settleCall(data, b, NOW); addCall(data, a, null, NOW);
  addCall(data, { ...a, at: T + 61 * 60_000 }, a, NOW);
  assert.equal(data.hours.get(bucketKey(T, a.source, a.model))!.lastAt, b.at);
  assert.equal([...data.sessionHours.values()].find(row => row.at === T)!.lastAt, b.at);
  assert.equal([...data.projectHours.values()].find(row => row.at === T)!.lastAt, b.at);
  assert.equal(data.latestAt, T + 61 * 60_000);
});

test("settled records survive more faster mutable calls than the record depth slowing down", () => {
  const data = emptyData(), stable = call("a", T + 10_000, T + 8_000), changing: LedgerCall[] = [];
  addCall(data, stable, null, NOW); settleCall(data, stable, NOW);
  for (let i = 0; i < 33; i++) {
    const row = call((i + 100).toString(16), T + 20_000, T + 19_000); changing.push(row); addCall(data, row, null, NOW);
  }
  for (const row of changing) addCall(data, { ...row, at: T + 23_000 }, row, NOW);
  assert.equal(data.recordHours.get(T)!.fastest[0].tps, 100);
  assert.equal(data.recordHours.get(T)!.fastest[0].key, stable.key);
  assert.equal(Object.values(data.recordHours.get(T)!.speeds).reduce((a, b) => a + b, 0), 34);
});

test("moving more large mutable calls than the record depth preserves the old hour's settled biggest call", () => {
  const data = emptyData(), stable = call("a", T + 50_000, T + 48_000, 150), changing: LedgerCall[] = [];
  addCall(data, stable, null, NOW); settleCall(data, stable, NOW);
  for (let i = 0; i < 33; i++) {
    const row = call((i + 100).toString(16), T + 59 * 60_000, T + 59 * 60_000 - 1000); changing.push(row); addCall(data, row, null, NOW);
  }
  for (const row of changing) addCall(data, { ...row, at: T + 61 * 60_000 }, row, NOW);
  assert.equal(data.recordHours.get(T)!.biggest[0].output, 150);
  assert.equal(data.recordHours.get(T)!.biggest[0].key, stable.key);
});

test("checkpoints keep only the final call mutable and correct it after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-corrections-")), path = join(root, "s.jsonl"), persistence = new TokenPersistence(join(root, "data"));
  let data: TokenData = emptyData();
  const create = () => new TokenIngester({ roots: [{ source: "claude", path: root }], now: () => NOW,
    onCall: (row, previous) => addCall(data, row, previous, NOW), onSettle: row => settleCall(data, row, NOW) });
  let ingester = create();
  try {
    let fixture = line({ type: "user", timestamp: iso(T), sessionId: "s" });
    for (let i = 0; i < 100; i++) fixture += line(response(`r${i}`, T + (i + 1) * 1000));
    await writeFile(path, fixture); await ingester.backfillAll();
    assert.equal(data.mutable.size, 1); assert.equal([...data.hours.values()][0].calls, 100);
    assert.equal(data.recordHours.get(T)!.settledBiggest!.length, RECORD_DEPTH);
    await persistence.write(persistence.serialize(data, ingester, 1)); await ingester.close();
    ingester = create(); data = (await persistence.restore(ingester)).data; await ingester.backfillAll();
    assert.equal(data.mutable.size, 1); assert.equal(ingester.diagnostics.calls, 0);
    await appendFile(path, line(response("r99", T + HOUR + 1000, 400))); await ingester.poll(true);
    assert.equal(data.mutable.size, 1);
    assert.equal(data.hours.get(bucketKey(T, "claude", "claude-opus-4"))!.lastAt, T + 99_000);
    assert.equal(data.hours.get(bucketKey(T, "claude", "claude-opus-4"))!.calls, 99);
    assert.equal(data.latestAt, T + HOUR + 1000);
    assert.equal(data.recordHours.get(T + HOUR)!.biggest[0].output, 400);
    await writeFile(path + ".new", line(response("replacement", NOW))); await rename(path + ".new", path); await ingester.poll(true);
    assert.equal(data.mutable.size, 1);
    await rm(path); await ingester.poll(true); assert.equal(data.mutable.size, 0);
  } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
});

test("an immutable partial line neither rereads bytes nor dirties the checkpoint on repeated polls", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-partial-idle-")), path = join(root, "s.jsonl");
  let changes = 0;
  const ingester = new TokenIngester({ roots: [{ source: "claude", path: root }], now: () => NOW,
    onCall: () => {}, onChange: () => { changes++; } });
  try {
    await writeFile(path, line(response("complete", T)) + line(response("partial", T + 1000)).slice(0, -5));
    await ingester.backfillAll(); changes = 0;
    const bytes = ingester.diagnostics.bytesRead;
    await ingester.poll(true); await ingester.poll(true);
    assert.equal(changes, 0); assert.equal(ingester.diagnostics.bytesRead, bytes);
    await appendFile(path, line(response("partial", T + 1000)).slice(-5)); await ingester.poll(true);
    assert.equal(ingester.diagnostics.calls, 2); assert.ok(changes > 0);
  } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
});

test("an open-call correction crossing retention maintenance subtracts from the rolled-up day", () => {
  const data = emptyData(), initial = call("a", T + 1000, T), now = T + 91 * DAY;
  addCall(data, initial, null, now);
  addCall(data, { ...initial, at: T + 2000, output: 300 }, initial, now + DAY);
  pruneData(data, now + DAY);
  assert.equal(data.hours.size, 0); assert.equal(data.days.size, 1);
  assert.equal([...data.days.values()][0].calls, 1); assert.equal([...data.days.values()][0].output, 300);
  assert.equal(data.earliestAt, T + 2000);
});
