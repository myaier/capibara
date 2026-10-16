import assert from "node:assert/strict";
import test from "node:test";
import { boundProviderTimeline, createProviderSubagentBridge } from "../server/provider-subagents";

function fixture(timeout = 50) {
  let handler: (message: unknown) => void = () => {};
  let removed = false;
  const sent: unknown[] = [];
  const bridge = createProviderSubagentBridge({ send(message) { sent.push(message); }, listen(listener) { handler = listener; return () => { removed = true; }; } }, timeout);
  const respond = (payload: Record<string, unknown>, type = "answer") => handler({ type: "paseo_frame", isBinary: false, data: JSON.stringify({ type: "session", message: { type, payload } }) });
  const requestId = () => JSON.parse((sent[sent.length - 1] as { data: string }).data).message.requestId as string;
  return { bridge, respond, requestId, get removed() { return removed; } };
}
test("provider bridge correlates only its own response", async () => {
  const f = fixture(); const request = f.bridge.request({ type: "read" }, "answer");
  f.respond({ requestId: "foreign", subagents: ["wrong"] });
  f.respond({ requestId: f.requestId(), subagents: ["right"] });
  assert.deepEqual((await request).subagents, ["right"]); f.bridge.dispose(); assert.equal(f.removed, true);
});
test("provider refusal is visible rather than an empty successful list", async () => {
  const f = fixture(); const request = f.bridge.request({ type: "read" }, "answer");
  f.respond({ requestId: f.requestId(), error: "unsupported host" });
  await assert.rejects(request, /unsupported host/); f.bridge.dispose();
});
test("provider bridge has timeout and cleanup cancellation", async () => {
  const f = fixture(5); await assert.rejects(f.bridge.request({ type: "read" }, "answer"), /宿主未响应/);
  const pending = f.bridge.request({ type: "read" }, "answer"); f.bridge.dispose();
  await assert.rejects(pending, /插件重新加载/);
  await assert.rejects(f.bridge.request({ type: "read" }, "answer"), /已关闭/);
});
test("provider output budget covers the entire response", () => {
  const payload = boundProviderTimeline({ epoch: "one", rows: Array.from({ length: 100 }, (_, seq) => ({ seq, item: { type: "tool_call", detail: { output: "x".repeat(100000), input: { many: Array(100).fill("a".repeat(1000)) } } } })) });
  assert.equal(payload.truncated, true);
  assert.ok(JSON.stringify(payload).length < 260000);
  assert.equal((payload.rows as Array<{ item: { type: string } }>)[99].item.type, "tool_call");
});
test("native projected limit does not truncate old raw prefix and lose newest reply", () => {
  const raw = Array.from({ length: 670 }, (_, index) => ({ seq: index + 1, timestamp: "2026-09-16T18:00:00Z", item: { type: "assistant_message", messageId: "reply", text: String(index % 10) } }));
  raw.push({ seq: 671, timestamp: "2026-09-16T18:01:00Z", item: { type: "assistant_message", messageId: "latest", text: "newest result" } });
  const result = boundProviderTimeline({ epoch: "one", direction: "tail", rows: raw, window: { minSeq: 1, maxSeq: 671, nextSeq: 672 }, hasOlder: false, hasNewer: false });
  const rows = result.rows as Array<{ seqEnd: number; item: { text: string } }>;
  assert.equal(rows.length, 2); assert.equal(rows[0].item.text.length, 670);
  assert.equal(rows[1].item.text, "newest result"); assert.equal(rows[1].seqEnd, 671);
  assert.deepEqual(result.endCursor, { epoch: "one", seq: 671 });
});
test("capping projected pages preserves direction and reports accurate pagination", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ seq: index + 1, item: { type: "assistant_message", messageId: `message-${index}`, text: String(index) } }));
  const tail = boundProviderTimeline({ epoch: "e", direction: "tail", rows });
  assert.equal((tail.rows as unknown[]).length, 150); assert.equal(tail.hasOlder, true);
  assert.deepEqual(tail.startCursor, { epoch: "e", seq: 51 }); assert.deepEqual(tail.endCursor, { epoch: "e", seq: 200 });
  const after = boundProviderTimeline({ epoch: "e", direction: "after", rows });
  assert.equal(after.hasNewer, true); assert.deepEqual(after.endCursor, { epoch: "e", seq: 150 });
});
test("exhausted output budget never removes tool identities and titles", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, item: { type: "tool_call", callId: `tool-${index}`, name: "shell", status: "completed", detail: { type: "shell", command: `echo ${index}`, output: "x".repeat(100000) } } }));
  const result = boundProviderTimeline({ epoch: "e", direction: "tail", rows });
  const first = (result.rows as Array<{ item: Record<string, unknown> }>)[0].item;
  assert.equal(first.name, "shell"); assert.equal(first.callId, "tool-0"); assert.equal(first.status, "completed");
});
test("a host session close fails in-flight requests at once and holds new ones until the session re-attaches", async () => {
  let handler: (message: unknown) => void = () => {};
  const sent: Array<{ data: string }> = [];
  const bridge = createProviderSubagentBridge({ send(message) { sent.push(message as { data: string }); }, listen(listener) { handler = listener; return () => {}; } }, 10_000);
  const started = Date.now();
  const inFlight = bridge.request({ type: "read" }, "answer");
  handler({ type: "paseo_close" });
  await assert.rejects(inFlight, /重新连接/); assert.ok(Date.now() - started < 1_000, "no timeout wait");
  const queued = bridge.request({ type: "read" }, "answer");
  assert.equal(sent.length, 1, "frames sent while the session is closed would be dropped by the host");
  handler({ type: "paseo_frame", isBinary: false, data: JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info" } } }) });
  assert.equal(sent.length, 2);
  const requestId = JSON.parse(sent[1].data).message.requestId as string;
  handler({ type: "paseo_frame", isBinary: false, data: JSON.stringify({ type: "session", message: { type: "answer", payload: { requestId, subagents: ["ok"] } } }) });
  assert.deepEqual((await queued).subagents, ["ok"]);
  bridge.dispose();
});
test("frames without an observatory request id are never parsed", () => {
  let handler: (message: unknown) => void = () => {};
  createProviderSubagentBridge({ send() {}, listen(listener) { handler = listener; return () => {}; } });
  const parse = JSON.parse; let parsed = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { parsed++; return parse(text, reviver); }) as typeof JSON.parse;
  try { handler({ type: "paseo_frame", isBinary: false, data: JSON.stringify({ type: "session", message: { type: "agent_stream", payload: { text: "x".repeat(100_000) } } }) }); }
  finally { JSON.parse = parse; }
  assert.equal(parsed, 0);
});
test("requests queued while the host session is closed leave the queue when they time out, and the queue has its own cap", async () => {
  let handler: (message: unknown) => void = () => {};
  const sent: Array<{ data: string }> = [];
  const bridge = createProviderSubagentBridge({ send(message) { sent.push(message as { data: string }); }, listen(listener) { handler = listener; return () => {}; } }, 20);
  handler({ type: "paseo_close" });
  const timedOut = Array.from({ length: 5 }, () => bridge.request({ type: "read" }, "answer"));
  assert.equal(bridge.queued, 5);
  for (const request of timedOut) await assert.rejects(request, /宿主未响应/);
  assert.equal(bridge.queued, 0, "timed-out requests are removed from the queue");
  // While the session stays closed, at most 16 requests wait; the rest fail at once instead of piling up.
  const waiting = Array.from({ length: 16 }, () => bridge.request({ type: "read" }, "answer"));
  await assert.rejects(bridge.request({ type: "read" }, "answer"), /繁忙/);
  assert.equal(bridge.queued, 16);
  handler({ type: "paseo_frame", isBinary: false, data: JSON.stringify({ type: "session", message: { type: "status", payload: {} } }) });
  assert.equal(sent.length, 16, "only live requests are sent after the session re-attaches"); assert.equal(bridge.queued, 0);
  bridge.dispose();
  for (const request of waiting) await assert.rejects(request);
});
