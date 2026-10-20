// Plaza furniture in a light oblique projection: depth recedes up and slightly right, so desks show their
// top and right side. Flat, outline-free shading keeps the outlined capybaras the only crisp element.
// Web only (react-native-web renders these as DOM SVG); SVG ids carry a plz- prefix so they never clash with the host page.
import type { ReactNode } from "react";
import { KX, KY, P, DESK, SEAT } from "./geometry";
import type { PlazaPhase } from "./motion";
type V3 = readonly [number, number, number];
const pts = (list: V3[]) => list.map(([x, y, z]) => P(x, y, z).map(v => v.toFixed(2)).join(",")).join(" ");

export const PAL = {
  oakTop: "#f1e3cf", oakFront: "#e1c9aa", oakSide: "#d4b997", panel: "#fbfaf7", panelLow: "#f2eee8", panelSide: "#e6e0d8",
  plinth: "#ddd6cc", alu: "#ecebe8", aluLow: "#dfddd9", aluSide: "#cfccc7", stand: "#d3cfc9", keyboard: "#e4e0da", keySide: "#d3cec7",
  shadow: "rgba(70, 58, 46, 0.16)", leaf: "#8db28a", leafDark: "#6d986c", leafLight: "#a3c49c", pot: "#f6f2ec", potRim: "#e1d9ce",
  mug: "#cf8f70", mugTop: "#e3ad92", book1: "#ad9fcc", book2: "#a4bd9f", book3: "#e6c993", ink: "#4a433d",
  frame: "#fdfcfa",
};

export const SCREEN: Partial<Record<PlazaPhase, string>> = {
  running: "#6aa6ff", starting: "#8ec0ff", approval: "#f5b83d", question: "#a58bff", plan: "#64c7a0", idle: "#a58bff",
  error: "#ff7a73", quota: "#f5b83d", unfinished: "#f5b83d", silent: "#c9c2b8", unread: "#f177b4", snoozed: "#c9c2b8",
};

export function SvgDefs() {
  return <defs>
    <filter id="plz-soft" x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="4" /></filter>
    <filter id="plz-softer" x="-40%" y="-120%" width="180%" height="340%"><feGaussianBlur stdDeviation="10" /></filter>
    <filter id="plz-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5" /></filter>
    <linearGradient id="plz-glass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#d6e4ee" /><stop offset="0.72" stopColor="#ebf0ef" /><stop offset="1" stopColor="#f3f2ec" />
    </linearGradient>
    <linearGradient id="plz-floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#e7e3dd" /><stop offset="0.18" stopColor="#eeebe6" /><stop offset="1" stopColor="#ebe8e3" />
    </linearGradient>
    <linearGradient id="plz-wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#f2f0ec" /><stop offset="1" stopColor="#f8f7f4" />
    </linearGradient>
    <linearGradient id="plz-panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={PAL.panel} /><stop offset="1" stopColor={PAL.panelLow} />
    </linearGradient>
    <linearGradient id="plz-alu" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={PAL.alu} /><stop offset="1" stopColor={PAL.aluLow} />
    </linearGradient>
  </defs>;
}

// cuboid: front, top and right faces (the only ones this camera sees)
export function Box({ x = 0, y = 0, z = 0, w, h, d, front, top, side, rx = 0 }: { x?: number; y?: number; z?: number; w: number; h: number; d: number; front?: string | null; top?: string | null; side?: string | null; rx?: number }) {
  const X = x + w, Y = y + h, Z = z + d;
  const [fx, fy] = P(x, Y, z);
  return <g>
    {side && <polygon points={pts([[X, y, z], [X, y, Z], [X, Y, Z], [X, Y, z]])} fill={side} />}
    {top && <polygon points={pts([[x, Y, z], [X, Y, z], [X, Y, Z], [x, Y, Z]])} fill={top} />}
    {front && <rect x={fx} y={fy} width={w} height={h} rx={rx} fill={front} />}
  </g>;
}

export function FloorShadow({ x, z, w, d, grow = 10, opacity = 1 }: { x: number; z: number; w: number; d: number; grow?: number; opacity?: number }) {
  const [cx, cy] = P(x + w / 2, 0, z + d / 2);
  return <ellipse cx={cx + 4} cy={cy + 3} rx={w / 2 + grow} ry={d * KY / 2 + grow * 0.55} fill={PAL.shadow} opacity={opacity} filter="url(#plz-soft)" />;
}

// soft island under a team's desks; a rounded parallelogram in the floor plane
export function FloorRug({ w, d, x = -24, z = -70, fill = "#e7e2da" }: { w: number; d: number; x?: number; z?: number; fill?: string }) {
  const corners: V3[] = [[x, 0, z], [x + w, 0, z], [x + w, 0, z + d], [x, 0, z + d]];
  return <g>
    <polygon points={pts(corners)} fill={fill} stroke={fill} strokeWidth="26" strokeLinejoin="round" />
    <polygon points={pts(corners)} fill="none" stroke="#f1eee9" strokeWidth="2" strokeLinejoin="round" opacity="0.9" />
  </g>;
}

export function DeskUnder({ w = DESK.w }: { w?: number }) {
  return <FloorShadow x={0} z={0} w={w} d={DESK.d} />;
}

function at(x: number, y: number, z: number, children: ReactNode) {
  const [sx, sy] = P(x, y, z);
  return <g transform={`translate(${sx.toFixed(2)} ${sy.toFixed(2)})`}>{children}</g>;
}

export type DeskItem = "plant" | "mug" | "books";
const ITEMS: Record<DeskItem, ReactNode> = {
  plant: <g>
    <path d="M -1 -7 C -10 -15 -12 -27 -6 -33 C -2 -25 1 -17 -1 -7 Z" fill={PAL.leafDark} />
    <path d="M 1 -7 C 6 -19 14 -25 19 -25 C 16 -15 9 -9 1 -7 Z" fill={PAL.leaf} />
    <path d="M 0 -7 C -2 -19 2 -31 8 -37 C 10 -27 6 -15 0 -7 Z" fill={PAL.leafLight} />
    <path d="M -8 -8 L 8 -8 L 6.5 1 C 6 3 -6 3 -6.5 1 Z" fill={PAL.pot} />
    <rect x="-8.5" y="-9" width="17" height="3" rx="1.5" fill={PAL.potRim} />
  </g>,
  mug: <g>
    <path d="M 6 -10 C 12 -10 12 -2 6 -2" fill="none" stroke={PAL.mug} strokeWidth="2.4" />
    <rect x="-7" y="-14" width="14" height="15" rx="3" fill={PAL.mug} />
    <ellipse cx="0" cy="-13" rx="6.5" ry="1.8" fill={PAL.mugTop} />
  </g>,
  books: <g>
    <rect x="-15" y="-6" width="30" height="6" rx="1.2" fill={PAL.book1} />
    <rect x="-12" y="-11.5" width="26" height="5.5" rx="1.2" fill={PAL.book2} />
    <rect x="-14" y="-16.5" width="24" height="5" rx="1.2" fill={PAL.book3} />
  </g>,
};

const PAPERS = <g>
  <polygon points={pts([[22, DESK.h + 0.4, 6], [52, DESK.h + 0.4, 2], [56, DESK.h + 0.4, 18], [26, DESK.h + 0.4, 22]])} fill="#fbfaf7" stroke="#e6dfd4" strokeWidth="0.8" />
  <polygon points={pts([[96, DESK.h + 0.8, 4], [124, DESK.h + 0.8, 8], [121, DESK.h + 0.8, 24], [93, DESK.h + 0.8, 20]])} fill="#fdfcf9" stroke="#e6dfd4" strokeWidth="0.8" />
</g>;

// a little door hanger on the monitor: the session is closed, the colleague stays
function ClosedSign({ x, y, z }: { x: number; y: number; z: number }) {
  const [sx, sy] = P(x, y, z);
  // CSS animation owns the inner transform, so the placement lives on the outer group
  return <g transform={`translate(${sx} ${sy})`}><g className="closed-sign">
    <path d="M 4 -1 L 10 -9 L 16 -1" fill="none" stroke="#b9b0a5" strokeWidth="1" />
    <rect x="-1" y="-1" width="22" height="13" rx="3" fill="#fbfaf7" stroke="#d9d2c7" strokeWidth="1" />
    <circle cx="10" cy="5.5" r="3.6" fill="none" stroke="#a1a5a4" strokeWidth="1.4" />
    <rect x="8.4" y="3.9" width="3.2" height="3.2" rx="0.6" fill="#a1a5a4" />
  </g></g>;
}

// cardboard box that appears on the desk while a leaving colleague packs up
function PackBox({ h = DESK.h }: { h?: number }) {
  const {d} = DESK;
  return at(22, h, d * 0.5, <g className="dk-box">
    <path d="M -15 -2 L 15 -2 L 14 -22 L -14 -22 Z" fill="#d6ac7c" />
    <rect x="-15" y="-24" width="30" height="4" rx="1" fill="#c79a68" />
    <g className="dk-box-flap-l"><path d="M -14 -22 L -22 -30 L -6 -31 L 0 -22 Z" fill="#e3bd90" /></g>
    <g className="dk-box-flap-r"><path d="M 14 -22 L 22 -30 L 6 -31 L 0 -22 Z" fill="#e3bd90" /></g>
  </g>);
}

// counter desk: oak slab over a warm-white panel; monitor turned toward the capybara.
// Parts are grouped (dk-*) so arrivals can build them up and departures can fold them away.
// the coding agent behind each session, shown like a sticker on the back of the monitor
interface ProviderLook { label: string; bg: string; ink?: string; ring?: string; glyph: string }
const PROVIDERS: Record<string, ProviderLook> = {
  claude: { label: "Claude Code", bg: "#d97757", glyph: "claude" },
  codex: { label: "Codex", bg: "#ffffff", ink: "#1d1d1f", ring: "#d6d3ce", glyph: "codex" },
  kimi: { label: "Kimi Code", bg: "#16181d", glyph: "kimi" },
  opencode: { label: "OpenCode", bg: "#5e6b63", glyph: "opencode" },
};
/** The coding agent's sticker: known harnesses get their mark; anything else shows its own name on a neutral tile. */
export const providerOf = (provider: string, label?: string): ProviderLook => PROVIDERS[provider.toLowerCase()] ?? { label: label || provider || "Agent", bg: "#9a948c", glyph: "" };

function ProviderGlyph({ name, ink = "#fff" }: { name: string; ink?: string }) {
  if (name === "claude") return <g stroke={ink} strokeWidth="1.3" strokeLinecap="round">
    {[0, 45, 90, 135].map(a => <line key={a} x1="0" y1="-3.6" x2="0" y2="3.6" transform={`rotate(${a})`} />)}
  </g>;
  if (name === "codex") return <path d="M -3.2 -2.4 L -0.6 0 L -3.2 2.4 M 0.4 2.6 L 3.4 2.6" fill="none" stroke={ink} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />;
  if (name === "kimi") return <g><path d="M -2.6 -3.2 V 3.2 M 2.6 -3.2 L -2.2 0.3 L 2.8 3.2" fill="none" stroke={ink} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><circle cx="3.4" cy="-2.9" r="1" fill="#4f8cff" /></g>;
  if (name === "opencode") return <path d="M -1.6 -3.4 C -3.4 -3.4 -2.2 0 -3.6 0 C -2.2 0 -3.4 3.4 -1.6 3.4 M 1.6 -3.4 C 3.4 -3.4 2.2 0 3.6 0 C 2.2 0 3.4 3.4 1.6 3.4" fill="none" stroke={ink} strokeWidth="1.1" strokeLinecap="round" />;
  return <circle r="2.2" fill={ink} />;
}

function ProviderSticker({ name, label }: { name: string; label?: string }) {
  const p = providerOf(name, label);
  return <g className="provider-sticker">
    <rect x="-6.5" y="-11" width="13" height="13" rx="3.4" fill={p.bg} stroke={p.ring || "none"} strokeWidth="0.8" />
    <g transform="translate(0 -4.5)"><ProviderGlyph name={p.glyph} ink={p.ink} /></g>
    <text y="9.5" textAnchor="middle" fontSize="6.4" fontWeight="600" fill="#8f877e" fontFamily="-apple-system,system-ui,sans-serif" letterSpacing="0.1">{p.label}</text>
  </g>;
}

// a little pennant on the monitor: this session has its own worktree
function Pennant({ x, y, z }: { x: number; y: number; z: number }) {
  const [px, py] = P(x, y, z);
  return <g transform={`translate(${px} ${py})`}>
    <rect x="-0.6" y="-15" width="1.2" height="15" rx="0.6" fill="#9b948b" />
    <g className="pennant"><path d="M 0.6 -15 L 11 -11.6 L 0.6 -8.2 Z" fill="#5fb487" /></g>
  </g>;
}

// w / seatX vary per seat (sub-agents get a narrower side desk); joinL / joinR push desks together into one table
export function DeskOver({ item = "plant", screen = null, phase = null, life = null, provider = null, providerLabel, w = DESK.w, h = DESK.h, seatX = SEAT.x, joinL = false, joinR = false, kind = null }: {
  item?: DeskItem; screen?: string | null; phase?: PlazaPhase | null; life?: "building" | "leaving" | null; provider?: string | null; providerLabel?: string;
  w?: number; h?: number; seatX?: number; joinL?: boolean; joinR?: boolean; kind?: "local" | "worktree" | null;
}) {
  const {d, slab} = DESK;
  const mx = w - 56, mz = d - 9;
  const inL = joinL ? 0 : 3, inR = joinR ? 0 : 3;
  const [gx, gy] = P(mx, h + 46, mz + 4);
  return <g>
    <g className="dk-body">
      <Box x={inL} y={0} z={3} w={w - inL - inR} h={h - slab} d={d - 5} front="url(#plz-panel)" side={joinR ? null : PAL.panelSide} />
      <Box x={inL + 4} y={0} z={3} w={w - inL - inR - 8} h={3.5} d={1} front={PAL.plinth} />
      <Box x={0} y={h - slab} z={0} w={w} h={slab} d={d} front={PAL.oakFront} top={PAL.oakTop} side={joinR ? null : PAL.oakSide} />
      {/* the seam where two desks were pushed together */}
      {joinL && <line x1="0" y1={-h + slab} x2={d * KX} y2={-h - d * KY} stroke="#e2d2bd" strokeWidth="1" />}
      {joinL && <line x1="0" y1={-h + slab} x2="0" y2="-3" stroke="#ebe5dc" strokeWidth="1" />}
    </g>
    <g className="dk-keys">
      <Box x={seatX - 26} y={h} z={d * 0.3} w={52} h={2.4} d={12} front={PAL.keySide} top={PAL.keyboard} side={PAL.keySide} />
    </g>
    <g className="dk-item">
      {at(16, h, d * 0.5, ITEMS[item])}
      {item === "mug" && at(16, h + 15, d * 0.5, <g className="desk-steam"><path d="M -2 0 C -6 -5 2 -8 -2 -14" /><path d="M 3 -1 C -1 -6 7 -9 3 -15" /></g>)}
    </g>
    {phase === "unfinished" && !life && PAPERS}
    {life === "leaving" && <PackBox h={h} />}
    <g className="dk-monitor">
      {/* monitor: foot, neck, aluminium back; the screen faces away from us */}
      <Box x={mx + 11} y={h} z={mz - 4} w={28} h={1.6} d={12} top={PAL.stand} front={PAL.aluSide} side={PAL.aluSide} />
      <Box x={mx + 21} y={h} z={mz + 2} w={8} h={12} d={3} front={PAL.stand} side={PAL.aluSide} />
      {/* light from the screen spills around the monitor edges, animated per state */}
      {screen && <rect className="screen-glow" data-phase={phase || ""} x={gx - 5} y={gy - 4} width="58" height="44" rx="8" fill={screen} filter="url(#plz-glow)" />}
      {screen && (() => { const [sx, sy] = P(mx - 1.4, h + 48, mz + 4); return <rect className="screen-edge" data-phase={phase || ""} x={sx} y={sy} width="2.6" height="32" rx="1.3" fill={screen} />; })()}
      <Box x={mx} y={h + 10} z={mz + 4} w={50} h={36} d={2.5} front="url(#plz-alu)" top={PAL.aluLow} side={PAL.aluSide} rx={4} />
      {at(mx + 25, h + 26, mz + 4, provider ? <ProviderSticker name={provider} label={providerLabel} /> : <circle r="3" fill="#d8d5d0" />)}
      {phase === "closed" && <ClosedSign x={mx + 14} y={h + 40} z={mz + 4} />}
      {kind === "worktree" && <Pennant x={mx + 46} y={h + 46} z={mz + 5} />}
    </g>
  </g>;
}

export function CoffeeBar() {
  const w = 160, h = 82, d = 46;
  return <g>
    <FloorShadow x={0} z={0} w={w} d={d} />
    <Box x={3} y={0} z={3} w={w - 6} h={h - 6} d={d - 5} front="url(#plz-panel)" side={PAL.panelSide} />
    {(() => { const [sx, sy] = P(w / 2, h - 20, 3); return <rect x={sx - 0.7} y={sy} width="1.4" height="54" fill="#ebe5dd" />; })()}
    <Box x={0} y={h - 6} z={0} w={w} h={6} d={d} front={PAL.oakFront} top={PAL.oakTop} side={PAL.oakSide} />
    {/* espresso machine */}
    <Box x={18} y={h} z={14} w={46} h={44} d={26} front="#47423d" top="#5a544e" side="#3a3632" rx={5} />
    {at(18, h, 14, <g>
      <rect x="4" y="-38" width="38" height="9" rx="2.5" fill="#5d5751" />
      <circle className="machine-led" cx="10" cy="-33.5" r="2" fill="#a6d8ac" />
      <g className="machine-steam"><circle cx="26" cy="-50" r="5" /><circle cx="31" cy="-55" r="4" /></g>
      <rect x="15" y="-24" width="16" height="8" rx="2" fill="#35312d" />
      <rect x="11" y="-7" width="24" height="3" rx="1.5" fill="#5d5751" />
    </g>)}
    {[0, 1, 2].map(i => <g key={i}>{at(88 + i * 15, h, 18, <g>
      <path d="M -5 -10 L 5 -10 L 4 0 L -4 0 Z" fill="#fdfbf7" />
      <rect x="-5" y="-6.5" width="10" height="3" fill="#cfa684" />
    </g>)}</g>)}
    {at(140, h, 20, <g>
      <rect x="-7" y="-18" width="14" height="18" rx="3" fill="#e8dfd2" />
      <rect x="-7.5" y="-21" width="15" height="4" rx="2" fill="#cdbfad" />
    </g>)}
  </g>;
}

export function TallPlant({ s = 1 }: { s?: number }) {
  return <g transform={`scale(${s})`}>
    <ellipse cx="3" cy="-1" rx="26" ry="7" fill={PAL.shadow} filter="url(#plz-soft)" />
    <g className="sway">
    <path d="M 0 -40 C -6 -70 -30 -88 -40 -96 C -24 -100 -6 -84 0 -40 Z" fill={PAL.leafDark} />
    <path d="M 0 -40 C 2 -76 20 -104 34 -110 C 36 -92 18 -64 0 -40 Z" fill={PAL.leaf} />
    <path d="M 0 -40 C -4 -82 -2 -116 8 -132 C 18 -112 10 -76 0 -40 Z" fill={PAL.leafLight} />
    <path d="M 0 -42 C -12 -58 -30 -62 -42 -58 C -30 -50 -14 -44 0 -42 Z" fill="#7aa577" />
    <path d="M 0 -44 C 12 -62 30 -70 44 -68 C 32 -58 14 -48 0 -44 Z" fill={PAL.leafDark} />
    </g>
    <path d="M -17 -42 L 17 -42 L 13 -2 C 12 1 -12 1 -13 -2 Z" fill={PAL.pot} />
    <rect x="-18" y="-45" width="36" height="5" rx="2.5" fill={PAL.potRim} />
  </g>;
}

export function Lounge() {
  return <g>
    <FloorShadow x={0} z={0} w={140} d={56} />
    <Box x={0} y={10} z={6} w={140} h={22} d={50} front="#e8dac9" top="#efe3d5" side="#dccbb8" rx={8} />
    <Box x={0} y={10} z={44} w={140} h={46} d={14} front="#dcc9b5" top="#e6d6c4" side="#d0bca6" rx={12} />
    <Box x={-10} y={10} z={6} w={14} h={34} d={52} front="#d4c0ab" top="#e0cfbc" side="#c9b49d" rx={7} />
    <Box x={136} y={10} z={6} w={14} h={34} d={52} front="#d4c0ab" top="#e0cfbc" side="#c9b49d" rx={7} />
    {at(4, 0, 8, <rect x="0" y="-10" width="4" height="10" rx="2" fill={PAL.ink} />)}
    {at(132, 0, 8, <rect x="0" y="-10" width="4" height="10" rx="2" fill={PAL.ink} />)}
    {at(30, 32, 30, <rect x="0" y="-22" width="34" height="22" rx="8" fill="#c9b6dc" opacity="0.9" />)}
  </g>;
}

