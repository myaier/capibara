import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The server entry wires modules together; loading it would start every store, so its wiring is read from the source.
const server = readFileSync(join(__dirname, "..", "index.server.ts"), "utf8");

test("恢复后续跑 gets the provider session logs, the evidence a restart can leave (codex-obs-resume-F2)", () => {
  assert.match(server, /registerResume\(server, bridge, \{[^}]*\blogs: tokens\.source\b[^}]*\}\)/);
});

test("the send capabilities carry the built-in each custom provider extends (codex-obs-send-ui-F3)", () => {
  const handler = server.slice(server.indexOf("server.handle(getSteerableProviders"));
  assert.ok(handler.length > 0, "the handler is registered");
  assert.match(handler.slice(0, handler.indexOf("});")), /return steerableReply\(await capabilities\.value\);/);
});
