// State effects. Head effects ride with the capybara (origin = its feet); desk effects sit on the workstation.
// Everything animates in CSS so a full office of effects stays cheap and pauses with the app.
import type { CSSProperties } from "react";
import { P, DESK, SEAT } from "./geometry";

const at = (h: number, x: number, y: number, extra: CSSProperties = {}): CSSProperties => ({ left: x * h, top: y * h, ...extra });
const Star = ({ size = 8, color }: { size?: number; color: string }) => <svg width={size} height={size} viewBox="-5 -5 10 10" style={{ display: "block" }}><path d="M0-5Q0.6-0.6 5 0Q0.6 0.6 0 5Q-0.6 0.6-5 0Q-0.6-0.6 0-5Z" fill={color} /></svg>;

export function HeadFx({ phase, h }: { phase: string; h: number }) {
  const k = h / 116;
  switch (phase) {
    case "question":
      return <>{[0, 1, 2].map(i => <span key={i} className="fx fx-q" style={at(h, 0.3 + i * 0.07, -1.0, {fontSize: 17 * k, animationDelay: `${i * 0.95}s`})}>?</span>)}</>;
    case "approval":
      return <svg className="fx fx-notice" style={at(h, -0.46, -1.16)} width={26 * k} height={22 * k} viewBox="0 0 26 22">
        <path d="M4 18 L1 13 M11 14 L10 6 M18 15 L23 9" stroke="#f0a92b" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      </svg>;
    case "plan":
      return <span className="fx fx-doc" style={at(h, 0.44, -1.04, {width: 22 * k, height: 27 * k})}>
        <svg viewBox="0 0 22 27" width="100%" height="100%"><rect x="1" y="1" width="20" height="25" rx="3" fill="#fff" stroke="#e7dfd3" />
          <rect x="5" y="7" width="12" height="2" rx="1" fill="#d8d1c6" /><rect x="5" y="12" width="9" height="2" rx="1" fill="#d8d1c6" /><rect x="5" y="17" width="11" height="2" rx="1" fill="#d8d1c6" />
          <g className="fx-doc-check"><circle cx="17" cy="21" r="5" fill="#34d399" /><path d="M14.6 21.2 L16.4 23 L19.6 19.6" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></g>
        </svg>
      </span>;
    case "error":
      return <>
        <span className="fx fx-bang" style={at(h, 0.4, -1.12, {fontSize: 24 * k})}>!</span>
        <span className="fx fx-sweat" style={at(h, 0.3, -0.92, {width: 8 * k, height: 11 * k})} />
      </>;
    case "quota":
      return <svg className="fx fx-sigh" style={at(h, 0.38, -0.66)} width={30 * k} height={18 * k} viewBox="0 0 30 18">
        <path d="M6 14 C1 14 1 8 6 8 C6 3 13 2 15 6 C18 2 25 4 24 9 C29 9 29 15 24 15 Z" fill="#fff" stroke="#e3ddd4" strokeWidth="1.2" />
      </svg>;
    case "unfinished": {
      // dazed stars circling the crown on a flat ellipse
      const rx = 0.36 * h, ry = 0.09 * h;
      const path = `path("M ${-rx} 0 A ${rx} ${ry} 0 1 0 ${rx} 0 A ${rx} ${ry} 0 1 0 ${-rx} 0")`;
      return <span className="fx fx-orbit" style={at(h, 0.02, -1.04)}>
        {[0, 1, 2].map(i => <span key={i} className="fx-orbit-star" style={{ offsetPath: path, animationDelay: `${-i * 0.62}s` } as CSSProperties}><Star size={(i ? 9 : 11) * k} color="#f5b83d" /></span>)}
      </span>;
    }
    case "unread":
      return <>{([[0.46, -0.6, 0], [0.26, -0.74, 0.5], [0.54, -0.36, 1]] as const).map(([x, y, d], i) =>
        <span key={i} className="fx fx-twinkle" style={at(h, x, y, {animationDelay: `${d}s`})}><Star size={(i === 1 ? 11 : 8) * k} color="#f472b6" /></span>)}</>;
    case "idle":
      return <span className="fx fx-typing" style={at(h, 0.4, -1.12, {transform: `scale(${k})`})}><i /><i /><i /></span>;
    case "done":
      return <>
        <span className="fx fx-done" style={at(h, -0.02, -1.2, {width: 22 * k, height: 22 * k})}>
          <svg viewBox="0 0 22 22" width="100%" height="100%"><circle cx="11" cy="11" r="10" fill="#34d399" /><path d="M6.5 11.4 L9.6 14.4 L15.6 8" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        {([[-0.4, -0.96, 0.2], [0.44, -1.1, 1.1], [0.5, -0.7, 2]] as const).map(([x, y, d], i) =>
          <span key={i} className="fx fx-twinkle slow" style={at(h, x, y, {animationDelay: `${d}s`})}><Star size={9 * k} color="#f2c14e" /></span>)}
      </>;
    case "snoozed":
      return <span className="fx fx-snooze" style={at(h, 0.42, -1.1, {transform: `scale(${k})`})}>
        <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="11" r="7" fill="#fff" stroke="#818cf8" strokeWidth="1.8" />
          <path d="M10 7.5 V11 L12.5 12.5" stroke="#818cf8" strokeWidth="1.6" strokeLinecap="round" fill="none" />
          <path d="M3.5 4.5 L6 2.5 M16.5 4.5 L14 2.5" stroke="#818cf8" strokeWidth="1.6" strokeLinecap="round" /></svg>
        <b>z</b>
      </span>;
    case "quiet":
      return <span className="fx fx-steam" style={at(h, 0.06, -0.62, {transform: `scale(${k})`})}><i /><i /></span>;
    case "silent":
      // nothing came out of this turn: crickets
      return <>{[0, 1].map(i => <span key={i} className="fx fx-cricket" style={at(h, 0.36 + i * 0.12, -0.98 + i * 0.06, {fontSize: (14 - i * 2) * k, animationDelay: `${i * 1.4}s`})}>♪</span>)}</>;
    case "canceled":
      return <span className="fx fx-stamp" style={at(h, 0.32, -1.12, {width: 24 * k, height: 24 * k})}>
        <svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="12" cy="12" r="10" fill="#fff" stroke="#b5afa7" strokeWidth="2" /><path d="M8.2 8.2 L15.8 15.8 M15.8 8.2 L8.2 15.8" stroke="#a39d95" strokeWidth="2.2" strokeLinecap="round" /></svg>
      </span>;
    default:
      return null;
  }
}

const GLYPHS = ["</>", "{ }", "01", ";", "=>", "[ ]"];

// desk-local effects: keystrokes over the keyboard, things above the monitor
export function DeskFx({ phase, seed = 0 }: { phase: string; seed?: number }) {
  const mx = DESK.w - 56, mz = DESK.d - 9;
  const [kx, ky] = P(SEAT.x, DESK.h + 4, DESK.d * 0.42);
  const [tx, ty] = P(mx + 25, DESK.h + 56, mz + 4);
  switch (phase) {
    case "running":
      return <>{[0, 1, 2, 3].map(i => <span key={i} className="fx fx-key" style={{left: kx - 22 + i * 14, top: ky, animationDelay: `${(i * 0.55 + (seed % 5) * 0.13).toFixed(2)}s`}}>{GLYPHS[(i + seed) % GLYPHS.length]}</span>)}</>;
    case "starting":
      return <span className="fx fx-spinner" style={{left: tx - 8, top: ty - 10}} />;
    case "error":
      return <span className="fx fx-smoke" style={{left: tx - 6, top: ty - 4}}><i /><i /></span>;
    case "quota":
      return <span className="fx fx-battery" style={{left: tx - 11, top: ty - 6}}><i /></span>;
    default:
      return null;
  }
}
