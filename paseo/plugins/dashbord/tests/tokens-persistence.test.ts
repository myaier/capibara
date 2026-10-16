import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addCall, emptyData, pruneData } from "../server/tokens/data";
import { TokenStore } from "../server/tokens/store";
import { DAY, iso, type LedgerCall } from "../server/tokens/types";
import { tokenResponseSchema, tokenTotal, tokenTruncationNotice } from "../shared/tokens";

const NOW = Date.parse("2026-09-23T12:00:00Z"), input = { range: "7d", utcOffsetMinutes: 0 } as const;
const line = (row: unknown) => JSON.stringify(row) + "\n";
const fixtureCall = (at = NOW): LedgerCall => ({ key: "0123456789abcdef", source: "claude", sessionId: "session", cwd: "/repo/demo", at,
  start: at - 10_000, model: "claude-opus-4", input: 10, cacheWrite: 20, cacheRead: 30, output: 200, reasoning: 0, subagent: false });
const response = (at = NOW) => ({ type: "assistant", timestamp: iso(at), sessionId: "session", cwd: "/repo/demo", requestId: "r", message: {
  id: "m", model: "claude-opus-4", content: "PRIVATE_OUTPUT", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 200 } } });

test("atomic round trip restores offsets, dedupe, records and unchanged replies without saving content", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-persist-")), logs = join(root, "logs"), directory = join(root, "data");
  await mkdir(logs);
  const file = join(logs, "session.jsonl");
  await writeFile(file, line({ type: "user", timestamp: iso(NOW - 10_000), message: { content: "PRIVATE_PROMPT" } }) + line(response()) + '{"type":"user","content":"PRIVATE_PARTIAL');
  const options = { directory, roots: [{ source: "claude" as const, path: logs }], now: () => NOW, poll: false };
  let store = new TokenStore(options);
  try {
    await store.ready;
    const first = tokenResponseSchema.parse(await store.read(input)); assert.equal(first.mode, "full");
    if (first.mode !== "full") throw new Error("full expected");
    assert.equal(first.totals.calls, 1); assert.equal(tokenTotal(first.totals), 260);
    assert.deepEqual(await store.read({ ...input, revision: first.revision }), { mode: "unchanged", unchanged: true, revision: first.revision });
    await store.flush();
    const text = await readFile(join(directory, "tokens.json"), "utf8");
    for (const secret of ["PRIVATE_OUTPUT", "PRIVATE_PROMPT", "PRIVATE_PARTIAL"]) assert.ok(!text.includes(secret));
    const saved = JSON.parse(text); assert.equal(saved.files[0].partialBytes, 41); assert.equal(saved.sessionDays.length, 1);
    const before = (await stat(join(directory, "tokens.json"))).mtimeMs;
    await store.flush(); assert.equal((await stat(join(directory, "tokens.json"))).mtimeMs, before);
    await store.close(); store = new TokenStore(options); await store.ready;
    assert.equal(store.ingester.diagnostics.calls, 0);
    const restored = await store.read(input); assert.equal(restored.mode, "full");
    if (restored.mode !== "full") throw new Error("full expected");
    assert.deepEqual(restored.totals, first.totals); assert.deepEqual(restored.records, first.records);
    assert.equal((await store.read({ ...input, revision: restored.revision })).unchanged, true);
    await appendFile(file, '"}\n' + line(response())); await store.poll(true);
    const final = await store.read(input); if (final.mode !== "full") throw new Error("full expected"); assert.equal(final.totals.calls, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("invalid persisted schemas are quarantined; unreadable roots remain a coverage error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tokens-corrupt-"));
  await writeFile(join(directory, "tokens.json"), '{"version":1,"hours":"bad"}');
  const notDirectory = join(directory, "not-a-directory"); await writeFile(notDirectory, "");
  const store = new TokenStore({ directory, roots: [{ source: "claude", path: notDirectory }], poll: false, now: () => NOW });
  try {
    await store.ready; assert.equal(await readFile(join(directory, "tokens.json.corrupt"), "utf8"), '{"version":1,"hours":"bad"}');
    const result = await store.read(input); if (result.mode !== "full") throw new Error("full expected");
    assert.equal(result.coverage.roots[0].error, "ENOTDIR"); assert.equal(result.totals.calls, 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("hourly retention rolls up to daily through 400 days and bounds sessions", () => {
  const data = emptyData();
  addCall(data, fixtureCall(NOW - 91 * DAY), null, NOW);
  assert.equal(data.hours.size, 1);
  pruneData(data, NOW + 2 * DAY); assert.equal(data.hours.size, 0); assert.equal(data.days.size, 1); assert.equal(data.sessionHours.size, 0);
  pruneData(data, NOW + 401 * DAY); assert.equal(data.days.size, 0); assert.equal(data.recent.size, 0); assert.equal(data.earliestAt, null);
  for (let i = 0; i < 5010; i++) addCall(data, { ...fixtureCall(), key: i.toString(16).padStart(16, "0"), sessionId: `s${i}` }, null, NOW);
  pruneData(data, NOW); assert.equal(data.sessions.size, 5000); assert.equal(data.sessionHours.size, 5000);
});

test("late response blocks replace counts and response time, including hour-boundary movement", () => {
  const data = emptyData(), first = { ...fixtureCall(NOW - 1), output: 8 }, next = { ...first, at: NOW + 1000, output: 158 };
  addCall(data, first, null, NOW); addCall(data, next, first, NOW);
  assert.equal(data.hours.size, 1); assert.equal([...data.hours.values()][0].output, 158); assert.equal([...data.hours.values()][0].calls, 1);
  assert.equal([...data.hours.values()][0].genMs, 11_001);
});

test("an import cut by its budgets says so in the coverage the Token page shows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tokens-truncated-")), root = join(directory, "logs");
  await mkdir(root, { recursive: true });
  for (const name of ["a", "b", "c"]) await writeFile(join(root, `${name}.jsonl`), "{}\n");
  const store = new TokenStore({ directory, roots: [{ source: "claude", path: root }], poll: false, now: () => NOW, limits: { files: 2 } });
  try {
    await store.ready;
    const result = tokenResponseSchema.parse(await store.read(input)); if (result.mode !== "full") throw new Error("full expected");
    assert.deepEqual(result.coverage.truncated, { files: true, bytes: false, index: false, scan: false });
    assert.equal(tokenTruncationNotice(result.coverage.truncated), "统计不完整：日志文件超过 2 万个，只统计最新的部分。");
    assert.equal(tokenTruncationNotice({ files: false, bytes: true, index: true, scan: true }), "统计不完整：日志总量超过 64 GB，更早的文件没有导入；日志目录条目超过 25 万个，本次扫描提前结束；去重索引超过 75 万条，最早的记录已截断。");
    assert.equal(tokenTruncationNotice({ files: false, bytes: false, index: false, scan: false }), null);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("subagent thread links survive a restart; logs read before 2.13 learn their parent once from their first line", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-threads-")), logs = join(root, "sessions"), directory = join(root, "data");
  await mkdir(logs);
  const usage = (n: number) => ({ input_tokens: 100 * n, cached_input_tokens: 40, output_tokens: 20 * n, total_tokens: 120 * n });
  const meta = (id: string, source: unknown) => line({ type: "session_meta", timestamp: iso(NOW - 60_000), payload: { id, cwd: "/repo/demo", source } });
  const record = (thread: string, response: string, at: number) => line({ type: "token_usage_record", timestamp: iso(at), payload: { thread_id: thread, response_id: response, usage: usage(1), thread_token_usage: usage(2) } });
  await writeFile(join(logs, "rollout-2026-09-23T00-00-00-parent.jsonl"), meta("parent-thread", "cli") + record("parent-thread", "p1", NOW - 5000));
  await writeFile(join(logs, "rollout-2026-09-23T00-00-00-child.jsonl"), meta("child-thread", { subagent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } } }) + record("child-thread", "c1", NOW - 3000));
  const options = { directory, roots: [{ source: "codex" as const, path: logs }], now: () => NOW, poll: false };
  const sessions = async (store: TokenStore) => { const result = await store.read(input); if (result.mode !== "full") throw new Error("full expected"); return result.sessions.map(session => [session.sessionId, session.calls, session.subagentCalls]); };
  let store = new TokenStore(options);
  try {
    await store.ready;
    assert.deepEqual([...store.data.threads], [["child-thread", "parent-thread"]]);
    assert.deepEqual(await sessions(store), [["parent-thread", 2, 1]]);
    await store.close();
    store = new TokenStore(options); await store.ready;
    assert.deepEqual([...store.data.threads], [["child-thread", "parent-thread"]], "the link is saved with the ledger");
    await store.close();
    // A ledger saved before 2.13: no links, and file states that never looked for a parent.
    const file = join(directory, "tokens.json"), saved = JSON.parse(await readFile(file, "utf8"));
    delete saved.threads;
    for (const entry of saved.files) { delete entry.state.parentThread; delete entry.state.threadId; entry.state.links = []; }
    await writeFile(file, JSON.stringify(saved));
    store = new TokenStore(options); await store.ready;
    assert.equal(store.ingester.diagnostics.calls, 0, "nothing is imported again");
    assert.deepEqual([...store.data.threads], [["child-thread", "parent-thread"]]);
    assert.deepEqual(await sessions(store), [["parent-thread", 2, 1]], "calls counted before the upgrade move to the parent too");
    const child = [...store.ingester.files.values()].find(entry => entry.path.endsWith("child.jsonl"))!;
    assert.equal(child.state.parentThread, "parent-thread"); assert.deepEqual(child.state.links, ["parent-thread"]);
    assert.equal(await store.ingester.probeThreads(), 0, "each log is probed once");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
