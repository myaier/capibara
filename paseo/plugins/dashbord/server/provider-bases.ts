import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { providerBasesFromConfig } from "../shared/provider-bases";
import { resolvePaseoHome } from "./paseo-home";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const TTL_MS = 5 * 60_000;

/**
 * `agents.providers.<id>.extends` of `$PASEO_HOME/config.json` per custom provider (shared/provider-bases.ts). Nothing else
 * from the config leaves this function (it also holds provider env and commands). {} when it is missing, too large or not
 * JSON. Never throws.
 */
export async function readProviderBases(home: string = resolvePaseoHome()): Promise<Record<string, string>> {
  const file = join(home, "config.json");
  try {
    if ((await stat(file)).size > MAX_CONFIG_BYTES) return {};
    return providerBasesFromConfig(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return {};
  }
}

/** The map, read at most once per 5 minutes (a config edit shows up within that), one read at a time. */
export function providerBasesReader(options: { home?: string; now?: () => number; ttlMs?: number } = {}): () => Promise<Record<string, string>> {
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? TTL_MS;
  let cached: { at: number; value: Promise<Record<string, string>> } | null = null;
  return () => {
    if (!cached || now() - cached.at > ttl) cached = { at: now(), value: readProviderBases(options.home ?? resolvePaseoHome()) };
    return cached.value;
  };
}
