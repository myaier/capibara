import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { dismissNotices, expireDismissals, hasUndismissed, NOTICE_RECOVERY_MS } from "../shared/notices";

test("a closed notice stays hidden until a new problem joins it", () => {
  const dismissed = dismissNotices([], ["fleet:a"]);
  assert.equal(hasUndismissed(["fleet:a"], dismissed), false);
  assert.equal(hasUndismissed(["fleet:a", "fleet:b"], dismissed), true, "another machine brings it back");
  assert.equal(hasUndismissed([], dismissed), false);
});

test("a closed problem is forgotten only after it has been gone for the recovery window", () => {
  const clearSince = new Map<string, number>();
  const dismissed = ["fleet:a", "sync:a"];
  assert.equal(expireDismissals(dismissed, new Set(["fleet:a", "sync:a"]), clearSince, 0), null, "still present");
  assert.equal(expireDismissals(dismissed, new Set(["fleet:a"]), clearSince, 1_000), null, "just cleared");
  assert.equal(expireDismissals(dismissed, new Set(["fleet:a", "sync:a"]), clearSince, 60_000), null, "flickered back: stays closed");
  assert.equal(expireDismissals(dismissed, new Set(["fleet:a"]), clearSince, 61_000), null);
  assert.deepEqual(expireDismissals(dismissed, new Set(["fleet:a"]), clearSince, 61_000 + NOTICE_RECOVERY_MS), ["fleet:a"], "gone long enough");
});

test("the dismissal list stays bounded", () => {
  const many = Array.from({ length: 80 }, (_, index) => `fleet:${index}`);
  assert.equal(dismissNotices([], many).length, 64);
  assert.equal(dismissNotices([], many).at(-1), "fleet:79", "the newest closures are kept");
});

test("every notice on the page can be closed", () => {
  const dashboard = readFileSync(join(__dirname, "..", "client", "dashboard.tsx"), "utf8");
  const lines = dashboard.split("\n").filter(line => /<Banner key="(sync|truncated|telemetry|persist|receipts|preferences)"/.test(line));
  assert.equal(lines.length, 6);
  for (const line of lines) assert.match(line, /onDismiss=\{\(\) => dismiss\(/, line.slice(0, 60));
  assert.match(dashboard, /<FleetCoverageNotice key="fleet" theme=\{theme\} dismissed=\{dismissedNotices\} onDismiss=\{dismiss\}/);
});
