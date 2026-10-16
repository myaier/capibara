import assert from "node:assert/strict";
import test from "node:test";
import { buildTimeAxis, lanesIn, segmentsBetween, shareEntries, splitPath, turnSpan } from "../shared/digest-view";

const minute = 60_000;

test("a single span maps linearly across the full width", () => {
  const axis = buildTimeAxis([{ start: 0, end: 10 * minute }], 200);
  assert.equal(axis.pieces.length, 1);
  assert.equal(axis.breaks.length, 0);
  assert.equal(axis.x(0), 0);
  assert.equal(axis.x(5 * minute), 100);
  assert.equal(axis.x(10 * minute), 200);
  // Before the start clamps to 0, after the end to the right edge.
  assert.equal(axis.x(-minute), 0);
  assert.equal(axis.x(20 * minute), 200);
});

test("long idle gaps become fixed-width breaks and short ones stay linear", () => {
  const spans = [{ start: 0, end: 10 * minute }, { start: 11 * minute, end: 20 * minute }, { start: 200 * minute, end: 230 * minute }];
  const axis = buildTimeAxis(spans, 418, { gapMs: 2 * minute, breakWidth: 18, minPieceWidth: 16 });
  // The first two spans are 1 minute apart and join; the third is 3 hours later.
  assert.equal(axis.pieces.length, 2);
  assert.deepEqual(axis.breaks.map(item => ({ width: item.width, ms: item.ms })), [{ width: 18, ms: 180 * minute }]);
  const [first, second] = axis.pieces;
  assert.equal(first!.width + second!.width + 18, 418);
  // 20 vs 30 minutes share the 400 px after the minimum widths.
  assert.ok(Math.abs(first!.width - (16 + 368 * 20 / 50)) < 1e-9);
  assert.equal(axis.x(20 * minute), first!.width);
  // A time inside the break sits at the end of the piece before it; the next piece starts after the break.
  assert.equal(axis.x(100 * minute), first!.width);
  assert.equal(axis.x(200 * minute), first!.width + 18);
  // x never decreases with time.
  let last = -1;
  for (let at = -minute; at <= 240 * minute; at += 7 * minute) { const x = axis.x(at); assert.ok(x >= last); last = x; }
});

test("tiny spans keep a minimum width and an empty axis maps to 0", () => {
  const axis = buildTimeAxis([{ start: 0, end: 100 * minute }, { start: 1000 * minute, end: 1000 * minute + 1000 }], 300, { minPieceWidth: 20 });
  assert.ok(axis.pieces[1]!.width >= 20);
  assert.equal(buildTimeAxis([], 300).x(123), 0);
  assert.equal(buildTimeAxis([{ start: 0, end: 1 }], 0).pieces.length, 0);
});

test("lanes, clipping, time share and paths", () => {
  assert.deepEqual(lanesIn([{ lane: "shell" }, { lane: "model" }, { lane: "edit" }, { lane: "shell" }]), ["model", "edit", "shell"]);
  assert.deepEqual(segmentsBetween([{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }], 5, 25), [{ start: 5, end: 10 }, { start: 20, end: 25 }]);
  const share = { model: 60, read: 0, search: 0, edit: 10, shell: 30, web: 0, agent: 0, plan: 0, wait: 0, other: 0 };
  assert.deepEqual(shareEntries(share).map(entry => [entry.lane, entry.fraction]), [["model", 0.6], ["shell", 0.3], ["edit", 0.1]]);
  assert.deepEqual(turnSpan({ start: 5, end: null }, 50), { start: 5, end: 50 });
  assert.deepEqual(splitPath("src/payments/idempotency.ts"), { dir: "src/payments/", name: "idempotency.ts" });
  assert.deepEqual(splitPath("README.md"), { dir: "", name: "README.md" });
});
