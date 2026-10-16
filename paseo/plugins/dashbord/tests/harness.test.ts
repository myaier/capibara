import test from "node:test";
import assert from "node:assert/strict";
import { harnessOf } from "../shared/harness";

test("a session's harness: built-in ids, custom providers by what they extend or name, short ids only exactly", () => {
  assert.equal(harnessOf("claude").name, "Claude Code");
  assert.equal(harnessOf("codex").name, "Codex");
  assert.equal(harnessOf("kimi").name, "Kimi");
  assert.equal(harnessOf("opencode").name, "OpenCode");
  assert.equal(harnessOf("team", { team: "codex" }).name, "Codex");
  assert.equal(harnessOf("my-claude").name, "Claude Code");
  assert.equal(harnessOf("codex-proxy").name, "Codex");
  assert.equal(harnessOf("pi").name, "Pi");
  assert.equal(harnessOf("pipeline").color, null, "pi only matches exactly");
  assert.deepEqual(harnessOf("acme"), { id: "acme", name: "acme", color: null, text: "A" });
});
