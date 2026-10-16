import assert from "node:assert/strict";
import test from "node:test";
import { digestSchema } from "../shared/digest";
import { normalizeTimelinePage } from "../shared/timeline";
import { buildDigest, MAX_DIGEST_BYTES } from "../server/digest/build";
import { compactRow, createFold, foldRows } from "../server/digest/fold";
import { fetchHistory } from "../server/digest/reader";
import type { TokenCall } from "../server/token-source";
import type { TelemetryEvent } from "../shared/telemetry";

function entries(count: number, wide = false) {
  return Array.from({ length: count }, (_, index) => {
    const seq = index + 1, phase = index % 100, turn = Math.floor(index / 100);
    const common = { seqStart: seq, seqEnd: seq, turnId: `t${turn}`, timestamp: new Date(1_780_000_000_000 + index * 1000).toISOString() };
    const text = wide ? "描述😀内容\n".repeat(1000) : "synthetic";
    if (phase === 0) return { ...common, item: { type: "user_message", text } };
    if (phase === 99) return { ...common, item: { type: "assistant_message", text } };
    const detail = phase % 6 < 2 ? { type: "shell", command: wide ? `npm test ${"测试".repeat(100)}` : "npm test", output: "BODY_MUST_NOT_LEAVE_SERVER", exitCode: phase % 10 === 0 ? 1 : 0 }
      : { type: "edit", filePath: `/repo/${wide ? "文件".repeat(115) : "file"}-${phase}.ts`, unifiedDiff: `--- a\n+++ b\n${"+line\n".repeat(100)}` };
    return { ...common, item: { type: "tool_call", callId: `${turn}:${Math.ceil(phase / 2)}`, name: detail.type === "shell" ? "Bash" : "Edit", status: phase % 2 ? "running" : "completed", detail } };
  });
}

test("the complete digest parses, keeps canonical references, and whole vs incremental builds agree", () => {
  const rows = normalizeTimelinePage({ epoch: "e", entries: entries(1000) }).rows.map(row => compactRow(row, "/repo"));
  const full = foldRows(createFold("a", "/repo", "e"), rows), incremental = foldRows(createFold("a", "/repo", "e"), rows.slice(0, 431));
  foldRows(incremental, rows.slice(431));
  const options = { now: 1_780_002_000_000, status: "idle" };
  const digest = buildDigest(full, options);
  assert.deepEqual(buildDigest(incremental, options), digest); assert.deepEqual(digestSchema.parse(digest), digest);
  assert.equal(digest.totals.turns, 10); assert.equal(digest.totals.tools, 490); assert.equal(digest.epoch, "e");
  assert.equal(digest.activeMs, Object.values(digest.timeShare).reduce((a, b) => a + b, 0));
  assert.equal(digest.activeMs, digest.turns.reduce((sum, turn) => sum + (turn.end! - turn.start), 0));
  const seqs = new Set(rows.map(row => row.seq));
  for (const item of [...digest.segments, ...digest.checks, ...digest.highlights]) if (item.seq !== null) assert.ok(seqs.has(item.seq));
  assert.ok(!JSON.stringify(digest).includes("BODY_MUST_NOT_LEAVE_SERVER"));
});

test("worst-case Unicode excerpts, many turns/tools/checks and tokens fit the UTF-8 payload budget", context => {
  const rows = normalizeTimelinePage({ epoch: "e", entries: entries(8000, true) }).rows.map(row => compactRow(row, "/repo"));
  const calls: TokenCall[] = Array.from({ length: 2000 }, (_, i) => ({ at: rows[Math.min(i * 4, rows.length - 1)]!.at, start: null,
    model: null, input: 120000, cacheWrite: 30000, cacheRead: 200000, output: 1200, reasoning: 500, subagent: false }));
  const digest = buildDigest(foldRows(createFold("a", "/repo", "e"), rows), { now: rows.at(-1)!.at, status: "idle" }, { source: "codex", calls });
  const bytes = Buffer.byteLength(JSON.stringify(digest));
  assert.ok(bytes <= MAX_DIGEST_BYTES, `payload ${bytes}`); assert.ok(bytes < 60_000);
  assert.equal(digest.turns.length, 60); assert.equal(digest.totals.turns, 80); assert.equal(digest.coverage.truncated, true);
  assert.ok(digest.segments.length <= 800); assert.ok(digest.files.length <= 40); assert.ok(digest.commands.length <= 20);
  assert.ok(digest.checks.length <= 80); assert.ok(digest.highlights.length <= 30); assert.ok(digest.tokens!.calls.length <= 400);
  assert.equal(digest.tokens!.totals.calls, 2000); digestSchema.parse(digest);
  context.diagnostic(JSON.stringify({ rows: rows.length, bytes, turns: digest.turns.length, segments: digest.segments.length }));
});

test("5,000 canonical rows build under two seconds; incremental fetch+build stays below 150 ms", async context => {
  const all = entries(5000);
  const start = performance.now();
  const history = await fetchHistory(async () => ({ epoch: "e", entries: all }), "a", "/repo");
  const options = { now: 1_780_009_000_000, status: "idle" };
  buildDigest(history.state, options);
  const initialMs = performance.now() - start;
  const extra = { ...all.at(-1)!, seqStart: 5001, seqEnd: 5001, timestamp: new Date(options.now).toISOString(), item: { type: "assistant_message", text: " complete" } };
  const from = performance.now();
  const incremental = await fetchHistory(async () => ({ epoch: "e", entries: [extra] }), "a", "/repo", history);
  buildDigest(incremental.state, options);
  const incrementalMs = performance.now() - from;
  assert.ok(initialMs < 2000, `initial ${initialMs}`); assert.ok(incrementalMs < 150, `incremental ${incrementalMs}`);
  assert.equal(history.state.rows, 5000); assert.equal(incremental.state.rows, 5001);
  context.diagnostic(JSON.stringify({ rows: 5000, initialMs, incrementalMs }));
});

test("an empty timeline has no epoch, turns, segments or time", () => {
  const digest = buildDigest(createFold("a"), { now: 10000, status: "idle" });
  assert.equal(digest.epoch, null); assert.equal(digest.start, null); assert.equal(digest.end, null); assert.equal(digest.activeMs, 0);
  assert.equal(digest.turns.length, 0); assert.equal(digest.segments.length, 0);
});

test("thousands of short turns with a full telemetry window use indexed event matching", context => {
  const state = foldRows(createFold("a", "/repo", "e"), Array.from({ length: 5000 }, (_, index) => ({
    seq: index + 1, lastSeq: index + 1, at: index * 1000, type: "user_message", turnId: `t${index}`, text: "Go" })));
  const events: TelemetryEvent[] = Array.from({ length: 500 }, (_, index) => ({ id: String(index), agentId: "a", agentTitle: "",
    at: new Date(index * 10000 + 500).toISOString(), type: "turn_completed", label: "" }));
  const from = performance.now();
  const digest = buildDigest(state, { now: 5000000, status: "idle", events });
  const ms = performance.now() - from;
  assert.equal(digest.totals.turns, 5000); assert.ok(ms < 150, `indexed fold took ${ms}`);
  context.diagnostic(JSON.stringify({ turns: 5000, events: 500, ms }));
});

test("5,000 projected entries support a bounded earlier-anchor update and replay", async context => {
  const rows = Array.from({ length: 5000 }, (_, index) => ({ seqStart: index * 2 + 1, seqEnd: index * 2 + 2, turnId: "turn",
    timestamp: new Date(1_780_000_000_000 + index * 1000).toISOString(),
    item: index === 0 ? { type: "user_message", text: "Go" } : index === 4999 ? { type: "assistant_message", text: "Done" }
      : { type: "tool_call", callId: `call-${index}`, name: "Read", status: "completed", detail: { type: "read", filePath: "/repo/a" } } }));
  const from = performance.now();
  const first = await fetchHistory(async () => ({ epoch: "e", projection: "projected", entries: rows }), "a", "/repo");
  const options = { now: 1_780_010_000_000, status: "idle" };
  buildDigest(first.state, options); const initialMs = performance.now() - from;
  const update = { ...rows[1]!, seqEnd: 10001, timestamp: new Date(options.now).toISOString() };
  const incrementStart = performance.now();
  const next = await fetchHistory(async options => { assert.equal(options.direction, "after"); return { epoch: "e", projection: "projected", entries: [update] }; }, "a", "/repo", first);
  buildDigest(next.state, options); const incrementalMs = performance.now() - incrementStart;
  assert.equal(next.state.rows, 5000); assert.equal(next.facts.size, 5000); assert.equal(next.state.lastSeq, 10001);
  assert.ok(initialMs < 2000, `initial ${initialMs}`); assert.ok(incrementalMs < 150, `incremental ${incrementalMs}`);
  context.diagnostic(JSON.stringify({ projectedRows: 5000, initialMs, incrementalMs }));
});
