import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { t } from "../../shared/text";
import { hueColor, phases } from "../status";
import { SvgDefs, DeskUnder, DeskOver, CoffeeBar, TallPlant, Lounge, FloorRug, SCREEN, providerOf, type DeskItem } from "./furniture";
import { Capy } from "./capy";
import { DeskFx } from "./fx";
import { DESK, SEAT, P, KX, KY, at, type Point } from "./geometry";
import { getPlazaLayout, type DeskSpot, type PlazaAgent, type PlazaLayout } from "./layout";
import { LIFE, LEAVE_MS, ENTER_MS, type Motion, type Route } from "./motion";
import { personaFor } from "./sprites";
import { ensurePlazaStyles } from "./styles";

// The same icons the dashboard uses; idle, done, canceled and the calm states speak through their own effects.
const BUBBLES: Partial<Record<string, string>> = { approval: "Hand", question: "MessageCircleQuestion", plan: "ClipboardList", error: "X", quota: "BatteryWarning", silent: "CircleDashed", unfinished: "CircleDotDashed", unread: "Mail", snoozed: "AlarmClock" };
const RIPPLE = new Set(["approval", "unread", "error"]);
const ATTENTION = new Set(["approval", "question", "plan", "error", "quota", "silent", "unfinished", "unread", "idle"]);
const ITEMS: DeskItem[] = ["plant", "mug", "books"];
/** Colleagues who stroll to the coffee bar at a time, so the bar never crowds. */
const COFFEE_RUNS = 2;
const zOf = (y: number) => Math.round(y * 2);
const hashOf = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h; };

/** Where this session's code lives, for the hover card. */
function checkoutLine(agent: PlazaAgent): string {
  if (agent.parentId) return t("plaza.subagentCheckout");
  return agent.checkout === "local" ? t("plaza.projectFolder") : `worktree · ${agent.worktree ?? ""}`;
}
const speed = (value: number) => value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");

interface Tracked extends PlazaAgent { leaving?: number; entering?: number }

/**
 * Arrivals and departures. A session that appears after the scene opened walks in once its new desk is built; one that
 * disappears while the filters stay the same packs up and leaves. A filter change just re-flows the room.
 */
function useLifecycle(agents: PlazaAgent[], filterKey: string): Tracked[] {
  const seen = useRef<Map<string, PlazaAgent> | null>(null), key = useRef(filterKey);
  const [, wake] = useState(0);
  const leaving = useRef(new Map<string, Tracked>()), entering = useRef(new Map<string, number>());
  const now = Date.now();
  const current = new Map(agents.map(agent => [agent.id, agent]));
  if (seen.current && key.current === filterKey) {
    for (const agent of agents) if (!seen.current.has(agent.id) && !entering.current.has(agent.id)) entering.current.set(agent.id, now);
    for (const [id, agent] of seen.current) if (!current.has(id) && !leaving.current.has(id)) leaving.current.set(id, { ...agent, leaving: now });
  } else if (seen.current) { leaving.current.clear(); entering.current.clear(); }
  for (const id of leaving.current.keys()) if (current.has(id)) leaving.current.delete(id);
  seen.current = current; key.current = filterKey;
  useEffect(() => {
    if (!leaving.current.size && !entering.current.size) return;
    const timer = setTimeout(() => {
      const at = Date.now();
      for (const [id, agent] of leaving.current) if (at - (agent.leaving ?? 0) > LEAVE_MS + 300) leaving.current.delete(id);
      for (const [id, since] of entering.current) if (at - since > ENTER_MS + 300) entering.current.delete(id);
      wake(value => value + 1);
    }, 500);
    return () => clearTimeout(timer);
  });
  return [...agents.map(agent => entering.current.has(agent.id) ? { ...agent, entering: entering.current.get(agent.id) } : agent), ...leaving.current.values()];
}

function Desk({ spot, selected, onSelect, height, coffee, rate, paused, theme }: {
  spot: DeskSpot & { agent: Tracked }; selected: boolean; onSelect: (id: string) => void; height: number; coffee: boolean; rate?: number; paused: { current: boolean }; theme: PluginTheme;
}) {
  const { agent, seg, route, seatY } = spot, [left, top] = spot.pos;
  const w = seg.w, seatX = seg.seatX, k = seg.scale, capH = height * k;
  const deskH = seg.h, lift = SEAT.y - (DESK.h - deskH);
  const [sx, sy] = P(seatX, 0, SEAT.z);
  const phase = agent.phase, meta = phases[phase];
  // offline means the state is unknown: grey, never the last known colour
  const tone = agent.offline ? hueColor(theme, "muted") : hueColor(theme, meta.hue);
  const motion: Motion | null = agent.leaving ? "leaving" : agent.entering ? "entering" : coffee && phase === "quiet" && !seg.sub && !agent.offline ? "coffee" : null;
  const live = !agent.offline;
  const screen = live ? SCREEN[phase] ?? null : null;
  const [bx, by] = P(seatX + capH * 0.42, lift + capH * 0.9, SEAT.z);
  const life = motion === "entering" ? "building" : motion === "leaving" ? "leaving" : null;
  const lifeCls = life ? " is-" + life : "";
  const started = agent.leaving ?? agent.entering ?? 0, offset = life ? Math.max(0, Date.now() - started) : motion === "coffee" ? (hashOf(agent.id) % 5) * 4300 : 0;
  // the CSS build / dismantle reads the same beats the walking uses
  const beats = { "--t-build": LIFE.build + "ms", "--t-pack": LIFE.cheer + "ms", "--t-pack-end": LIFE.cheer + LIFE.pack + "ms",
    "--t-down": LIFE.down + "ms", "--t-dismantle": LIFE.dismantle + "ms", "--t-dismantle-ms": LIFE.dismantleMs + "ms", animationDelay: life ? `-${offset}ms` : undefined } as CSSProperties;
  const provider = providerOf(agent.provider, agent.providerLabel);
  const state = agent.offline && agent.host ? t("fleet.hostOffline", { host: agent.host }) : meta.label;
  const card = [agent.name, checkoutLine(agent), [provider.label, agent.host].filter(Boolean).join(" · "), state].join("\n");
  const item = ITEMS[hashOf(agent.id) % ITEMS.length]!;
  return <>
    <svg className={"plz-piece desk-under" + (selected ? " is-selected" : "") + lifeCls} style={{ left, top, zIndex: zOf(top) - 1, ...beats }} width="1" height="1">
      {selected ? <ellipse cx={w / 2 + 12} cy={-10} rx={w * 0.66} ry={30} fill="#8fb3ff" opacity="0.22" filter="url(#plz-softer)" /> : null}
      <DeskUnder w={w} />
    </svg>
    <span className={"plz-actor" + (agent.offline ? " is-offline" : "")} style={{ left: left + sx, top: top + sy, zIndex: zOf(top + sy) }}>
      <Capy persona={personaFor(agent.id)} phase={phase} serial={hashOf(agent.id) % 97} height={capH} seatLift={lift} frozen={!!agent.offline} paused={paused}
        motion={motion} route={route as Route} seatY={seatY} offset={offset} />
    </span>
    <svg className={"plz-piece desk-over" + (agent.offline ? " is-offline" : "") + lifeCls} style={{ left, top, zIndex: zOf(top), ...beats }} width="1" height="1">
      <DeskOver item={item} screen={screen} phase={live ? phase : null} life={life} provider={agent.provider} providerLabel={agent.providerLabel}
        w={w} h={deskH} seatX={seatX} joinL={seg.joinL} joinR={seg.joinR} kind={seg.sub ? null : seg.kind} />
    </svg>
    {live && !life ? <span className="plz-deskfx" style={{ left: left + seatX - SEAT.x, top, zIndex: zOf(top) + 1 }}><DeskFx phase={phase} seed={hashOf(agent.id) % 13} /></span> : null}
    {life ? <span className={"plz-lifefx" + lifeCls} style={{ left, top, zIndex: zOf(top) + 1, ...beats }}>
      {life === "leaving" ? <span className="leave-bubble" style={{ left: bx + 2, top: by - SEAT.y + 26 }}>{t("plaza.offWork")}</span> : null}
      {life === "leaving" ? [0, 1, 2].map(i => <span key={i} className="leave-note" style={{ left: bx - 30 + i * 22, top: by - SEAT.y + 40, animationDelay: `calc(var(--t-pack-end) + ${i * 140 - offset}ms)` }}>{"♪"}</span>) : null}
      {[0, 1, 2, 3, 4].map(i => <span key={i} className="life-dust" style={{ left: 14 + i * (w - 30) / 4, top: -8 - (i % 2) * 6, animationDelay: `${(life === "building" ? 60 : LIFE.dismantle + 260) + i * 70 - offset}ms` }} />)}
      {life === "building" ? [0, 1, 2].map(i => <span key={i} className="build-spark" style={{ left: 30 + i * (w - 80) / 2, top: -70 - (i % 2) * 22, animationDelay: `${780 + i * 110 - offset}ms` }}>{"✦"}</span>) : null}
    </span> : null}
    <button type="button" className={"plz-station" + (selected ? " selected" : "") + (agent.offline ? " offline" : "") + lifeCls + (seg.sub ? " is-sub" : "")}
      style={{ left: left - 4, top: top - height - 66, width: w + 22, height: height + 66, zIndex: zOf(top) + 2, "--tone": tone, ...beats } as CSSProperties}
      onClick={() => { if (!agent.leaving) onSelect(agent.id); }} title={card} aria-label={card.replace(/\n/g, " · ")} aria-pressed={selected} data-agent-id={agent.id} data-state={phase}>
      {/* nameplate printed on the desk's front panel; its light breathes while the colleague needs you */}
      <span className="plz-plate" style={{ top: height + 66 - deskH + DESK.slab + 3, height: deskH - DESK.slab - 7, width: w - 12 }}>
        <strong><i data-pulse={live && ATTENTION.has(phase) ? "attention" : live && phase === "running" ? "busy" : undefined} /><span className="plate-name">{agent.name}</span>{agent.host ? <em className="host-chip">{agent.host}</em> : null}</strong>
        <small>{seg.sub ? t("plaza.subtask", { state }) : state}</small>
      </span>
      {live && phase === "running" && !motion && rate ? <span className="tok-rate" style={{ left: sx + 14 * k, top: sy - lift - capH * 1.12 + height + 66 - 20 }}>
        <Icon name="Zap" size={10} color="#60a5fa" /><b>{speed(rate)}</b><small>{t("secondarySessionList.tokS").trim()}</small>
      </span> : null}
      {BUBBLES[phase] && !motion && live ? <span className={"plz-bubble" + (RIPPLE.has(phase) ? " ripple" : "")} style={{ left: bx + 4, top: by + height + 66 }}>
        <Icon name={BUBBLES[phase]!} size={15} color={tone} />
      </span> : null}
    </button>
  </>;
}

// no wall: a soft floor that runs past the world bounds, so the room fills the stage at any zoom
const BLEED = 2400;
function FloorBackdrop({ width, height }: { width: number; height: number }) {
  return <svg className="plz-backdrop" width={width} height={height}>
    <SvgDefs />
    <rect x={-BLEED} y={-BLEED} width={width + BLEED * 2} height={height + BLEED * 2} fill="#eeeae4" />
    <ellipse cx={width / 2} cy={height * 0.55} rx={width * 0.62} ry={height * 0.62} fill="#f4f1ec" filter="url(#plz-softer)" />
  </svg>;
}

function Placed({ pos, children }: { pos: Point; children: ReactNode }) {
  return <svg className="plz-piece" style={{ left: pos[0], top: pos[1], zIndex: zOf(pos[1]) }} width="1" height="1">{children}</svg>;
}

export interface AgentsPlazaProps {
  theme: PluginTheme; agents: PlazaAgent[]; rates: ReadonlyMap<string, number>; selectedId: string | null; onSelect: (id: string) => void;
  /** Changes whenever the visible set changes for a reason other than sessions starting or ending (filters, search, host). */
  filterKey: string; paused: boolean; version: string;
}

/** The session list as an office: one colleague per session, desks grouped by project and checkout. Web only. */
export function AgentsPlaza({ theme, agents, rates, selectedId, onSelect, filterKey, paused, version }: AgentsPlazaProps) {
  ensurePlazaStyles(version);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const stage = useRef<any>(null), pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    const node = stage.current, Observer = (globalThis as any).ResizeObserver;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const tracked = useLifecycle(agents, filterKey);
  const layout: PlazaLayout | null = useMemo(() => size.width && tracked.length ? getPlazaLayout(tracked, size) : null, [tracked, size]);
  const room = layout?.mode === "room", f = layout?.furniture;
  // only the first few idle colleagues in the room stroll to the coffee bar
  const strollers = useMemo(() => new Set(room ? layout!.desks.filter(d => d.agent.phase === "quiet" && !d.seg.sub && !d.agent.offline).slice(0, COFFEE_RUNS).map(d => d.agent.id) : []), [layout, room]);
  const scale = layout?.scale ?? 1;
  const offsetX = layout ? Math.max(0, (size.width - layout.width * scale) / 2) : 0, offsetY = layout ? Math.max(0, (size.height - layout.height * scale) / 2) : 0;
  return <div ref={stage} className={"plz" + (paused ? " is-paused" : "")} style={{ position: "relative", flex: 1, minHeight: 0, overflow: "auto", background: "#eeeae4" }}>
    {layout ? <div style={{ position: "relative", width: Math.max(size.width, layout.width * scale), height: Math.max(size.height, layout.height * scale), overflow: "hidden" }}>
      <div className={"plz-world " + (room ? "is-room" : "is-floor")} style={{ position: "absolute", left: offsetX, top: offsetY, width: layout.width, height: layout.height, transform: `scale(${scale})`, transformOrigin: "0 0", "--world-scale": scale } as CSSProperties}>
        <FloorBackdrop width={layout.width} height={layout.height} />
        {room && f && layout.origin ? <>
          <Placed pos={at(layout.origin, f.coffee[0], 0, f.coffee[1])}><CoffeeBar /></Placed>
          <Placed pos={at(layout.origin, f.sofa[0], 0, f.sofa[1])}><Lounge /></Placed>
          <Placed pos={at(layout.origin, f.plantL[0], 0, f.plantL[1])}><TallPlant s={1.05} /></Placed>
          <Placed pos={at(layout.origin, f.plantR[0], 0, f.plantR[1])}><TallPlant s={0.92} /></Placed>
        </> : null}
        {layout.pods.map(p => <div key={p.project}>
          <svg className="plz-piece" style={{ left: p.origin[0], top: p.origin[1], zIndex: 1 }} width="1" height="1"><FloorRug w={p.rowW + 40} d={p.depth + 140} /></svg>
          <span className="plz-sign" style={{ left: p.origin[0] + p.depth * KX + 6, top: p.origin[1] - p.depth * KY - 250 }}>{p.project}<small>{t("plaza.count", { count: p.agents.length })}</small></span>
        </div>)}
        {layout.desks.map(spot => <Desk key={spot.agent.id} spot={spot as DeskSpot & { agent: Tracked }} selected={selectedId === spot.agent.id} onSelect={onSelect} height={room ? 116 : 108}
          coffee={strollers.has(spot.agent.id)} rate={rates.get(spot.agent.id)} paused={pausedRef} theme={theme} />)}
      </div>
    </div> : null}
  </div>;
}
