import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface PaseoHomeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** Where a rejected value is reported (console.warn); tests collect it. */
  log?: (message: string) => void;
}
const reported = new Set<string>();

/**
 * The daemon home every part of the plugin reads and writes under: `PASEO_HOME` when it is an absolute path or starts with
 * `~/` (`~` alone is the home directory), else `~/.paseo`. A relative value would depend on the plugin process's working
 * directory, so it is not used; it falls back to `~/.paseo` and is logged once.
 */
export function resolvePaseoHome(options: PaseoHomeOptions = {}): string {
  const env = options.env ?? process.env, home = options.home ?? homedir();
  const raw = env.PASEO_HOME?.trim(), fallback = join(home, ".paseo");
  if (!raw) return fallback;
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  if (isAbsolute(raw)) return resolve(raw);
  if (!reported.has(raw)) {
    reported.add(raw);
    (options.log ?? (message => console.warn(message)))(`[agent-observatory] PASEO_HOME "${raw.slice(0, 200)}" is neither an absolute path nor ~/…; using ${fallback}`);
  }
  return fallback;
}

/**
 * Creates a plugin data directory private to the user (0700) and tightens an existing one that others can read or enter
 * (`mkdir` leaves an existing directory's mode alone). A symlink, or a directory owned by someone else, is left as it is.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isDirectory() && (info.mode & 0o077) !== 0 && info.uid === (process.getuid?.() ?? info.uid)) await chmod(path, 0o700);
}
