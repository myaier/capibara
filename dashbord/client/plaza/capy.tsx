import { useEffect, useRef } from "react";
import { poseAt, routeAt, TYPING_FRAMES, type Motion, type Route } from "./motion";
import { P } from "./geometry";
import { HeadFx } from "./fx";
import { BODY, frameOf, loadAtlas, type Persona } from "./sprites";

export function CarryBox() {
  return <svg viewBox="0 0 46 40" width="100%" style={{ display: "block", overflow: "visible" }}>
    <path d="M10 6 C8 -4 18 -6 17 6 Z" fill="#8db28a" /><path d="M17 7 C22 -6 32 -2 25 8 Z" fill="#a3c49c" />
    <rect x="31" y="1" width="5" height="9" rx="1" fill="#ad9fcc" transform="rotate(10 33 6)" />
    <path d="M3 8 H43 L41 37 Q23 40 5 37 Z" fill="#d6ac7c" stroke="#3a2a1f" strokeWidth="2" strokeLinejoin="round" />
    <path d="M3 8 L-2 2 M43 8 L48 2" stroke="#3a2a1f" strokeWidth="2" strokeLinecap="round" />
    <path d="M3 8 L-2 2 L10 1 L16 8 Z M43 8 L48 2 L36 1 L30 8 Z" fill="#e3bd90" stroke="#3a2a1f" strokeWidth="1.6" strokeLinejoin="round" />
    <rect x="16" y="16" width="14" height="5" rx="1" fill="#c79a68" />
  </svg>;
}

/** Draws one frame with its feet on (fx, fy); `height` is the body height in CSS pixels. */
function drawFrame(ctx: any, img: any, persona: Persona, name: string, fx: number, fy: number, height: number) {
  const f = frameOf(persona, name);
  if (!f) return;
  const [x, y, w, h, ax, ay] = f, k = height / BODY;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x, y, w, h, fx - ax * k, fy - ay * k, w * k, h * k);
}

// canvas box around the feet, wide enough for raised paws and held props
const BOX = { left: 0.66, right: 0.66, up: 1.14, down: 0.06 };

// one shared animation clock for every capybara on the page
const subscribers = new Set<(now: number) => void>();
let ticking = false;
function tick(now: number) {
  for (const fn of subscribers) fn(now);
  if (subscribers.size) requestAnimationFrame(tick); else ticking = false;
}
function subscribe(fn: (now: number) => void) {
  subscribers.add(fn);
  if (!ticking) { ticking = true; requestAnimationFrame(tick); }
  return () => { subscribers.delete(fn); };
}

export interface CapyProps {
  persona: Persona; phase: string; serial?: number; height?: number; seatLift?: number;
  /** Frozen: an offline host's snapshot; the pose stays where it was. */
  frozen?: boolean; paused: { current: boolean };
  motion?: Motion | null; route?: Route | null; seatY?: number | null; offset?: number; dpr?: number;
}

/**
 * Animated capybara whose feet sit on the wrapper origin (its seat on the floor).
 * `motion` plays a route (entering, leaving, coffee) relative to the seat; `seatY` lets a moving
 * colleague re-sort itself in depth against desks it walks behind.
 */
export function Capy({ persona, phase, serial = 0, height = 116, seatLift = 0, frozen = false, paused, motion = null, route = null, seatY = null, offset = 0, dpr = 2 }: CapyProps) {
  const wrap = useRef<any>(null), walk = useRef<any>(null), act = useRef<any>(null), canvas = useRef<any>(null), fxRef = useRef<any>(null), freeze = useRef(frozen);
  freeze.current = frozen;
  // routes arrive as fresh objects on every layout pass; key them by value so animations never restart
  const routeRef = useRef(route), routeKey = route ? JSON.stringify(route) : "";
  routeRef.current = route;
  const W = height * (BOX.left + BOX.right), H = height * (BOX.up + BOX.down);
  useEffect(() => {
    let dead = false, elapsed = offset, last = performance.now(), drawn = "", placed = "", stepped = "", acted = "", img: any = null;
    void loadAtlas(persona).then(loaded => { img = loaded; drawn = ""; });
    const paint = (now: number) => {
      const c = canvas.current, w = wrap.current;
      if (dead || !c || !w) return;
      if (!freeze.current && !paused.current) elapsed += Math.min(120, Math.max(0, now - last));
      last = now;
      const move = motion ? routeAt(motion, elapsed, routeRef.current ?? undefined) : null;
      const name = move?.frame ?? poseAt(phase, elapsed, serial).frame;
      const lift = move ? move.lift : 1;
      const [ox, oy] = move ? P(move.x, 0, move.z) : [0, 0];
      // only touch the DOM when something changed; seated colleagues cost nothing per frame
      const place = `translate(${ox.toFixed(1)}px, ${(oy - seatLift * lift).toFixed(1)}px)|${(move?.opacity ?? 1).toFixed(2)}|${move?.carry ? 1 : 0}`;
      if (place !== placed) {
        placed = place;
        const [transform, opacity] = place.split("|");
        w.style.transform = transform;
        w.style.opacity = opacity;
        w.dataset.standing = lift < 0.98 ? "true" : "false";
        w.dataset.carry = move?.carry ? "true" : "false";
        if (seatY != null && w.parentElement) w.parentElement.style.zIndex = String(Math.round((seatY + oy) * 2));
      }
      // walking: alternate feet, bob on every step, face the direction of travel
      const step = move?.walking && move.step != null ? move.step : null;
      const gait = step == null ? `scale(${move?.flip ? -1 : 1}, 1)`
        : `translateY(${(-Math.abs(Math.sin(step / 170 * Math.PI)) * 3.2).toFixed(2)}px) rotate(${(Math.sin(step / 170 * Math.PI) * 2.2).toFixed(2)}deg) scale(${move!.flip ? -1 : 1}, 1)`;
      if (gait !== stepped && walk.current) { stepped = gait; walk.current.style.transform = gait; }
      const mode = freeze.current ? "frozen" : move?.act || (move && (move.walking || move.lift < 0.98) ? "moving" : phase);
      if (mode !== acted && act.current) {
        acted = mode;
        act.current.dataset.act = mode;
        if (fxRef.current) fxRef.current.style.visibility = mode === phase ? "visible" : "hidden";
      }
      if (!img || name === drawn) return;
      const prev = drawn;
      drawn = name;
      const ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      drawFrame(ctx, img, persona, name, height * BOX.left, height * BOX.up, height);
      c.dataset.frame = name;
      // a tiny squash on pose changes hides the cut; typing and walking keep crisp alternation
      if (prev && !(TYPING_FRAMES.has(prev) && TYPING_FRAMES.has(name)) && !name.startsWith("walk") && c.animate && !paused.current)
        c.animate([{ transform: "scale(1.04, 0.955)" }, { transform: "scale(0.985, 1.02)" }, { transform: "scale(1, 1)" }], { duration: 260, easing: "ease-out" });
    };
    paint(last);
    const stop = subscribe(paint);
    return () => { dead = true; stop(); };
  }, [persona, phase, serial, height, seatLift, motion, routeKey, seatY, offset, dpr, W, H]);
  return <span ref={wrap} className="capy" data-phase={phase} data-persona={persona}>
    <span className="capy-shadow" style={{ width: height * 0.62, height: height * 0.11, left: -height * 0.31, top: -height * 0.055 }} />
    <span ref={act} className="capy-act" data-act={frozen ? "frozen" : phase}>
      <span ref={walk} className="capy-walk">
        <span className="capy-breath" style={{ animationDelay: `${-(serial % 7) * 0.53}s` }}>
          {/* the packed box rides on the head on the way out */}
          <span className="capy-carry" style={{ left: -height * 0.2, top: -height * 1.24, width: height * 0.4 }}><CarryBox /></span>
          <canvas ref={canvas} width={Math.round(W * dpr)} height={Math.round(H * dpr)}
            style={{ width: W, height: H, left: -height * BOX.left, top: -height * BOX.up, transformOrigin: `${height * BOX.left}px ${height * BOX.up}px` }} />
        </span>
      </span>
    </span>
    {!frozen ? <span ref={fxRef} className="capy-fx"><HeadFx phase={phase} h={height} /></span> : null}
  </span>;
}
