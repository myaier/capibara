import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The dashboard is a React Native surface (no renderer in node tests): its banner wiring is checked in the source.
const dashboard = readFileSync(join(__dirname, "..", "client", "dashboard.tsx"), "utf8");

test("看板 shows the telemetry store's own Chinese sentence as it is, never behind the old 「事件无法保存：」 prefix (opus-F74)", () => {
  const banner = dashboard.split("\n").find(line => line.includes('key="persist"'));
  assert.ok(banner, "the persistence banner is still there");
  assert.match(banner, /message=\{telemetry\.persistenceError\}/, "the sentence says by itself whether saving failed or the saved history could not be read");
  assert.doesNotMatch(dashboard, /事件无法保存：/);
});

test("归档已读完成 is gated by the heartbeat guard and re-reads the heartbeats on its second tap (codex-F16)", () => {
  assert.match(dashboard, /heartbeatGuard\(heartbeats\.data, !!heartbeats\.error\)/, "a failed poll does not trust the data it kept");
  assert.match(dashboard, /confirmArchive\(archiveMarks, agents, harvestScope, await checkHeartbeats\(\), \{ truncated: data\.truncated \}\)/);
  assert.match(dashboard, /disabled: true, hint: `暂不可用：\$\{archiveOffer\.reason\}`/, "an untrusted read (or a cut list) leaves the entry disabled with its reason");
  assert.match(dashboard, /archiveReadCandidates\(agents, harvestScope, heartbeatState, \{ truncated: data\.truncated \}\)/, "a cut session list may hide the children archiving takes along");
  assert.doesNotMatch(dashboard, /byAgent\.get\(agent\.id\)\?\.some\(beat => beat\.status === "active"\)/, "the 500-item display list no longer decides alone");
});
