import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTimelinePage } from "../shared/timeline";
import { buildActivity } from "../server/digest/activity";
import { buildAggregates } from "../server/digest/aggregates";
import { compactRow, createFold, foldRows } from "../server/digest/fold";

function fixture(tools: Array<Record<string, unknown>>) {
  const entries = [{ type: "user_message", text: "synthetic" }, ...tools, { type: "assistant_message", text: "done" }]
    .map((item, i) => ({ item, turnId: "t1", seqStart: i + 1, seqEnd: i + 1, timestamp: new Date(i * 1000).toISOString() }));
  const state = foldRows(createFold("a", "/repo", "e"), normalizeTimelinePage({ epoch: "e", entries }).rows.map(row => compactRow(row, "/repo")));
  const { turns } = buildActivity(state, { now: 10000, status: "idle" });
  return { ...buildAggregates(state, turns, 10000), turns, state };
}
const tool = (id: string, status: string, detail: Record<string, unknown>) => ({ type: "tool_call", callId: id, name: "Tool", status, detail });

test("files reuse diff counts, relative paths and final lifecycle details exactly once", () => {
  const result = fixture([tool("read", "completed", { type: "read", filePath: "/repo/a.ts" }),
    tool("edit", "running", { type: "edit", filePath: "/repo/a.ts", unifiedDiff: "--- a.ts\n+++ a.ts\n-old\n+new\n+added\n" }),
    tool("edit", "completed", { type: "edit", filePath: "/repo/a.ts" }),
    tool("write", "completed", { type: "write", filePath: "/outside/b.ts", content: "one\r\ntwo\n" })]);
  assert.deepEqual(result.files.map(f => [f.path, f.reads, f.edits, f.added, f.removed]), [["a.ts", 1, 1, 2, 1], ["/outside/b.ts", 0, 1, 2, 0]]);
  assert.equal(result.editedFiles, 2); assert.equal(result.turns[0]!.tools, 3); assert.equal(result.turns[0]!.added, 4);
  assert.ok(!JSON.stringify([...result.state.tools.values()]).includes("unifiedDiff"));
});

test("commands/checks use nonzero exit status, preserve canonical seq and group programs", () => {
  const result = fixture([tool("a", "running", { type: "shell", command: "X=1 npx tsc --noEmit" }),
    tool("a", "completed", { type: "shell", exitCode: 2 }), tool("b", "completed", { type: "shell", command: "npx tsc --noEmit", exitCode: 0 }),
    tool("c", "completed", { type: "shell", command: "grep test package.json", exitCode: 0 }),
    tool("d", "canceled", { type: "shell", command: "pytest" })]);
  assert.equal(result.commands[0]!.program, "tsc"); assert.equal(result.commands[0]!.runs, 2); assert.equal(result.commands[0]!.failures, 1);
  assert.deepEqual(result.checks.map(c => [c.kind, c.ok, c.seq]), [["typecheck", false, 2], ["typecheck", true, 4], ["test", null, 6]]);
  assert.equal(result.turns[0]!.commands, 4); assert.equal(result.turns[0]!.checksPassed, 1); assert.equal(result.turns[0]!.checksFailed, 1);
});

test("all tool detail kinds map to the expected lanes, including web search and todo", () => {
  const types = [{ type: "shell", command: "echo ok" }, { type: "read", filePath: "a" }, { type: "edit", filePath: "b" },
    { type: "write", filePath: "c" }, { type: "search", query: "q" }, { type: "search", query: "q", toolName: "web_search" },
    { type: "fetch", url: "https://example.com/private/path?q=secret" }, { type: "sub_agent", description: "Review", log: "private" },
    { type: "plan", text: "private" }, { type: "unknown", input: "private", output: "private" }];
  const { state, turns } = fixture([...types.map((detail, i) => tool(String(i), "completed", detail)), { type: "todo", items: [] }]);
  assert.deepEqual([...state.tools.values()].map(t => t.lane), ["shell", "read", "edit", "edit", "search", "web", "web", "agent", "plan", "other", "plan"]);
  assert.equal([...state.tools.values()][6]!.target, "example.com"); assert.equal(turns[0]!.lanes.model, 0); assert.equal(turns[0]!.lanes.wait, 0);
});

test("path excerpt collisions retain distinct file counts and sparse shell exits remain sticky", () => {
  const prefix = "/repo/" + "long/".repeat(60);
  const result = fixture([tool("a", "completed", { type: "write", filePath: `${prefix}a`, content: "a" }),
    tool("b", "completed", { type: "write", filePath: `${prefix}b`, content: "b" }),
    tool("shell", "completed", { type: "shell", command: "npm test", exitCode: 1 }),
    tool("shell", "completed", { type: "shell" })]);
  assert.equal(result.editedFiles, 2); assert.equal(result.turns[0]!.files, 2); assert.equal(result.files.length, 2);
  assert.equal(result.checks[0]!.ok, false);
});
