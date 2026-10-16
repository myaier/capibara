import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Which base a Paseo provider id runs on, for 恢复后续跑's 额度窗口 option (opus-B18: the host's usage sources are named after
 * the base, claude / codex …, never after a custom id) and 交给另一个 Provider's 同一额度来源 hint (opus-B23). A custom provider
 * that `extends` a built-in or plugin provider runs that CLI, so it counts as its base; an ACP provider (`extends: "acp"`) and
 * every other id stand for themselves. Paseo allows one level of `extends`. Read from the daemon config by
 * server/provider-bases.ts; only `agents.providers.<id>.extends` leaves it. No provider id is assumed here.
 */
export const getProviderBases = defineRpc({
  name: "observatory.providers.bases",
  input: z.object({}),
  output: z.object({ bases: z.record(z.string().max(64), z.string().max(64)) }),
});
export type ProviderBases = Readonly<Record<string, string>>;

const ID = /^[\w.-]{1,64}$/;
/** At most this many custom providers are read (a config is far smaller). */
export const MAX_PROVIDER_BASES = 200;

/** Custom provider id → the provider it extends, from a daemon config (`agents.providers.<id>.extends`); ACP ones are left out. */
export function providerBasesFromConfig(config: unknown): Record<string, string> {
  const providers = (config as { agents?: { providers?: unknown } } | null)?.agents?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  const bases: Record<string, string> = {};
  for (const [id, entry] of Object.entries(providers as Record<string, unknown>).slice(0, MAX_PROVIDER_BASES)) {
    const base = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as { extends?: unknown }).extends : undefined;
    if (ID.test(id) && typeof base === "string" && ID.test(base) && base !== "acp" && base !== id) bases[id] = base;
  }
  return bases;
}

/** The base a provider id runs on (its usage source): what it extends, else the id itself. */
export function quotaBaseOf(provider: string, bases: ProviderBases = {}): string {
  return bases[provider] ?? provider;
}
