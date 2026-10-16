import assert from "node:assert/strict";
import test from "node:test";
import { buildDigest } from "../server/digest/build";
import { MAX_BYTES, MAX_ROWS, PAGE_SIZE, fetchHistory, jsonSize, type TimelineFetch } from "../server/digest/reader";

const at = (seq: number) => new Date(Date.UTC(2026, 9, 1) + seq * 1000).toISOString();
/** A synthetic projected history: a turn every ten entries, a shell call with `output` in each of the others. */
function history(length: number, output = "ok") {
  return Array.from({ length }, (_, index) => {
    const seq = index + 1, turnId = `turn-${Math.floor(index / 10)}`;
    return index % 10 ? { seqStart: seq, seqEnd: seq, timestamp: at(seq), turnId, item: { type: "tool_call", callId: `call-${seq}`, name: "Bash", status: "completed",
      detail: { type: "shell", command: "npm test", output, exitCode: 0 } } } : { seqStart: seq, seqEnd: seq, timestamp: at(seq), turnId, item: { type: "user_message", text: `step ${seq}` } };
  });
}
/** Pages like the daemon: a tail and `before` pages honour `limit`; each response is the projected entry window. */
function daemon(entries: ReturnType<typeof history>) {
  const requests: Array<{ direction: string; limit: number; cursor?: number; ticks: number }> = [];
  let ticks = 0, spinning = true;
  const spin = () => { ticks++; if (spinning) setImmediate(spin); }; setImmediate(spin);
  const fetch: TimelineFetch = async options => {
    const limit = options.limit ?? 0, cursor = options.cursor?.seq;
    requests.push({ direction: options.direction!, limit, ...(cursor === undefined ? {} : { cursor }), ticks });
    const eligible = options.direction === "before" ? entries.filter(entry => entry.seqStart < cursor!) : entries;
    const selected = eligible.slice(-limit);
    return { epoch: "synthetic", projection: "projected", entries: selected, hasOlder: selected.length < eligible.length, hasNewer: false,
      startCursor: selected.length ? { epoch: "synthetic", seq: selected[0]!.seqStart } : null, endCursor: entries.length ? { epoch: "synthetic", seq: entries.at(-1)!.seqEnd } : null };
  };
  return { fetch, requests, stop: () => { spinning = false; } };
}

test("a first read pages backwards in bounded batches and yields to the event loop between them", async () => {
  const source = daemon(history(1_800));
  try {
    const result = await fetchHistory(source.fetch, "synthetic-agent", "/synthetic");
    assert.deepEqual(source.requests.map(({ direction, limit, cursor }) => [direction, limit, cursor ?? null]),
      [["tail", PAGE_SIZE, null], ["before", PAGE_SIZE, 1_301], ["before", PAGE_SIZE, 801], ["before", PAGE_SIZE, 301]]);
    assert.ok(source.requests.every(request => request.limit <= PAGE_SIZE && PAGE_SIZE <= 1_000));
    // Other macrotasks ran between every two batches.
    assert.ok(source.requests.every((request, index) => !index || request.ticks > source.requests[index - 1]!.ticks));
    assert.equal(result.facts.size, 1_800); assert.equal(result.state.rows, 1_800); assert.equal(result.state.truncated, false);
    assert.deepEqual(result.cursor, { epoch: "synthetic", seq: 1_800 }); assert.equal(result.state.turns.length, 180);
  } finally { source.stop(); }
});

test("the byte budget stops a first read early and marks the digest truncated", async () => {
  // About 21 KB per entry: two batches pass 16 MB, so the third is never requested.
  const output = "x".repeat(21_000), source = daemon(history(3_000, output));
  try {
    const result = await fetchHistory(source.fetch, "synthetic-agent", "/synthetic");
    assert.deepEqual(source.requests.map(request => request.direction), ["tail", "before"]);
    assert.ok(2 * PAGE_SIZE * output.length >= MAX_BYTES);
    assert.equal(result.facts.size, 2 * PAGE_SIZE); assert.equal(result.state.truncated, true);
    assert.equal(Math.min(...result.facts.keys()), 2_001, "the newest history is the part that is kept");
    assert.ok(!JSON.stringify([...result.facts.values()]).includes(output.slice(0, 64)), "outputs are never retained");
    const digest = buildDigest(result.state, { now: Date.parse(at(3_100)), status: "idle" });
    assert.equal(digest.coverage.truncated, true); assert.equal(digest.coverage.rows, 2 * PAGE_SIZE);
  } finally { source.stop(); }
});

test("MAX_ROWS still bounds the window; batches never ask for more than the remaining room", async () => {
  const source = daemon(history(MAX_ROWS + 1_200));
  try {
    const result = await fetchHistory(source.fetch, "synthetic-agent", "/synthetic");
    assert.equal(source.requests.length, MAX_ROWS / PAGE_SIZE);
    assert.ok(source.requests.every(request => request.limit === PAGE_SIZE));
    assert.equal(result.facts.size, MAX_ROWS); assert.equal(result.state.truncated, true);
    assert.equal(Math.min(...result.facts.keys()), 1_201);
  } finally { source.stop(); }
  const short = daemon(history(PAGE_SIZE - 20));
  try {
    const result = await fetchHistory(short.fetch, "synthetic-agent", "/synthetic");
    assert.equal(short.requests.length, 1); assert.equal(result.state.truncated, false); assert.equal(result.facts.size, PAGE_SIZE - 20);
  } finally { short.stop(); }
});

test("the size estimate tracks serialized JSON without building it", () => {
  for (const value of [history(40, "y".repeat(5_000)), history(3), { nested: [[1, true, null], { text: "中文输出", deep: { a: "b" } }] }]) {
    const real = JSON.stringify(value).length, estimate = jsonSize(value);
    assert.ok(estimate >= real * 0.9 && estimate <= real * 1.25, `${estimate} vs ${real}`);
  }
});
