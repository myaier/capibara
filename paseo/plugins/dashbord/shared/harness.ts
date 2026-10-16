import { quotaBaseOf, type ProviderBases } from "./provider-bases";

/**
 * The coding harness (CLI) a session runs on, for the small brand mark before its live 「tk/s」. Native <Image> does not draw
 * SVG, so a mark is a brand-coloured tile with a Lucide glyph or a letter or two, like vivid-activity's file chips.
 */
export interface Harness {
  id: string;
  /** Product name, not translated. */
  name: string;
  /** Brand colour of the tile; `null` picks a stable palette hue from the id (`hueFor`). */
  color: string | null;
  /** A Lucide icon name, or `text` when no icon fits. */
  icon?: string;
  text?: string;
}

const KNOWN: readonly Harness[] = [
  { id: "claude", name: "Claude Code", color: "#D97757", icon: "Asterisk" },
  { id: "codex", name: "Codex", color: "#10A37F", icon: "Aperture" },
  { id: "kimi", name: "Kimi", color: "#1F6FEB", text: "K" },
  { id: "opencode", name: "OpenCode", color: "#211E1E", text: "oc" },
  { id: "copilot", name: "Copilot", color: "#8534F3", icon: "Bot" },
  { id: "gemini", name: "Gemini", color: "#4285F4", icon: "Sparkle" },
  { id: "grok", name: "Grok", color: "#18181B", text: "G" },
  { id: "omp", name: "Oh My Pi", color: "#0F766E", text: "π" },
  { id: "pi", name: "Pi", color: "#0F766E", text: "π" },
  { id: "antigravity", name: "Antigravity", color: "#4285F4", icon: "Orbit" },
  { id: "muse", name: "Muse Code", color: "#DB2777", text: "M" },
];
/** Matched inside custom ids (`my-claude`, `codex-proxy`); short ids like `pi` only match exactly. */
const CONTAINED = KNOWN.filter(harness => harness.id.length >= 4);

/** A custom provider counts as the provider it extends; otherwise its id names it (exactly, then by a known name inside). */
export function harnessOf(provider: string, bases: ProviderBases = {}): Harness {
  const id = quotaBaseOf(provider, bases).toLowerCase();
  const known = KNOWN.find(harness => harness.id === id) ?? CONTAINED.find(harness => id.includes(harness.id));
  if (known) return known;
  const initial = Array.from(provider.replace(/^[^\p{L}\p{N}]+/u, ""))[0]?.toUpperCase() ?? "?";
  return { id: provider, name: provider, color: null, text: initial };
}
