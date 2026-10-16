import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./paseo-home";
import { telemetryDirectory } from "./telemetry";

/** An IANA zone name as the RPCs accept it (`US/Pacific`, `Europe/Berlin`, `Etc/GMT+8`), usable by `Intl`. */
export function validZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z][\w+-]*(\/[\w+-]+){0,2}$/.test(value)) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return value; } catch { return null; }
}

/**
 * The time zone of the devices the user reads the observatory on (grok-F2). The plugin runs inside the daemon, often on a
 * server set to UTC, while the user reads on a phone in another zone; work that has no client at hand (a limit notice
 * without a zone at a turn's end, a day window of a background analysis) uses the zone a client reported last. Clients
 * report it with their reads; it is kept in one small file, so a daemon restart does not fall back to the host's zone.
 * Only the zone name is stored.
 */
export class DeviceZone {
  private zone: string | null = null;
  private saved: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly hostZone: string | null;
  readonly ready: Promise<void>;

  constructor(options: { directory?: string; hostZone?: string | null } = {}) {
    this.file = join(options.directory ?? telemetryDirectory(), "device-zone.json");
    this.hostZone = validZone(options.hostZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.ready = readFile(this.file, "utf8").then(text => { const zone = validZone((JSON.parse(text) as { zone?: unknown }).zone); if (zone && !this.zone) { this.zone = zone; this.saved = zone; } }).catch(() => {});
  }

  /** A client's zone (ignored unless valid); written only when it changes. */
  note(value: unknown): void {
    const zone = validZone(value);
    if (!zone || zone === this.zone) return;
    this.zone = zone;
    this.writing = this.writing.then(() => this.save()).catch(() => {});
  }
  /** The devices' zone when one has been reported, else null. */
  device(): string | null { return this.zone; }
  /** The zone to read a wall-clock time in: the devices' when known, else the host process's (possibly UTC). */
  current(): string | null { return this.zone ?? this.hostZone; }

  private async save(): Promise<void> {
    const zone = this.zone;
    if (!zone || zone === this.saved) return;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await ensurePrivateDirectory(join(this.file, ".."));
      await writeFile(temporary, JSON.stringify({ version: 1, zone }), { mode: 0o600 });
      await rename(temporary, this.file);
      this.saved = zone;
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async close(): Promise<void> { await this.writing; }
}
