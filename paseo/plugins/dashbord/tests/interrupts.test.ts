import assert from "node:assert/strict";
import test from "node:test";
import { createInterruptGrace } from "../server/interrupts";

test("a failure right after 拒绝并中断 is the user's cancel; later failures stay failures", () => {
  let now = 1_000_000;
  const grace = createInterruptGrace(() => now);
  assert.equal(grace.outcome("a", "failed", "t0"), "failed");
  grace.note("a");
  now += 9_000;
  assert.equal(grace.outcome("b", "failed", "t9"), "failed", "per Agent");
  assert.equal(grace.outcome("a", "failed", "t1"), "canceled");
  assert.equal(grace.outcome("a", "failed", "t1"), "canceled", "every handler of the same turn end gets the same answer");
  assert.equal(grace.outcome("a", "failed", "t2"), "failed", "only the interrupted turn: a prompt sent right after that fails is a failure");
  grace.note("a");
  assert.equal(grace.outcome("a", "completed", "t3"), "completed");
  assert.equal(grace.outcome("a", "failed", "t4"), "failed", "the interrupted turn ended normally; the mark is used up");
  grace.note("a");
  now += 11_000;
  assert.equal(grace.outcome("a", "failed", "t5"), "failed", "the grace period is over");
});
