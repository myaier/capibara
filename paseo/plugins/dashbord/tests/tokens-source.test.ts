import assert from "node:assert/strict";
import fsp, { appendFile, chmod, mkdir, mkdtemp, open, rename, rm, stat, symlink, truncate, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { digestSchema } from "../shared/digest";
import { TOKEN_SOURCES } from "../shared/tokens";
import { digestTokenSources } from "../server/tokens";
import { TokenIngester } from "../server/tokens/ingester";
import { LocalTokenCallSource, MARKER_CHUNK, MARKER_FILES, MARKER_READS, MARKER_REST, MARKER_TAIL, MARKER_WHOLE, type MarkerEvidence, type MarkerRun } from "../server/tokens/source";
import { iso, type LogRoot } from "../server/tokens/types";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const line = (value: unknown) => JSON.stringify(value) + "\n";
const user = (sessionId: string, at = NOW - 10_000, parent?: string) => ({ type: "user", sessionId, cwd: "/repo", timestamp: iso(at),
  ...(parent ? { forkedFrom: { sessionId: parent, messageUuid: "copied-user" } } : {}), message: { content: "PRIVATE_PROMPT" } });
const assistant = (sessionId: string, id: string, at = NOW, output = 100, parent?: string) => ({ type: "assistant", sessionId, cwd: "/repo", timestamp: iso(at), requestId: `req-${id}`,
  ...(parent ? { forkedFrom: { sessionId: parent, messageUuid: `copied-${id}` } } : {}),
  message: { id, model: "claude-opus-5", content: "PRIVATE_OUTPUT", usage: { input_tokens: 11, cache_creation_input_tokens: 22, cache_read_input_tokens: 33, output_tokens: output } } });

/** `clock`: the ingester's, NOW until a test moves it on (a run, a later scan). */
async function fixture(run: (root: string, ingester: TokenIngester, source: LocalTokenCallSource, clock: { now: number }) => Promise<void>, roots?: (root: string) => LogRoot[]): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-source-")), clock = { now: NOW };
  const ingester = new TokenIngester({ roots: roots?.(root) ?? [{ source: "claude", path: root }], now: () => clock.now, onCall: () => {} });
  try { await run(root, ingester, new LocalTokenCallSource(ingester), clock); }
  finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("call source distinguishes unknown sessions from known empty logs and awaits initialization", async () => fixture(async (root, ingester, source) => {
  await writeFile(join(root, "empty.jsonl"), line(user("empty")));
  let initialized!: () => void;
  const initializedPromise = new Promise<void>(resolve => { initialized = resolve; });
  const waiting = new LocalTokenCallSource(ingester, initializedPromise).callsForSessions(["empty"]);
  await ingester.scan(); initialized();
  const empty = await waiting;
  assert.deepEqual({ source: empty?.source, calls: empty?.calls }, { source: "claude", calls: [] }); assert.match(empty!.version, /^[a-f0-9]{32}$/);
  assert.equal(await source.callsForSessions(["unknown"]), null);
  assert.equal(await source.callsForSessions([]), null);
}));

test("call source resolves fork ancestors and descendants, includes parent subagents and prefers original usage", async () => fixture(async (root, ingester, source) => {
  await mkdir(join(root, "child", "subagents"), { recursive: true });
  await writeFile(join(root, "root.jsonl"), line(user("root", NOW - 40_000)) + line(assistant("root", "root-call", NOW - 30_000, 100)));
  await writeFile(join(root, "child.jsonl"), line(user("child", NOW - 40_000, "root")) + line(assistant("child", "root-call", NOW + 5000, 999, "root")) + line(assistant("child", "child-call", NOW - 20_000, 200)));
  await writeFile(join(root, "grandchild.jsonl"), line(user("grandchild", NOW - 40_000, "child")) + line(assistant("grandchild", "child-call", NOW + 5000, 999, "child")) + line(assistant("grandchild", "grandchild-call", NOW - 10_000, 400)));
  await writeFile(join(root, "child", "subagents", "agent-x.jsonl"), line(user("agent-x", NOW - 17_000)) + line(assistant("agent-x", "subagent-call", NOW - 15_000, 300)));
  await writeFile(join(root, "unrelated.jsonl"), line(assistant("unrelated", "unrelated-call", NOW, 500)));
  await utimes(join(root, "child.jsonl"), new Date(NOW - 100_000), new Date(NOW - 100_000));
  await ingester.backfillAll();
  const result = await source.callsForSessions(["grandchild"]);
  assert.deepEqual(result?.calls.map(call => [call.at, call.output, call.subagent]), [
    [NOW - 30_000, 100, false], [NOW - 20_000, 200, false], [NOW - 15_000, 300, true], [NOW - 10_000, 400, false],
  ]);
  assert.deepEqual(await source.callsForSessions(["root"]), result);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.deepEqual(Object.keys(result!.calls[0]).sort(), ["at", "cacheRead", "cacheWrite", "input", "model", "output", "reasoning", "start", "subagent"].sort());
}));

test("on-demand parsing discovers ancestor links before background ingestion has parsed them", async () => fixture(async (root, ingester, source) => {
  await writeFile(join(root, "root.jsonl"), line(assistant("root", "a", NOW - 2000)));
  await writeFile(join(root, "child.jsonl"), line(user("child", NOW - 1000, "root")) + line(assistant("child", "b")));
  await ingester.scan();
  assert.equal((await source.callsForSessions(["child"]))?.calls.length, 2);
  assert.ok([...ingester.files.values()].every(file => file.offset === 0));
}));

test("cached reads extend partial tails, preserve output corrections and serialize concurrent callers", async () => fixture(async (root, ingester, source) => {
  const path = join(root, "s.jsonl"), first = line(user("s")) + line(assistant("s", "a", NOW - 2000, 8));
  await writeFile(path, first); await ingester.scan();
  const initial = await source.callsForSessions(["s"]);
  assert.equal(initial?.calls[0].output, 8);
  initial!.calls[0].output = 9999;
  const correction = line(assistant("s", "a", NOW - 1000, 158));
  await appendFile(path, correction.slice(0, -5));
  assert.equal((await source.callsForSessions(["s"]))?.calls[0].output, 8);
  await appendFile(path, correction.slice(-5) + line(assistant("s", "b", NOW, 200)));
  const results = await Promise.all([source.callsForSessions(["s"]), source.callsForSessions(["s"])]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0]?.calls.map(call => [call.output, call.at, call.start]), [[158, NOW - 1000, NOW - 10_000], [200, NOW, NOW - 10_000]]);
}));

test("truncation, replacement and same-size rewrites invalidate cached history", async () => fixture(async (root, ingester, source) => {
  const path = join(root, "s.jsonl");
  await writeFile(path, line(assistant("s", "a")) + line(assistant("s", "b"))); await ingester.scan();
  assert.equal((await source.callsForSessions(["s"]))?.calls.length, 2);
  await writeFile(path, line(assistant("s", "c")));
  assert.equal((await source.callsForSessions(["s"]))?.calls.length, 1);
  await writeFile(path + ".new", line(assistant("s", "d", NOW, 300))); await rename(path + ".new", path);
  assert.equal((await source.callsForSessions(["s"]))?.calls[0].output, 300);
  await writeFile(path, line(assistant("s", "e", NOW, 400))); await utimes(path, new Date(NOW + 10_000), new Date(NOW + 10_000));
  assert.equal((await source.callsForSessions(["s"]))?.calls[0].output, 400);
  await rm(path);
  assert.equal(await source.callsForSessions(["s"]), null);
}));

test("mixed-provider requests select the first requested known source and suppress paired Codex counts", async () => fixture(async (root, ingester, source) => {
  await mkdir(join(root, "claude")); await mkdir(join(root, "codex"));
  await writeFile(join(root, "claude", "c.jsonl"), line(assistant("c", "c-call")));
  const usage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
  await writeFile(join(root, "codex", "rollout-test.jsonl"), line({ type: "session_meta", payload: { id: "x" } }) +
    line({ type: "turn_context", payload: { model: "gpt-5" } }) + line({ type: "event_msg", timestamp: iso(NOW - 1000), payload: { type: "task_started" } }) +
    line({ type: "token_usage_record", timestamp: iso(NOW), payload: { thread_id: "x", response_id: "r", usage, thread_token_usage: usage } }) +
    line({ type: "event_msg", timestamp: iso(NOW + 10), payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } }));
  await ingester.backfillAll();
  assert.equal((await source.callsForSessions(["unknown", "c", "x"]))?.source, "claude");
  const result = await source.callsForSessions(["x", "c"]);
  assert.equal(result?.source, "codex"); assert.equal(result?.calls.length, 1);
  assert.deepEqual(result?.calls.map(call => [call.at, call.start, call.input, call.cacheWrite, call.cacheRead, call.output, call.reasoning]), [[NOW + 10, NOW - 1000, 50, 10, 40, 20, 5]]);
}, root => [{ source: "claude", path: join(root, "claude") }, { source: "codex", path: join(root, "codex") }]));

test("cache limits never truncate the history returned for large or many-file requests", async () => fixture(async (root, ingester) => {
  const source = new LocalTokenCallSource(ingester, undefined, { budget: { files: 4, calls: 50 } });
  for (let index = 0; index < 9; index++) await writeFile(join(root, `s${index}.jsonl`), line(assistant(`s${index}`, `a${index}`)));
  await ingester.scan();
  const ids = Array.from({ length: 9 }, (_, index) => `s${index}`);
  assert.equal((await source.callsForSessions(ids))?.calls.length, 9);
  const cache = (source as unknown as { cache: Map<string, { calls: Map<string, unknown> }> }).cache;
  assert.ok(cache.size <= 4);
  await writeFile(join(root, "large.jsonl"), Array.from({ length: 51 }, (_, index) => line(assistant("large", `large-${index}`))).join(""));
  await ingester.scan();
  assert.equal((await source.callsForSessions(["large"]))?.calls.length, 51);
  assert.ok([...cache.values()].reduce((count, entry) => count + entry.calls.size, 0) <= 50);
  assert.ok(!cache.has(join(root, "large.jsonl")), "a log with more calls than the whole budget is read, not kept");
}));

test("a Codex session's history includes the subagent threads it spawned, marked as subagent calls", async () => fixture(async (root, ingester, source) => {
  const usage = (n: number) => ({ input_tokens: 100 * n, cached_input_tokens: 40, output_tokens: 20 * n, total_tokens: 120 * n });
  const meta = (id: string, spawnedBy?: string) => line({ type: "session_meta", timestamp: iso(NOW - 60_000), payload: { id, cwd: "/repo", source: spawnedBy ? { subagent: { thread_spawn: { parent_thread_id: spawnedBy, depth: 1 } } } : "cli" } });
  const record = (thread: string, response: string, at: number) => line({ type: "token_usage_record", timestamp: iso(at), payload: { thread_id: thread, response_id: response, usage: usage(1), thread_token_usage: usage(2) } });
  await writeFile(join(root, "rollout-2026-09-23T00-00-00-parent.jsonl"), meta("parent") + record("parent", "p1", NOW - 5000));
  await writeFile(join(root, "rollout-2026-09-23T00-00-01-child.jsonl"), meta("child", "parent") + record("child", "c1", NOW - 3000));
  await writeFile(join(root, "rollout-2026-09-23T00-00-02-other.jsonl"), meta("other") + record("other", "o1", NOW - 1000));
  await ingester.backfillAll();
  const history = await source.callsForSessions(["parent"]);
  assert.equal(history?.source, "codex");
  assert.deepEqual(history!.calls.map(call => [call.at, call.subagent]), [[NOW - 5000, false], [NOW - 3000, true]]);
}, root => [{ source: "codex", path: root }]));

// opus-F70: the digest polls a session every 30-60 s; a Claude session with many subagents is one log per subagent.
const subagentSession = async (root: string, logs: number, sid = "main"): Promise<string[]> => {
  await mkdir(join(root, sid, "subagents"), { recursive: true });
  const paths = [join(root, `${sid}.jsonl`), ...Array.from({ length: logs - 1 }, (_, index) => join(root, sid, "subagents", `agent-${index}.jsonl`))];
  for (const [index, path] of paths.entries()) {
    await writeFile(path, line(user(sid, NOW - 60_000 + index * 100)) + line(assistant(sid, `m-${index}`, NOW - 50_000 + index * 100, 10 + index)));
    await utimes(path, new Date(NOW - 100_000 + index * 1000), new Date(NOW - 100_000 + index * 1000));
  }
  return paths;
};

test("a session with more logs than the old 8-file cache is read once; the next read is served from the cache", async () => fixture(async (root, ingester, source) => {
  const paths = await subagentSession(root, 24);
  await ingester.scan();
  const first = await source.callsForSessions(["main"]), afterFirst = source.diagnostics.bytesRead;
  assert.equal(first?.calls.length, 24); assert.equal(first?.calls.filter(call => call.subagent).length, 23);
  assert.equal(source.diagnostics.reused, 0);
  const second = await source.callsForSessions(["main"]);
  assert.deepEqual(second, first);
  assert.equal(source.diagnostics.bytesRead, afterFirst, "nothing is read again");
  assert.equal(source.diagnostics.reused, paths.length, "every log, finished subagents included, is reused from its unchanged identity");
}));

test("a log that only grew is read from where the last read stopped; the version moves with it", async () => fixture(async (root, ingester, source) => {
  const paths = await subagentSession(root, 3);
  await ingester.scan();
  const first = await source.callsForSessions(["main"]), before = source.diagnostics.bytesRead;
  const appended = line(user("main", NOW - 20_000)) + line(assistant("main", "late", NOW - 10_000, 77));
  await appendFile(paths[2]!, appended);
  const second = await source.callsForSessions(["main"]);
  assert.equal(source.diagnostics.bytesRead - before, Buffer.byteLength(appended), "only the appended bytes are read");
  assert.equal(second?.calls.length, 4); assert.equal(second?.calls.at(-1)?.output, 77);
  assert.notEqual(second?.version, first?.version);
  assert.equal((await source.callsForSessions(["main"]))?.version, second?.version, "unchanged logs keep their version");
  // The budget counts what the cache really holds, though a log's call map grows in place as it is read on.
  for (let index = 0; index < 3; index++) { await appendFile(paths[0]!, line(assistant("main", `more-${index}`, NOW - 9000 + index))); await source.callsForSessions(["main"]); }
  const internals = source as unknown as { cache: Map<string, { calls: Map<string, unknown> }>; cachedCalls: number };
  assert.equal(internals.cachedCalls, [...internals.cache.values()].reduce((sum, entry) => sum + entry.calls.size, 0));
  assert.equal(internals.cachedCalls, 7);
}));

test("a truncated or replaced log is read again from the start", async () => fixture(async (root, ingester, source) => {
  const paths = await subagentSession(root, 2);
  await ingester.scan();
  await source.callsForSessions(["main"]);
  let before = source.diagnostics.bytesRead;
  const shorter = line(assistant("main", "rewritten", NOW - 5000, 5));
  await writeFile(paths[1]!, shorter);
  let result = await source.callsForSessions(["main"]);
  assert.equal(source.diagnostics.bytesRead - before, Buffer.byteLength(shorter), "the whole (shorter) log, from its start");
  assert.deepEqual(result?.calls.map(call => call.output), [10, 5]);
  before = source.diagnostics.bytesRead;
  const replacement = line(assistant("main", "replaced", NOW - 4000, 6)) + line(assistant("main", "replaced-2", NOW - 3000, 7));
  await writeFile(paths[1]! + ".new", replacement); await rename(paths[1]! + ".new", paths[1]!);
  result = await source.callsForSessions(["main"]);
  assert.equal(source.diagnostics.bytesRead - before, Buffer.byteLength(replacement), "a new inode is read whole");
  assert.deepEqual(result?.calls.map(call => call.output), [10, 6, 7]);
}));

test("a session larger than the cache keeps its leading logs cached instead of missing on every read", async () => fixture(async (root, ingester) => {
  const source = new LocalTokenCallSource(ingester, undefined, { budget: { calls: 10 } });
  await subagentSession(root, 24);
  await ingester.scan();
  assert.equal((await source.callsForSessions(["main"]))?.calls.length, 24);
  for (let round = 1; round <= 2; round++) {
    const reused = source.diagnostics.reused;
    assert.equal((await source.callsForSessions(["main"]))?.calls.length, 24);
    assert.equal(source.diagnostics.reused - reused, 10, "the same 10 logs are served from the cache each time");
  }
}));

test("other sessions' logs are evicted first, least recently used first", async () => fixture(async (root, ingester) => {
  const source = new LocalTokenCallSource(ingester, undefined, { budget: { files: 4 } });
  await subagentSession(root, 3, "alpha"); await subagentSession(root, 3, "beta");
  await ingester.scan();
  await source.callsForSessions(["alpha"]); await source.callsForSessions(["beta"]);
  const reused = source.diagnostics.reused;
  await source.callsForSessions(["beta"]);
  assert.equal(source.diagnostics.reused - reused, 3, "the session just read stays whole");
  const cache = (source as unknown as { cache: Map<string, unknown> }).cache;
  assert.equal(cache.size, 4); assert.equal([...cache.keys()].filter(path => path.includes("alpha")).length, 1);
}));

test("a source outside the allow-list answers null, so 复盘 never receives a log format its schema does not name", async () => fixture(async (root, ingester) => {
  const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 };
  await writeFile(join(root, "rollout-2026-09-23T00-00-00-x.jsonl"), line({ type: "session_meta", payload: { id: "x" } }) +
    line({ type: "event_msg", timestamp: iso(NOW), payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } }));
  await ingester.backfillAll();
  assert.equal((await new LocalTokenCallSource(ingester).callsForSessions(["x"]))?.calls.length, 1);
  assert.equal(await new LocalTokenCallSource(ingester, undefined, { sources: ["claude"] }).callsForSessions(["x"]), null);
}, root => [{ source: "codex", path: root }]));

test("复盘's token history is served for exactly the log sources its schema names", () => {
  const named = digestSchema.shape.tokens.unwrap().shape.source.options;
  assert.deepEqual([...digestTokenSources()].sort(), [...named].sort());
  assert.ok(named.every(source => (TOKEN_SOURCES as readonly string[]).includes(source)));
});

// 恢复后续跑 after a daemon restart (codex-obs-resume-F2): whether the prompt a heartbeat sent, which names its run, is in the session's own log.
const RUN = "3b8d7a52-6c1e-4f0a-9d2b-7e4c5a1f9e30", MARKER = `run=${RUN}`, OTHER_MARKER = "run=5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
/** The prompt as Claude Code logs it: the host's system envelope, `Schedule "<name>" fired (id=<scheduleId>, run=<runId>).` and the prompt. */
const fired = (sessionId: string, run = RUN) => line({ type: "user", sessionId, cwd: "/home/me/app", timestamp: iso(NOW),
  message: { role: "user", content: `<paseo-system>\nSchedule "恢复后续跑 · 修复登录" fired (id=8c71c89f, run=${run}).\n额度已经恢复，请接着做。\n</paseo-system>` } });
/** A run that begins and ends now, by the ingester's clock (after it began watching). */
const ran = (clock: { now: number }): MarkerRun => ({ startedAt: clock.now += 1000, endedAt: clock.now += 1000 });
/**
 * Decisions about runs that just began and ended (`findMarker` with the run), each once the ledger has scanned since: the clock
 * moves past the run's end and a scan begins, as the ledger's next rescan (every 30 s) would.
 */
const decider = (ingester: TokenIngester, source: LocalTokenCallSource, clock: { now: number }) => async (ids: string[], marker: string): Promise<MarkerEvidence> => {
  const run = ran(clock);
  clock.now += 1000; await ingester.scan();
  return source.findMarker(ids, marker, { run });
};
/** A promise opened from outside (a scan held mid-way). */
const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; };

test("findMarker: the prompt a heartbeat sent is found by its run id, as a whole id, in the session's own log only, and nothing is kept; a decision about a run whose logs were scanned since and read whole without it says it is absent", async () => fixture(async (root, ingester, source, clock) => {
  const decide = decider(ingester, source, clock);
  await writeFile(join(root, "s.jsonl"), line(user("s", NOW - 60_000)) + fired("s") + line(assistant("s", "a")));
  await writeFile(join(root, "other.jsonl"), fired("other", "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c"));
  await mkdir(join(root, "s", "subagents"), { recursive: true });
  await writeFile(join(root, "s", "subagents", "agent-x.jsonl"), fired("s", "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c"));
  await ingester.scan();
  assert.equal(await source.findMarker(["s"], MARKER), "found");
  assert.equal(await decide(["s"], MARKER.slice(0, -1)), "absent", "the start of a longer id is not it");
  assert.equal(await decide(["other"], MARKER), "absent", "another session's log");
  assert.equal(await decide(["s"], "run=0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c"), "absent", "a subagent's log is not the session's");
  // Only a decision about a run tells it absent: not a look at the tails, nor a whole read for the marker alone (codex-obs-resume-recheck4-F1).
  assert.deepEqual([await source.findMarker(["s"], MARKER.slice(0, -1)), await source.findMarker(["other"], MARKER, { whole: true })], ["unknown", "unknown"]);
  // No log of the session, or nothing to look for: nothing can be told (codex-obs-resume-recheck3-F1).
  assert.equal(await source.findMarker(["unknown"], MARKER), "unknown");
  assert.equal(await decide(["unknown"], MARKER), "unknown", "no log of it, scanned since the run ended");
  assert.equal(await source.findMarker([], MARKER), "unknown");
  assert.equal(await source.findMarker(["s"], "run="), "unknown", "too short to name a run");
  const internals = source as unknown as { cache: Map<string, unknown> };
  assert.equal(internals.cache.size, 0, "nothing parsed or cached for it");
  assert.equal(source.diagnostics.bytesRead, 0);
  assert.ok(source.diagnostics.markerBytes > 0);
  // It waits for nothing, the ledger's first import included (codex-obs-resume-recheck5-F2): a log no scan has listed is not
  // found yet, and a decision about a run since which no scan began is pending.
  const early = new LocalTokenCallSource(ingester, new Promise<void>(() => {}));
  await writeFile(join(root, "late.jsonl"), fired("late"));
  const run = ran(clock);
  assert.deepEqual([await early.findMarker(["late"], MARKER), await early.findMarker(["late"], MARKER, { run })], ["unknown", "pending"]);
  clock.now += 1000; await ingester.scan();
  assert.deepEqual([await early.findMarker(["late"], MARKER), await early.findMarker(["late"], MARKER, { run })], ["found", "found"]);
}));

test("findMarker reads Codex rollouts and Pi sessions by their own ids, never a Grok session", async () => fixture(async (root, _ingester, _source, clock) => {
  const ingester = new TokenIngester({ roots: [{ source: "codex", path: join(root, "codex") }, { source: "pi", path: join(root, "pi") }, { source: "grok", path: join(root, "grok") }], now: () => clock.now, onCall: () => {} });
  try {
    const thread = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", pi = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", grok = "c0ffee00-1111-4222-8333-444455556666";
    const prompt = `<paseo-system>\nSchedule "恢复后续跑 · x" fired (id=8c71c89f, run=${RUN}).\n继续\n</paseo-system>`;
    await mkdir(join(root, "codex", "2026", "09", "23"), { recursive: true });
    await writeFile(join(root, "codex", "2026", "09", "23", `rollout-2026-09-23T00-00-00-${thread}.jsonl`), line({ type: "session_meta", payload: { id: thread, cwd: "/home/me/app", source: "cli" } }) +
      line({ type: "response_item", timestamp: iso(NOW), payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }));
    await mkdir(join(root, "pi", "--home-me-app--"), { recursive: true });
    await writeFile(join(root, "pi", "--home-me-app--", `2026-09-23T00-00-00-000Z_${pi}.jsonl`), line({ type: "session", id: pi, cwd: "/home/me/app", timestamp: iso(NOW - 1000) }) +
      line({ type: "message", timestamp: iso(NOW), message: { role: "user", content: [{ type: "text", text: prompt }] } }));
    await mkdir(join(root, "grok", encodeURIComponent("/home/me/app"), grok), { recursive: true });
    await writeFile(join(root, "grok", encodeURIComponent("/home/me/app"), grok, "usage.json"), JSON.stringify({ note: prompt }));
    await ingester.scan();
    const source = new LocalTokenCallSource(ingester), decide = decider(ingester, source, clock);
    assert.equal(await source.findMarker([thread], MARKER), "found", "Codex");
    assert.equal(await source.findMarker([pi], MARKER), "found", "Pi");
    assert.deepEqual([await decide([thread], OTHER_MARKER), await decide([pi], OTHER_MARKER)], ["absent", "absent"], "read whole without another run's");
    // Grok's conversation holds the prompt too, but it is never opened: Grok can show neither (codex-obs-resume-recheck3-F1).
    const before = source.diagnostics.markerBytes;
    assert.deepEqual([await source.findMarker([grok], MARKER), await source.findMarker([grok], MARKER, { whole: true }), await decide([grok], MARKER)], ["unknown", "unknown", "unknown"], "Grok is never opened");
    assert.equal(source.diagnostics.markerBytes, before, "not a byte of it read");
    assert.equal(await new LocalTokenCallSource(ingester, undefined, { sources: ["claude"] }).findMarker([thread], MARKER, { whole: true }), "unknown", "a source not served is not read either");
  } finally { await ingester.close(); }
}));

test("findMarker compares only the last 16 MB of a log (128 MB to tell it is absent), back from the end in chunks, finding a marker across two of them; the newest few logs only", async () => fixture(async (root, ingester, source, clock) => {
  const decide = decider(ingester, source, clock);
  const filler = (bytes: number) => "y".repeat(bytes - 1) + "\n";
  // Behind more than MARKER_TAIL of later output: not looked for.
  await writeFile(join(root, "far.jsonl"), fired("far") + filler(MARKER_TAIL + 4096));
  // Across the edge between the last chunk and the one before it: found.
  const head = fired("edge").slice(0, fired("edge").indexOf(MARKER)), rest = fired("edge").slice(fired("edge").indexOf(MARKER) + MARKER.length);
  const after = MARKER_CHUNK + 5 - MARKER.length - Buffer.byteLength(rest);
  await writeFile(join(root, "edge.jsonl"), filler(2 * MARKER_CHUNK) + head + MARKER + rest + filler(after));
  await ingester.scan();
  const before = source.diagnostics.markerBytes;
  assert.equal(await source.findMarker(["far"], MARKER), "unknown", "not in the tail, and the rest was not read: nothing told");
  assert.equal(source.diagnostics.markerBytes - before, MARKER_TAIL, "exactly the tail");
  // A whole read finds it at its start.
  assert.equal(await source.findMarker(["far"], MARKER, { whole: true }), "found");
  assert.equal(await source.findMarker(["far"], OTHER_MARKER), "unknown");
  assert.equal(await decide(["far"], OTHER_MARKER), "absent", "read to its first byte without it");
  assert.equal(await source.findMarker(["edge"], MARKER), "found");
  // One session id in more logs than MARKER_FILES: the newest are read.
  for (let index = 0; index <= MARKER_FILES; index++) {
    const path = join(root, `split-${index}.jsonl`);
    await writeFile(path, line(user("split", NOW - 1000)) + (index === 0 ? fired("split") : ""));
    await utimes(path, new Date(NOW - 100_000 + index * 1000), new Date(NOW - 100_000 + index * 1000));
  }
  await ingester.backfillAll();
  assert.equal(await decide(["split"], MARKER), "unknown", "the oldest of five is past the limit: not found, and not told absent either");
  await appendFile(join(root, `split-${MARKER_FILES}.jsonl`), fired("split"));
  await ingester.scan();
  assert.equal(await source.findMarker(["split"], MARKER), "found");
}));

test("findMarker tells a marker absent only from logs it read whole: one it cannot open, a symlink, or a session one of whose logs cannot be read is unknown (codex-obs-resume-recheck3-F1)", async () => fixture(async (root, ingester, source, clock) => {
  const decide = decider(ingester, source, clock);
  await writeFile(join(root, "empty.jsonl"), "");
  await writeFile(join(root, "plain.jsonl"), line(user("plain", NOW - 60_000)) + fired("plain", OTHER_MARKER.slice(4)));
  await writeFile(join(root, "locked.jsonl"), line(user("locked")));
  await writeFile(join(root, "linked-target.txt"), line(user("linked")));
  await writeFile(join(root, "linked.jsonl"), line(user("linked")));
  // Two logs of one session.
  await writeFile(join(root, "pair-a.jsonl"), line(user("pair")));
  await writeFile(join(root, "pair-b.jsonl"), line(user("pair")));
  await ingester.backfillAll();
  assert.equal(await decide(["empty"], MARKER), "absent", "an empty log holds no prompt");
  assert.equal(await decide(["plain"], MARKER), "absent");
  assert.equal(await decide(["pair"], MARKER), "absent", "both read whole");
  // Not opened: unreadable (as another user's), or a log that has become a symlink (never followed).
  await chmod(join(root, "locked.jsonl"), 0o000);
  await chmod(join(root, "pair-a.jsonl"), 0o000);
  await rm(join(root, "linked.jsonl")); await symlink(join(root, "linked-target.txt"), join(root, "linked.jsonl"));
  try {
    if (process.getuid?.() !== 0) {
      assert.equal(await decide(["locked"], MARKER), "unknown", "cannot be opened");
      assert.equal(await decide(["pair"], MARKER), "unknown", "one of its logs cannot be read");
    }
    assert.equal(await decide(["linked"], MARKER), "unknown", "a symlink is not followed");
    await appendFile(join(root, "pair-b.jsonl"), fired("pair"));
    assert.equal(await decide(["pair"], MARKER), "found", "the other one still shows it");
  } finally { await chmod(join(root, "locked.jsonl"), 0o600); await chmod(join(root, "pair-a.jsonl"), 0o600); }
}));

test("findMarker never tells a marker absent from a log longer than 128 MB: its start is never read (codex-obs-resume-recheck3-F1)", async () => fixture(async (root, ingester, source, clock) => {
  // Sparse: longer than the window, without a byte of it written.
  const handle = await open(join(root, "huge.jsonl"), "w"); await handle.truncate(MARKER_WHOLE + MARKER_CHUNK); await handle.close();
  await ingester.scan();
  const run = ran(clock);
  clock.now += 1000; await ingester.scan();
  const before = source.diagnostics.markerBytes;
  assert.equal(await source.findMarker(["huge"], MARKER, { run }), "unknown");
  assert.equal(source.diagnostics.markerBytes - before, MARKER_WHOLE, "exactly the window");
}));

// 「确认没有」 from the ledger's own scans (codex-obs-resume-recheck5-F1, F2): a scan begun since the run ended listed the logs'
// roots whole, no log of the session was lost since the run began, and each was read whole while it did not change.
const SID = "6f1c2a3b-0000-4000-8000-00000000000a";

test("a decision waits for a scan begun after the run ended: until then it is pending, whatever the logs indexed say (codex-obs-resume-recheck5-F2)", async () => fixture(async (root, ingester, source, clock) => {
  const old = join(root, "old-project", `${SID}.jsonl`), latest = join(root, "new-project", `${SID}.jsonl`);
  await mkdir(dirname(old)); await mkdir(dirname(latest));
  await writeFile(old, line(user(SID, NOW - 60_000)));
  await ingester.backfillAll();
  const run = ran(clock);
  // While it went, the prompt went into a new log of the session in another directory, which no scan has listed yet.
  await writeFile(latest, line(user(SID)) + fired(SID));
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run }), "pending", "the log indexed lacks it, but it may not be every log");
  assert.equal(await source.findMarker([SID], MARKER, { run }), "pending", "nor is the prompt found in it");
  assert.equal(ingester.files.has(latest), false);
  // A scan that began before the run ended does not count, though it ended after it: a log may have come behind it.
  clock.now = run.endedAt - 500; const behind = ingester.scan(); clock.now = run.endedAt + 500; await behind;
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run }), "pending");
  assert.equal(await source.findMarker([SID], MARKER, { run }), "found", "the logs indexed are read in any case");
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run }), "absent", "both logs, listed since the run ended, read whole");
  // No log of a session known: pending until a scan has begun since the run ended, then nothing to tell.
  const next = ran(clock);
  assert.equal(await source.findMarker(["nobody"], MARKER, { run: next }), "pending");
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker(["nobody"], MARKER, { run: next }), "unknown");
}));

test("a decision whose logs a scan cut by a budget left out is unknown at once, not pending: the next scan is cut as well (codex-obs-resume-recheck4-F1)", async () => {
  for (const cut of ["files", "bytes", "scanEntries"] as const) await fixture(async (root, ingester, source, clock) => {
    const old = join(root, "a", `${SID}.jsonl`), latest = join(root, "b", `${SID}.jsonl`);
    await mkdir(dirname(old)); await mkdir(dirname(latest));
    await writeFile(old, line(user(SID, NOW - 60_000)));
    await ingester.backfillAll();
    const run = ran(clock);
    await writeFile(latest, line(user(SID)) + fired(SID));
    // The import budgets (TOKEN_IMPORT_LIMITS, 20,000 logs on a real host) at their edge: the log indexed fits, the new one not.
    const saved = { ...ingester.limits };
    if (cut === "files") ingester.limits.files = 1;
    else if (cut === "bytes") ingester.limits.bytes = (await stat(old)).size;
    else ingester.limits.scanEntries = 1;
    clock.now += 1000; await ingester.scan();
    assert.deepEqual([ingester.truncated[cut === "scanEntries" ? "scan" : cut], ingester.files.has(latest)], [true, false], cut);
    assert.equal(await source.findMarker([SID], MARKER, { run }), "unknown", `cut by ${cut}`);
    Object.assign(ingester.limits, saved);
    clock.now += 1000; await ingester.scan();
    assert.equal(await source.findMarker([SID], MARKER, { run }), "found", `${cut}: within budget again, the new log is read`);
  });
});

test("a decision is pending while a directory of the logs' source could not be listed since the run ended, and decided once one lists it whole; another source's failing root does not matter (codex-obs-resume-recheck4-F1)", async () => {
  if (process.getuid?.() === 0) return; // permissions do not stop root
  await fixture(async (root, ingester, source, clock) => {
    const old = join(root, "claude", "a", `${SID}.jsonl`), hidden = join(root, "claude", "locked", `${SID}.jsonl`), codex = join(root, "codex", "locked");
    await mkdir(dirname(old), { recursive: true }); await mkdir(dirname(hidden), { recursive: true }); await mkdir(codex, { recursive: true });
    await writeFile(old, line(user(SID, NOW - 60_000)));
    await writeFile(hidden, line(user(SID)) + fired(SID));
    await chmod(dirname(hidden), 0o000);
    try {
      await ingester.backfillAll();
      const run = ran(clock);
      clock.now += 1000; await ingester.scan();
      assert.ok(ingester.roots[0].error);
      assert.equal(await source.findMarker([SID], MARKER, { run }), "pending", "a directory of Claude logs could not be listed: maybe next time");
      await chmod(dirname(hidden), 0o700); await chmod(codex, 0o000);
      clock.now += 1000; await ingester.scan();
      assert.ok(ingester.roots[1].error);
      assert.equal(await source.findMarker([SID], OTHER_MARKER, { run }), "absent", "every Claude log listed and read; Codex's root does not hold them");
      assert.equal(await source.findMarker([SID], MARKER, { run }), "found");
    } finally { await chmod(dirname(hidden), 0o700); await chmod(codex, 0o700); }
  }, root => [{ source: "claude", path: join(root, "claude") }, { source: "codex", path: join(root, "codex") }]);
});

test("a log of the session that left the index since the run began (deleted, or a symlink now) leaves it unknown; one gone before the run began does not, and a symlink there since before is never read (codex-obs-resume-recheck5-F1)", async () => fixture(async (root, ingester, source, clock) => {
  // Codex's repro: the session's two logs indexed, the prompt in the second; that one moved out of the logs, a symlink to it left in its place.
  const first = join(root, "first", `${SID}.jsonl`), second = join(root, "second", `${SID}.jsonl`), moved = join(root, "moved-out.txt");
  await mkdir(dirname(first)); await mkdir(dirname(second));
  await writeFile(first, line(user(SID, NOW - 60_000)));
  await ingester.backfillAll();
  const run = ran(clock);
  await writeFile(second, line(user(SID)) + fired(SID));
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], MARKER, { run }), "found");
  await rename(second, moved); await symlink(moved, second);
  clock.now += 1000; await ingester.scan();
  assert.equal(ingester.files.has(second), false, "a symlink is not followed: the log leaves the index");
  assert.equal(await source.findMarker([SID], MARKER, { run }), "unknown", "the log it lost since the run began may hold the prompt");
  // A symlink there since before a run began: the session's writes go through it, to a file never read.
  const later = ran(clock);
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run: later }), "unknown");
  // Deleted while a run went (no symlink left): its prompt may have gone with it.
  await rm(second);
  const third = ran(clock);
  await writeFile(second, line(user(SID)) + fired(SID, OTHER_MARKER.slice(4)));
  clock.now += 1000; await ingester.scan();
  await rm(second);
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run: third }), "unknown");
  // Gone before the run began: it cannot have taken the run's prompt.
  const fourth = ran(clock);
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run: fourth }), "absent");
}));

test("a log of the session found lost while its other logs were read is no proof either: the record is read again before telling absent (codex-obs-resume-recheck5-F1)", async () => fixture(async (root, ingester, source, clock) => {
  const path = join(root, "a", `${SID}.jsonl`), linked = join(root, "b", `${SID}.jsonl`), target = join(root, "target.txt");
  await mkdir(dirname(path)); await mkdir(dirname(linked));
  await settled(ingester, path, line(user(SID, NOW - 60_000)));
  await ingester.backfillAll();
  const run = ran(clock);
  clock.now += 1000; await ingester.scan();
  // While its log is read, the ledger's rescan finds another log of the session, a symlink to a file it never reads.
  const meanwhile = async () => { await writeFile(target, line(user(SID)) + fired(SID)); await symlink(target, linked); clock.now += 1000; await ingester.scan(); };
  assert.deepEqual(await whileRead(path, { stat: meanwhile }, () => source.findMarker([SID], MARKER, { run })), { result: "unknown", opens: 1 });
}));

test("a root listed before that is gone or unreadable since the run began leaves its source unvouched, though its logs were never indexed; an optional root never there does not (codex-obs-resume-recheck5-F1)", async () => fixture(async (root, ingester, source, clock) => {
  const old = join(root, "a", `${SID}.jsonl`), other = join(root, "b"), latest = join(other, "project", `${SID}.jsonl`);
  await mkdir(dirname(old), { recursive: true }); await mkdir(other);
  await writeFile(old, line(user(SID, NOW - 60_000)));
  await ingester.backfillAll();
  const before = ran(clock);
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], MARKER, { run: before }), "absent", "the optional root never there does not count");
  const run = ran(clock);
  // The prompt went into a new log in the second root, which moved away before any scan listed it (Codex's repro moved a root too).
  await mkdir(dirname(latest)); await writeFile(latest, line(user(SID)) + fired(SID));
  await rename(other, join(root, "b-moved"));
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], MARKER, { run }), "unknown");
}, root => [{ source: "claude", path: join(root, "a") }, { source: "claude", path: join(root, "b") }, { source: "claude", path: join(root, "never-there") }]));

test("a log replaced or cut short since it was indexed has lost what it held: unknown, whether the ingester read it again since or not (codex-obs-resume-recheck5-F1)", async () => fixture(async (root, ingester, source, clock) => {
  const path = join(root, `${SID}.jsonl`), plain = line(user(SID, NOW - 60_000));
  await writeFile(path, plain);
  await ingester.backfillAll();
  // The prompt went in, then the log was replaced by a copy without it (renamed over), no read of the ingester since.
  const run = ran(clock);
  await appendFile(path, fired(SID));
  await writeFile(`${path}.tmp`, plain); await rename(`${path}.tmp`, path);
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], MARKER, { run }), "unknown", "not the file the index knew");
  // Read again by the ingester since (its poll): the index knows the new file, and that the old one's content is gone.
  await ingester.poll();
  assert.equal(await source.findMarker([SID], MARKER, { run }), "unknown", "replaced, as the ingester saw");
  // Cut short and read again: likewise.
  const later = ran(clock);
  await appendFile(path, fired(SID, OTHER_MARKER.slice(4)));
  await ingester.poll();
  await writeFile(path, plain);
  await ingester.poll();
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run: later }), "unknown", "cut short since the run began");
  // A run begun after: what it may have written is there to read.
  const after = ran(clock);
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run: after }), "absent");
}));

test("a log the ingester reads again from its start is noted lost before the index takes in the new file: a decision while that read goes is not absent (codex-obs-resume-recheck6-F1)", async () => fixture(async (root, ingester, source, clock) => {
  // Codex's repro: the prompt went in and was read; the log was then replaced by a copy without it, and a decision is asked while
  // the ledger's poll reads the new file from its start.
  const path = join(root, `${SID}.jsonl`), plain = line(user(SID, NOW - 60_000));
  await writeFile(path, plain);
  await ingester.backfillAll();
  const run = ran(clock);
  await appendFile(path, fired(SID)); await ingester.poll();
  assert.equal(await source.findMarker([SID], MARKER, { run }), "found");
  await writeFile(`${path}.tmp`, plain); await rename(`${path}.tmp`, path); await delay(MARKER_REST + 30);
  clock.now += 1000; await ingester.scan();
  let during: unknown;
  const decide = async () => {
    during = [await source.findMarker([SID], MARKER, { run }), ingester.lostSince([SID], ["claude"], run.startedAt), ingester.files.get(path)?.ino === (await stat(path)).ino];
  };
  await whileRead(path, { first: decide }, () => ingester.poll());
  assert.deepEqual(during, ["unknown", true, true], "the index holds the new file already, and knows the old one's content is gone");
  assert.equal(await source.findMarker([SID], MARKER, { run }), "unknown");
}));

test("a root added since the last scan leaves the index unvouched until a scan lists it, and one added while the logs are read too: pending, then what it holds is read (codex-obs-resume-recheck6-F1)", async () => fixture(async (root, ingester, source, clock) => {
  // Codex's repro: a custom provider's log directory, found in the daemon's config, already holds the session's log with the prompt.
  const [a, b, c, d] = ["a", "b", "c", "d"].map(name => join(root, name)), THIRD = "run=7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";
  for (const directory of [a, b, c, d]) await mkdir(directory);
  await writeFile(join(a, `${SID}.jsonl`), line(user(SID, NOW - 60_000)));
  await writeFile(join(b, `${SID}.jsonl`), line(user(SID)) + fired(SID));
  await ingester.backfillAll();
  const run = ran(clock);
  clock.now += 1000; await ingester.scan();
  assert.deepEqual([await source.findMarker([SID], MARKER, { run }), await source.findMarker(["nobody"], MARKER, { run })], ["absent", "unknown"], "as far as the roots watched go");
  assert.equal(ingester.addRoots([{ source: "claude", path: b }]), 1);
  assert.deepEqual([await source.findMarker([SID], MARKER, { run }), await source.findMarker(["nobody"], MARKER, { run })], ["pending", "pending"], "no scan has listed it yet");
  clock.now += 1000; await ingester.scan();
  assert.equal(await source.findMarker([SID], MARKER, { run }), "found");
  // Added while a scan goes on: that scan lists it, its walk reading the roots as it reaches them.
  const later = ran(clock);
  await writeFile(join(c, `${SID}.jsonl`), line(user(SID)) + fired(SID, OTHER_MARKER.slice(4)));
  const patched = fsp as unknown as { readdir: (...args: unknown[]) => Promise<unknown> }, readdir = patched.readdir, reached = gate(), resume = gate();
  let held = false;
  patched.readdir = async (...args) => { if (!held && args[0] === a) { held = true; reached.open(); await resume.wait; } return readdir(...args); };
  syncBuiltinESMExports();
  try {
    clock.now += 1000; const scanning = ingester.scan();
    await reached.wait; ingester.addRoots([{ source: "claude", path: c }]); resume.open(); await scanning;
  } finally { patched.readdir = readdir; syncBuiltinESMExports(); }
  assert.equal(await source.findMarker([SID], OTHER_MARKER, { run: later }), "found");
  // Added, and even listed by a scan, while a decision reads the logs: what it holds was not read then; the next decision reads it.
  const last = ran(clock);
  await writeFile(join(d, `${SID}.jsonl`), line(user(SID)) + fired(SID, THIRD.slice(4)));
  clock.now += 1000; await ingester.scan();
  const meanwhile = async () => { ingester.addRoots([{ source: "claude", path: d }]); clock.now += 1000; await ingester.scan(); };
  assert.deepEqual(await whileRead(join(a, `${SID}.jsonl`), { stat: meanwhile }, () => source.findMarker([SID], THIRD, { run: last })), { result: "pending", opens: 1 });
  assert.equal(await source.findMarker([SID], THIRD, { run: last }), "found");
}, root => [{ source: "claude", path: join(root, "a") }]));

test("nothing is vouched for before the ingester began watching, nor for a source a root of which holds a symlinked directory (codex-obs-resume-recheck5-F1)", async () => fixture(async (root, ingester, source, clock) => {
  const path = join(root, "a", `${SID}.jsonl`), elsewhere = await mkdtemp(join(tmpdir(), "tokens-source-linked-"));
  try {
    await mkdir(dirname(path)); await writeFile(path, line(user(SID, NOW - 60_000)));
    await ingester.backfillAll();
    const earlier: MarkerRun = { startedAt: NOW - 5000, endedAt: NOW - 4000 };
    clock.now += 1000; await ingester.scan();
    assert.equal(await source.findMarker([SID], MARKER, { run: earlier }), "unknown", "begun before this ingester watched: a log lost then is not known");
    const run = ran(clock);
    clock.now += 1000; await ingester.scan();
    assert.equal(await source.findMarker([SID], MARKER, { run }), "absent");
    // A project directory that is a symlink: never walked, so any session's log may be in it.
    await symlink(elsewhere, join(root, "linked-project"));
    const later = ran(clock);
    clock.now += 1000; await ingester.scan();
    assert.equal(await source.findMarker([SID], MARKER, { run: later }), "unknown");
  } finally { await rm(elsewhere, { recursive: true, force: true }); }
}));

test("findMarker waits for nothing: neither the token reads queued before it nor a scan going on, and makes no scan of its own (codex-obs-resume-recheck5-F2)", async () => fixture(async (root, ingester, _source, clock) => {
  await writeFile(join(root, `${SID}.jsonl`), line(user(SID, NOW - 60_000)) + fired(SID));
  await ingester.backfillAll();
  const run = ran(clock);
  // A rescan going on holds the ingester's queue; this source's token reads wait for a first import that never ends.
  const held = gate(), scan = ingester.scan.bind(ingester);
  let scans = 0;
  ingester.scan = async () => { scans++; await held.wait; return scan(); };
  const polling = ingester.poll(true);
  const blocked = new LocalTokenCallSource(ingester, new Promise<void>(() => {}));
  void blocked.callsForSessions([SID]);
  const answers = await Promise.race([Promise.all([blocked.findMarker([SID], MARKER), blocked.findMarker([SID], MARKER, { whole: true }), blocked.findMarker([SID], MARKER, { run }),
    blocked.findMarker([SID], OTHER_MARKER, { run })]), delay(3000).then(() => "kept waiting")]);
  assert.deepEqual(answers, ["found", "found", "found", "pending"]);
  assert.equal(scans, 1, "no scan made for it");
  held.open(); await polling;
}));

test("a rescan asked while the first import runs waits for it: the two never read the same logs at once", async () => fixture(async (root, ingester) => {
  await writeFile(join(root, "s.jsonl"), line(user("s", NOW - 60_000)) + line(assistant("s", "a")));
  const internals = ingester as unknown as { read: (...args: unknown[]) => Promise<void> }, read = internals.read.bind(ingester);
  internals.read = async (...args) => { await delay(400); return read(...args); };
  const backfill = ingester.backfillAll();
  while (!ingester.backfill.files) await delay(5); // its scan is done; its import is reading
  const rescanned = ingester.poll(true).then(() => ingester.backfill.done);
  await backfill;
  assert.equal(await rescanned, true);
}));

/**
 * Runs `body` while the first `times` opens of `path` (findMarker's reads; nothing else opens it meanwhile) change the file:
 * `opened` before the read's first stat, `stat` just after it (before a byte is read), `first` after its first read (the last
 * chunk), `read` once the log's first byte was read (read back from the end, that is the whole log). Real files and real reads:
 * only the moment of the change is chosen.
 */
async function whileRead<T>(path: string, hooks: { opened?: () => Promise<unknown>; stat?: () => Promise<unknown>; first?: () => Promise<unknown>; read?: () => Promise<unknown> },
  body: () => Promise<T>, times = 1): Promise<{ result: T; opens: number }> {
  const patched = fsp as unknown as { open: (...args: unknown[]) => Promise<FileHandle> }, original = patched.open;
  let opens = 0;
  patched.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]) !== path || ++opens > times) return handle;
    await hooks.opened?.();
    let stated = false, reads = 0;
    return new Proxy(handle, { get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      if (key === "stat") return async (...options: unknown[]) => { const details = await value.apply(target, options); if (!stated) { stated = true; await hooks.stat?.(); } return details; };
      if (key === "read") return async (...read: unknown[]) => {
        const result = await value.apply(target, read);
        if (!reads++) await hooks.first?.();
        if (read[3] === 0) await hooks.read?.();
        return result;
      };
      return value.bind(target);
    } });
  };
  syncBuiltinESMExports();
  try { const result = await body(); return { result, opens }; }
  finally { patched.open = original; syncBuiltinESMExports(); }
}
/** Writes a log and lets it rest (last changed longer than MARKER_REST ago, as a log no one is writing); the ingester reads it, as its poll does. */
async function settled(ingester: TokenIngester, path: string, text: string): Promise<void> { await writeFile(path, text); await delay(MARKER_REST + 30); await ingester.poll(); }

test("findMarker reads a log again when it changed while read, and tells absent only from a read it did not change under (codex-obs-resume-recheck4-F1)", async () => fixture(async (root, ingester, source, clock) => {
  const path = join(root, `${SID}.jsonl`), plain = line(user(SID, NOW - 60_000));
  // A line as long as the prompt's, to rewrite the log in place at its length.
  const prompted = plain + fired(SID), blank = plain + " ".repeat(Buffer.byteLength(fired(SID)) - 1) + "\n";
  assert.equal(Buffer.byteLength(prompted), Buffer.byteLength(blank));
  await settled(ingester, path, plain);
  await ingester.backfillAll();
  const decide = decider(ingester, source, clock), decideRun = () => decide([SID], MARKER);
  // Appended after the read's first stat: that read stops at the old end, the next one reads the prompt.
  assert.deepEqual(await whileRead(path, { stat: () => appendFile(path, fired(SID)) }, decideRun), { result: "found", opens: 2 });
  // Appended without it: read again, unchanged this time, and only then told absent.
  await settled(ingester, path, plain);
  assert.deepEqual(await whileRead(path, { stat: () => appendFile(path, line(assistant(SID, "b"))) }, decideRun), { result: "absent", opens: 2 });
  // Replaced at its path (the old file renamed away, a new one written): the old one was read, the new one shows the prompt.
  await settled(ingester, path, plain);
  const replace = (text: string) => async () => { await rename(path, `${path}.old`); await writeFile(path, text); };
  assert.deepEqual(await whileRead(path, { stat: replace(prompted) }, decideRun), { result: "found", opens: 2 });
  // Replaced by one without it: what the old one held is gone, so nothing is told.
  await settled(ingester, path, plain);
  assert.deepEqual(await whileRead(path, { stat: replace(plain) }, decideRun), { result: "unknown", opens: 2 });
  // Rewritten in place at its length once read whole: only its times moved.
  await settled(ingester, path, blank);
  assert.deepEqual(await whileRead(path, { read: () => writeFile(path, prompted) }, decideRun), { result: "found", opens: 2 });
  await settled(ingester, path, prompted.replace(RUN, OTHER_MARKER.slice(4)));
  assert.deepEqual(await whileRead(path, { read: () => writeFile(path, blank) }, decideRun), { result: "unknown", opens: 2 }, "rewritten without it: not told absent");
  // Cut short once read whole: shrunk.
  await settled(ingester, path, blank);
  assert.deepEqual(await whileRead(path, { read: () => truncate(path, Buffer.byteLength(plain)) }, decideRun), { result: "unknown", opens: 2 });
  // Cut short while read (grown by two chunks since the ingester read it, shrunk once the last was read, though not below what the
  // index knew): the chunk before it comes back short.
  await settled(ingester, path, plain);
  await appendFile(path, " ".repeat(2 * MARKER_CHUNK) + "\n"); await delay(MARKER_REST + 30);
  assert.deepEqual(await whileRead(path, { first: () => truncate(path, Buffer.byteLength(plain) + MARKER_CHUNK / 2) }, decideRun), { result: "unknown", opens: 2 });
  // Changing on every read: MARKER_READS reads, then nothing told.
  await settled(ingester, path, plain);
  assert.deepEqual(await whileRead(path, { stat: () => appendFile(path, line(assistant(SID, "c"))) }, decideRun, Infinity), { result: "unknown", opens: MARKER_READS });
  // The look at a tail (a run still going) reads once and only finds: unchanged.
  await settled(ingester, path, plain);
  assert.deepEqual(await whileRead(path, { stat: () => appendFile(path, fired(SID)) }, () => source.findMarker([SID], MARKER)), { result: "unknown", opens: 1 });
  assert.deepEqual(await whileRead(path, { stat: () => appendFile(path, line(assistant(SID, "d"))) }, () => source.findMarker([SID], MARKER)), { result: "found", opens: 1 });
  // Its directory replaced while read (moved away, a new one holding the prompt in its place): the file read was not touched, so
  // none of its times moved, but its path now names another file.
  const moved = "7a7a7a7a-0000-4000-8000-00000000000b", folder = join(root, "project"), nested = join(folder, `${moved}.jsonl`);
  await mkdir(folder); await writeFile(nested, line(user(moved, NOW - 60_000))); await delay(MARKER_REST + 30);
  assert.equal(await decide([moved], MARKER), "absent", "indexed by the ledger's scan (the only other open of it)");
  const swap = async () => { await rename(folder, `${folder}-old`); await mkdir(folder); await writeFile(nested, line(user(moved)) + fired(moved)); };
  assert.deepEqual(await whileRead(nested, { stat: swap }, () => decide([moved], MARKER)), { result: "found", opens: 2 });
}));

test("findMarker reads a log again when it changed within one tick of the file system clock, which moves none of its times (codex-obs-resume-recheck4-F1)", async () => fixture(async (root, ingester, source, clock) => {
  const path = join(root, `${SID}.jsonl`), plain = line(user(SID, NOW - 60_000));
  const prompted = plain + fired(SID), blank = plain + " ".repeat(Buffer.byteLength(fired(SID)) - 1) + "\n";
  await settled(ingester, path, blank);
  await ingester.backfillAll();
  const decide = decider(ingester, source, clock);
  // Written just as the read opens it, and again (with the prompt, at the same length) once it was read: on a clock that moves
  // in ticks of some milliseconds both writes usually leave the same times, so only how recently it changed shows it.
  for (let round = 0; round < 5; round++) {
    await settled(ingester, path, blank);
    const run = await whileRead(path, { opened: () => writeFile(path, blank), read: () => writeFile(path, prompted) }, () => decide([SID], MARKER));
    assert.deepEqual(run, { result: "found", opens: 2 }, `round ${round}`);
  }
  // A log no one writes is told absent at the first read.
  await settled(ingester, path, blank);
  assert.deepEqual(await whileRead(path, {}, () => decide([SID], MARKER)), { result: "absent", opens: 1 });
}));
