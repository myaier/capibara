import { statsTimeZoneSchema, type StatsMetrics, type StatsTool } from "../shared/stats";

/** Internal, compact storage types. Directory descriptors never cross the RPC boundary. */
export type StatsHour = StatsMetrics & { hour: string };
/**
 * One Agent's metrics in one UTC hour (`hour` is the ISO start), kept only for hours with activity. Hours rather than
 * days, so each device time zone regroups them into its own local days: a UTC day would put a US Pacific evening
 * (from 17:00 in summer) on the next day.
 */
export type StatsAttribution = StatsMetrics & { agentId: string; hour: string; lastActiveAt: string };
/** Tool calls of one UTC hour; `kinds` are exact per-kind totals that survive the per-hour name cap. */
export interface StatsToolHour { hour: string; tools: StatsTool[]; kinds?: StatsTool[] }
export interface StatsAgentRecord {
  agentId: string; lastKey: string | null; maxTurnMs: number; maxTurnAt: string | null; updatedAt: number;
}
export interface StatsDirectoryAgent {
  id: string; createdAt: string; provider: string; model: string | null; parentAgentId: string | null;
  projectKey: string; projectName: string; status: string; archivedAt: string | null; title: string | null;
  requiresAttention: boolean; attentionReason: string | null; pendingPermissions: number; activeTurn: boolean;
  /** Latest user message; a final reply written after it decides 待回复. */
  lastUserMessageAt?: string | null;
  /** Native last update: an upper bound for when the last turn ended. */
  updatedAt?: string | null;
  contextUsed: number | null; contextMax: number | null;
  /** Provider session id (`persistence.sessionId`), for matching provider logs. */
  sessionId: string | null;
  /** Exact working directory, used to attribute provider logs to the Paseo project. */
  cwd?: string;
  /** Paseo workspace, and the `paseo.schedule-id` / `paseo.schedule-run` labels a schedule stamps on the Agents it creates (定时运行). */
  workspaceId?: string | null;
  scheduleId?: string | null;
  scheduleRunId?: string | null;
}

export const STATS_HOUR_MS = 3_600_000;
export const STATS_DAY_MS = 86_400_000;
export const statsHour = (at: number): string => new Date(Math.floor(at / STATS_HOUR_MS) * STATS_HOUR_MS).toISOString();
export const statsDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
/** YYYY-MM-DD of a day number (days since 1970-01-01). */
export const statsDayText = (day: number): string => new Date(day * STATS_DAY_MS).toISOString().slice(0, 10);

/**
 * The device's clock for grouping: `offsetAt(at)` is what to add to a UTC instant to read its local wall time. A named
 * zone gives every instant its own offset (exact across daylight-saving changes); `name` is null for the fixed offset.
 */
export interface StatsZone { readonly name: string | null; offsetAt(at: number): number }
/** Local calendar day number of an instant. */
export const statsLocalDay = (at: number, zone: StatsZone): number => Math.floor((at + zone.offsetAt(at)) / STATS_DAY_MS);
/** Local wall-clock hour (0–23) of an instant. */
export const statsLocalHour = (at: number, zone: StatsZone): number => new Date(at + zone.offsetAt(at)).getUTCHours();

// Every current offset and every transition instant is a multiple of 15 minutes, so one lookup per slot is exact.
const SLOT_MS = 15 * 60_000, SLOTS_PER_DAY = STATS_DAY_MS / SLOT_MS, MAX_ZONES = 8, MAX_CACHED = 20_000;
interface ZoneTable { offset(at: number): number | null }
const tables = new Map<string, ZoneTable | null>();

/** Local wall time minus UTC at `at`, or null when the instant cannot be formatted. */
function wallOffset(format: Intl.DateTimeFormat, at: number): number | null {
  try {
    const part: Record<string, number> = {};
    for (const { type, value } of format.formatToParts(at)) if (type !== "literal") part[type] = Number(value);
    // `% 24`: some ICU versions print midnight as 24 even with h23.
    const offset = Date.UTC(part.year, part.month - 1, part.day, part.hour % 24, part.minute, part.second) - Math.floor(at / 1000) * 1000;
    return Number.isFinite(offset) && Math.abs(offset) <= 18 * STATS_HOUR_MS ? offset : null;
  } catch { return null; }
}

function createTable(timeZone: string): ZoneTable | null {
  let format: Intl.DateTimeFormat;
  try {
    // en-US with the Gregorian calendar and Latin digits, whatever this server's default locale is.
    format = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  } catch { return null; } // RangeError: a zone this server's time zone data does not know.
  if (wallOffset(format, Date.now()) === null) return null;
  const slots = new Map<number, number | null>(), days = new Map<number, number | null>();
  const slot = (index: number): number | null => {
    if (!slots.has(index)) { if (slots.size >= MAX_CACHED) slots.clear(); slots.set(index, wallOffset(format, index * SLOT_MS)); }
    return slots.get(index)!;
  };
  return { offset: at => {
    // One lookup per UTC day: a day that starts and ends on the same offset has no transition in between.
    const day = Math.floor(at / STATS_DAY_MS);
    if (!days.has(day)) {
      if (days.size >= MAX_CACHED) days.clear();
      const start = slot(day * SLOTS_PER_DAY), end = slot((day + 1) * SLOTS_PER_DAY);
      days.set(day, start !== null && start === end ? start : null);
    }
    return days.get(day) ?? slot(Math.floor(at / SLOT_MS));
  } };
}

function zoneTable(timeZone: string): ZoneTable | null {
  if (!statsTimeZoneSchema.safeParse(timeZone).success) return null;
  if (tables.has(timeZone)) { const table = tables.get(timeZone)!; tables.delete(timeZone); tables.set(timeZone, table); return table; }
  const table = createTable(timeZone);
  tables.set(timeZone, table);
  while (tables.size > MAX_ZONES) tables.delete(tables.keys().next().value!);
  return table;
}

/**
 * The device's IANA `timeZone` (named as the device reports it) when this server knows it and it agrees with the
 * device's own offset at `now`; otherwise the fixed `utcOffsetMinutes`. On disagreement the device wins: outdated zone
 * data on either side would otherwise move today's midnight away from the clock the user is looking at.
 */
export function statsZone(utcOffsetMinutes: number, timeZone?: string | null, now = Date.now()): StatsZone {
  const fixed = utcOffsetMinutes * 60_000, table = timeZone ? zoneTable(timeZone) : null;
  if (!timeZone || !table || table.offset(now) !== fixed) return { name: null, offsetAt: () => fixed };
  return { name: timeZone, offsetAt: at => table.offset(at) ?? fixed };
}
