import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLIPS, ENTER_MS, LANE, LEAVE_MS, LIFE, poseAt, routeAt, routeDuration } from "../client/plaza/motion";
import { DESK } from "../client/plaza/geometry";
import { ROOM_MAX, getPlazaLayout, tablesOf, type PlazaAgent } from "../client/plaza/layout";
import { viewPreferencesSchema, defaultViewPreferences } from "../shared/preferences";

const frames = JSON.parse(readFileSync(new URL("../assets/plaza/frames.json", import.meta.url), "utf8")) as { personas: Record<string, { frames: Record<string, unknown> }> };
const PHASES = ["running", "starting", "approval", "question", "plan", "idle", "error", "quota", "silent", "unfinished", "unread", "snoozed", "done", "quiet", "closed", "canceled"] as const;
const view = { width: 1180, height: 690 };

function agent(index: number, extra: Partial<PlazaAgent> = {}): PlazaAgent {
  return { id: `agent-${index}`, name: `Agent ${index}`, project: "Demo", host: null, checkout: "worktree", worktree: `tree-${index}`, parentId: null,
    provider: "codex", providerLabel: "Codex", seat: index, phase: "running", ...extra };
}
const team = (count: number, extra: (index: number) => Partial<PlazaAgent> = () => ({})) => Array.from({ length: count }, (_, index) => agent(index, extra(index)));
const overlaps = (a: { pos: [number, number]; seg: { w: number } }, b: typeof a) =>
  Math.abs(a.pos[1] - b.pos[1]) < 40 && a.pos[0] < b.pos[0] + b.seg.w - 0.5 && b.pos[0] < a.pos[0] + a.seg.w - 0.5;

test("every phase poses with frames that every colleague's atlas has", () => {
  for (const phase of PHASES) {
    assert.ok(CLIPS[phase], phase);
    for (const at of [0, 90, 700, 1600, 4200, 9100, 20000]) for (const persona of Object.values(frames.personas)) assert.ok(persona.frames[poseAt(phase, at, 5).frame], `${phase} @${at}`);
  }
  for (const step of [...CLIPS.walk!, ...CLIPS.sip!]) for (const persona of Object.values(frames.personas)) assert.ok(persona.frames[step.frame]);
});

test("typing keeps moving; closed and canceled hold still", () => {
  const seen = new Set(Array.from({ length: 40 }, (_, index) => poseAt("running", index * 90).frame));
  assert.ok(seen.has("focus_a") && seen.has("focus_b"));
  assert.deepEqual(poseAt("closed", 0), poseAt("closed", 12000));
  assert.deepEqual(poseAt("canceled", 0, 3), poseAt("canceled", 9000, 3));
});

test("a small team gets one room that grows with it; a bigger or mixed one gets project islands", () => {
  const widths = [];
  for (let count = 1; count <= ROOM_MAX; count++) {
    const layout = getPlazaLayout(team(count), view);
    assert.equal(layout.mode, "room");
    assert.equal(layout.desks.length, count);
    widths.push(layout.width);
  }
  assert.ok(widths[ROOM_MAX - 1]! > widths[0]!);
  assert.equal(getPlazaLayout(team(ROOM_MAX + 1), view).mode, "floor");
  assert.equal(getPlazaLayout(team(3, index => ({ project: index ? "Demo" : "Other" })), view).mode, "floor");
});

test("36 and 72 sessions each get one desk and desks never collide", () => {
  for (const count of [36, 72]) {
    const layout = getPlazaLayout(team(count, index => ({ project: `Project ${index % 6}`, checkout: index % 6 < 2 ? "local" : "worktree" })), view);
    assert.equal(layout.desks.length, count);
    assert.equal(new Set(layout.desks.map(desk => desk.agent.id)).size, count);
    for (let i = 0; i < layout.desks.length; i++) for (let j = i + 1; j < layout.desks.length; j++) assert.ok(!overlaps(layout.desks[i]!, layout.desks[j]!), `${count}: ${i}/${j}`);
    assert.ok(layout.scale > 0.25);
  }
});

test("local sessions share one pushed-together table; sub-agents sit at a smaller side desk", () => {
  const agents = [agent(0, { checkout: "local" }), agent(1, { checkout: "local" }), agent(2), agent(3, { parentId: "agent-2" })];
  const tables = tablesOf(agents);
  assert.deepEqual(tables.map(table => [table.kind, table.members.map(member => member.agent.id)]), [["local", ["agent-0", "agent-1"]], ["worktree", ["agent-2", "agent-3"]]]);
  const layout = getPlazaLayout(agents, view);
  const [first, second] = layout.desks.filter(desk => desk.seg.kind === "local");
  assert.ok(Math.abs(first!.pos[0] + first!.seg.w - second!.pos[0]) < 0.5 && first!.seg.joinR && second!.seg.joinL);
  const sub = layout.desks.find(desk => desk.agent.id === "agent-3")!;
  assert.ok(sub.seg.sub && sub.seg.scale < 1 && sub.seg.w < DESK.w);
});

test("grandchild sub-agents get a desk beside their top-level ancestor", () => {
  const agents = [agent(0), agent(1, { parentId: "agent-0" }), agent(2, { parentId: "agent-1" }), agent(3, { checkout: "local" }), agent(4, { parentId: "agent-3" })];
  const layout = getPlazaLayout(agents, view);
  assert.equal(layout.desks.length, 5);
  assert.deepEqual(tablesOf(agents).map(table => table.members.map(member => member.agent.id)), [["agent-0", "agent-1", "agent-2"], ["agent-3"], ["agent-4"]]);
});

test("arrivals walk in after the desk is built; departures pack up and are gone before the archive settles", () => {
  assert.equal(routeAt("entering", 300)!.opacity, 0);
  const walking = routeAt("entering", LIFE.build + 600)!;
  assert.ok(walking.walking && walking.opacity > 0.9);
  assert.equal(routeAt("entering", ENTER_MS + 10), null);
  assert.equal(routeAt("leaving", 100)!.act, "cheer");
  assert.equal(routeAt("leaving", LIFE.cheer + 100)!.frame, "folder_put_away");
  assert.ok(routeAt("leaving", LIFE.down + 50)!.carry);
  assert.equal(routeAt("leaving", LIFE.dismantle)!.lift, 0);
  assert.ok(LIFE.dismantle + LIFE.dismantleMs + 200 <= LEAVE_MS);
  assert.equal(routeAt("leaving", LEAVE_MS)!.opacity, 0);
});

test("walkers pass behind seated colleagues, face where they go, and the coffee run ends back in the seat", () => {
  const layout = getPlazaLayout(team(6, index => ({ phase: "quiet", checkout: "local" as const, seat: index })), view);
  for (const desk of layout.desks) for (const motion of ["coffee", "entering", "leaving"] as const) {
    const total = routeDuration(motion, desk.route);
    let previous = null as ReturnType<typeof routeAt>;
    for (let index = 0; index <= 600; index++) {
      const pose = routeAt(motion, (index / 600) * total, desk.route);
      if (!pose || pose.hidden) continue;
      if (pose.lift === 0 && Math.abs(pose.x) > 0.5) assert.ok(pose.z >= LANE - 0.5, `${motion}: x=${pose.x} z=${pose.z}`);
      if (previous && pose.walking && pose.lift === 0 && Math.abs(pose.x - previous.x) > 1) assert.equal(pose.flip, pose.x < previous.x);
      previous = pose;
    }
  }
  const coffee = layout.desks[0]!.route;
  const end = routeAt("coffee", routeDuration("coffee", coffee) - 1, coffee)!;
  assert.deepEqual([end.x, end.z, end.lift], [0, 0, 1]);
});

test("the list / plaza choice is an optional saved preference", () => {
  const base = defaultViewPreferences("host:global:overview");
  assert.equal(viewPreferencesSchema.parse({ ...base, sessionsView: "plaza" }).sessionsView, "plaza");
  assert.equal(viewPreferencesSchema.parse(base).sessionsView, undefined);
  assert.equal(viewPreferencesSchema.safeParse({ ...base, sessionsView: "grid" }).success, false);
});
