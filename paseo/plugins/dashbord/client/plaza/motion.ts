// Pose schedules and walking routes for the capybara frames: pure functions of elapsed time,
// so tests, pausing and replays stay simple.
export type PlazaPhase = "running" | "starting" | "approval" | "question" | "plan" | "idle" | "error" | "quota" | "silent" | "unfinished" | "unread" | "snoozed" | "done" | "quiet" | "closed" | "canceled";
export type Motion = "entering" | "leaving" | "coffee";
export interface Step { frame: string; ms: number }
export interface Route { door?: readonly [number, number]; aisle?: readonly [number, number]; coffee?: readonly [number, number] }
export interface Pose { frame: string; x: number; z: number; lift: number; flip: boolean; walking: boolean; opacity: number; step?: number; hidden?: boolean; carry?: boolean; act?: string; waving?: boolean }
type Segment = { ms: number; at: (t: number) => Partial<Pose> & { frame: string; x: number; z: number; lift: number } };

const s = (frame: string, ms: number): Step => ({ frame, ms });
// typing comes in bursts with short pauses (v7 focused face; v6 blink between bursts)
const TYPING = [
  s('focus_a', 160), s('focus_b', 160), s('focus_a', 170), s('focus_b', 180), s('focus_a', 150), s('focus_b', 170),
  s('focus_a', 760), s('typing_blink', 120), s('focus_a', 480),
  s('focus_b', 170), s('focus_a', 160), s('focus_b', 160), s('focus_a', 180), s('focus_b', 150), s('focus_a', 170), s('focus_b', 160),
  s('focus_a', 1200), s('typing_blink', 110), s('focus_a', 300),
];

// each state gets its own face: v7 expressions carry the emotion, v6 poses add the action between them
export const CLIPS: Record<string, Step[]> = {
  running: TYPING,
  starting: [s('relaxed', 900), s('typing_blink', 110), s('relaxed', 700), s('focus_a', 220), s('focus_b', 200), s('focus_a', 220), s('relaxed', 1400), s('typing_blink', 110), s('relaxed', 500)],
  approval: [s('hopeful', 4200), s('awaiting_approval', 900), s('hopeful', 3400)],
  question: [s('ponder', 2600), s('puzzled', 1300), s('ponder', 3000), s('awaiting_reply', 900)],
  plan: [s('proud_plan', 2400), s('plan_point', 1700), s('proud_plan', 1800), s('plan_point', 1200)],
  idle: [s('awaiting_reply', 3200), s('relaxed', 1300), s('awaiting_reply', 2400), s('typing_blink', 110), s('relaxed', 700)],
  error: [s('surprised', 1300), s('teary', 4200), s('surprised', 500), s('teary', 3000)],
  quota: [s('drained', 4200), s('hourglass_wait', 1600), s('drained', 3400)],
  silent: [s('blank', 2800), s('plan_hold', 1200), s('blank', 2400), s('relaxed', 700)],
  unfinished: [s('unfinished_dazed', 3400), s('plan_hold', 1000), s('unfinished_dazed', 3000)],
  unread: [s('smug', 2600), s('envelope_offer', 1500), s('smug', 2400)],
  snoozed: [s('envelope_hold', 10000)],
  done: [s('folder_put_away', 1300), s('overjoyed', 2200), s('relaxed', 5000), s('typing_blink', 110), s('relaxed', 3000)],
  quiet: [s('cozy', 2600), s('mug_drink', 950), s('mug_eyes_closed', 600), s('mug_hold', 2600), s('cozy', 2400)],
  closed: [s('relaxed', 10000)],
  canceled: [s('resigned', 10000)],
  walk: [s('walk_left', 170), s('walk_right', 170)],
  sip: [s('mug_hold', 1500), s('mug_drink', 1100), s('mug_eyes_closed', 900), s('mug_hold', 1400)],
};

// one-off openings play once, then the clip loops
const INTRO: Record<string, number> = { done: 2, error: 1 };
const STILL = new Set(['closed', 'canceled', 'snoozed']);

export const TYPING_FRAMES = new Set(['typing_a', 'typing_b', 'typing_blink', 'focus_a', 'focus_b']);

export function poseAt(phase: string, elapsed: number, seed = 0): Step {
  const clip = CLIPS[phase] ?? CLIPS.quiet!;
  if (STILL.has(phase)) return clip[0];
  const intro = INTRO[phase] ?? 0;
  const introMs = clip.slice(0, intro).reduce((n, step) => n + step.ms, 0);
  if (elapsed < introMs) {
    let at = elapsed;
    for (const step of clip.slice(0, intro)) { if (at < step.ms) return step; at -= step.ms; }
  }
  const loop = clip.slice(intro), total = loop.reduce((n, step) => n + step.ms, 0);
  // stagger colleagues so a room never moves in unison
  let at = (elapsed - introMs + (['walk', 'sip'].includes(phase) ? 0 : (seed % 17) * 389)) % total;
  for (const step of loop) { if (at < step.ms) return step; at -= step.ms; }
  return loop[0]!;
}

// ---------------------------------------------------------------- routes
// A route is a list of segments in world units relative to the seat (x right, z into the room).
// Each segment returns {frame, x, z, lift, flip, walking, opacity}; lift 1 = seated, 0 = feet on the floor.
const WALK_SPEED = 0.13; // world units per ms
export const HOP_MS = 520;

// rises onto the seat with a small overshoot
export function hop(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.min(1.12, Math.sin(t * Math.PI * 0.5) * 1.12) - (t > 0.75 ? (t - 0.75) * 0.48 : 0);
}

const seg = {
  sit: (ms: number, phase: string): Segment => ({ms, at: t => ({frame: poseAt(phase, t).frame, x: 0, z: 0, lift: 1})}),
  wave: (ms: number): Segment => ({ms, at: t => ({frame: t < 200 ? 'relaxed' : 'awaiting_approval', x: 0, z: 0, lift: 1, waving: t >= 200})}),
  down: (x = 0, z = 0): Segment => ({ms: HOP_MS * 0.8, at: t => ({frame: 'relaxed', x, z, lift: 1 - hop(t / (HOP_MS * 0.8)), walking: true})}),
  up: (x = 0, z = 0): Segment => ({ms: HOP_MS, at: t => ({frame: 'relaxed', x, z, lift: hop(t / HOP_MS), walking: t < HOP_MS})}),
  stand: (ms: number, [x, z]: readonly [number, number], phase: string): Segment => ({ms, at: t => ({frame: poseAt(phase, t).frame, x, z, lift: 0})}),
  walk: ([x0, z0]: readonly [number, number], [x1, z1]: readonly [number, number], flipWhenStill = false): Segment => {
    const ms = Math.max(1, Math.hypot(x1 - x0, z1 - z0) / WALK_SPEED);
    return {ms, at: t => {
      const k = Math.min(1, t / ms);
      return {frame: poseAt('walk', t).frame, x: x0 + (x1 - x0) * k, z: z0 + (z1 - z0) * k, lift: 0, flip: x1 < x0 - 0.5 || (Math.abs(x1 - x0) <= 0.5 && flipWhenStill), walking: true, step: t};
    }};
  },
};

function play(segments: Segment[], elapsed: number, { loop = false, fadeOut = 0 } = {}): Pose {
  const total = segments.reduce((n, g) => n + g.ms, 0);
  let t = loop ? elapsed % total : Math.min(elapsed, total - 0.001);
  for (const g of segments) {
    if (t < g.ms) {
      const p: Pose = { flip: false, walking: false, opacity: 1, ...g.at(t) };
      if (fadeOut && !loop) p.opacity = Math.max(0, Math.min(1, (total - elapsed) / fadeOut));
      return p;
    }
    t -= g.ms;
  }
  const last = segments[segments.length - 1]!;
  return { flip: false, walking: false, opacity: 1, ...last.at(last.ms) };
}

// Lifecycle beats. The desk build / dismantle (CSS) reads the same numbers through custom properties,
// so the walking and the furniture stay in step.
const BEATS = { build: 1000, cheer: 900, pack: 1200, wave: 520 };
const DOWN = BEATS.cheer + BEATS.pack + BEATS.wave;   // hops off the chair, box in arms
/** down: off the chair; dismantle: the desk folds away once the seat is empty. */
export const LIFE = { ...BEATS, down: DOWN, dismantle: DOWN + 500, dismantleMs: 800 } as const;

// route geometry: door (where colleagues enter/leave), an aisle to walk along, optional coffee spot
// arrivals and departures walk at most WALK_LIMIT so the lifecycle stays snappy; they fade at the far end
const WALK_LIMIT = 300;
const clampDoor = ([x, z]: readonly [number, number]): [number, number] => { const d = Math.hypot(x, z) || 1, k = Math.min(1, WALK_LIMIT / d); return [x * k, z * k]; };

// walkers never cross in front of seated colleagues: they step back behind their own chair onto
// this lane first, walk sideways only along it, and step forward again to sit down
export const LANE = 46;

const beat = (ms: number, fn: (t: number) => Partial<Pose> & { frame: string }): Segment => ({ ms, at: t => ({ x: 0, z: 0, lift: 1, ...fn(t) }) });
const carrying = (g: Segment): Segment => ({ ms: g.ms, at: t => ({ ...g.at(t), carry: true }) });

export function routeScript(motion: Motion | null, route: Route = {}): Segment[] | null {
  const door = clampDoor(route.door || [-WALK_LIMIT, 0]);
  const fromLeft = door[0] < 0;
  if (motion === 'entering') return [
    // the new desk is still being built: wait out of sight at the door
    {ms: LIFE.build, at: () => ({frame: 'walk_left', x: door[0], z: LANE, lift: 0, hidden: true})},
    seg.walk([door[0], LANE], [0, LANE]), seg.walk([0, LANE], [0, 0], !fromLeft), seg.up(),
  ];
  if (motion === 'leaving') return [
    // time to go home: paws up a few times
    beat(LIFE.cheer, t => ({frame: Math.floor(t / 180) % 2 ? 'overjoyed' : 'awaiting_approval', act: 'cheer'})),
    // pack the desk into a box
    beat(LIFE.pack, () => ({frame: 'folder_put_away', act: 'pack'})),
    // one last wave
    beat(LIFE.wave, () => ({frame: 'awaiting_approval', act: 'wave'})),
    carrying(seg.down()), carrying(seg.walk([0, 0], [0, LANE], fromLeft)), carrying(seg.walk([0, LANE], [door[0], LANE])),
  ];
  if (motion === 'coffee' && route.coffee) {
    const [ax] = route.aisle || [route.coffee[0], 0];
    const [cx, cz] = route.coffee;
    // depth-only legs keep facing the way the previous leg went, so nobody spins round at a corner
    const out = ax < 0, home = cx < ax;
    const there = [seg.down(), seg.walk([0, 0], [0, LANE], out), seg.walk([0, LANE], [ax, LANE]),
      seg.walk([ax, LANE], [ax, cz], out), seg.walk([ax, cz], [cx, cz], out)];
    const back = [seg.walk([cx, cz], [ax, cz], !home), seg.walk([ax, cz], [ax, LANE], !home),
      seg.walk([ax, LANE], [0, LANE]), seg.walk([0, LANE], [0, 0], !out), seg.up()];
    return [seg.sit(12000, 'quiet'), ...there, seg.stand(5200, [cx, cz], 'sip'), ...back, seg.sit(3000, 'quiet')];
  }
  return null;
}

export function routeDuration(motion: Motion | null, route?: Route): number {
  const script = routeScript(motion, route);
  return script ? script.reduce((n, g) => n + g.ms, 0) : 0;
}

// where a moving colleague is right now; null when it is simply sitting at its desk
export function routeAt(motion: Motion | null, elapsed: number, route?: Route): Pose | null {
  const script = routeScript(motion, route);
  if (!script) return null;
  if (motion === 'coffee') return play(script, elapsed, {loop: true});
  if (motion === 'leaving') return play(script, elapsed, {fadeOut: 420});
  const total = script.reduce((n, g) => n + g.ms, 0);
  if (elapsed >= total) return null;
  const p = play(script, elapsed);
  if (motion === 'entering') p.opacity = p.hidden ? 0 : Math.min(1, (elapsed - LIFE.build) / 260);
  return p;
}

export const ENTER_MS = routeDuration("entering"), LEAVE_MS = routeDuration("leaving");
