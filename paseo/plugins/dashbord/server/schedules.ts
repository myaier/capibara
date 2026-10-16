import { translator } from "../shared/i18n";
import { t } from "../shared/text";
import { randomUUID } from "node:crypto";
import { watch as watchDirectory } from "node:fs";
import { open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { HEARTBEAT_LIST_MAX, HEARTBEAT_TARGETS_MAX, RUN_WINDOWS, cadenceLabel, findChangeRequest, getScheduleHeartbeats, getScheduleRun, listScheduleRuns, normalizeRunQuery, parseTime, previewOf, runSearchText, searchFold,
  type HeartbeatSummary, type HeartbeatsResponse, type RunLink, type RunStatus, type RunWindow, type ScheduleRunDetail, type ScheduleRunRow, type ScheduleRunsResponse,
  type ScheduleRunsState, type ScheduleSummary } from "../shared/schedules";
import { contentRevision } from "./revision";
import type { StatsDirectoryAgent } from "./stats-types";
import { telemetryDirectory } from "./telemetry";
import { ensurePrivateDirectory, resolvePaseoHome } from "./paseo-home";
import { redactSecrets } from "./redaction";
import { withoutUserinfo } from "../shared/change-request";

/**
 * 定时运行 index. The plugin SDK has no schedules API, so the daemon's own records are read (read-only):
 * `$PASEO_HOME/schedules/*.json` (one file per schedule, every run with its final reply) and
 * `$PASEO_HOME/projects/workspaces.json` (archived workspaces keep their name and branch only there).
 * Agents come from the shared StatsDirectory walk (once a minute, already paid for by 看板 / Token), joined by
 * run id, the `paseo.schedule-run` label, or — for heartbeats — the schedule's target Agent. Paseo's agent list leaves
 * out every Agent whose project was removed (each run gets its own workspace, so old runs lose their project easily),
 * so the records under `$PASEO_HOME/agents/` fill the gaps for Agents a schedule created or points at.
 *
 * A schedule's file disappears with the schedule, and its run history with it. The observatory keeps a small
 * metadata ledger (no replies, no prompts: a schedule without a name or title is stored as 未命名定时任务 plus its short
 * id) so a deleted schedule's runs stay listed, and rebuilds runs it never saw from the labels Paseo stamps on every
 * Agent a schedule creates. Heartbeat Agents carry no such label, so the ledger is kept in the background (`ScheduleRecorder`
 * watches the schedules directory), not only while someone has the page open.
 */

const LOG = "[agent-observatory:schedules]";
const MAX_FILE_BYTES = 32 * 1024 * 1024, LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const LEDGER_RUNS = 3000, LEDGER_SCHEDULES = 400, LEDGER_DAYS = 400;
const OUTPUT_MAX = 60_000, PROMPT_MAX = 8000, ERROR_MAX = 2000;
const DAY_MS = 86_400_000, WINDOW_STEP_MS = 10 * 60_000;
/**
 * Search reads what a run's detail shows (its first 60,000 characters) and folds at most 16 million characters of replies per
 * request; folded replies are kept per parsed run, so later searches cost a substring test. Past the budget, runs match on their
 * other fields only and the page says so.
 */
const SEARCH_FOLD_BUDGET = 16_000_000;
/** Finished heartbeats stay on their Agent's card this long after their last run. */
const HEARTBEAT_DONE_MS = 7 * DAY_MS;
/** Agent records are listed at most once a minute (like the directory walk) and parsed only when they change. */
const AGENT_SCAN_MS = 60_000, AGENT_RECORD_MAX_BYTES = 1024 * 1024;
/**
 * Budgets of one scan, kept in memory as parsed files: schedule files and their total size, Agent records, their total
 * size and the directory entries listed for them. Far above a heavy host (October 2026: one schedule file of 3 KB and
 * 432 Agent records of 1.3 MB in 69 folders); past a budget the rest is skipped and the page says so.
 */
export interface ScheduleScanLimits { scheduleFiles: number; scheduleBytes: number; agentRecords: number; agentBytes: number; entries: number }
export const SCHEDULE_SCAN_LIMITS: ScheduleScanLimits = { scheduleFiles: 2000, scheduleBytes: 256 * 1024 * 1024, agentRecords: 50_000, agentBytes: 256 * 1024 * 1024, entries: 100_000 };
/** A schedule file that does not fit in what is left of the scan's byte budget. */
class OverBudget extends Error {}

// Loose mirrors of Paseo's StoredScheduleSchema / workspace registry: unknown keys pass, ids are plain strings.
const runSchema = z.object({ id: z.string(), scheduledFor: z.string().nullable().optional(), startedAt: z.string(), endedAt: z.string().nullable().optional(),
  status: z.enum(["running", "succeeded", "failed"]), agentId: z.string().nullable().optional(), workspaceId: z.string().nullable().optional(),
  output: z.string().nullable().optional(), error: z.string().nullable().optional() });
const scheduleSchema = z.object({ id: z.string(), name: z.string().nullable().optional(), prompt: z.string().optional(),
  cadence: z.discriminatedUnion("type", [z.object({ type: z.literal("cron"), expression: z.string(), timezone: z.string().nullable().optional() }), z.object({ type: z.literal("every"), everyMs: z.number().positive() })]),
  target: z.discriminatedUnion("type", [z.object({ type: z.literal("agent"), agentId: z.string() }),
    z.object({ type: z.literal("new-agent"), config: z.object({ provider: z.string().optional(), cwd: z.string().optional(), title: z.string().nullable().optional() }).passthrough() })]),
  status: z.enum(["active", "paused", "completed"]), nextRunAt: z.string().nullable().optional(), lastRunAt: z.string().nullable().optional(),
  // Only displayed: a malformed value must not hide the schedule.
  maxRuns: z.number().int().positive().nullable().optional().catch(null), runs: z.array(z.unknown()) });
type StoredRun = z.output<typeof runSchema>;
type StoredSchedule = Omit<z.output<typeof scheduleSchema>, "runs"> & { runs: StoredRun[] };
const workspaceSchema = z.object({ workspaceId: z.string(), displayName: z.string().nullable().optional(), title: z.string().nullable().optional(), branch: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(), autoArchivedChangeRequestUrl: z.string().nullable().optional() });
type WorkspaceRecord = z.output<typeof workspaceSchema>;

const ledgerRunSchema = z.object({ scheduleId: z.string().max(80), kind: z.enum(["new-agent", "heartbeat"]), status: z.enum(["running", "succeeded", "failed", "unknown"]),
  scheduledFor: z.string().nullable(), startedAt: z.string(), endedAt: z.string().nullable(), agentId: z.string().max(256).nullable(), workspaceId: z.string().max(256).nullable(),
  error: z.string().max(300).nullable(), link: z.string().max(2000).nullable(), hadOutput: z.boolean() });
const ledgerScheduleSchema = z.object({ name: z.string().max(200), kind: z.enum(["new-agent", "heartbeat"]), cadence: z.string().max(160), timezone: z.string().max(80).nullable().default(null),
  // 2.13: the raw cron and the run limit, so a deleted one-shot still reads 一次性 · 10月11日 22:35 (older ledgers have neither).
  expression: z.string().max(120).nullable().default(null), maxRuns: z.number().int().positive().nullable().default(null),
  provider: z.string().max(120).nullable(), projectName: z.string().max(240).nullable(), lastSeenAt: z.string(), deletedAt: z.string().nullable() });
const ledgerSchema = z.object({ version: z.literal(1), schedules: z.record(z.string(), ledgerScheduleSchema), runs: z.record(z.string(), ledgerRunSchema) });
export type ScheduleLedger = z.infer<typeof ledgerSchema>;

interface Cached<Value> { mtimeMs: number; size: number; value: Value }
async function readCached<Value>(path: string, cached: Cached<Value> | undefined, parse: (raw: unknown) => Value, maxBytes = MAX_FILE_BYTES, budget = Infinity): Promise<Cached<Value> | null> {
  let info;
  try { info = await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (info.size > budget) throw new OverBudget();
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
  if (info.size > maxBytes) throw new Error(`${basename(path)} is larger than ${maxBytes} bytes`);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return { mtimeMs: info.mtimeMs, size: info.size, value: parse(raw) };
}
function parseSchedule(raw: unknown, file: string, warn: (message: string) => void): StoredSchedule | null {
  const parsed = scheduleSchema.safeParse(raw);
  if (!parsed.success) { warn(`ignoring unreadable schedule file ${file}`); return null; }
  const runs: StoredRun[] = [];
  for (const candidate of parsed.data.runs) { const run = runSchema.safeParse(candidate); if (run.success) runs.push(run.data); }
  return { ...parsed.data, runs };
}
/**
 * A schedule file as read: the schedule when it fits the mirror above, and whom archiving must spare (codex-F16): the Agent its active
 * or paused heartbeat wakes (Paseo completes both kinds when that Agent is archived, `completeForAgent`), null when it wakes nobody,
 * undefined when the file does not say.
 */
interface ScheduleFile { schedule: StoredSchedule | null; wakes: string | null | undefined }
/**
 * Whom a file that does not fit the mirror (a newer Paseo's cadence, say) wakes, read loosely. Paseo skips a file without a target,
 * so that one wakes nobody; a target kind this plugin does not know might wake an existing Agent, so it stays unknown.
 */
function looseWakes(raw: unknown): string | null | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const target = record.target && typeof record.target === "object" && !Array.isArray(record.target) ? record.target as Record<string, unknown> : null;
  if (!target || typeof target.type !== "string" || target.type === "new-agent") return null;
  if (target.type !== "agent") return undefined;
  return typeof target.agentId === "string" && target.agentId && record.status !== "completed" ? target.agentId : null;
}
function parseScheduleFile(raw: unknown, file: string, warn: (message: string) => void): ScheduleFile {
  const schedule = parseSchedule(raw, file, warn);
  if (!schedule) return { schedule: null, wakes: looseWakes(raw) };
  return { schedule, wakes: schedule.target.type === "agent" && schedule.status !== "completed" ? schedule.target.agentId : null };
}
/** Whom live heartbeats wake as of one scan, and whether that is everyone: false after a read error, a scan budget or an unknown target. */
interface Wakes { targets: ReadonlySet<string>; complete: boolean; error: string | null }
function parseWorkspaces(raw: unknown): Map<string, WorkspaceRecord> {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { workspaces?: unknown }).workspaces) ? (raw as { workspaces: unknown[] }).workspaces : [];
  const records = new Map<string, WorkspaceRecord>();
  for (const candidate of list) { const parsed = workspaceSchema.safeParse(candidate); if (parsed.success) records.set(parsed.data.workspaceId, parsed.data); }
  return records;
}

const recordText = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
/**
 * An Agent record (`$PASEO_HOME/agents/<folder>/<id>.json`, Paseo's StoredAgentRecord) as a directory entry, with the
 * schedule labels when it has them; internal Agents and anything unreadable are null.
 */
export function agentFromRecord(raw: unknown): StatsDirectoryAgent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const labels = record.labels && typeof record.labels === "object" && !Array.isArray(record.labels) ? record.labels as Record<string, unknown> : {};
  const id = recordText(record.id, 256), scheduleId = recordText(labels["paseo.schedule-id"], 80), scheduleRunId = recordText(labels["paseo.schedule-run"], 120);
  if (!id || record.internal === true) return null;
  const cwd = typeof record.cwd === "string" ? record.cwd : "", cwdName = (basename(cwd) || t("serverSchedules.m001")).slice(0, 240);
  const nested = (key: string) => record[key] && typeof record[key] === "object" ? record[key] as Record<string, unknown> : {};
  const persistence = nested("persistence");
  return { id, createdAt: recordText(record.createdAt, 64) ?? "", provider: recordText(record.provider, 1024) ?? "unknown",
    model: recordText(nested("config").model, 1024) ?? recordText(nested("runtimeInfo").model, 1024),
    parentAgentId: recordText(labels["paseo.parent-agent-id"], 256), projectKey: cwdName, projectName: cwdName, status: recordText(record.lastStatus, 40) ?? "closed",
    archivedAt: recordText(record.archivedAt, 64), title: recordText(record.title, 240), requiresAttention: record.requiresAttention === true,
    attentionReason: recordText(record.attentionReason, 80), pendingPermissions: 0, activeTurn: false, lastUserMessageAt: recordText(record.lastUserMessageAt, 64),
    updatedAt: recordText(record.updatedAt, 64), contextUsed: null, contextMax: null, sessionId: recordText(persistence.sessionId, 256), cwd,
    workspaceId: recordText(record.workspaceId, 256), scheduleId, scheduleRunId };
}

export interface ScheduleDirectory { agents: StatsDirectoryAgent[]; digest: string; refresh(paseo: PaseoApi): Promise<void> }
export interface ScheduleIndexOptions {
  home?: string; dataDirectory?: string; directory: ScheduleDirectory; now?: () => number; writeDelayMs?: number;
  /** Test overrides for the 32 MB schedule-file and 8 MB ledger ceilings. */ maxFileBytes?: number; maxLedgerBytes?: number;
  /** Test overrides for the scan budgets (SCHEDULE_SCAN_LIMITS). */ limits?: Partial<ScheduleScanLimits>;
  /** Test overrides (never above them) for the 500 listed heartbeats and the 5000 targets of the heartbeats RPC. */ heartbeatCaps?: { list?: number; targets?: number };
  /** Test override for SEARCH_FOLD_BUDGET. */ searchFoldBudget?: number;
  /** Where warnings go (console.warn); tests collect them. */ log?: (message: string) => void;
}
interface Base {
  rows: ScheduleRunRow[]; summaries: ScheduleSummary[]; reconstructed: number; error: string | null;
  /** Every live heartbeat, by the Agent it wakes (most relevant first). */ heartbeats: HeartbeatSummary[];
  /** The parsed run behind each row that a live file still has: its full reply is what search reads. */ stored: Map<string, StoredRun>;
  /** Whom the heartbeats of this scan wake, for 归档已读完成 (beyond the 500 the RPC lists). */ wakes: Wakes;
}

const clip = (value: string | null | undefined, max: number) => value ? value.length > max ? `${value.slice(0, max - 1)}…` : value : null;
/** A failed read in a log line: a JSON error quotes the file and a schema error its fields, so those give their name only. */
const errorKind = (error: unknown) => error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError") ? error.name : String(error);
/** The host's own run errors (Paseo 0.11.1: schedule/service.js, provider refresh, ACP resume); other text can be the Agent's last message. */
const HOST_ERROR = /^(?:Daemon restarted before the scheduled run completed|Agent \S+ (?:no longer exists|is archived|already has an active run)|Scheduled agent \S+ (?:is waiting for permission|failed|was canceled)|Schedule \S+ target changed during execution|Working directory [^\n]{1,1000} (?:is not a directory|no longer exists)|Timed out refreshing [^\n]{1,300} after \d+ms[^\n]{0,300}|\S+ does not support ACP session resume)$/;
const SYSTEM_ERROR = "[System Error]";
/**
 * The error the ledger keeps, which outlives the host's copy: a host message as it is; for a failed turn, whose error is the
 * Agent's last message, only the part from the host's `[System Error]` marker on (masked), never the reply before it.
 */
export function ledgerError(error: string | null | undefined): string | null {
  const text = error?.trim();
  if (!text) return null;
  if (HOST_ERROR.test(text)) return clip(text, 300);
  const marker = text.lastIndexOf(SYSTEM_ERROR);
  return marker >= 0 ? clip(redactSecrets(text.slice(marker)), 300) : t("serverSchedules.m002");
}
/** The schedule's own name or title; without either, a neutral 未命名定时任务 plus its short id. This is what the ledger keeps. */
function storedNameOf(schedule: StoredSchedule): string {
  const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
  return clip(schedule.name?.trim() || config?.title?.trim() || t("serverSchedules.m003", { value1: schedule.id.slice(0, 8) }), 200)!;
}
/** What the live list shows: as stored, except that an unnamed schedule is recognised by its prompt's start (never saved). */
function nameOf(schedule: StoredSchedule): string {
  const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
  return schedule.name?.trim() || config?.title?.trim() ? storedNameOf(schedule) : clip(previewOf(schedule.prompt, 40), 200) ?? storedNameOf(schedule);
}
/** Paseo runs a cron without a zone in UTC; intervals have none. */
const zoneOf = (schedule: StoredSchedule) => schedule.cadence.type === "cron" ? clip(schedule.cadence.timezone?.trim() || "UTC", 80) : null;
const expressionOf = (schedule: StoredSchedule) => schedule.cadence.type === "cron" ? clip(schedule.cadence.expression.trim(), 120) : null;
/** The latest run by start (Paseo appends runs in order; a hand-edited file may not). */
const lastRunOf = (runs: readonly StoredRun[]) => runs.reduce<StoredRun | undefined>((latest, run) => !latest || parseTime(run.startedAt) >= parseTime(latest.startedAt) ? run : latest, undefined);
/** Agent-only evidence: a finished turn reads as success, an error as failure; anything else stays unknown. */
function agentRunStatus(agent: StatsDirectoryAgent): RunStatus {
  if (!agent.archivedAt && (agent.activeTurn || agent.status === "running" || agent.status === "initializing")) return "running";
  if (agent.status === "error") return "failed";
  return agent.attentionReason === "finished" ? "succeeded" : "unknown";
}

export class ScheduleIndex {
  private readonly home: string;
  private readonly ledgerFile: string;
  private readonly now: () => number;
  private readonly writeDelayMs: number;
  private files = new Map<string, Cached<ScheduleFile>>();
  private workspaces: Cached<Map<string, WorkspaceRecord>> | null = null;
  private ledger: ScheduleLedger = { version: 1, schedules: {}, runs: {} };
  private ledgerRevision = contentRevision(this.ledger);
  /** False when an unreadable ledger could not be set aside: it is never overwritten then. */
  private ledgerWritable = true;
  private notice: string | null = null;
  private writeFailed = false;
  private ready: Promise<void>;
  private baseKey: string | null = null;
  private textKey = "";
  private base: Base | null = null;
  /** When the files were last compared with `base` (reads that tolerate some age reuse it). */
  private checkedAt = -Infinity;
  /** Agents the live schedules point at (heartbeat targets, Agents runs created): whose turns are worth a nudge. */
  private scheduleAgents = new Set<string>();
  /** One cached response per window and search (a few at most), keyed by its 30-day edge and notice. */
  private windows = new Map<string, { key: string; state: ScheduleRunsState }>();
  /** Folded replies and row fields for search, alive as long as the parsed run / built row is. */
  private readonly foldedReplies = new WeakMap<StoredRun, string>();
  private readonly foldedRows = new WeakMap<ScheduleRunRow, string>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Changes not on disk yet; `close()` saves them once and no timer runs after it. */
  private dirty = false;
  private closed = false;
  /** Agent records by path (null when internal or unreadable), and the last scan. */
  private agentFiles = new Map<string, { mtimeMs: number; size: number; agent: StatsDirectoryAgent | null }>();
  private agentScanAt = -Infinity;
  private agentScan: { agents: StatsDirectoryAgent[] } = { agents: [] };
  private readonly warn: (message: string) => void;
  private readonly limits: ScheduleScanLimits;
  /** Which part of the last scans hit its budget: shown with the ledger notices. */
  private cut = { schedules: false, agents: false };

  constructor(private readonly options: ScheduleIndexOptions) {
    this.home = options.home ?? resolvePaseoHome();
    this.ledgerFile = join(options.dataDirectory ?? telemetryDirectory(), "schedule-ledger.json");
    this.now = options.now ?? Date.now;
    this.writeDelayMs = options.writeDelayMs ?? 2000;
    this.warn = options.log ?? (message => console.warn(`${LOG} ${message}`));
    this.limits = { ...SCHEDULE_SCAN_LIMITS, ...options.limits };
    this.ready = this.loadLedger();
  }

  /** A damaged or oversized ledger is renamed aside (never silently overwritten) and recording starts again. */
  private async loadLedger() {
    try {
      const info = await stat(this.ledgerFile);
      if (info.size > (this.options.maxLedgerBytes ?? LEDGER_MAX_BYTES)) throw new Error("ledger too large");
      const parsed = ledgerSchema.parse(JSON.parse(await readFile(this.ledgerFile, "utf8")));
      // Ledgers before 2.15.1 kept a link's `user:password@` and the reply text of a failed turn as its error.
      for (const run of Object.values(parsed.runs)) { if (run.link) run.link = withoutUserinfo(run.link); run.error = ledgerError(run.error); }
      this.ledger = parsed; this.ledgerRevision = contentRevision(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // One backup, replaced by the next: a ledger damaged again and again never piles up copies.
      const backup = this.ledgerFile.replace(/\.json$/, ".corrupt.json");
      try {
        await rename(this.ledgerFile, backup);
        this.notice = t("serverSchedules.m004", { value1: basename(backup) });
      } catch {
        this.ledgerWritable = false;
        this.notice = t("serverSchedules.m005");
      }
      this.warn(`ledger unreadable: ${errorKind(error)}`);
    }
  }

  /**
   * Reads the schedule files that changed. Besides the schedules it says whom their live heartbeats wake and whether that is everyone
   * (codex-F16): an unreadable directory or file, a scan budget or a target kind this plugin does not know leaves it incomplete. A file
   * that is not JSON wakes nobody: Paseo skips it as well.
   */
  private async readSchedules(): Promise<{ schedules: StoredSchedule[]; stamps: string[]; error: string | null; wakes: Wakes }> {
    const directory = join(this.home, "schedules");
    let names: string[];
    try { names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.files.clear(); this.cut.schedules = false; return { schedules: [], stamps: [], error: null, wakes: { targets: new Set(), complete: true, error: null } }; }
      return { schedules: [], stamps: ["unreadable"], error: t("serverSchedules.m006"), wakes: { targets: new Set(), complete: false, error: t("serverSchedules.m007") } };
    }
    let over = names.length > this.limits.scheduleFiles, budget = this.limits.scheduleBytes, unreadable = 0, unknown = 0;
    if (over) names = names.slice(0, this.limits.scheduleFiles);
    const schedules: StoredSchedule[] = [], stamps: string[] = [], seen = new Set<string>(), targets = new Set<string>();
    for (const name of names) {
      const path = join(directory, name);
      seen.add(path);
      try {
        const file = await readCached(path, this.files.get(path), raw => parseScheduleFile(raw, name, this.warn), this.options.maxFileBytes, budget);
        if (!file) { this.files.delete(path); continue; }
        this.files.set(path, file); budget -= file.size;
        stamps.push(`${name}:${file.mtimeMs}:${file.size}`);
        if (file.value.schedule) schedules.push(file.value.schedule);
        if (file.value.wakes === undefined) unknown++; else if (file.value.wakes) targets.add(file.value.wakes);
      } catch (error) {
        if (error instanceof OverBudget) { over = true; seen.delete(path); stamps.push(`${name}:over`); continue; }
        if (error instanceof SyntaxError) { stamps.push(`${name}:invalid`); this.warn(`ignoring ${name}, which is not JSON`); continue; }
        unreadable++; stamps.push(`${name}:error`); this.warn(`could not read ${name}: ${errorKind(error)}`);
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    this.cut.schedules = over;
    const problem = unreadable ? t("serverSchedules.m008", { unreadable: unreadable }) : unknown ? t("serverSchedules.m009", { unknown: unknown }) : null;
    return { schedules, stamps, error: null, wakes: { targets, complete: !over && !problem, error: problem } };
  }

  private async readWorkspaces(): Promise<{ records: Map<string, WorkspaceRecord>; stamp: string }> {
    try {
      const file = await readCached(join(this.home, "projects", "workspaces.json"), this.workspaces ?? undefined, parseWorkspaces);
      this.workspaces = file;
      return { records: file?.value ?? new Map(), stamp: file ? `${file.mtimeMs}:${file.size}` : "none" };
    } catch (error) {
      this.warn(`could not read the workspace registry: ${errorKind(error)}`);
      return { records: this.workspaces?.value ?? new Map(), stamp: "error" };
    }
  }

  /** Re-reads only changed files; rebuilds rows only when a file, the workspace registry or the Agent directory changed. */
  /**
   * Agent records under `$PASEO_HOME/agents/<folder>/<id>.json`. Paseo 0.11's agent list (what `paseo.agents.list`
   * returns) drops an Agent whose workspace's project is gone, while the record and the host's per-id lookup remain; on
   * this host that hid every past run of a schedule. Folders are listed at most once a minute and a record is parsed
   * again only when its size or modification time changes.
   */
  private async scanAgentRecords(): Promise<{ agents: StatsDirectoryAgent[] }> {
    if (this.now() - this.agentScanAt < AGENT_SCAN_MS) return this.agentScan;
    this.agentScanAt = this.now();
    const root = join(this.home, "agents");
    let folders: string[];
    try { folders = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`could not list Agent records: ${String(error)}`);
      else { this.agentFiles.clear(); this.agentScan = { agents: [] }; this.cut.agents = false; }
      return this.agentScan;
    }
    const agents: StatsDirectoryAgent[] = [], seen = new Set<string>();
    let entries = 0, records = 0, bytes = 0, over = false;
    scan: for (const folder of folders) {
      if (++entries > this.limits.entries) { over = true; break; }
      let names: string[];
      try { names = (await readdir(join(root, folder), { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name).sort(); }
      catch { continue; }
      for (const name of names) {
        if (++entries > this.limits.entries || records >= this.limits.agentRecords) { over = true; break scan; }
        const path = join(root, folder, name);
        try {
          // Only records small enough to parse (1 MB) are held in memory, so only they count against the byte budget.
          const info = await stat(path), cost = info.size <= AGENT_RECORD_MAX_BYTES ? info.size : 0;
          if (bytes + cost > this.limits.agentBytes) { over = true; continue; }
          records++; bytes += cost; seen.add(path);
          let file = this.agentFiles.get(path);
          if (!file || file.mtimeMs !== info.mtimeMs || file.size !== info.size) {
            let agent: StatsDirectoryAgent | null = null;
            // A record being rewritten (or not JSON) is skipped quietly; the next change brings it back.
            if (info.size <= AGENT_RECORD_MAX_BYTES) { try { agent = agentFromRecord(JSON.parse(await readFile(path, "utf8"))); } catch { agent = null; } }
            file = { mtimeMs: info.mtimeMs, size: info.size, agent };
            this.agentFiles.set(path, file);
          }
          if (file.agent) agents.push(file.agent);
        } catch { /* removed while listing */ }
      }
    }
    for (const path of this.agentFiles.keys()) if (!seen.has(path)) this.agentFiles.delete(path);
    this.cut.agents = over;
    this.agentScan = { agents };
    return this.agentScan;
  }

  private async current(paseo: PaseoApi | null): Promise<Base> {
    await this.ready;
    if (paseo) await this.options.directory.refresh(paseo).catch(() => {});
    const [{ schedules, stamps, error, wakes }, { records, stamp }, scanned] = await Promise.all([this.readSchedules(), this.readWorkspaces(), this.scanAgentRecords()]);
    // Records only add Agents the host does not list (its own entry has live status and the project name): those a
    // schedule created, and those a schedule, a run or the ledger points at (a heartbeat's target, a run's Agent).
    const listed = this.options.directory.agents, listedIds = new Set(listed.map(agent => agent.id)), referenced = new Set<string>();
    for (const schedule of schedules) { if (schedule.target.type === "agent") referenced.add(schedule.target.agentId); for (const run of schedule.runs) if (run.agentId) referenced.add(run.agentId); }
    this.scheduleAgents = new Set(referenced);
    for (const run of Object.values(this.ledger.runs)) if (run.agentId) referenced.add(run.agentId);
    const unlisted = scanned.agents.filter(agent => !listedIds.has(agent.id) && (agent.scheduleRunId || referenced.has(agent.id)));
    // A scan cut short by its file budget lists the same first files: whether the heartbeat targets are complete is part of the key.
    const key = contentRevision([translator().language, translator().hash, stamps, stamp, this.options.directory.digest, wakes.complete, wakes.error,
      unlisted.map(agent => [agent.id, agent.status, agent.archivedAt, agent.attentionReason, agent.title, agent.updatedAt, agent.workspaceId])]);
    // Building is synchronous, so two reads in flight (the page and the background recorder) never adopt each other's build
    // under their own key: each builds from what it read unless the other already built exactly that.
    if (key !== this.baseKey || !this.base) {
      const agents = [...listed, ...unlisted];
      const unlistedIds = new Set(unlisted.map(agent => agent.id));
      this.base = this.build(schedules, records, error, agents, unlistedIds, wakes); this.baseKey = key; this.windows.clear();
    }
    this.checkedAt = this.now(); this.textKey = `${translator().language}:${translator().hash}`;
    return this.base;
  }

  /** The last build while it is at most `maxAgeMs` old (the background recorder rebuilds it on every file change), else a fresh one. */
  private async recent(maxAgeMs: number): Promise<Base> {
    return this.base && this.textKey === `${translator().language}:${translator().hash}` && maxAgeMs > 0 && this.now() - this.checkedAt <= maxAgeMs ? this.base : this.current(null);
  }

  /** The run feed for a window, searched by `query` when given; an unchanged `revision` answers in a few bytes. */
  async list(paseo: PaseoApi | null, input: { revision?: string; window?: RunWindow; query?: string } = {}): Promise<ScheduleRunsResponse> {
    const base = await this.current(paseo);
    const window = input.window ?? "recent", limits = RUN_WINDOWS[window], query = normalizeRunQuery(input.query ?? "");
    // Window edges move in 10-minute steps; a step that moves no run keeps the revision, so polls stay a few bytes.
    const bucket = Math.floor(this.now() / WINDOW_STEP_MS) * WINDOW_STEP_MS;
    const cutoff = limits.days === null ? null : bucket - limits.days * DAY_MS;
    const notice = [this.notice, this.cut.schedules ? t("serverSchedules.m010", { value1: this.limits.scheduleFiles, value2: Math.round(this.limits.scheduleBytes / 1024 ** 2) }) : null,
      this.cut.agents ? t("serverSchedules.m011", { value1: this.limits.agentRecords, value2: Math.round(this.limits.agentBytes / 1024 ** 2), value3: this.limits.entries }) : null].filter(Boolean).join(" ").slice(0, 500) || null;
    const cacheKey = `${bucket}:${notice ?? ""}`, slot = `${window}\n${query}`;
    let state = this.windows.get(slot)?.key === cacheKey ? this.windows.get(slot)!.state : undefined;
    if (!state) {
      // A search narrows the runs first; the window then caps what matched, and older / truncated count matches only.
      const search = query ? this.search(base, query.split(" ")) : null;
      const pool = search ? base.rows.filter(row => search.ids.has(row.id)) : base.rows;
      let runs = 0, heartbeats = 0;
      const kept = pool.filter(row => {
        if (cutoff !== null && (parseTime(row.startedAt) || parseTime(row.scheduledFor)) < cutoff && row.status !== "running") return false;
        return row.kind === "heartbeat" ? heartbeats++ < limits.heartbeats : runs++ < limits.runs;
      });
      const week = { runs: 0, failed: 0, heartbeats: 0, heartbeatsFailed: 0 }, weekFloor = bucket - 7 * DAY_MS;
      for (const row of base.rows) {
        if ((parseTime(row.startedAt) || parseTime(row.scheduledFor)) < weekFloor) continue;
        if (row.kind === "heartbeat") { week.heartbeats++; if (row.status === "failed") week.heartbeatsFailed++; }
        else { week.runs++; if (row.status === "failed") week.failed++; }
      }
      const keptHeartbeats = kept.filter(row => row.kind === "heartbeat").length, allHeartbeats = pool.filter(row => row.kind === "heartbeat").length;
      // The query is part of the body, so each search has its own revision.
      const body = { window, query, ...(search?.limited ? { searchLimited: true } : {}), schedules: base.summaries.slice(0, 400), runs: kept,
        older: pool.length - allHeartbeats - (kept.length - keptHeartbeats), olderHeartbeats: allHeartbeats - keptHeartbeats, truncated: kept.length < pool.length, week,
        reconstructed: base.reconstructed, error: base.error, notice };
      state = { mode: "full", unchanged: false, revision: contentRevision(body), generatedAt: new Date(this.now()).toISOString(), ...body };
      this.windows.delete(slot);
      this.windows.set(slot, { key: cacheKey, state });
      // Keep the two windows plus a few recent searches.
      for (const old of this.windows.keys()) { if (this.windows.size <= 8) break; this.windows.delete(old); }
    }
    return input.revision && input.revision === state.revision ? { mode: "unchanged", unchanged: true, revision: state.revision } : state;
  }

  /**
   * Rows whose fields and full recorded reply (the first 60,000 characters, as the detail shows) contain every word. Folding a
   * reply is paid once per parsed run; at most SEARCH_FOLD_BUDGET characters are folded per request, the rest match on their fields.
   */
  private search(base: Base, words: readonly string[]): { ids: Set<string>; limited: boolean } {
    const ids = new Set<string>();
    let budget = this.options.searchFoldBudget ?? SEARCH_FOLD_BUDGET, limited = false;
    for (const row of base.rows) {
      let fields = this.foldedRows.get(row);
      if (fields === undefined) { fields = runSearchText(row); this.foldedRows.set(row, fields); }
      const missing = words.filter(word => !fields!.includes(word));
      if (!missing.length) { ids.add(row.id); continue; }
      const stored = base.stored.get(row.id), output = stored?.output;
      if (!stored || !output) continue;
      let reply = this.foldedReplies.get(stored);
      if (reply === undefined) {
        const source = output.length > OUTPUT_MAX ? output.slice(0, OUTPUT_MAX) : output;
        if (source.length > budget) { limited = true; continue; }
        budget -= source.length;
        reply = searchFold(source);
        this.foldedReplies.set(stored, reply);
      }
      if (missing.every(word => reply!.includes(word))) ids.add(row.id);
    }
    return { ids, limited };
  }

  /**
   * Every heartbeat by the Agent it wakes (finished ones for 7 days after their last run), the 500 most relevant; and for 归档已读完成
   * (codex-F16) every Agent an active or paused heartbeat wakes, with whether the scan behind it read every schedule file. `fresh`
   * reads the files now instead of reusing a recent build (the second tap of 归档已读完成); an unchanged `revision` answers in a few bytes.
   */
  async heartbeats(input: { revision?: string; fresh?: boolean } = {}, maxAgeMs = 0): Promise<HeartbeatsResponse> {
    const base = await this.recent(input.fresh ? 0 : maxAgeMs);
    const floor = Math.floor(this.now() / WINDOW_STEP_MS) * WINDOW_STEP_MS - HEARTBEAT_DONE_MS;
    const caps = this.options.heartbeatCaps, listMax = Math.min(caps?.list ?? HEARTBEAT_LIST_MAX, HEARTBEAT_LIST_MAX), targetsMax = Math.min(caps?.targets ?? HEARTBEAT_TARGETS_MAX, HEARTBEAT_TARGETS_MAX);
    // An id the response cannot carry (over 256 characters) leaves its Agent unprotected, so the targets are no longer complete.
    const shown = base.heartbeats.filter(item => item.agentId.length <= 256 && (item.status !== "completed" || (parseTime(item.lastRun?.endedAt) || parseTime(item.lastRun?.startedAt)) >= floor));
    const targets = [...base.wakes.targets].filter(id => id.length <= 256).sort();
    const heartbeats = shown.slice(0, listMax), complete = base.wakes.complete && targets.length === base.wakes.targets.size && targets.length <= targetsMax;
    const body = { heartbeats, truncated: heartbeats.length < shown.length, error: base.wakes.error, complete, targets: targets.slice(0, targetsMax) };
    const revision = contentRevision(body);
    return input.revision === revision ? { mode: "unchanged", unchanged: true, revision } : { mode: "full", unchanged: false, revision, generatedAt: new Date(this.now()).toISOString(), ...body };
  }

  /** Failed runs that started at or after `sinceMs`, ordinary schedules and heartbeats apart, from a build at most `maxAgeMs` old. */
  async failures(sinceMs: number, maxAgeMs = 0): Promise<{ runs: number; heartbeats: number }> {
    const base = await this.recent(maxAgeMs);
    const counts = { runs: 0, heartbeats: 0 };
    for (const row of base.rows) {
      if (row.status !== "failed" || (parseTime(row.startedAt) || parseTime(row.scheduledFor)) < sinceMs) continue;
      if (row.kind === "heartbeat") counts.heartbeats++; else counts.runs++;
    }
    return counts;
  }

  /** Reads the schedule files and records what changed in the ledger, as the page would; for background recording. */
  async sync(): Promise<void> { await this.current(null); }
  /** Whether a live schedule points at this Agent (a heartbeat's target, an Agent one of its runs created), as of the last read. */
  pointsAt(agentId: string): boolean { return this.scheduleAgents.has(agentId); }
  /** `$PASEO_HOME/schedules`, which the recorder watches. */
  get schedulesDirectory(): string { return join(this.home, "schedules"); }
  get scanLimits(): Readonly<ScheduleScanLimits> { return this.limits; }

  private build(schedules: StoredSchedule[], workspaces: Map<string, WorkspaceRecord>, readError: string | null, agents: StatsDirectoryAgent[], unlistedIds: ReadonlySet<string>, wakes: Wakes): Base {
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const byRun = new Map<string, StatsDirectoryAgent>();
    for (const agent of agents) if (agent.scheduleRunId) byRun.set(agent.scheduleRunId, agent);
    const nowIso = new Date(this.now()).toISOString();
    const rows: ScheduleRunRow[] = [];
    const summaries = new Map<string, Omit<ScheduleSummary, "recent" | "total" | "failed" | "running">>();
    const seenRuns = new Set<string>();
    const heartbeats: HeartbeatSummary[] = [], stored = new Map<string, StoredRun>();

    const agentRef = (agent: StatsDirectoryAgent | undefined, id: string | null): ScheduleRunRow["agent"] =>
      agent ? { id: agent.id, title: clip(agent.title, 240), status: agent.status.slice(0, 40), archivedAt: agent.archivedAt, known: true, ...(unlistedIds.has(agent.id) ? { listed: false } : {}) } : id ? { id, title: null, status: null, archivedAt: null, known: false } : null;
    const workspaceRef = (id: string | null): ScheduleRunRow["workspace"] => {
      if (!id) return null;
      const record = workspaces.get(id);
      return { id, name: clip(record?.title?.trim() || record?.displayName?.trim() || null, 240), branch: clip(record?.branch?.trim() || null, 240), archivedAt: record?.archivedAt ?? null };
    };
    const linkOf = (output: string | null | undefined, workspaceId: string | null, stored: string | null = null): RunLink | null => {
      const archived = workspaceId ? workspaces.get(workspaceId)?.autoArchivedChangeRequestUrl : null;
      if (archived) { const found = findChangeRequest(archived); return found ? { ...found, state: "merged" } : null; }
      return findChangeRequest(output) ?? findChangeRequest(stored);
    };

    // 1. Live schedule files.
    for (const schedule of schedules) {
      const kind = schedule.target.type === "agent" ? "heartbeat" as const : "new-agent" as const;
      const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
      const name = nameOf(schedule), timezone = zoneOf(schedule);
      const targetAgentId = schedule.target.type === "agent" ? schedule.target.agentId : null;
      const targetAgent = targetAgentId ? byId.get(targetAgentId) : undefined;
      const projectName = targetAgent?.projectName ?? (config?.cwd ? basename(config.cwd) : null);
      const provider = clip(config?.provider ?? targetAgent?.provider ?? null, 120);
      const maxRuns = schedule.maxRuns ?? null, cadence = cadenceLabel(schedule.cadence, maxRuns), expression = expressionOf(schedule), lastRun = lastRunOf(schedule.runs);
      // A one-shot's absolute time: when it will run, or when its run was due (its end time would be off by the run's length).
      const onceAt = maxRuns === 1 ? schedule.nextRunAt ?? lastRun?.scheduledFor ?? lastRun?.startedAt ?? null : null;
      summaries.set(schedule.id, { id: schedule.id, name, kind, status: schedule.status, cadence, timezone, target: clip(targetAgent?.title ?? (config?.cwd ? basename(config.cwd) : null), 240),
        nextRunAt: schedule.nextRunAt ?? null, lastRunAt: schedule.lastRunAt ?? null, provider, expression, maxRuns, onceAt });
      this.ledger.schedules[schedule.id] = { name: storedNameOf(schedule), kind, cadence, timezone, expression, maxRuns, provider, projectName: clip(projectName, 240), lastSeenAt: nowIso, deletedAt: null };
      if (targetAgentId) heartbeats.push({ scheduleId: schedule.id, agentId: targetAgentId, name, status: schedule.status, cadence, timezone, expression, maxRuns, once: maxRuns === 1,
        nextRunAt: schedule.nextRunAt ?? null, onceAt, runs: schedule.runs.length,
        lastRun: lastRun ? { status: lastRun.status, startedAt: lastRun.startedAt, endedAt: lastRun.endedAt ?? null, error: clip(lastRun.error, 300) } : null });
      for (const run of schedule.runs) {
        if (run.output) stored.set(run.id, run);
        // A failed heartbeat never records its Agent; the schedule's own target is the Agent it prompted.
        const agent = (run.agentId ? byId.get(run.agentId) : undefined) ?? byRun.get(run.id) ?? targetAgent;
        const agentId = run.agentId ?? agent?.id ?? targetAgentId;
        const workspaceId = run.workspaceId ?? agent?.workspaceId ?? null;
        const link = linkOf(run.output, workspaceId);
        seenRuns.add(run.id);
        rows.push({ id: run.id, scheduleId: schedule.id, scheduleName: name, kind, status: run.status, source: "schedule", scheduledFor: run.scheduledFor ?? null, startedAt: run.startedAt, endedAt: run.endedAt ?? null,
          preview: previewOf(run.output), hasOutput: !!run.output?.trim(), error: clip(run.error, ERROR_MAX), agent: agentRef(agent, agentId ?? null), workspace: workspaceRef(workspaceId),
          projectName: clip(agent?.projectName ?? projectName, 240), link });
        this.ledger.runs[run.id] = { scheduleId: schedule.id, kind, status: run.status, scheduledFor: run.scheduledFor ?? null, startedAt: run.startedAt, endedAt: run.endedAt ?? null,
          agentId: agentId ?? null, workspaceId, error: ledgerError(run.error), link: link?.url ?? null, hadOutput: !!run.output?.trim() };
      }
    }
    // 2. Ledger runs whose schedule file (or run record) is gone.
    const live = new Set(schedules.map(schedule => schedule.id));
    for (const [id, meta] of Object.entries(this.ledger.schedules)) if (!live.has(id) && !meta.deletedAt) this.ledger.schedules[id] = { ...meta, deletedAt: nowIso };
    for (const [runId, run] of Object.entries(this.ledger.runs)) {
      if (seenRuns.has(runId)) continue;
      const meta = this.ledger.schedules[run.scheduleId];
      const agent = (run.agentId ? byId.get(run.agentId) : undefined) ?? byRun.get(runId);
      // A run still "running" in the ledger after its file vanished never finished as far as anyone recorded.
      const status: RunStatus = run.status === "running" ? agent ? agentRunStatus(agent) : "unknown" : run.status;
      seenRuns.add(runId);
      rows.push({ id: runId, scheduleId: run.scheduleId, scheduleName: meta?.name ?? t("serverSchedules.m012", { value1: run.scheduleId }), kind: run.kind, status, source: "ledger", scheduledFor: run.scheduledFor, startedAt: run.startedAt, endedAt: run.endedAt,
        preview: null, hasOutput: false, error: run.error, agent: agentRef(agent, run.agentId), workspace: workspaceRef(run.workspaceId ?? agent?.workspaceId ?? null), projectName: agent?.projectName ?? meta?.projectName ?? null, link: linkOf(null, run.workspaceId, run.link) });
      if (!summaries.has(run.scheduleId)) summaries.set(run.scheduleId, { id: run.scheduleId, name: meta?.name ?? t("serverSchedules.m013", { value1: run.scheduleId }), kind: run.kind, status: "deleted", cadence: meta?.cadence ?? "",
        timezone: meta?.timezone ?? null, target: meta?.projectName ?? null, nextRunAt: null, lastRunAt: null, provider: meta?.provider ?? null,
        expression: meta?.expression ?? null, maxRuns: meta?.maxRuns ?? null, onceAt: null });
    }
    // 3. Agents a schedule created that nobody recorded (schedule deleted before the observatory saw it).
    const orphanTitles = new Map<string, Map<string, number>>();
    let reconstructed = 0;
    for (const agent of agents) {
      if (!agent.scheduleRunId || !agent.scheduleId || seenRuns.has(agent.scheduleRunId)) continue;
      reconstructed++;
      seenRuns.add(agent.scheduleRunId);
      const titles = orphanTitles.get(agent.scheduleId) ?? new Map<string, number>();
      if (agent.title) titles.set(agent.title, (titles.get(agent.title) ?? 0) + 1);
      orphanTitles.set(agent.scheduleId, titles);
      const meta = this.ledger.schedules[agent.scheduleId];
      rows.push({ id: agent.scheduleRunId, scheduleId: agent.scheduleId, scheduleName: meta?.name ?? "", kind: "new-agent", status: agentRunStatus(agent), source: "agent", scheduledFor: null, startedAt: agent.createdAt,
        endedAt: agent.archivedAt ?? agent.updatedAt ?? null, preview: null, hasOutput: false, error: null, agent: agentRef(agent, agent.id), workspace: workspaceRef(agent.workspaceId ?? null), projectName: agent.projectName, link: null });
    }
    for (const [scheduleId, titles] of orphanTitles) {
      const meta = this.ledger.schedules[scheduleId];
      const title = [...titles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const name = meta?.name ?? clip(title ? previewOf(title, 60) : null, 200) ?? t("serverSchedules.m014", { scheduleId: scheduleId });
      for (const row of rows) if (row.scheduleId === scheduleId && row.source === "agent") row.scheduleName = name;
      if (!summaries.has(scheduleId)) summaries.set(scheduleId, { id: scheduleId, name, kind: "new-agent", status: "deleted", cadence: meta?.cadence ?? "", timezone: meta?.timezone ?? null,
        target: meta?.projectName ?? rows.find(row => row.scheduleId === scheduleId)?.projectName ?? null, nextRunAt: null, lastRunAt: null, provider: meta?.provider ?? null,
        expression: meta?.expression ?? null, maxRuns: meta?.maxRuns ?? null, onceAt: null });
    }

    rows.sort((a, b) => parseTime(b.startedAt) - parseTime(a.startedAt) || a.id.localeCompare(b.id));
    const scheduleList: ScheduleSummary[] = [...summaries.values()].map(summary => {
      const own = rows.filter(row => row.scheduleId === summary.id);
      // A deleted one-shot still knows when its run was due.
      const onceAt = summary.onceAt ?? (summary.maxRuns === 1 ? own[0]?.scheduledFor ?? own[0]?.startedAt ?? null : null);
      return { ...summary, onceAt, recent: own.slice(0, 10).reverse().map(row => row.status), total: own.length, failed: own.filter(row => row.status === "failed").length, running: own.filter(row => row.status === "running").length };
    }).sort((a, b) => Number(a.status === "deleted") - Number(b.status === "deleted") || Number(b.running > 0) - Number(a.running > 0) || a.name.localeCompare(b.name, translator().language));
    // Most relevant first, so the 500 the RPC sends are the ones to show: active by next run, paused, then finished (latest first).
    const order = { active: 0, paused: 1, completed: 2 } as const, lastOf = (item: HeartbeatSummary) => parseTime(item.lastRun?.endedAt) || parseTime(item.lastRun?.startedAt);
    heartbeats.sort((a, b) => order[a.status] - order[b.status] || (a.status === "completed" ? lastOf(b) - lastOf(a) : (parseTime(a.nextRunAt) || Infinity) - (parseTime(b.nextRunAt) || Infinity)) || a.scheduleId.localeCompare(b.scheduleId));

    this.trimLedger();
    this.scheduleLedgerWrite();
    return { rows, summaries: scheduleList, reconstructed, error: readError, heartbeats, stored, wakes };
  }

  /** Newest 3000 runs within 400 days; schedules only while a run still points at them (or they still exist). */
  private trimLedger() {
    const floor = this.now() - LEDGER_DAYS * DAY_MS;
    const runs = Object.entries(this.ledger.runs).filter(([, run]) => (parseTime(run.startedAt) || this.now()) >= floor)
      .sort((a, b) => parseTime(b[1].startedAt) - parseTime(a[1].startedAt)).slice(0, LEDGER_RUNS);
    this.ledger.runs = Object.fromEntries(runs);
    const used = new Set(runs.map(([, run]) => run.scheduleId));
    const schedules = Object.entries(this.ledger.schedules).filter(([id, meta]) => used.has(id) || !meta.deletedAt);
    this.ledger.schedules = Object.fromEntries(schedules.sort((a, b) => parseTime(b[1].lastSeenAt) - parseTime(a[1].lastSeenAt)).slice(0, LEDGER_SCHEDULES));
  }

  private scheduleLedgerWrite() {
    if (!this.ledgerWritable) return;
    // `lastSeenAt` alone moving is not worth a write.
    const next = contentRevision({ ...this.ledger, schedules: Object.fromEntries(Object.entries(this.ledger.schedules).map(([id, meta]) => [id, { ...meta, lastSeenAt: "" }])) });
    if (next === this.ledgerRevision) return;
    this.ledgerRevision = next;
    this.dirty = true;
    // After close() a change is only kept in memory: nothing may write once the plugin (or a test) has let go of the directory.
    if (this.closed) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => { this.writeTimer = null; void this.flush(); }, this.writeDelayMs);
    this.writeTimer.unref?.();
  }

  /**
   * Writes the ledger now, atomically and privately: the data directory is 0700 (an existing wider one is tightened), the
   * temporary file has a random name and is created exclusively with mode 0600 (`wx`), then renamed; writes run one after another.
   */
  flush(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    if (!this.ledgerWritable) return this.writes;
    const snapshot = JSON.stringify(this.ledger);
    this.dirty = false;
    this.writes = this.writes.then(async () => {
      await ensurePrivateDirectory(dirname(this.ledgerFile));
      const temporary = `${this.ledgerFile}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(snapshot, "utf8"); } finally { await handle.close(); }
        await rename(temporary, this.ledgerFile);
      } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      if (this.writeFailed) { this.notice = null; this.writeFailed = false; }
    }).catch(error => {
      this.notice = t("serverSchedules.m016"); this.writeFailed = true;
      this.warn(`could not save the ledger: ${String(error)}`);
    });
    return this.writes;
  }

  /** Stops the write timer, saves pending changes once and waits for every write (and the initial ledger read); later changes stay in memory. */
  async close(): Promise<void> {
    if (this.closed) return this.writes;
    this.closed = true;
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    await this.ready.catch(() => {});
    return this.dirty ? this.flush() : this.writes;
  }

  /** One run's full recorded reply (only the live schedule file has it), its prompt, and how the feed describes it. */
  async run(paseo: PaseoApi | null, runId: string): Promise<ScheduleRunDetail> {
    const base = await this.current(paseo);
    const row = base.rows.find(candidate => candidate.id === runId) ?? null;
    const schedule = row ? base.summaries.find(summary => summary.id === row.scheduleId) ?? null : null;
    for (const file of this.files.values()) {
      const stored = file.value.schedule;
      const run = stored?.runs.find(candidate => candidate.id === runId);
      if (!stored || !run) continue;
      const output = run.output?.replace(/^\s*---\s*\n/, "").trim() || null;
      return { runId, output: output ? output.slice(0, OUTPUT_MAX) : null, outputTruncated: !!output && output.length > OUTPUT_MAX, prompt: clip(stored.prompt ?? null, PROMPT_MAX),
        note: output ? null : run.status === "running" ? t("serverSchedules.m017") : t("serverSchedules.m018"), row, schedule };
    }
    return { runId, output: null, outputTruncated: false, prompt: null, row, schedule,
      note: row?.source === "ledger" || this.ledger.runs[runId] ? t("serverSchedules.m019") : t("serverSchedules.m020") };
  }
}

/** The part of `fs.watch` the recorder uses; tests pass their own. */
export interface DirectoryWatcher { close(): void; on(event: "error", listener: (error: Error) => void): unknown }
export type WatchDirectory = (directory: string, onChange: (filename: string | null) => void) => DirectoryWatcher;
const watchSchedules: WatchDirectory = (directory, onChange) =>
  // Not persistent: the watcher never keeps the plugin process (or a test) alive by itself.
  watchDirectory(directory, { persistent: false }, (_event, filename) => onChange(filename === null ? null : String(filename)));
export interface ScheduleRecorderOptions {
  /** Quiet time after a change before recording (2 s): one atomic write is several events, a run start and end are two writes. */
  debounceMs?: number;
  /** How often the directory listing is compared with the one last recorded (5 min); a lost watcher is set up again then. */
  pollMs?: number;
  watch?: WatchDirectory;
  log?: (message: string) => void;
}

/**
 * Keeps the ledger without anyone opening 定时运行. Paseo deletes a schedule's runs with its file and heartbeat Agents carry
 * no labels to rebuild them from, so every change in `$PASEO_HOME/schedules` is recorded within seconds: `fs.watch` on the
 * directory (2 s debounce; Paseo writes a temporary file and renames it over the schedule, so `*.tmp` events are ignored and the
 * rename itself is the change). Every 5 minutes the listing (directory identity and mtime, each schedule file's size and mtime)
 * is compared with the one last recorded, which also covers a watcher that failed (inotify limits, unsupported file systems), a
 * directory created after the plugin started, and one replaced while watched. Recording reads only changed files.
 */
export class ScheduleRecorder {
  private readonly directory: string;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly watchImpl: WatchDirectory;
  private readonly log: (message: string) => void;
  private watcher: DirectoryWatcher | null = null;
  private watchedIno: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private recording: Promise<void> | null = null;
  private again = false;
  private closed = false;
  /** The listing as of the last recording; a poll that sees another one records again. */
  private recorded: string | null = null;
  private readonly warned = new Set<string>();

  constructor(private readonly index: ScheduleIndex, options: ScheduleRecorderOptions = {}) {
    this.directory = index.schedulesDirectory;
    this.debounceMs = options.debounceMs ?? 2000;
    this.pollMs = options.pollMs ?? 5 * 60_000;
    this.watchImpl = options.watch ?? watchSchedules;
    this.log = options.log ?? (message => console.warn(`${LOG} ${message}`));
  }

  /** Whether a watcher reports changes right now (else only the 5-minute comparison does). */
  get watching(): boolean { return !!this.watcher; }

  /** Watches, polls, and records once soon: runs that happened while the plugin was stopped. */
  start(): void {
    if (this.closed || this.poller) return;
    this.poller = setInterval(() => void this.poll(), this.pollMs);
    this.poller.unref?.();
    void this.poll();
  }

  /** Record soon (debounced): an Agent's turn started or ended. Agents no live schedule points at are ignored. */
  nudge(agentId?: string): void {
    if (agentId && !this.index.pointsAt(agentId)) return;
    this.request();
  }

  /** Stops watching and polling, and waits for a recording in flight (the index is closed after this). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.poller) { clearInterval(this.poller); this.poller = null; }
    this.unwatch();
    await this.recording?.catch(() => {});
  }

  private request(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.record(); }, this.debounceMs);
    this.timer.unref?.();
  }

  /** One recording at a time; a request during one runs it once more afterwards. */
  private record(): Promise<void> {
    if (this.recording) { this.again = true; return this.recording; }
    this.recording = (async () => {
      do {
        this.again = false;
        try {
          // The listing is taken first: a change during the recording leaves it different, so the next poll records again.
          const listing = await this.listing().catch(() => null);
          await this.index.sync();
          if (listing) this.recorded = listing.signature;
        } catch (error) { this.warnOnce("record", `background recording failed: ${String(error)}`); }
      } while (this.again && !this.closed);
    })().finally(() => { this.recording = null; });
    return this.recording;
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    let listing: { signature: string; ino: number | null };
    try { listing = await this.listing(); } catch (error) { this.warnOnce("list", `cannot list the schedules directory: ${String(error)}`); return; }
    if (this.closed) return;
    // A directory removed or replaced while watched leaves the watcher silent: watch the one that is there now.
    if (this.watcher && this.watchedIno !== listing.ino) this.unwatch();
    if (!this.watcher && listing.ino !== null) this.watch(listing.ino);
    if (listing.signature !== this.recorded) this.request();
  }

  private watch(ino: number): void {
    try {
      const watcher = this.watchImpl(this.directory, filename => {
        // Paseo's temporary files (`.<id>.json.<pid>.<time>.<uuid>.tmp`) come and go before the rename that matters.
        if (filename && filename.endsWith(".tmp")) return;
        this.request();
      });
      watcher.on("error", error => {
        if (this.watcher !== watcher) return;
        this.unwatch();
        this.warnOnce("watch-error", `stopped watching the schedules directory (${String(error)}); comparing it every ${this.every} instead`);
        this.request();
      });
      this.watcher = watcher; this.watchedIno = ino;
    } catch (error) {
      this.warnOnce("watch", `cannot watch the schedules directory (${(error as NodeJS.ErrnoException).code ?? String(error)}); comparing it every ${this.every} instead`);
    }
  }

  private unwatch(): void {
    const watcher = this.watcher;
    this.watcher = null; this.watchedIno = null;
    try { watcher?.close(); } catch { /* already closed */ }
  }

  /** The directory's identity and mtime and each schedule file's size and mtime (within the scan's file budget); "missing" without it. */
  private async listing(): Promise<{ signature: string; ino: number | null }> {
    let info;
    try { info = await stat(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { signature: "missing", ino: null }; throw error; }
    const names = (await readdir(this.directory)).filter(name => name.endsWith(".json")).sort().slice(0, this.index.scanLimits.scheduleFiles);
    const files = await Promise.all(names.map(async name => {
      try { const file = await stat(join(this.directory, name)); return `${name}:${file.mtimeMs}:${file.size}`; } catch { return `${name}:gone`; }
    }));
    return { signature: `${info.ino}:${info.mtimeMs}:${files.join("|")}`, ino: info.ino };
  }

  private get every(): string { return this.pollMs >= 60_000 ? `${Math.round(this.pollMs / 60_000)} min` : `${this.pollMs} ms`; }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(message);
  }
}

/** What index.server.ts wires (see registerSchedules). */
export interface ScheduleModule {
  /** Record soon (2 s debounce). Call it when an Agent's turn starts or ends; Agents no live schedule points at cost nothing. */
  nudge(agentId?: string): void;
  /** Failed runs of ordinary schedules (heartbeats apart) that started at or after `sinceMs`. */
  failuresSince(sinceMs: number): Promise<number>;
  /** Failed heartbeat runs that started at or after `sinceMs`. */
  heartbeatFailuresSince(sinceMs: number): Promise<number>;
  /** Plugin stop / reload: stops the recorder, then saves pending ledger changes. */
  close(): Promise<void>;
}

/**
 * 定时运行's RPCs (`observatory.schedules.list` / `.run` / `.heartbeats`) and the background recorder. Reads that only need the
 * schedule files (heartbeats, failure counts) reuse the last build while the watcher keeps it current (10 minutes at most),
 * otherwise for a minute; the page's list and a `fresh` heartbeat read (归档已读完成's second tap) always compare the files.
 */
export function registerSchedules(server: PluginServerContext, dependencies: { directory: ScheduleDirectory }, options: ScheduleRecorderOptions = {}): ScheduleModule {
  const index = new ScheduleIndex({ directory: dependencies.directory });
  const recorder = new ScheduleRecorder(index, options);
  const maxAge = () => recorder.watching ? 10 * 60_000 : 60_000;
  server.handle(listScheduleRuns, (input, { paseo }) => index.list(paseo, input));
  server.handle(getScheduleRun, (input, { paseo }) => index.run(paseo, input.runId));
  server.handle(getScheduleHeartbeats, input => index.heartbeats(input, maxAge()));
  recorder.start();
  return {
    nudge: agentId => recorder.nudge(agentId),
    failuresSince: async sinceMs => (await index.failures(sinceMs, maxAge())).runs,
    heartbeatFailuresSince: async sinceMs => (await index.failures(sinceMs, maxAge())).heartbeats,
    async close() { await recorder.close(); await index.close(); },
  };
}
