import assert from "node:assert/strict";
import test from "node:test";
import { digestSchema } from "../shared/digest";
import { normalizeTimelinePage } from "../shared/timeline";
import { buildDigest } from "../server/digest/build";
import { compactRow } from "../server/digest/fold";
import { fetchHistory, type TimelineFetch } from "../server/digest/reader";

interface Entry {
  seqStart: number; seqEnd: number; timestamp: string; turnId: string;
  item: Record<string, unknown>; sourceSeqRanges?: Array<{ startSeq: number; endSeq: number }>;
}
const entry = (seqStart: number, seqEnd: number, at: number, item: Record<string, unknown>, turnId = "turn"): Entry =>
  ({ seqStart, seqEnd, timestamp: new Date(at).toISOString(), turnId, item });
const page = (entries: Entry[], extra: Record<string, unknown> = {}) => ({
  epoch: "projected-epoch", projection: "projected", entries, hasOlder: false, hasNewer: false, ...extra,
});
const shell = (status = "completed") => ({ type: "tool_call", callId: "shell", name: "Bash", status,
  detail: { type: "shell", command: "npm test", output: "OUTPUT_MUST_NOT_BE_RETAINED" } });
const read = (callId = "read") => ({ type: "tool_call", callId, name: "Read", status: "completed",
  detail: { type: "read", filePath: "/synthetic/example.ts", content: "CONTENT_MUST_NOT_BE_RETAINED" } });
function parallel(status = "completed"): Entry[] {
  return [entry(1, 1, 1000, { type: "user_message", text: "Run the synthetic checks" }),
    { ...entry(2, 6, 6000, shell(status)), sourceSeqRanges: [{ startSeq: 2, endSeq: 2 }, { startSeq: 6, endSeq: 6 }] },
    { ...entry(3, 7, 8000, read()), sourceSeqRanges: [{ startSeq: 3, endSeq: 3 }, { startSeq: 7, endSeq: 7 }] },
    entry(8, 10, 10000, { type: "assistant_message", messageId: "reply", text: "Checks finished" })];
}

test("projected parallel calls share the preceding event bound and keep timeline anchors", async () => {
  const requests: string[] = [];
  const history = await fetchHistory(async options => {
    requests.push(options.direction!); assert.equal(options.projection, "projected"); return page(parallel());
  }, "synthetic-agent", "/synthetic");
  assert.deepEqual(requests, ["tail"]);
  assert.ok(history.facts instanceof Map);
  assert.deepEqual([...history.facts.keys()], [1, 2, 3, 8]);
  assert.equal(history.state.rows, 4); assert.equal(history.state.lastSeq, 10);
  assert.deepEqual(history.cursor, { epoch: "projected-epoch", seq: 10 });
  const tools = [...history.state.tools.values()].sort((a, b) => a.seq - b.seq);
  assert.deepEqual(tools.map(tool => [tool.seq, tool.start, tool.end]), [[2, 1000, 6000], [3, 1000, 8000]]);
  const digest = buildDigest(history.state, { now: 12000, status: "idle" });
  assert.equal(digest.epoch, "projected-epoch"); assert.equal(digest.totals.tools, 2);
  assert.deepEqual(digest.segments.filter(segment => segment.lane === "model").map(segment => [segment.start, segment.end, segment.seq]), [[8000, 10000, 8]]);
  assert.deepEqual([digest.timeShare.shell, digest.timeShare.read, digest.timeShare.model, digest.activeMs], [5000, 2000, 2000, 9000]);
  assert.equal(digest.checks[0]?.seq, 2);
  for (const reference of [...digest.segments, ...digest.checks, ...digest.highlights]) {
    if (reference.seq !== null) assert.ok([2, 3, 8].includes(reference.seq));
  }
  assert.ok(!JSON.stringify([...history.facts.values()]).includes("MUST_NOT_BE_RETAINED"));
  digestSchema.parse(digest);
});

test("earlier-anchored projected updates replace facts and equal a full authoritative rebuild", async () => {
  const initial = parallel("running");
  const previous = await fetchHistory(async () => page(initial), "synthetic-agent", "/synthetic");
  const revisedTool = { ...initial[1]!, seqEnd: 11, timestamp: new Date(11000).toISOString(), item: shell("completed"),
    sourceSeqRanges: [{ startSeq: 2, endSeq: 2 }, { startSeq: 6, endSeq: 6 }, { startSeq: 11, endSeq: 11 }] };
  const revisedReply = { ...initial[3]!, seqEnd: 12, timestamp: new Date(12000).toISOString(),
    item: { type: "assistant_message", messageId: "reply", text: "Checks finished and all passed" } };
  const directions: string[] = [];
  const next = await fetchHistory(async options => {
    directions.push(options.direction!); assert.equal(options.projection, "projected");
    assert.deepEqual(options.cursor, { epoch: "projected-epoch", seq: 10 });
    return page([revisedTool, revisedReply]);
  }, "synthetic-agent", "/synthetic", previous);
  const rebuilt = await fetchHistory(async () => page([initial[0]!, revisedTool, initial[2]!, revisedReply]), "synthetic-agent", "/synthetic");
  assert.deepEqual(directions, ["after"]);
  assert.equal(next.facts.size, 4); assert.equal(next.state.rows, 4); assert.equal(next.state.tools.size, 2);
  assert.equal(next.state.lastSeq, 12); assert.equal(next.cursor?.seq, 12);
  assert.equal(next.state.turns[0]?.reply, "Checks finished and all passed");
  assert.deepEqual(next.state, rebuilt.state);
  const options = { now: 15000, status: "idle" };
  assert.deepEqual(buildDigest(next.state, options), buildDigest(rebuilt.state, options));
  assert.equal(previous.state.lastSeq, 10); assert.equal(previous.state.turns[0]?.reply, "Checks finished");
  assert.equal(previous.facts.get(2)?.lastSeq, 6);
  assert.equal([...previous.state.tools.values()].find(tool => tool.seq === 2)?.status, "running");
});

test("an empty projected increment leaves the fold and projected row coverage unchanged", async () => {
  const previous = await fetchHistory(async () => page(parallel()), "synthetic-agent", "/synthetic");
  const next = await fetchHistory(async options => {
    assert.equal(options.direction, "after"); assert.equal(options.projection, "projected");
    return page([], { endCursor: previous.cursor });
  }, "synthetic-agent", "/synthetic", previous);
  assert.deepEqual(next.state, previous.state); assert.deepEqual(next.facts, previous.facts);
  assert.equal(next.state.rows, 4); assert.deepEqual(next.cursor, previous.cursor);
});

test("a projected epoch replacement rebuilds from tail and drops all old anchors", async () => {
  const previous = await fetchHistory(async () => page(parallel()), "synthetic-agent", "/synthetic");
  const replacement = [entry(1, 1, 20000, { type: "user_message", text: "A fresh turn" }, "new-turn"),
    entry(2, 4, 22000, { type: "assistant_message", text: "Fresh reply" }, "new-turn")];
  const directions: string[] = [];
  const next = await fetchHistory(async options => {
    directions.push(options.direction!);
    return page(replacement, { epoch: "replacement-epoch", reset: options.direction === "after" });
  }, "synthetic-agent", "/synthetic", previous);
  assert.deepEqual(directions, ["after", "tail"]);
  assert.equal(next.state.epoch, "replacement-epoch"); assert.equal(next.state.tools.size, 0);
  assert.deepEqual([...next.facts.keys()], [1, 2]); assert.equal(next.state.rows, 2);
  const digest = buildDigest(next.state, { now: 25000, status: "idle" });
  assert.equal(digest.epoch, "replacement-epoch"); assert.equal(digest.turns[0]?.reply, "Fresh reply");
  assert.deepEqual(next.cursor, { epoch: "replacement-epoch", seq: 4 });
});

test("projected source ranges permit sequence gaps without a redundant tail rebuild", async () => {
  const previous = await fetchHistory(async () => page(parallel()), "synthetic-agent", "/synthetic");
  const additions: Entry[] = [
    { ...entry(11, 13, 13000, read("later-one")), sourceSeqRanges: [{ startSeq: 11, endSeq: 11 }, { startSeq: 13, endSeq: 13 }] },
    { ...entry(17, 20, 20000, read("later-two")), sourceSeqRanges: [{ startSeq: 17, endSeq: 17 }, { startSeq: 20, endSeq: 20 }] },
  ];
  const directions: string[] = [];
  const next = await fetchHistory(async options => {
    directions.push(options.direction!); return page(additions);
  }, "synthetic-agent", "/synthetic", previous);
  assert.deepEqual(directions, ["after"]);
  assert.equal(next.state.rows, 6); assert.equal(next.facts.size, 6); assert.equal(next.state.lastSeq, 20);
  assert.equal(next.state.truncated, false); assert.equal(next.state.tools.size, 4);
  assert.deepEqual([...next.facts.keys()], [1, 2, 3, 8, 11, 17]);
});

test("projected running tools extend to now only while their turn is active", async () => {
  const history = await fetchHistory(async () => page(parallel("running")), "synthetic-agent", "/synthetic");
  const active = buildDigest(history.state, { now: 20000, status: "running" });
  const stopped = buildDigest(history.state, { now: 20000, status: "idle" });
  assert.equal(active.segments.find(segment => segment.seq === 2)?.end, 20000);
  assert.equal(stopped.segments.find(segment => segment.seq === 2)?.end, 6000);
  assert.equal(active.turns[0]?.end, null); assert.equal(stopped.turns[0]?.end, 10000);
  assert.equal(stopped.commands[0]?.ms, 5000);
});

test("canonical responses remain supported with exact lifecycle timestamps", async () => {
  const entries = [entry(1, 1, 1000, { type: "user_message", text: "Synthetic canonical turn" }),
    entry(2, 2, 2000, shell("running")), entry(3, 3, 4000, shell("completed")),
    entry(4, 4, 5000, { type: "assistant_message", text: "Done" })];
  const fetch: TimelineFetch = async options => {
    assert.equal(options.projection, "projected"); return page(entries, { projection: "canonical" });
  };
  const history = await fetchHistory(fetch, "synthetic-agent", "/synthetic");
  assert.equal(history.state.rows, 4); assert.equal(history.state.tools.size, 1);
  const tool = [...history.state.tools.values()][0]!;
  assert.deepEqual([tool.start, tool.end, tool.seq], [2000, 4000, 2]);
  const normalized = normalizeTimelinePage(page(parallel())).rows;
  const compact = compactRow(normalized[1]!, "/synthetic", true);
  assert.equal(compact.seq, 2); assert.equal(compact.lastSeq, 6);
  assert.ok(!JSON.stringify(compact).includes("OUTPUT_MUST_NOT_BE_RETAINED"));
});

test("a limited projected after page cannot skip unseen anchors behind a long-running tool's end", async () => {
  const before = parallel("running");
  const previous = await fetchHistory(async () => page(before), "synthetic-agent", "/synthetic");
  const updated = { ...before[1]!, seqEnd: 100, timestamp: new Date(30000).toISOString(), item: shell("completed") };
  const unseen = entry(20, 30, 20000, read("unseen")), directions: string[] = [];
  const next = await fetchHistory(async options => {
    directions.push(options.direction!);
    return options.direction === "after" ? page([updated], { hasNewer: true }) : page([before[0]!, updated, before[2]!, before[3]!, unseen]);
  }, "synthetic-agent", "/synthetic", previous);
  assert.deepEqual(directions, ["after", "tail"]); assert.equal(next.facts.size, 5); assert.ok(next.facts.has(20));
  assert.equal(next.state.tools.size, 3); assert.equal(next.state.lastSeq, 100);
});
