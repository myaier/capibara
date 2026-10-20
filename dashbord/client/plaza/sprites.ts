// Capybara colleague atlases: every pose of a persona packed into one WebP, frames normalised to the same body height.
// The plaza chunk inlines them (esbuild dataurl loader), so the scene needs no network access.
import headset from "../../assets/plaza/headset.webp";
import beanie from "../../assets/plaza/beanie.webp";
import glasses from "../../assets/plaza/glasses.webp";
import frames from "../../assets/plaza/frames.json";

export type Persona = "headset" | "beanie" | "glasses";
export const PERSONAS: readonly Persona[] = ["headset", "beanie", "glasses"];
const URLS: Record<Persona, string> = { headset, beanie, glasses };
/** [x, y, w, h, anchorX, anchorY]: the frame in the atlas and the feet inside it. */
type Frame = readonly [number, number, number, number, number, number];
const SHEETS = frames.personas as unknown as Record<Persona, { frames: Record<string, Frame> }>;
export const BODY: number = frames.body;
export const frameOf = (persona: Persona, name: string): Frame | undefined => SHEETS[persona].frames[name] ?? SHEETS[persona].frames.relaxed;

const atlases = new Map<Persona, Promise<any>>();
export function loadAtlas(persona: Persona): Promise<any> {
  let pending = atlases.get(persona);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const image = new (globalThis as any).Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = URLS[persona];
    });
    atlases.set(persona, pending);
  }
  return pending;
}

/** Identity follows the session (host + id); state, filters and names never change it. */
export function personaFor(id: string): Persona {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  return PERSONAS[hash % PERSONAS.length]!;
}
