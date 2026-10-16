import assert from "node:assert/strict";
import test from "node:test";
import { findChangeRequest } from "../shared/change-request";
import { enrichAgents } from "../shared/background";
import { normalizeAgent } from "../shared/model";

test("a reply's merge or pull request becomes a short label; the last one mentioned wins (opus-B16)", () => {
  assert.deepEqual(findChangeRequest("已提交 MR：https://git.example.com/team/app/-/merge_requests/128，等你审。"), { url: "https://git.example.com/team/app/-/merge_requests/128", label: "!128", kind: "mr" });
  assert.deepEqual(findChangeRequest("PR: https://forge.example.org/team/app/pull/34."), { url: "https://forge.example.org/team/app/pull/34", label: "#34", kind: "pr" });
  assert.equal(findChangeRequest("旧的 https://forge.example.org/a/b/pull/1 已关闭，新的是 https://forge.example.org/a/b/pull/2")?.label, "#2");
  assert.equal(findChangeRequest("见 https://forge.example.org/a/b/pull/12/files"), null, "a sub-page is not the request itself");
  assert.equal(findChangeRequest("没有链接，只有 #12 和 !34"), null);
  assert.equal(findChangeRequest(null), null);
  // A push URL with credentials keeps only the address.
  assert.equal(findChangeRequest("推送到 https://oauth2:QX7-token-0123@git.example.test/g/p/-/merge_requests/5 了")?.url, "https://git.example.test/g/p/-/merge_requests/5");
  assert.equal(findChangeRequest("https://user@git.example.test/g/p/-/merge_requests/6")?.url, "https://git.example.test/g/p/-/merge_requests/6");
  // Only the end of a huge reply is scanned, in linear time.
  const long = `${"x ".repeat(200_000)}https://git.example.com/a/b/-/merge_requests/9`;
  const started = Date.now();
  assert.equal(findChangeRequest(long)?.label, "!9");
  assert.ok(Date.now() - started < 500);
});

test("the link reaches the row through the page's enrichment, also while the Agent runs", () => {
  const link = { url: "https://forge.example.org/a/b/pull/5", label: "#5", kind: "pr" as const };
  const running = normalizeAgent({ id: "a", status: "running", activeTurn: { startedAt: "2026-10-11T00:00:00.000Z" } });
  const telemetry = { startedAt: "2026-10-10T00:00:00.000Z", persistenceError: null, events: [], agents: [{ agentId: "a", turnStartedAt: null, turnEndedAt: null, outcome: null, completedTurns: 1, failedTurns: 0, canceledTurns: 0, totalRunMs: 0, permissionWaitMs: 0, link }] };
  assert.deepEqual(enrichAgents([running], telemetry)[0]!.changeRequest, link);
});
