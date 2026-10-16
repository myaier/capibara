import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Built-in providers that implement steering in Paseo 0.11 (the same list as the client's `send-plan.ts`). */
export const STEERING_BASES: readonly string[] = ["claude", "codex", "pi", "opencode", "omp"];
/** Built-in providers whose steering also takes slash commands (the client's `SLASH_STEERING_PROVIDERS`). */
export const SLASH_STEERING_BASES: readonly string[] = ["claude"];
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** Custom provider ids in a daemon config whose `extends` names one of `bases` (one level deep, as Paseo allows). */
export function steerableFromConfig(config: unknown, bases: readonly string[] = STEERING_BASES): string[] {
  const providers = (config as { agents?: { providers?: unknown } } | null)?.agents?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
  return Object.entries(providers as Record<string, unknown>)
    .filter(([id, entry]) => /^[\w.-]{1,64}$/.test(id) && !!entry && typeof entry === "object"
      && bases.includes(String((entry as { extends?: unknown }).extends)))
    .map(([id]) => id);
}

/** Custom provider ids built on Claude: the only ones that take a steered slash command. */
export function slashSteerableFromConfig(config: unknown): string[] {
  return steerableFromConfig(config, SLASH_STEERING_BASES);
}

/** The built-in steering provider each custom id extends, so the client can tell what a command does to it. */
export function providerBasesFromConfig(config: unknown): Record<string, string> {
  const providers = (config as { agents?: { providers?: unknown } } | null)?.agents?.providers as Record<string, { extends?: unknown }> | undefined;
  return Object.fromEntries(steerableFromConfig(config).map((id) => [id, String(providers?.[id]?.extends)]));
}

/** `PASEO_HOME` when absolute or `~/…`, else `~/.paseo` (a relative value would depend on the plugin's working directory). */
export function daemonHome(env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): string {
  const raw = env.PASEO_HOME?.trim();
  if (!raw) return join(home, ".paseo");
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : join(home, ".paseo");
}

/**
 * The built-in steering providers plus this daemon's custom ids built on them, read from `$PASEO_HOME/config.json`.
 * Only `agents.providers.<id>.extends` is read; nothing else from the config leaves this function. Never throws.
 */
export async function readSteerableProviders(env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): Promise<string[]> {
  return (await readSendCapabilities(env, home)).steerable;
}

/**
 * What the client's `sendPlan()` needs: providers that steer at all, those that also steer slash commands (Claude
 * and the ids built on it), and the built-in each custom id extends. `bases` is optional for callers written before
 * it existed; without it `sendPlan()` reads commands into custom ids cautiously.
 */
export interface SendCapabilities {
  steerable: string[];
  slashSteerable: string[];
  bases?: Record<string, string>;
}

/**
 * The daemon's send capabilities. Same config read and the same guarantees as `readSteerableProviders()`. Pass all
 * three fields through to `sendPlan()`; an RPC schema must keep `bases`.
 */
export async function readSendCapabilities(env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): Promise<SendCapabilities> {
  const fallback = { steerable: [...STEERING_BASES], slashSteerable: [...SLASH_STEERING_BASES], bases: {} };
  try {
    const text = await readFile(join(daemonHome(env, home), "config.json"), "utf8");
    if (text.length > MAX_CONFIG_BYTES) return fallback;
    const config = JSON.parse(text);
    return {
      steerable: [...new Set([...STEERING_BASES, ...steerableFromConfig(config)])],
      slashSteerable: [...new Set([...SLASH_STEERING_BASES, ...slashSteerableFromConfig(config)])],
      bases: providerBasesFromConfig(config),
    };
  } catch {
    return fallback;
  }
}
