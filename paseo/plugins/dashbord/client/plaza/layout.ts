import { DESK, SEAT, SUB, KX, KY, at, type Point } from "./geometry";
import type { PlazaPhase, Route } from "./motion";

/** One colleague as the plaza sees a dashboard session. */
export interface PlazaAgent {
  id: string; name: string; project: string; host: string | null;
  /** local: works in the project folder itself; worktree: has its own checkout. */
  checkout: "local" | "worktree"; worktree: string | null; parentId: string | null;
  provider: string; providerLabel: string; seat: number; phase: PlazaPhase; offline?: boolean;
}
export interface Seg { w: number; seatX: number; scale: number; h: number; kind: "local" | "worktree"; sub: boolean; joinL: boolean; joinR: boolean }
export interface DeskSpot { agent: PlazaAgent; seg: Seg; pos: [number, number]; seatY: number; route: Route }
export interface Pod { project: string; agents: PlazaAgent[]; rowW: number; depth: number; w: number; h: number; x: number; y: number; origin: [number, number] }
export interface Furniture { coffee: Point; sofa: Point; plantL: Point; plantR: Point }
export interface PlazaLayout { mode: "room" | "floor"; width: number; height: number; scale: number; desks: DeskSpot[]; pods: Pod[]; origin?: Point; furniture?: Furniture }
interface Table { kind: "local" | "worktree"; first: number; members: Array<{ agent: PlazaAgent; sub: boolean }>; w: number }

// Only occupied desks exist. Desks are grouped into tables:
//   local    — sessions working in the project folder itself share one long table (pushed-together desks),
//   worktree — a session with its own worktree gets its own desk; its sub-agents sit at side desks beside it.
// Tables are placed in seat order, so arrivals and departures re-flow the scene; the scene animates those moves.
export const ROOM_MAX = 8;
export const ROW_Z = 390;  // leaves room above front-row heads for the tok/s badge
const GAP = 46, BACK_Z = 420, STAGGER = 187, LOCAL_MAX = 4;
const ORIGIN_Y = 425, ROOM_H = 495;
export const COFFEE = { w: 160, z: 530, spot: [95, 515] as const };  // set back far enough that walkers pass in front of it

const bySeat = (a: PlazaAgent, b: PlazaAgent) => (a.seat - b.seat) || a.id.localeCompare(b.id);
const seatYOf = (origin: Point, x: number, z: number, seatX: number) => at(origin, x + seatX, 0, z + SEAT.z)[1];
const seatGeom = (sub: boolean) => sub ? { w: SUB.w, seatX: SUB.seatX, scale: SUB.scale, h: SUB.h } : { w: DESK.w, seatX: SEAT.x, scale: 1, h: DESK.h };

export function tablesOf(agents: PlazaAgent[]): Table[] {
  const list = [...agents].sort(bySeat), byId = new Map(list.map(a => [a.id, a]));
  // every sub-agent (at any depth) sits beside its top-level ancestor among the visible sessions
  const rootOf = (a: PlazaAgent): PlazaAgent => { let node = a; for (let hops = 0; node.parentId && byId.has(node.parentId) && hops < 64; hops++) node = byId.get(node.parentId)!; return node; };
  const isSub = (a: PlazaAgent) => rootOf(a) !== a;
  const subsOf = (main: PlazaAgent) => list.filter(s => isSub(s) && rootOf(s) === main).map(agent => ({ agent, sub: true }));
  const mains = list.filter(a => !isSub(a));
  const locals = mains.filter(a => a.checkout === "local");
  const tables: Table[] = [];
  for (let i = 0; i < locals.length; i += LOCAL_MAX)
    tables.push({ kind: "local", first: locals[i]!.seat, members: locals.slice(i, i + LOCAL_MAX).map(agent => ({ agent, sub: false })), w: 0 });
  for (const a of mains.filter(a => a.checkout !== "local")) tables.push({ kind: "worktree", first: a.seat, members: [{ agent: a, sub: false }, ...subsOf(a)], w: 0 });
  // sub-agents of a local session get their own side desks after the local table
  for (const a of locals) for (const member of subsOf(a)) tables.push({ kind: "local", first: member.agent.seat, members: [member], w: 0 });
  tables.sort((a, b) => a.first - b.first);
  for (const t of tables) t.w = t.members.reduce((n, m) => n + seatGeom(m.sub).w + (m.sub ? SUB.gap : 0), 0);
  return tables;
}

/** One entry per seat of a table placed with its front-left floor corner at world (x, z). */
function seatsOf(table: Table, x: number, z: number, origin: Point, route: (sx: number, sz: number) => Route): DeskSpot[] {
  let cx = x;
  return table.members.map((m, i) => {
    // only the local table is pushed together; a sub-agent's side table stands a little apart
    const g = seatGeom(m.sub), next = table.members[i + 1];
    const seg: Seg = { ...g, kind: table.kind, sub: m.sub, joinL: i > 0 && !m.sub, joinR: !!next && !next.sub };
    if (m.sub) cx += SUB.gap;
    const spot: DeskSpot = { agent: m.agent, seg, pos: at(origin, cx, 0, z), seatY: seatYOf(origin, cx, z, g.seatX), route: route(cx + g.seatX, z + SEAT.z) };
    cx += g.w;
    return spot;
  });
}

// One room for a single small team: coffee bar back-left, sofa back-right, plants at the front corners.
// Tables alternate back / front, so a newcomer at the end never moves anyone.
function roomLayout(agents: PlazaAgent[], fit: (w: number, h: number) => number): PlazaLayout {
  const tables = tablesOf(agents), x0 = 208, origin: Point = [0, ORIGIN_Y];
  const rows = { back: x0, front: x0 + STAGGER };
  const placed = tables.map((t, i) => {
    const row = i % 2 === 0 ? "back" : "front", x = rows[row];
    rows[row] += t.w + GAP;
    return { t, x, z: row === "back" ? BACK_Z : 0 };
  });
  const backEnd = rows.back - GAP, frontEnd = rows.front - GAP;
  const furniture: Furniture = { coffee: [0, COFFEE.z], sofa: [Math.max(backEnd, x0) + 70, 540], plantL: [x0 + STAGGER - 235, -30], plantR: [Math.max(frontEnd, x0 + STAGGER) + 85, -20] };
  const width = Math.max(furniture.sofa[0] + 540 * KX + 210, furniture.plantR[0] + 60, 760);
  const aisle = x0 - 48; // left of the back row, in front of the coffee bar
  const route = (sx: number, sz: number): Route => ({ door: [(sx < width / 2 ? -80 : width + 80) - sx, 0], aisle: [aisle - sx, 0], coffee: [COFFEE.spot[0] - sx, COFFEE.spot[1] - sz] });
  const desks = placed.flatMap(({ t, x, z }) => seatsOf(t, x, z, origin, route));
  return { mode: "room", width, height: ROOM_H, scale: fit(width, ROOM_H), origin, furniture, desks, pods: [] };
}

// Several projects: one island per project. Tables are packed into as few lines as fit
// (first-fit by width, so a long local table and single desks share lines without holes).
function podOf(project: string, agents: PlazaAgent[]) {
  const tables = tablesOf(agents), maxW = Math.max((agents.length <= 6 ? 3 : 4) * (DESK.w + GAP) - GAP, ...tables.map(t => t.w));
  const lines: Array<{ items: Table[]; w: number }> = [];
  for (const t of [...tables].sort((a, b) => b.w - a.w || a.first - b.first)) {
    const line = lines.find(l => l.w + GAP + t.w <= maxW);
    if (line) { line.items.push(t); line.w += GAP + t.w; } else lines.push({ items: [t], w: t.w });
  }
  // inside a line keep seat order, so the scene reads the same way the list does
  for (const l of lines) l.items.sort((a, b) => a.first - b.first);
  const rowW = Math.max(...lines.map(l => l.w)), depth = (lines.length - 1) * ROW_Z;
  return { project, agents, lines: lines.map(l => l.items), rowW, depth, w: rowW + depth * KX + 70, h: depth * KY + 324 };
}

export function getPlazaLayout(agents: PlazaAgent[], viewport: { width: number; height: number }, maxScale = 1.4): PlazaLayout {
  const fit = (w: number, h: number) => Math.max(0.2, Math.min(maxScale, (viewport.width - 16) / w, (viewport.height - 12) / h));
  if (agents.length <= ROOM_MAX && new Set(agents.map(a => a.project)).size <= 1) return roomLayout(agents, fit);
  const names = [...new Set([...agents].sort(bySeat).map(a => a.project))];
  const pods = names.map(p => podOf(p, agents.filter(a => a.project === p)));
  // shelf-pack the islands with their own widths; try every sensible shelf width and keep the one that fits best
  const widest = Math.max(...pods.map(p => p.w)) + 50;
  const widths = [...new Set(pods.map((_, i) => pods.slice(0, i + 1).reduce((n, p) => n + p.w + 50, 0)))].filter(w => w >= widest);
  let best: PlazaLayout | null = null;
  for (const shelf of widths.length ? widths : [pods.reduce((n, p) => n + p.w + 50, 0)]) {
    const desks: DeskSpot[] = [], placed: Pod[] = [];
    let x = 40, y = 70, rowH = 0, width = 0;
    for (const p of pods) {
      if (x > 40 && x + p.w > shelf + 40) { x = 40; y += rowH + 40; rowH = 0; }
      const origin: [number, number] = [x + 34, y + p.h - 74];
      placed.push({ project: p.project, agents: p.agents, rowW: p.rowW, depth: p.depth, w: p.w, h: p.h, x, y, origin });
      p.lines.forEach((line, li) => {
        const z = (p.lines.length - 1 - li) * ROW_Z;
        let lx = 0;
        for (const t of line) { desks.push(...seatsOf(t, lx, z, origin, sx => ({ door: [-(sx + 90), 0] }))); lx += t.w + GAP; }
      });
      x += p.w + 50; rowH = Math.max(rowH, p.h); width = Math.max(width, x);
    }
    const height = y + rowH + 10, scale = fit(width + 10, height);
    if (!best || scale > best.scale + 1e-6) best = { mode: "floor", width: width + 10, height, scale, desks, pods: placed };
  }
  return best!;
}
export { KY };
