import { onTextChange } from "../shared/i18n";
import { t } from "../shared/text";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { PaseoApi } from "./paseo-types";
import type { ProviderBridge } from "./provider-subagents";
import { LEGACY_RESUME_NAME, LEGACY_RESUME_PROMPT, PENDING_RESUME, RESUME_BUSY_RETRY_MS, RESUME_LEDGER_LIMIT, RESUME_MISSED_GRACE_MS, RESUME_MISSED_RETRY_MS, RESUME_PROMPT, RESUME_WINDOW_MS, RESUME_WINDOW_TEXT, cancelResume, getResumes,
  resumeCadenceSchema, resumeCron, resumeEntrySchema, resumeName, sameMinute, scheduleResume, type CancelResumeResult, type ResumeCadence, type ResumeEntry,
  type ResumeReason, type ResumesResponse, type ResumeStatus, type ScheduleResumeResult } from "../shared/resume";
import { getProviderBases } from "../shared/provider-bases";
import { object, string } from "../shared/timeline";
import { validZone } from "./device-zone";
import { ensurePrivateDirectory } from "./paseo-home";
import { providerBasesReader } from "./provider-bases";
import { contentRevision } from "./revision";
import { telemetryDirectory } from "./telemetry";
import type { MarkerEvidence, MarkerRun } from "./tokens/source";

type Bridge = Pick<ProviderBridge, "request">;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const iso = (at: number) => new Date(at).toISOString();
const MINUTE = 60_000, DAY = 86_400_000;
/** Finished resumes stay on their card this long, then leave the ledger. */
const KEEP_FINISHED_MS = 7 * DAY;
/**
 * The host answers a plugin RPC within 30 s (0.11.1 plugins/runtime.js) and drops the answer after that while the request goes on.
 * So a change starts no later than this after the request arrived (codex-obs-resume-recheck5-F2): a cancel's (then one
 * schedule/delete, 8 s at most, and the ledger's write), a schedule's (then schedule/create, 15 s at most, and undoing a wrong one,
 * 8 s). One later is not made: the device is told to try again. A schedule checks it after every wait, before each change: after
 * the Agent's snapshot read (before the create), after each inspect or delete of an old heartbeat (before deleting the next dead
 * one), and before adopting one (codex-obs-resume-recheck6-F2). A heartbeat made in time is kept (or undone, at a wrong minute).
 */
const CANCEL_START_MS = 15_000, SCHEDULE_START_MS = 6_000;
let SCHEDULE_TOO_LATE = t("serverResume.m001");
/** The ledger file, at most: a larger one is not read (and is set aside), so nothing is ever written past it. */
export const LEDGER_MAX_BYTES = 1024 * 1024;
/**
 * Heartbeats kept to delete (`tidy`) past which nothing new is taken on. None is ever dropped to make room
 * (codex-obs-resume-recheck9-F2): once this many wait, until deletes go through again, 安排续跑 is refused, saying why, and a resume
 * ending (or a retry replacing its heartbeat) with one that cannot be deleted yet stays as it is; the next check tries again.
 */
export const TIDY_LIMIT = 200;
/**
 * The most heartbeats `tidy` ever holds. Past TIDY_LIMIT only a 安排续跑 already under way adds one: the heartbeat of the Agent's
 * ended resume, replaced by the record of the one just made or taken up (`put`), which is never refused (it would leave that
 * heartbeat unrecorded: a second prompt once the user asks again). Each request under way adds one at most, and at most
 * RESUME_LEDGER_LIMIT are under way (`scheduling`). Full, with the most entries, the file holds about 110 KB of the host's ids and
 * times; every bounded field at its longest in three-byte characters, about 830 KB: under LEDGER_MAX_BYTES, which `persist`
 * checks before each write all the same.
 */
export const TIDY_HARD_LIMIT = TIDY_LIMIT + RESUME_LEDGER_LIMIT;

/** 05:02 / 明天 05:02 / 10月13日 05:02 in `zone` (the devices'), seen from `now`. */
export function wallLabel(at: number, zone: string | null | undefined, now = Date.now()): string {
  const timeZone = validZone(zone) ?? "UTC";
  const parts = (value: number) => {
    const read = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).formatToParts(value);
    const part = (type: string) => read.find(item => item.type === type)?.value ?? "";
    return { day: Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day"))), month: Number(part("month")), date: Number(part("day")), clock: `${part("hour").padStart(2, "0")}:${part("minute")}` };
  };
  const wake = parts(at), days = Math.round((wake.day - parts(now).day) / DAY);
  return days === 0 ? wake.clock : days === 1 ? t("serverResume.m002", { value1: wake.clock }) : t("serverResume.m003", { value1: wake.month, value2: wake.date, value3: wake.clock });
}

/**
 * The first minute from `at` on that no other heartbeat and no other waiting resume wakes in (F2; `taken` holds whole minutes
 * since the epoch). The host's schedule ticks overlap: one waits for a run's whole turn while the next ticks run the following
 * heartbeats, then it goes on with the list it read before and can run one of them a second time. Apart, two resumes are never
 * due together in one tick's list; deleting each heartbeat once it has run covers a list read before it ran. The ledger picks
 * every wake through one allocator for all Agents (`ResumeLedger.hold`, codex-obs-resume-F1). Not covered: a recurring heartbeat
 * of the user's whose later firings land on a resume's minute (only each heartbeat's next wake is listed).
 */
export function freeMinute(at: number, taken: ReadonlySet<number>): number {
  let minute = Math.floor(at / MINUTE);
  while (taken.has(minute)) minute++;
  return minute === Math.floor(at / MINUTE) ? at : minute * MINUTE;
}

// ---------- the host's schedules, through the session's own requests (the SDK has no schedules API) ----------

/** A run as schedule/inspect has it; `id` is the run id the host also wrote into the prompt it sent (`run=<id>`). */
interface HeartbeatRun { id: string; status: string; startedAt: number; endedAt: number | null; error: string }
/** Its cadence, when a cron (the expression and its zone, none for UTC); null for any other kind. */
export interface HeartbeatCron { expression: string; timezone: string | null }
interface Heartbeat { id: string; name: string | null; status: string; nextRunAt: number | null; agentId: string | null; maxRuns: number | null; prompt: string | null;
  createdAt: number | null; cron: HeartbeatCron | null; runs: HeartbeatRun[] }
const instant = (value: unknown) => { const at = Date.parse(string(value)); return Number.isFinite(at) ? at : null; };
function heartbeatOf(raw: unknown): Heartbeat | null {
  const schedule = object(raw), id = string(schedule.id), target = object(schedule.target), cadence = object(schedule.cadence);
  if (!id) return null;
  const runs = (Array.isArray(schedule.runs) ? schedule.runs : []).map(object).map(run => ({ id: string(run.id).slice(0, 128), status: string(run.status), startedAt: Date.parse(string(run.startedAt)),
    endedAt: instant(run.endedAt), error: string(run.error) })).filter(run => Number.isFinite(run.startedAt)).sort((a, b) => a.startedAt - b.startedAt);
  return { id, name: typeof schedule.name === "string" ? schedule.name : null, status: string(schedule.status), nextRunAt: instant(schedule.nextRunAt),
    agentId: target.type === "agent" ? string(target.agentId) || null : null, maxRuns: typeof schedule.maxRuns === "number" ? schedule.maxRuns : null,
    prompt: typeof schedule.prompt === "string" ? schedule.prompt : null, createdAt: instant(schedule.createdAt),
    cron: cadence.type === "cron" && typeof cadence.expression === "string" ? { expression: cadence.expression.slice(0, 200), timezone: typeof cadence.timezone === "string" ? cadence.timezone : null } : null, runs };
}
/**
 * A heartbeat's rule as the ledger keeps it (`ResumeEntry.cadence`): its cron's fields one space apart, and its zone; null when it
 * is not a cron the ledger can keep.
 */
function ruleOf(cron: HeartbeatCron | null): ResumeCadence | null {
  if (!cron) return null;
  const rule = { expression: cron.expression.trim().split(/\s+/).join(" "), timezone: cron.timezone };
  return resumeCadenceSchema.safeParse(rule).success ? rule : null;
}
/**
 * Whether a heartbeat still has the rule it was made or taken up with (`ResumeEntry.cadence`, codex-obs-resume-recheck10-F1): the
 * same cron in the same zone (none is UTC). Only the user changes a rule (in 计划); the host only moves a wake to a later match of
 * the same one (a restart). Which one an old wake still matches says nothing: a rule changed to every two hours still matches the
 * 02:00 it replaced.
 */
function sameRule(cron: HeartbeatCron | null, kept: ResumeCadence | null | undefined): boolean {
  const rule = ruleOf(cron);
  return !!rule && !!kept && rule.expression === kept.expression && (rule.timezone ?? "UTC") === (kept.timezone ?? "UTC");
}
/**
 * One of this Agent's own 恢复后续跑 heartbeats (F7): the name, this Agent as the target, a single run and the resume prompt
 * (schedule/list and schedule/inspect both carry them). A copy the user made recurring in 计划 keeps the name, so the name
 * alone never adopts, replaces, deletes or cancels one.
 */
const resumeIdentity = (name: string | null, prompt: string | null): string => createHash("sha256").update(JSON.stringify([name, prompt])).digest("hex");
const legacyResumeIdentity = (name: string | null, prompt: string | null): boolean => !!name?.startsWith(LEGACY_RESUME_NAME) && prompt === LEGACY_RESUME_PROMPT;
const generatedIdentity = (name: string, prompt: string): string | undefined => legacyResumeIdentity(name, prompt) ? undefined : resumeIdentity(name, prompt);
/**
 * How the host failed a run, read only from its own whole wording (daemon 0.11.1 schedule/service.js, agent-manager.js) with
 * this Agent's id where it writes one (codex-obs-resume-recheck2-F1). Once the prompt went in, the host fails a run with the
 * Agent's own last reply, which can be any text, one quoting these errors included: such a reply is never the host's error.
 * `prompted`: after the prompt (a pending permission, a failed turn with no reply at all); `busy`, `gone`, `archived`,
 * `no-resume` (an ACP session its provider cannot load again), `load-timeout`: before it; `restart`: a daemon restart cut the
 * run short, before or after the prompt. Null for anything else, which says nothing about the prompt.
 */
type HostFailure = "prompted" | "busy" | "gone" | "archived" | "no-resume" | "load-timeout" | "restart";
function hostFailure(error: string, agentId: string): HostFailure | null {
  // The host's own errors are one short line; a longer text is a reply.
  if (!error || error.length > 400 || error.includes("\n")) return null;
  switch (error) {
    case `Scheduled agent ${agentId} is waiting for permission`: case `Scheduled agent ${agentId} failed`: return "prompted";
    case `Agent ${agentId} already has an active run`: return "busy";
    case `Agent ${agentId} no longer exists`: return "gone";
    case `Agent ${agentId} is archived`: return "archived";
    case "Daemon restarted before the scheduled run completed": return "restart";
  }
  if (/^\S+ does not support ACP session resume$/.test(error)) return "no-resume";
  // provider-refresh-deadline.js: `Timed out refreshing <provider label> after <ms>ms[; pending: <activities>]`.
  return /^Timed out refreshing .+ after \d+ms(?:; pending: .+)?$/.test(error) ? "load-timeout" : null;
}
const notFound = (error: unknown) => /not found/i.test(errorText(error));
/** The heartbeat with its runs; null once it is gone (deleted). Other failures throw: try again later. */
async function inspectHeartbeat(bridge: Bridge, id: string): Promise<Heartbeat | null> {
  let response: Record<string, unknown>;
  try { response = await bridge.request({ type: "schedule/inspect", scheduleId: id }, "schedule/inspect/response"); }
  catch (error) { if (notFound(error)) return null; throw error; }
  const heartbeat = heartbeatOf(response.schedule);
  if (!heartbeat) throw new Error(t("serverResume.m004"));
  return heartbeat;
}
/**
 * Every schedule the host has, without runs (schedule/list): one request serves adopting, taking over and the minutes taken. All
 * of them: the host lists the oldest first, so a cut would drop the newest, the retry whose answer was lost among them (made
 * twice, it would prompt the Agent twice) and the minutes they wake in.
 */
async function listHeartbeats(bridge: Bridge): Promise<Heartbeat[]> {
  const response = await bridge.request({ type: "schedule/list" }, "schedule/list/response");
  return (Array.isArray(response.schedules) ? response.schedules : []).map(heartbeatOf).filter((heartbeat): heartbeat is Heartbeat => heartbeat !== null);
}
/** Deletes a heartbeat; one already gone counts as deleted. */
async function deleteHeartbeat(bridge: Bridge, id: string): Promise<void> {
  try { await bridge.request({ type: "schedule/delete", scheduleId: id }, "schedule/delete/response"); }
  catch (error) { if (!notFound(error)) throw error; }
}
/**
 * Deletes a heartbeat the ledger is done with or replaces. A delete that fails may have gone through all the same (its answer
 * lost: the plugin session reconnecting, a timeout), so the heartbeat is read again at once: gone, it was deleted, and is never
 * taken later for one the user deleted in Paseo (canceled, never retried); still there, or unreadable, the delete failed (thrown).
 */
async function removeHeartbeat(bridge: Bridge, id: string): Promise<void> {
  try { await deleteHeartbeat(bridge, id); }
  catch (error) { if (await inspectHeartbeat(bridge, id).catch(() => undefined) !== null) throw error; }
}
/** A heartbeat made (`ok`), or why not. */
type Made = { ok: true; id: string; nextRunAt: number } | { ok: false; message: string };
/**
 * One one-off heartbeat at `at` (a UTC cron, `maxRuns` 1, expiring with the retry window). Kept only when the host's own
 * `nextRunAt` is the minute asked for (codex-F7): a heartbeat at any other time is deleted again and reported.
 */
async function createHeartbeat(bridge: Bridge, input: { agentId: string; at: number; name: string; prompt: string; expiresAt: number }, zone: string | null | undefined, now: number): Promise<Made> {
  const response = await bridge.request({ type: "schedule/create", prompt: input.prompt, name: input.name, cadence: { type: "cron", ...resumeCron(input.at) },
    target: { type: "agent", agentId: input.agentId }, maxRuns: 1, expiresAt: iso(input.expiresAt) }, "schedule/create/response", 15_000);
  const schedule = object(response.schedule), id = string(schedule.id);
  if (!id) return { ok: false, message: t("serverResume.m005", { value1: string(response.error) || t("serverResume.m006") }) };
  const next = Date.parse(string(schedule.nextRunAt));
  if (sameMinute(next, input.at)) return { ok: true, id, nextRunAt: next };
  // Never keep a wake at a time the user did not confirm.
  const removed = await removeHeartbeat(bridge, id).then(() => true, () => false);
  const host = Number.isFinite(next) ? t("serverResume.m007", { value1: wallLabel(next, zone, now) }) : t("serverResume.m008");
  return { ok: false, message: t("serverResume.m009", { host: host, value2: wallLabel(input.at, zone, now), value3: removed ? t("serverResume.m010") : t("serverResume.m011", { value1: input.name }) }) };
}
/**
 * The wake minutes of all Agents' resumes, as the ledger hands them out (`ResumeLedger.hold`, codex-obs-resume-F1): `hold` picks
 * the first free minute from the asked time and holds it at once; `release` hears that the create made no heartbeat: the minute is
 * free again. A heartbeat made, or one that may have been (its answer lost, recorded as a resume to confirm), is the caller's to
 * release once its ledger entry holds the minute.
 */
export interface WakeMinutes { hold(asked: number): number; release(at: number): void }

/**
 * Creates the first heartbeat behind 恢复后续跑 through the host session's own `schedule/create` request (the one
 * `paseo heartbeat create` sends). Checked first: the Agent exists and is not archived (a snapshot read that never loads it),
 * and the time is in the future within 8 days. A minute in `taken` (another heartbeat wakes then, F2), or one the ledger's
 * allocator holds, moves the wake to the next free one, which the reply says. `zone` words the reply (the devices' zone).
 * `late`: the request has waited past its time to start a change (SCHEDULE_START_MS): nothing is made, the minute is let go.
 * A create whose answer was lost comes back scheduled without a heartbeat (`scheduleId` null), for the caller to record as a
 * resume to confirm: never made twice (codex-obs-resume-recheck12). `at`: the minute asked of the host, whose cron is the
 * heartbeat's own rule.
 */
export async function createResume(paseo: PaseoApi, bridge: Bridge, input: { agentId: string; at: string; title?: string; timeZone?: string }, now = Date.now(), zone?: string | null,
  taken: ReadonlySet<number> | WakeMinutes = new Set(), late: () => boolean = () => false): Promise<ScheduleResumeResult & { name?: string; at?: number; identity?: string }> {
  const failed = (message: string): ScheduleResumeResult => ({ status: "failed", scheduleId: null, runAt: null, message });
  const asked = Date.parse(input.at), words = zone ?? input.timeZone;
  if (!Number.isFinite(asked) || asked < now + 30_000 || asked > now + 8 * DAY) return failed(t("serverResume.m012"));
  const minutes = "hold" in taken ? taken : null, at = minutes ? minutes.hold(asked) : freeMinute(asked, taken as ReadonlySet<number>);
  let made = false;
  try {
    const current = await paseo.agents.ref(input.agentId).refresh();
    if (late()) return failed(SCHEDULE_TOO_LATE);
    if (!current?.agent) return failed(t("serverResume.m013"));
    if (current.agent.archivedAt) return failed(t("serverResume.m014"));
    const name = resumeName(input.title ?? current.agent.title), prompt = RESUME_PROMPT, identity = generatedIdentity(name, prompt);
    const moved = sameMinute(at, asked) ? "" : t("serverResume.m015", { value1: wallLabel(asked, words, now), value2: Math.max(1, Math.round((at - asked) / MINUTE)) });
    let created: Made;
    try { created = await createHeartbeat(bridge, { agentId: input.agentId, at, name, prompt, expiresAt: at + RESUME_WINDOW_MS }, words, now); }
    catch (error) {
      // No answer: the host may have made it all the same. Never made twice: recorded as a resume to confirm, which the ledger's
      // checks look for (`ResumeLedger.made`, codex-obs-resume-recheck12).
      made = true;
      return { status: "scheduled", scheduleId: null, runAt: iso(Math.floor(at / MINUTE) * MINUTE), name, at, ...(identity ? { identity } : {}),
        message: t("serverResume.m016", { value1: errorText(error).replaceAll(t("serverResume.m017"), t("serverResume.m018")).replace(/[。.]$/, ""), value2: wallLabel(at, words, now), moved: moved }) };
    }
    if (!created.ok) return failed(created.message);
    made = true;
    return { status: "scheduled", scheduleId: created.id, runAt: iso(created.nextRunAt), name, at, ...(identity ? { identity } : {}),
      message: t("serverResume.m019", { value1: wallLabel(created.nextRunAt, words, now), moved: moved, RESUME_WINDOW_TEXT: RESUME_WINDOW_TEXT }) };
  } catch (error) {
    return failed(t("serverResume.m020", { value1: errorText(error).replaceAll(t("serverResume.m021"), t("serverResume.m022")) }));
  } finally {
    if (!made) minutes?.release(at);
  }
}

// ---------- the ledger ----------

const fileSchema = z.object({ version: z.literal(1), entries: z.array(z.unknown()).max(RESUME_LEDGER_LIMIT * 2), tidy: z.unknown().optional() });
/**
 * The provider's own session logs (LocalTokenCallSource): what a session's logs say of a marker the host wrote into a prompt
 * (`run=<runId>`): "found"; "absent" only about a `run`, when the logs scanned since it ended can vouch for every log of the
 * session and each was read whole, unchanged, without it; "pending" while they have not been scanned since (ask again later);
 * else "unknown". `whole`: read each log from its first byte, not only its tail (as a `run` does). Read for one question only,
 * never kept, and never waiting for a scan.
 */
export interface SessionLogs { findMarker(sessionIds: readonly string[], marker: string, options?: { whole?: boolean; run?: MarkerRun }): Promise<MarkerEvidence> }
export interface ResumeLedgerOptions {
  /** Where `resume-ledger.json` lives (the plugin data directory). */ directory?: string;
  now?: () => number;
  /** Background checks, every `checkMs` while a resume waits; tests call `check()` themselves. */ timers?: boolean;
  checkMs?: number;
  /** The devices' zone (DeviceZone.current()), for the wording of replies. */ zone?: () => string | null | undefined;
  log?: (message: string) => void;
  /**
   * The provider session logs (the token module's LocalTokenCallSource): after a daemon restart cut a run short, the prompt found
   * there is the evidence it went in (codex-obs-resume-F2). Without them only the host's attention counts as evidence.
   */
  logs?: SessionLogs;
}
/**
 * The Agent as the host records it, read without loading it: `userAt` is its lastUserMessageAt, which a scheduled prompt never
 * sets (F1, F3); `sessionId` its provider session, whose own log may hold the prompt (`evidence`).
 */
interface AgentState { missing: boolean; archived: boolean; userAt: number | null; sessionId: string | null }
/** Schedule and run ids as the host makes them (8 hex digits, a UUID): the only ids put into a marker looked for in a log. */
const HOST_ID = /^[\w-]{1,128}$/;
/** A heartbeat kept to delete, as the ledger file holds it (`tidy`). */
const tidySchema = z.object({ identity: z.string().regex(/^[a-f0-9]{64}$/).optional(), id: z.string().regex(HOST_ID), agentId: z.string().min(1).max(256) });
/**
 * Whether an ended resume's heartbeat may still be owed a delete: not one cancelled here (deleted then), deleted in Paseo, or the
 * user's (changed or paused there).
 */
const owesDelete = (entry: ResumeEntry) => !!entry.scheduleId && !PENDING_RESUME.has(entry.status)
  && !(entry.status === "canceled" && ["user", "deleted", "edited", "paused"].includes(entry.reason ?? ""));
type Finish = Pick<ResumeEntry, "status" | "reason">;

/**
 * 恢复后续跑 that only counts once the prompt went in (grok-F5, opus-F38). The host gives a heartbeat one chance: a run that
 * finds the Agent busy fails (and counts against `maxRuns`), a daemon restart cuts a run short or moves a missed wake to the
 * cron's next match (next month), and nothing runs while the host is down. So each Agent's latest resume is kept here, and
 * while one waits its heartbeat is inspected every minute:
 *
 * - 已续跑 only on proof tied to this very run (codex-obs-resume-recheck-F1): the host's run record (it succeeded, or failed
 *   once the prompt was in: waiting for permission, "Scheduled agent … failed"), or the prompt itself, with this schedule's
 *   and this run's ids, in the provider's own session log (`evidence`). A turn seen starting proves nothing: a system notification
 *   (a subagent finishing, another schedule) opens one too and moves no prompt time, so does the user's own message;
 * - a run still going → 正在唤醒 until proof or its end;
 * - a run that found the Agent busy or a load the host timed out (the host's own words for it, and its session's logs, read
 *   whole and scanned since the run ended, proving the prompt is not there: a reply can be those very words,
 *   codex-obs-resume-recheck2-F1, recheck3-F1), a wake that never ran (pushed out, completed without a run, or minutes past) →
 *   a new one-off heartbeat (第 2 次 …) 10 or 2 minutes later, unless the user has messaged the Agent since it stopped (已取消,
 *   F3); while the logs have not been scanned since the run ended, a later check decides (within the window); the same words
 *   without that proof (no log the plugin reads, Grok's or an ACP provider's, or one it cannot read or lost) → 未能确认, never
 *   sent again on its own;
 * - a daemon restart that cut a run short: 已续跑 only on proof, else 未能确认, never sent again on its own
 *   (codex-obs-resume-F2: a turn_started the plugin missed proves nothing, nor does attention raised since);
 * - any other failure: its text is the Agent's own last reply or an error met while sending, so the prompt may well be in →
 *   已续跑 on proof, else 未能确认续跑, never sent again on its own (the card offers 重新安排); the host's words for an Agent gone or
 *   archived, or an ACP session it cannot load again → 未能续跑 on the same proof that the prompt is not there (gone or archived
 *   also when the Agent itself says so), else 未能确认 too;
 * - the heartbeat deleted in Paseo → 已取消; changed there (another prompt, more runs, another Agent or name) → the user's from
 *   then on, never deleted (codex-obs-resume-F4); the window (6 hours from the first wake) over → 未能续跑, which the card offers
 *   to 重新安排.
 *
 * Every heartbeat keeps `maxRuns` 1, wakes in a minute no other heartbeat wakes in (F2; one allocator for every Agent's first
 * wake and retries, codex-obs-resume-F1) and is deleted once the ledger is done with it, the one it replaces first; a create
 * whose answer was lost is looked for, never made twice (F4, `made`). One Agent has at most one resume waiting: asking again
 * returns it. The file holds ids, times, the attempt and the state only, at most RESUME_LEDGER_LIMIT Agents; finished ones leave
 * after 7 days.
 */
export class ResumeLedger {
  private entries = new Map<string, ResumeEntry>();
  /** The last heartbeat name per Agent (in memory only), so a retry keeps the title. */
  private names = new Map<string, string>();
  /** When each Agent's heartbeat was last inspected (in memory only). */
  private inspectedAt = new Map<string, number>();
  /**
   * Heartbeats of finished resumes still to delete, by id → Agent: their run was still going, the delete failed, or a resume replaced
   * theirs (`put`). Kept in the ledger file, so a plugin reload never loses one: the host never deletes a finished one-off itself
   * (codex-obs-resume-recheck8-F2). `tidyOne` reads each before deleting it; one leaves only once it is gone, deleted, or the
   * user's (changed or paused in Paseo). None is ever dropped to make room (`track`, codex-obs-resume-recheck9-F2); at most
   * TIDY_HARD_LIMIT.
   */
  private tidy = new Map<string, string>();
  /** Fingerprints for localized heartbeats still waiting for cleanup after their entry was replaced. */
  private tidyIdentities = new Map<string, string>();
  private owns(heartbeat: Heartbeat, agentId: string): boolean {
    if (heartbeat.agentId !== agentId || heartbeat.maxRuns !== 1) return false;
    const entry = this.entries.get(agentId);
    const identity = this.tidyIdentities.get(heartbeat.id) ?? (entry && (!entry.scheduleId || entry.scheduleId === heartbeat.id) ? entry.identity : undefined);
    return identity ? resumeIdentity(heartbeat.name, heartbeat.prompt) === identity : legacyResumeIdentity(heartbeat.name, heartbeat.prompt);
  }
  /** 安排续跑 requests under way (in memory only): each adds one waiting resume at most, and one heartbeat to delete (`put`). */
  private scheduling = 0;
  /** Wake minutes held for heartbeats being created, whatever the Agent (whole minutes since the epoch; in memory only, `hold`). */
  private held = new Set<number>();
  /** When a run's prompt was last looked for in its session's log and not found, by run id (in memory only, `evidence`). */
  private markerMisses = new Map<string, number>();
  private readonly file: string;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly timers: boolean;
  private readonly checkMs: number;
  private readonly zone: () => string | null | undefined;
  private readonly log: (message: string) => void;
  private readonly logs: SessionLogs | null;
  private locks = new Map<string, Promise<void>>();
  private writes: Promise<void> = Promise.resolve();
  private paseo: PaseoApi | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private checking: Promise<void> | null = null;
  private lastCheckAt = -Infinity;
  private error: string | null = null;
  private corrupt = false;
  private closed = false;
  readonly ready: Promise<void>;

  constructor(private readonly bridge: Bridge, options: ResumeLedgerOptions = {}) {
    this.directory = options.directory ?? telemetryDirectory(); this.file = join(this.directory, "resume-ledger.json");
    this.now = options.now ?? Date.now; this.timers = options.timers ?? true; this.checkMs = options.checkMs ?? MINUTE;
    this.zone = options.zone ?? (() => null); this.log = options.log ?? (message => console.warn(message)); this.logs = options.logs ?? null;
    this.ready = this.load().then(() => { this.arm(); if (this.pending().length) this.checkSoon(5000); });
  }

  /** The latest context's API: background checks read the Agent with it (it exists only inside RPCs and hooks). */
  notePaseo(paseo: PaseoApi): void { this.paseo = paseo; }

  /** An Agent's turn ended: when its resume is due (or its heartbeat waits to be deleted), look now instead of at the next minute. */
  nudge(agentId: string): void {
    const entry = this.entries.get(agentId);
    if ((entry && PENDING_RESUME.has(entry.status) && Date.parse(entry.wakeAt) <= this.now() + MINUTE) || [...this.tidy.values()].includes(agentId)) this.checkSoon(3000);
  }

  /**
   * A turn of this Agent began (agent.turn_started; `at` is when the hook arrived). It proves nothing about the resume: a system
   * notification (a subagent finishing, another schedule) opens a turn as a heartbeat's prompt does, without a message time,
   * and the hook names neither (codex-obs-resume-recheck-F1). At or after a waiting resume's wake (a second of slack) it only
   * brings the next check forward, which looks for proof (`evidence`). `_turnId`: the host's, which nothing can tie to a run.
   */
  async noteTurn(agentId: string, at = this.now(), _turnId: string | null = null): Promise<void> {
    await this.ready;
    const entry = this.entries.get(agentId);
    if (entry && PENDING_RESUME.has(entry.status) && at >= Date.parse(entry.wakeAt) - 1000) this.checkSoon(3000);
  }

  async list(agentId?: string): Promise<ResumeEntry[]> {
    await this.ready;
    return [...this.entries.values()].filter(entry => !agentId || entry.agentId === agentId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(entry => ({ ...entry }));
  }

  async read(input: { agentId?: string; revision?: string }): Promise<ResumesResponse> {
    const entries = await this.list(input.agentId);
    // A page reading a waiting resume after a quiet spell (a restart, timers off) gets it checked.
    if (entries.some(entry => PENDING_RESUME.has(entry.status)) && this.now() - this.lastCheckAt > this.checkMs) this.checkSoon(0);
    const revision = contentRevision({ entries, error: this.error });
    return input.revision === revision ? { mode: "unchanged", unchanged: true, revision } : { mode: "full", unchanged: false, revision, generatedAt: iso(this.now()), entries, error: this.error };
  }

  /** 恢复后续跑: one waiting resume per Agent; asking again returns it (已在 05:02 安排). */
  async schedule(paseo: PaseoApi, input: { agentId: string; at: string; timeZone?: string; title?: string; stopAt?: string }): Promise<ScheduleResumeResult> {
    this.paseo = paseo;
    const late = this.deadline(SCHEDULE_START_MS);
    await this.ready;
    return this.withAgent(input.agentId, async () => {
      // The asking device words the reply; the zone devices reported last otherwise.
      const now = this.now(), zone = input.timeZone ?? this.zone();
      const current = this.entries.get(input.agentId);
      if (current && PENDING_RESUME.has(current.status)) return this.existing(current, zone, now);
      const refused = (message: string): ScheduleResumeResult => ({ status: "failed", scheduleId: null, runAt: null, message });
      const tooLate = () => refused(SCHEDULE_TOO_LATE);
      // Full: nothing new is taken on, and nothing already owed is dropped for it (codex-obs-resume-recheck9-F2).
      if (this.tidy.size >= TIDY_LIMIT) return refused(t("serverResume.m023", { value1: this.tidy.size }));
      // Requests under way count as waiting: however many come at once, the waiting resumes stay within the limit, and the
      // heartbeats kept to delete within TIDY_HARD_LIMIT.
      const waiting = this.pending().length + this.scheduling;
      if (waiting >= RESUME_LEDGER_LIMIT) return refused(t("serverResume.m024", { waiting: waiting, RESUME_LEDGER_LIMIT: RESUME_LEDGER_LIMIT }));
      if (late()) return tooLate();
      this.scheduling++;
      try {
        // One schedule/list: a heartbeat left by 2.13 or from before a lost ledger is adopted, never doubled, and the minutes
        // other heartbeats wake in are skipped (F2); the minute comes from the allocator all Agents share (codex-obs-resume-F1).
        const listed = await listHeartbeats(this.bridge).catch(() => null);
        if (late()) return tooLate();
        let adopted: ResumeEntry | null = null;
        try { adopted = listed ? await this.adopt(listed, input.agentId, input.stopAt ?? null, now, late) : null; }
        catch (error) { return { status: "failed", scheduleId: null, runAt: null, message: t("serverResume.m025", { value1: errorText(error).replaceAll(t("serverResume.m026"), t("serverResume.m027")) }) }; }
        if (adopted) return this.existing(adopted, zone, now);
        if (late()) return tooLate();
        const result = await createResume(paseo, this.bridge, input, now, zone, this.minutes(listed ?? [], input.agentId), late);
        if (result.status !== "scheduled" || !result.runAt || result.at === undefined) return result;
        if (result.name) this.names.set(input.agentId, result.name);
        // Planned at the minute asked of the host, its cron the rule the heartbeat was sent with. Without a heartbeat (its answer
        // lost) a resume to confirm, which the checks look for (`made`) and judge as they find it, the user's change in 计划 before
        // then included (codex-obs-resume-recheck11-F1); never made again (codex-obs-resume-recheck12).
        const at = result.at;
        const entry: ResumeEntry = { agentId: input.agentId, scheduleId: result.scheduleId, stopAt: input.stopAt ?? null, plannedAt: iso(Math.floor(at / MINUTE) * MINUTE), wakeAt: result.runAt,
          attempt: 1, status: "scheduled", reason: null, createdAt: iso(now), updatedAt: iso(now), deliveredAt: null, cadence: resumeCron(at), ...(result.identity ? { identity: result.identity } : {}) };
        // The waiting entry holds the minute from here on. Recorded whatever other Agents have left to delete meanwhile (`put`):
        // past this point the heartbeat exists, or may.
        try { await this.put(entry); } finally { this.release(at); }
        const { name: _name, at: _at, identity: _identity, ...reply } = result;
        return { ...reply, entry: { ...entry } };
      } finally { this.scheduling--; }
    });
  }

  /**
   * 取消续跑: only this Agent's own 恢复后续跑 heartbeat (F7), and not while it is waking the Agent. Nothing is changed once the
   * request has waited too long for its answer to reach the device (CANCEL_START_MS, codex-obs-resume-recheck5-F2). The heartbeat
   * is deleted first and the resume recorded as cancelled after; a delete that fails changes nothing and says so.
   */
  async cancel(paseo: PaseoApi, input: { agentId: string; scheduleId?: string }): Promise<CancelResumeResult> {
    this.paseo = paseo;
    const late = this.deadline(CANCEL_START_MS);
    await this.ready;
    return this.withAgent(input.agentId, async () => {
      const entry = this.entries.get(input.agentId);
      let waiting = entry && PENDING_RESUME.has(entry.status) ? entry : null;
      const failed = (message: string): CancelResumeResult => ({ status: "failed", message, entry: entry ? { ...entry } : null });
      const tooLate = () => failed(t("serverResume.m028"));
      if (late()) return tooLate();
      let id = waiting ? waiting.scheduleId : input.scheduleId ?? null;
      // One still to be confirmed (its create's answer lost, or the create failed): the host may have made it all the same, and that
      // one is what is cancelled (`made`). More than one that could be it is never guessed at (codex-obs-resume-recheck12-F4).
      if (waiting && !id) {
        let made: Heartbeat | "absent" | "ambiguous";
        try { made = this.made(waiting, await listHeartbeats(this.bridge)); }
        catch (error) { return failed(t("serverResume.m029", { value1: errorText(error).replaceAll(t("serverResume.m030"), t("serverResume.m031")) })); }
        if (late()) return tooLate();
        if (made === "ambiguous") return failed(t("serverResume.m032"));
        // None made yet: no more looking or making. A create the host is still writing may land all the same, so no promise.
        if (made === "absent") return { status: "canceled", message: t("serverResume.m033"),
          entry: await this.update(waiting, { status: "canceled", reason: "user" }) };
        id = made.id; waiting = { ...waiting, scheduleId: id };
      }
      if (!id) return failed(t("serverResume.m034"));
      let heartbeat: Heartbeat | null;
      try { heartbeat = await inspectHeartbeat(this.bridge, id); } catch (error) { return failed(t("serverResume.m035", { value1: errorText(error).replaceAll(t("serverResume.m036"), t("serverResume.m037")) })); }
      if (late()) return tooLate();
      if (!heartbeat) return { status: "canceled", message: t("serverResume.m038"), entry: waiting ? await this.update(waiting, { status: "canceled", reason: "user" }) : entry ?? null };
      if (!this.owns(heartbeat, input.agentId)) {
        if (!waiting) return failed(t("serverResume.m039"));
        // The ledger's own heartbeat, changed in Paseo since (codex-obs-resume-F4): the user's now, kept as they made it.
        return { status: "failed", message: t("serverResume.m040"),
          entry: await this.update(waiting, { status: "canceled", reason: "edited" }) };
      }
      if (heartbeat.runs.some(run => run.status === "running")) return failed(t("serverResume.m041"));
      // A run whose prompt surely went in (the host says so, or its session's log has it), which the next check would find too.
      // The log is read for every failed run, as the check reads it first: an error that looks like one from before the prompt
      // may be the Agent's own reply (codex-obs-resume-recheck2-F1).
      let went: HeartbeatRun | null = null;
      for (const run of heartbeat.runs) {
        if (run.status === "succeeded" || (run.status === "failed" && (hostFailure(run.error, input.agentId) === "prompted" || await this.evidence(input.agentId, heartbeat, run, "find") === "found"))) { went = run; break; }
      }
      if (late()) return tooLate();
      if (went) {
        if (waiting) await this.deliver(waiting, heartbeat, went.startedAt);
        return { status: "failed", message: t("serverResume.m042"), entry: waiting ? { ...this.entries.get(input.agentId)! } : entry ?? null };
      }
      // A delete whose answer was lost and that went through is the cancel done (`removeHeartbeat`).
      try { await removeHeartbeat(this.bridge, id); } catch (error) { return failed(t("serverResume.m043", { value1: errorText(error).replaceAll(t("serverResume.m044"), t("serverResume.m045")) })); }
      const now = this.now(), wake = heartbeat.nextRunAt ?? now;
      const base: ResumeEntry = waiting ?? { agentId: input.agentId, scheduleId: id, stopAt: null, plannedAt: iso(wake), wakeAt: iso(wake), attempt: 1, status: "scheduled", reason: null,
        createdAt: iso(now), updatedAt: iso(now), deliveredAt: null, cadence: ruleOf(heartbeat.cron) };
      // A heartbeat the ledger did not know, cancelled: its record would replace the Agent's last one, whose heartbeat may still be
      // owed a delete. With no room to keep that, the last record stays (still naming it) and this one is not kept.
      if (!waiting && !this.room(this.replaced(base))) return { status: "canceled", message: t("serverResume.m046"), entry: entry ? { ...entry } : null };
      return { status: "canceled", message: t("serverResume.m047"), entry: await this.update(base, { status: "canceled", reason: "user" }) };
    });
  }

  /** One pass over the waiting resumes, then the heartbeats still to delete; never overlaps itself. */
  check(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      await this.ready;
      this.lastCheckAt = this.now();
      for (const entry of this.pending()) {
        if (this.closed) return;
        await this.withAgent(entry.agentId, () => this.checkOne(entry.agentId)).catch(error => this.log(t("serverResume.m048", { value1: errorText(error) })));
      }
      for (const [id, agentId] of [...this.tidy]) {
        if (this.closed) return;
        await this.withAgent(agentId, () => this.tidyOne(id, agentId)).catch(error => this.log(t("serverResume.m049", { value1: errorText(error) })));
      }
    })().finally(() => { this.checking = null; this.arm(); });
    return this.checking;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = null; this.soon = null;
    await this.checking?.catch(() => {});
    await this.writes;
  }

  private pending(): ResumeEntry[] { return [...this.entries.values()].filter(entry => PENDING_RESUME.has(entry.status)); }

  private existing(entry: ResumeEntry, zone: string | null | undefined, now: number): ScheduleResumeResult {
    const wake = wallLabel(Date.parse(entry.wakeAt), zone, now), nth = entry.attempt > 1 ? t("serverResume.m050", { value1: entry.attempt }) : "";
    return { status: "scheduled", scheduleId: entry.scheduleId, runAt: entry.wakeAt, existing: true, entry: { ...entry },
      message: t("serverResume.m051", { value1: entry.scheduleId ? t("serverResume.m052", { wake: wake, nth: nth }) : t("serverResume.m053", { wake: wake, nth: nth }) }) };
  }

  /** The minutes other heartbeats (of any kind), the other waiting resumes and the heartbeats being created wake in (F2). */
  private taken(listed: readonly Heartbeat[], agentId: string): Set<number> {
    const minutes = new Set<number>(this.held);
    for (const heartbeat of listed) if (heartbeat.status === "active" && heartbeat.nextRunAt !== null) minutes.add(Math.floor(heartbeat.nextRunAt / MINUTE));
    for (const entry of this.pending()) if (entry.agentId !== agentId) minutes.add(Math.floor(Date.parse(entry.wakeAt) / MINUTE));
    return minutes;
  }
  /**
   * The one allocator of wake minutes, for every Agent's first wake and each retry (codex-obs-resume-F1): the first free minute
   * from `at` (`taken`, `freeMinute`), held at once. Picking and holding are one synchronous step, so two Agents asked at the same
   * moment, both having read a schedule/list without the other's heartbeat, never get the same minute (the host's overlapping
   * ticks would run one of the two heartbeats twice). The hold lasts while the create is out, until the ledger entry holds the
   * minute (`release`; one whose answer was lost is recorded all the same, as a resume to confirm), or the create surely failed.
   */
  private hold(at: number, listed: readonly Heartbeat[], agentId: string): number {
    const wake = freeMinute(at, this.taken(listed, agentId));
    this.held.add(Math.floor(wake / MINUTE));
    return wake;
  }
  private release(at: number): void { this.held.delete(Math.floor(at / MINUTE)); }
  /** The allocator as `createResume` takes it, with the list just read. */
  private minutes(listed: readonly Heartbeat[], agentId: string): WakeMinutes {
    return { hold: asked => this.hold(asked, listed, agentId), release: at => this.release(at) };
  }

  /**
   * This Agent's own 恢复后续跑 heartbeat already waiting in the host (not in the ledger), adopted; dead ones are deleted (`waitingOwn`,
   * which throws when one cannot be read). Past the request's time (`late`) none is: null, and the next request or check takes them up.
   */
  private async adopt(listed: readonly Heartbeat[], agentId: string, stopAt: string | null, now: number, late: () => boolean): Promise<ResumeEntry | null> {
    const heartbeat = await this.waitingOwn(listed, agentId, now, now + 8 * DAY, late);
    if (!heartbeat || late()) return null;
    if (heartbeat.name) this.names.set(agentId, heartbeat.name);
    const adopted: ResumeEntry = { agentId, scheduleId: heartbeat.id, stopAt, plannedAt: iso(heartbeat.wake), wakeAt: iso(heartbeat.wake), attempt: 1, status: "scheduled", reason: null,
      createdAt: iso(now), updatedAt: iso(now), deliveredAt: null, cadence: ruleOf(heartbeat.cron) };
    await this.put(adopted);
    return adopted;
  }

  /**
   * The first of this Agent's own active 恢复后续跑 heartbeats that still waits to wake it, between a few minutes ago and `latest`;
   * the other own ones are deleted: moved out a month (a minute missed while the host was down), one more that would wake it
   * twice, or one long past. The list only names the candidates: each is read first and judged on what the host has now
   * (codex-obs-resume-recheck8-F1). One the user has changed in 计划 since (another prompt, more runs, another Agent) is theirs,
   * neither taken up nor deleted; one whose wake moved is judged, and taken up, at its new wake. A one-off with a run waits for
   * nothing more, whatever its wake says (codex-obs-resume-recheck8-F3): a run going keeps its wake (a scheduled one its past
   * wake, one made by hand in Paseo a wake still ahead), and such a heartbeat is neither taken up nor deleted; one run by hand
   * and done stays active until the host's next tick completes it, and is deleted. The heartbeat of this Agent's resume the
   * ledger has ended, or one it is to delete (`tidy`), is never taken up either. One that cannot be read throws: nothing is
   * taken up, deleted or made on a guess. Once `late` (a request past its time, codex-obs-resume-recheck6-F2) it stops there.
   */
  private async waitingOwn(listed: readonly Heartbeat[], agentId: string, now: number, latest: number, late: () => boolean = () => false): Promise<(Heartbeat & { wake: number }) | null> {
    const entry = this.entries.get(agentId), ended = entry && !PENDING_RESUME.has(entry.status) ? entry.scheduleId : null;
    let found: (Heartbeat & { wake: number }) | null = null;
    for (const candidate of listed) {
      if (candidate.nextRunAt === null || candidate.status !== "active" || !this.owns(candidate, agentId)) continue;
      const heartbeat = await inspectHeartbeat(this.bridge, candidate.id);
      if (late()) break;
      if (!heartbeat || heartbeat.status !== "active" || heartbeat.nextRunAt === null || !this.owns(heartbeat, agentId) || heartbeat.runs.some(run => run.status === "running")) continue;
      const wake = heartbeat.nextRunAt;
      if (!found && !heartbeat.runs.length && heartbeat.id !== ended && !this.tidy.has(heartbeat.id) && wake >= now - RESUME_MISSED_GRACE_MS && wake <= latest) { found = { ...heartbeat, wake }; continue; }
      await deleteHeartbeat(this.bridge, heartbeat.id).catch(() => {});
    }
    return found;
  }

  private async checkOne(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry || !PENDING_RESUME.has(entry.status)) return;
    const now = this.now(), wake = Date.parse(entry.wakeAt);
    if (!entry.scheduleId) { await this.retry(entry, null, entry.reason ?? "error", now); return; }
    // Long before its wake nothing can have run: a look every 10 minutes notices a heartbeat deleted or paused in Paseo, and the
    // user carrying on by hand.
    if (now < wake - 2 * MINUTE && now - (this.inspectedAt.get(agentId) ?? -Infinity) < 10 * MINUTE) return;
    let heartbeat: Heartbeat | null;
    try { heartbeat = await inspectHeartbeat(this.bridge, entry.scheduleId); } catch { return; } // unreachable for now: the next minute
    await this.judge(entry, heartbeat, now);
  }

  /**
   * The resume's heartbeat as the host has it now, just read, decides (`checkOne`; a retry's own heartbeat whose answer was lost,
   * `retry`): deleted or changed in 计划, its runs, paused, completed, a wake missed or moved. Who moved a wake is read from its rule
   * (`sameRule`, codex-obs-resume-recheck10-F1): changed since the ledger made or took it up, the user did, and their time is
   * followed, never judged missed by the old one (codex-obs-resume-recheck9-F1); the same rule at a later time, the host did (a
   * restart pushed a missed wake to its cron's next match, a month out), and that or a wake let pass is tried again.
   */
  private async judge(entry: ResumeEntry, heartbeat: Heartbeat | null, now: number): Promise<void> {
    const agentId = entry.agentId;
    this.inspectedAt.set(agentId, now);
    // Gone: the user deleted it in 计划. (A delete of the ledger's own whose answer and the read after it were both lost reads the
    // same; that double failure is a known limit, as it was live, codex-obs-resume-recheck13.)
    if (!heartbeat) { await this.update(entry, { status: "canceled", reason: "deleted" }); return; }
    // Changed in Paseo's 计划 since (another prompt, more runs, another Agent or name; codex-obs-resume-F4): no longer a resume, so
    // never taken as one going in, tried again or deleted. The user's to keep as they made it; the ledger lets go of it.
    if (!this.owns(heartbeat, agentId)) { await this.update(entry, { status: "canceled", reason: "edited" }); return; }
    if (heartbeat.name) this.names.set(agentId, heartbeat.name);
    const done = heartbeat.runs.find(run => run.status === "succeeded");
    if (done) { await this.deliver(entry, heartbeat, done.startedAt); return; }
    const running = heartbeat.runs.find(run => run.status === "running");
    if (running) {
      // The run lasts the whole turn (and the load before it): 已续跑 early only on proof (its prompt in the session's log),
      // otherwise its end decides. A turn seen meanwhile may be anyone's (codex-obs-resume-recheck-F1); if the user's message or a
      // system notification took the Agent first, the run fails as busy and the retry reads whether the user carried on (F3).
      if (await this.evidence(agentId, heartbeat, running, "look") === "found") { await this.deliver(entry, heartbeat, running.startedAt); return; }
      if (entry.status !== "waking") await this.update(entry, { status: "waking" });
      return;
    }
    const failure = heartbeat.runs.filter(run => run.status === "failed").at(-1);
    if (failure) { await this.failed(entry, heartbeat, failure, now); return; }
    if (heartbeat.status === "paused") { await this.update(entry, { status: "canceled", reason: "paused" }); return; }
    // Completed without a run: its expiry passed while the host was down, or the Agent was archived (retry reads which).
    if (heartbeat.status === "completed") { await this.retry(entry, heartbeat, "missed", now); return; }
    let wake = Date.parse(entry.wakeAt);
    if (!sameRule(heartbeat.cron, entry.cadence)) {
      // Its rule changed in 计划 since the ledger made or took it up (codex-obs-resume-recheck10-F1): the user's, whatever an earlier
      // wake still matches. Their time is followed wherever it is, never judged missed by an earlier one nor tried again in its
      // place while the heartbeat waits: it wakes the Agent when they said. Past the retry window a run that fails is not tried
      // again; past the heartbeat's own expiry (the window's end, unless they moved that too) the host completes it unrun, and
      // the resume ends as 未能续跑.
      if (heartbeat.nextRunAt !== null && !sameMinute(heartbeat.nextRunAt, wake)) { entry = await this.update(entry, { wakeAt: iso(heartbeat.nextRunAt) }); wake = heartbeat.nextRunAt; }
    } else if (heartbeat.nextRunAt === null || heartbeat.nextRunAt > wake + RESUME_MISSED_GRACE_MS || now > wake + RESUME_MISSED_GRACE_MS) {
      // Its own rule at a later time, or a wake let pass: the host's doing (a restart moves a missed wake to the cron's next match,
      // a month out). Tried again.
      await this.retry(entry, heartbeat, "missed", now);
      return;
    }
    // Not due yet: the user may have carried on by hand since it stopped (F3). Not in the last half minute, while the host may be firing it.
    if (heartbeat.nextRunAt !== null && heartbeat.nextRunAt - now > 30_000) await this.settled(entry, heartbeat);
  }

  /**
   * A run that failed (F1). The host's own words for this Agent say how (`hostFailure`): after the prompt (a pending
   * permission, a failed turn with no reply) it is 已续跑; a restart needs proof (`restarted`). Otherwise the session's log
   * decides first (`evidence`, codex-obs-resume-recheck2-F1): this very run's prompt in it is 已续跑 whatever the error says,
   * since after the prompt the error is the Agent's last reply, any text, the host's own errors word for word included. So
   * those errors, from before the prompt, count only once the log, read whole, proves the prompt is not there
   * (codex-obs-resume-recheck3-F1): then busy or a load the host timed out is tried again, gone, archived or an ACP session that
   * cannot be loaded again is 未能续跑. Without that proof (a provider whose prompts no log the plugin reads keeps, Grok or ACP;
   * a log that cannot be read or was lost) nothing is tried again: the resume is moot once the user has carried on or the Agent is
   * gone or archived (`settled`), else 未能确认 (the card offers 重新安排). Any other text is 未能确认 too. A turn seen while the run
   * went is no proof (codex-obs-resume-recheck-F1). With nothing to read the Agent with yet (no RPC or hook has lent a context
   * since the plugin started), or logs not scanned since the run ended ("pending", codex-obs-resume-recheck5-F2), a later check
   * decides, within the window.
   */
  private async failed(entry: ResumeEntry, heartbeat: Heartbeat, failure: HeartbeatRun, now: number): Promise<void> {
    const host = hostFailure(failure.error, entry.agentId);
    if (host === "prompted") return this.deliver(entry, heartbeat, failure.startedAt);
    if (host === "restart") return this.restarted(entry, heartbeat, failure, now);
    if (!this.paseo && now <= Date.parse(entry.plannedAt) + RESUME_WINDOW_MS) return;
    const agent = await this.agentState(entry.agentId);
    const seen = agent && !agent.missing ? await this.evidence(entry.agentId, heartbeat, failure, "decide", agent) : "unknown";
    if (seen === "found") return this.deliver(entry, heartbeat, failure.startedAt);
    if (seen === "pending" && now <= Date.parse(entry.plannedAt) + RESUME_WINDOW_MS) return;
    if (seen === "absent") {
      if (host === "busy") return this.retry(entry, heartbeat, "busy", now);
      if (host === "load-timeout") return this.retry(entry, heartbeat, "error", now);
      if (host === "gone" || host === "archived") { await this.finish(entry, heartbeat, { status: "failed", reason: host }); return; }
      // An ACP session the provider cannot load again: this Agent can never be woken.
      if (host === "no-resume") { await this.finish(entry, heartbeat, { status: "failed", reason: "error" }); return; }
    }
    if (host !== null && agent && await this.settled(entry, heartbeat, agent)) return;
    await this.finish(entry, heartbeat, { status: "failed", reason: "unsure" });
  }

  /**
   * A daemon restart cut the run short (codex-obs-resume-F2). The host writes the same error whether that came while it was
   * loading the Agent, before any prompt, or in the middle of the resumed turn, and a turn_started the plugin never got (it was
   * reloading, or went down with the daemon) proves nothing. So: 已续跑 on proof read without loading the Agent (`evidence`); 你已接着做
   * when the user has carried on since the stop; otherwise 未能确认, never sent again on its own (the card asks to look at the
   * session first and offers 重新安排). Attention raised since proves nothing either: another turn may have raised it, or the
   * user marking the session unread (codex-obs-resume-recheck-F1). With nothing to read with yet (right after the restart no
   * RPC or hook has lent a context), or logs not scanned since the run ended, a later check decides, within the window.
   */
  private async restarted(entry: ResumeEntry, heartbeat: Heartbeat, run: HeartbeatRun, now: number): Promise<void> {
    const agent = await this.agentState(entry.agentId), within = now <= Date.parse(entry.plannedAt) + RESUME_WINDOW_MS;
    if (!agent && within) return;
    const seen = agent && !agent.missing ? await this.evidence(entry.agentId, heartbeat, run, "decide", agent) : "unknown";
    if (seen === "found") return this.deliver(entry, heartbeat, run.startedAt);
    if (seen === "pending" && within) return;
    if (agent && await this.settled(entry, heartbeat, agent)) return;
    await this.finish(entry, heartbeat, { status: "failed", reason: "restart-unsure" });
  }
  /**
   * What the provider's own session log says of this run's prompt, tied to this very run (codex-obs-resume-recheck-F1): the
   * prompt itself, found by the ids the host wrote into it (`Schedule "<name>" fired (id=<scheduleId>, run=<runId>).`), where
   * Claude Code, Codex and Pi write each prompt as it is sent. The host keeps no copy to read (it drops such prompts from the
   * timeline, and reading that would load the Agent), and a turn's hook names no prompt. "found" proves it went in; "absent"
   * that it did not, only when the session's logs, scanned since the run ended, can be vouched for and each was read whole,
   * unchanged, without it (codex-obs-resume-recheck3-F1, recheck4-F1, recheck5-F1); "pending" while they have not been scanned
   * since (the ledger scans every 30 s: a later check asks again, codex-obs-resume-recheck5-F2); anything else is "unknown": no
   * logs, no session, ids not of the host's form, a provider whose prompts no log the plugin reads keeps (Grok, ACP), a scan cut
   * short, a log lost, unreadable, still changing or rewritten. `how`: "look" while the run goes (only "found" counts: the logs'
   * tails, at most every two minutes in its first half hour); "find" whole logs, where only "found" counts (a cancel); "decide"
   * the run's end (whole logs, all four answers).
   */
  private async evidence(agentId: string, heartbeat: Heartbeat, run: HeartbeatRun, how: "look" | "find" | "decide", known?: AgentState | null): Promise<MarkerEvidence> {
    if (!this.logs || !HOST_ID.test(heartbeat.id) || !HOST_ID.test(run.id)) return "unknown";
    const now = this.now(), missed = this.markerMisses.get(run.id);
    if (how === "look" && (now - run.startedAt > 30 * MINUTE || (missed !== undefined && now - missed < 2 * MINUTE))) return "unknown";
    const agent = known ?? await this.agentState(agentId);
    if (!agent?.sessionId) return "unknown";
    const options = how === "look" ? {} : how === "find" ? { whole: true } : { run: { startedAt: run.startedAt, endedAt: run.endedAt ?? now } };
    const seen = await this.logs.findMarker([agent.sessionId], `fired (id=${heartbeat.id}, run=${run.id}).`, options).catch((): MarkerEvidence => "unknown");
    if (seen === "found") this.markerMisses.delete(run.id);
    else { this.markerMisses.delete(run.id); this.markerMisses.set(run.id, now); while (this.markerMisses.size > 200) this.markerMisses.delete(this.markerMisses.keys().next().value!); }
    return seen;
  }

  /**
   * Replaces `heartbeat` with a new one-off heartbeat within the window (10 minutes on for a busy Agent or a load error, 2 for a
   * missed wake); 未能续跑 once the window is over. Nothing is sent once the resume is moot (`settled`). Without a heartbeat in the
   * record (`scheduleId` null: a create whose answer was lost, the first one's included, or one that failed) it looks for the one
   * the host may have made (`made`); a retry's not made is made again, a first one never is (codex-obs-resume-recheck12).
   */
  private async retry(entry: ResumeEntry, heartbeat: Heartbeat | null, reason: ResumeReason, now: number): Promise<void> {
    const windowEnd = Date.parse(entry.plannedAt) + RESUME_WINDOW_MS, attempt = entry.scheduleId ? entry.attempt + 1 : entry.attempt;
    // A resume's first heartbeat is scheduled, each retry's retrying.
    const state: Finish = attempt > 1 ? { status: "retrying", reason } : { status: "scheduled", reason: null };
    // Kept as one to create, from this pass on (`attemptAt`: a heartbeat made before it is not this attempt's, `made`): the next check
    // tries again until the window is over. Its wake stays the time last asked of the host, where a heartbeat whose answer was lost
    // would wake it (so that turn still counts, noteTurn).
    const later = (at: number, identity: string | null = entry.identity ?? null) => this.update(entry, { ...state, scheduleId: null, attempt, wakeAt: iso(at), attemptAt: iso(now), ...(identity === null && entry.identity === undefined ? {} : { identity: identity ?? undefined }) });
    // One schedule/list serves the rest: the heartbeat the host made for this one while its answer was lost, this Agent's own
    // one still waiting, and the minutes other heartbeats wake in (F2). A list that fails, or a heartbeat of this Agent's that
    // cannot be read, leaves it to the next check.
    let listed: Heartbeat[] | null = null;
    if (!entry.scheduleId) {
      // Its create went out and the answer never came back (a timeout, the plugin session reconnecting), so the host may have made
      // it (F4); or the create failed. Only who it is comes from the list (`made`); read, it is judged as a check judges the
      // resume's heartbeat, paused, its runs, a moved wake and the user carrying on included (codex-obs-resume-recheck9-F1,
      // recheck12-F3), whatever the window says (one that ran or still waits is never left behind). A list or read that fails
      // leaves it as it is, still to be confirmed and its attempt's start kept, for the next check.
      let made: Heartbeat | "absent" | "ambiguous", current: Heartbeat | null = null;
      try { listed = await listHeartbeats(this.bridge); made = this.made(entry, listed); if (typeof made === "object") current = await inspectHeartbeat(this.bridge, made.id); }
      catch (error) { this.log(t("serverResume.m054", { value1: errorText(error) })); return; }
      if (typeof made === "object") { await this.judge(await this.update(entry, { ...state, scheduleId: made.id, attempt, cadence: resumeCron(Date.parse(entry.wakeAt)) }), current, now); return; }
      // None yet: the host lists no create still being written to its store, which a timeout leaves going
      // (codex-obs-resume-recheck11-F3). So it is looked for again for a while: a first one's two minutes from its request, a
      // retry's until two minutes before its wake, when one made then still wakes the Agent on time.
      if (made === "absent" && now < (attempt > 1 ? Date.parse(entry.wakeAt) - 2 * MINUTE : Date.parse(entry.createdAt) + 2 * MINUTE)) return;
      // More than one that could be it (or one that is not a resume heartbeat), or a first one still not there: never guessed at,
      // made again or deleted (codex-obs-resume-recheck12, recheck13-F2): 未能确认, and the user looks in 计划 (the card offers
      // 重新安排). A retry's not there is made again.
      if (made === "ambiguous" || attempt === 1) { await this.update(entry, { status: "failed", reason: "unsure", scheduleId: null }); return; }
    }
    if (await this.settled(entry, heartbeat)) return;
    // The heartbeat it replaces goes first: a live one could still fire (two prompts); a host tick holding an older list could
    // run a finished one again (F2), so one that will not go now is deleted later. With no room to keep it, the retry waits for
    // the next check rather than forget it (codex-obs-resume-recheck9-F2). A delete whose answer was lost and that went through
    // counts (`removeHeartbeat`).
    if (heartbeat) {
      try { await removeHeartbeat(this.bridge, heartbeat.id); } catch { if (heartbeat.status !== "completed" || !this.track(heartbeat.id, entry.agentId)) return; }
    }
    // A retry still to be created keeps its own time when that is still ahead.
    const base = entry.scheduleId ? Math.ceil((now + (reason === "busy" || reason === "error" ? RESUME_BUSY_RETRY_MS : RESUME_MISSED_RETRY_MS)) / MINUTE) * MINUTE
      : Math.max(Date.parse(entry.wakeAt), Math.ceil((now + MINUTE) / MINUTE) * MINUTE);
    const expired = () => this.update(entry, { status: "failed", reason: "expired", ...(heartbeat ? {} : { scheduleId: null }) });
    if (base > windowEnd - MINUTE) { await expired(); return; }
    // Else this Agent's own heartbeat still waiting within the window is taken up (`waitingOwn`, which deletes the dead ones):
    // never one with a run going, such as an earlier resume's still running after its delivery, whose prompt is not this retry's.
    let claimed: (Heartbeat & { wake: number }) | null;
    try { listed ??= await listHeartbeats(this.bridge); claimed = await this.waitingOwn(listed.filter(other => other.id !== heartbeat?.id), entry.agentId, now, windowEnd); }
    catch (error) { this.log(t("serverResume.m055", { value1: errorText(error) })); await later(entry.scheduleId ? base : Date.parse(entry.wakeAt)); return; }
    if (claimed) {
      if (claimed.name) this.names.set(entry.agentId, claimed.name);
      await this.update(entry, { ...state, scheduleId: claimed.id, attempt, wakeAt: iso(claimed.wake), cadence: ruleOf(claimed.cron) });
      return;
    }
    // The same allocator as a first wake (codex-obs-resume-F1); made or not, the waiting entry holds the minute afterwards (a
    // retry still to be created keeps it as its wake, `later`).
    const at = this.hold(base, listed, entry.agentId);
    try {
      if (at > windowEnd - MINUTE) { await expired(); return; }
      const name = resumeName(null, attempt), known = this.names.get(entry.agentId)?.replace(/(?:（第 \d+ 次）| \(attempt \d+\))$/, ""); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
      const title = known ? `${known}${attempt > 1 ? t("serverResume.m056", { attempt: attempt }) : ""}` : name;
      // On disk before the create goes out, its attempt's start with it (codex-obs-resume-recheck13-F2): its answer lost, or the
      // plugin reloaded meanwhile, the next check finds what it made by that time (`made`).
      const prompt = RESUME_PROMPT, identity = generatedIdentity(title, prompt);
      const sent = await later(at, identity ?? null);
      const created = await createHeartbeat(this.bridge, { agentId: entry.agentId, at, name: title, prompt, expiresAt: Math.max(windowEnd, at + 10 * MINUTE) }, this.zone(), now)
        .catch((error): { ok: false; message: string } => ({ ok: false, message: errorText(error) }));
      if (!created.ok) { this.log(t("serverResume.m057", { value1: created.message })); return; }
      this.names.set(entry.agentId, title);
      await this.update(sent, { scheduleId: created.id, wakeAt: iso(created.nextRunAt), cadence: resumeCron(at) });
    } finally { this.release(at); }
  }

  /**
   * The heartbeat the host may have made for a resume still to be confirmed, its create's answer lost (F4): the one for this Agent
   * the host made since this attempt began (`attemptAt`, the first attempt's being the request, codex-obs-resume-recheck13-F2), so
   * an earlier attempt's, or one the user made and ran meanwhile, is never taken for it. Told by that, not by its name, prompt or
   * title, which the user can change (an Agent's title can end in 第 N 次 itself, recheck12-F3); and it has to be a resume heartbeat:
   * one that is not may be the user's, made while this attempt's was not, as unsure as two. "absent": none yet; "ambiguous": more
   * than one, or one not a resume heartbeat, never guessed at. A retry recorded without `attemptAt` (the live ledger's, dcf049d)
   * began at a time unknown: the resume's start would take for it one the user made and ran meanwhile, so any is ambiguous
   * (codex-obs-resume-recheck14-F1); a first attempt's start is the request.
   */
  private made(entry: ResumeEntry, listed: readonly Heartbeat[]): Heartbeat | "absent" | "ambiguous" {
    const since = Date.parse(entry.attemptAt ?? entry.createdAt), known = entry.attemptAt !== undefined || entry.attempt === 1;
    const mine = listed.filter(heartbeat => heartbeat.agentId === entry.agentId && (heartbeat.createdAt ?? -Infinity) >= since);
    return known && mine.length === 1 && this.owns(mine[0]!, entry.agentId) ? mine[0]! : mine.length ? "ambiguous" : "absent";
  }

  /**
   * Whether the resume is moot, settled here: the Agent gone or archived (未能续跑), or the user has messaged it since it stopped
   * (F3: lastUserMessageAt, which a scheduled prompt never sets) → 已取消 (resumed), its heartbeat deleted first, so it is not
   * prompted twice. A heartbeat that cannot be deleted now leaves it to the next check, moot all the same: no retry goes ahead.
   * Read without loading it (`known`: just read). Without a context to read with yet, it is not moot: the user's own message
   * would have lent one (agent.turn_started).
   */
  private async settled(entry: ResumeEntry, heartbeat: Heartbeat | null, known?: AgentState): Promise<boolean> {
    const agent = known ?? await this.agentState(entry.agentId);
    if (!agent) return false;
    if (agent.missing || agent.archived) { await this.finish(entry, heartbeat, { status: "failed", reason: agent.missing ? "gone" : "archived" }); return true; }
    if (agent.userAt === null || agent.userAt <= Date.parse(entry.stopAt ?? entry.createdAt)) return false;
    // A heartbeat that could still fire must be gone before the resume reads as canceled; a delete whose answer was lost and that
    // went through counts (`removeHeartbeat`), as the user carrying on, never the user deleting it.
    const live = heartbeat?.status === "active" && !heartbeat.runs.some(run => run.status === "running");
    if (live) { try { await removeHeartbeat(this.bridge, heartbeat.id); } catch { return true; } }
    await this.finish(entry, live ? null : heartbeat, { status: "canceled", reason: "resumed" });
    return true;
  }

  private async deliver(entry: ResumeEntry, heartbeat: Heartbeat, at: number): Promise<void> {
    await this.finish(entry, heartbeat, { status: "delivered", reason: null }, { deliveredAt: iso(at) });
  }
  /**
   * A resume the ledger is done with: its heartbeat goes too (`retire`). False when that heartbeat has to wait for a delete and
   * there is no room to keep it (codex-obs-resume-recheck9-F2): the resume stays as it is, still naming it, and the next check
   * ends it again.
   */
  private async finish(entry: ResumeEntry, heartbeat: Heartbeat | null, end: Finish, extra: Partial<Pick<ResumeEntry, "deliveredAt">> = {}): Promise<boolean> {
    if (heartbeat && !(await this.retire(entry.agentId, heartbeat))) return false;
    await this.update(entry, { ...end, ...extra });
    return true;
  }
  /**
   * Deletes a heartbeat the ledger is done with, finished runs and all (F2): a host tick holding a list read before the run can
   * run a finished one-off heartbeat again, and a manual run (Paseo's 立即运行) leaves it active. One still running goes once its
   * run ends (the next checks; its turn's end looks at once); one paused in Paseo is the user's to keep. A delete whose answer was
   * lost and that went through counts (`removeHeartbeat`). False when it has to be kept to delete and there is no room (`track`).
   */
  private async retire(agentId: string, heartbeat: Heartbeat): Promise<boolean> {
    if (heartbeat.status === "paused") return true;
    if (!heartbeat.runs.some(run => run.status === "running")) {
      try { await removeHeartbeat(this.bridge, heartbeat.id); this.tidy.delete(heartbeat.id); return true; } catch { /* tried again at the next check */ }
    }
    return this.track(heartbeat.id, agentId);
  }
  /** Whether a heartbeat can be kept to delete: it already is, or `tidy` has room. */
  private room(id: string | null): boolean { return !id || this.tidy.has(id) || this.tidy.size < TIDY_LIMIT; }
  /**
   * Keeps a heartbeat to delete (`tidy`) if there is room (`keep`). Never makes room by dropping one (codex-obs-resume-recheck9-F2):
   * false when full, and the caller keeps the duty where it was.
   */
  private track(id: string, agentId: string): boolean {
    if (!this.room(id)) return false;
    this.keep(id, agentId);
    return true;
  }
  /** Keeps a heartbeat to delete, saved with the next write of the ledger. */
  private keep(id: string, agentId: string): void {
    this.tidy.delete(id); this.tidy.set(id, agentId);
    const entry = this.entries.get(agentId);
    if (entry?.scheduleId === id && entry.identity) this.tidyIdentities.set(id, entry.identity);
  }
  private async tidyOne(id: string, agentId: string): Promise<void> {
    if (!this.tidy.has(id)) return;
    let heartbeat: Heartbeat | null;
    try { heartbeat = await inspectHeartbeat(this.bridge, id); } catch { return; }
    const done = () => { this.tidy.delete(id); this.tidyIdentities.delete(id); return this.persist(); };
    // Changed in Paseo since the ledger was done with it (codex-obs-resume-F4): the user's now, never deleted.
    if (heartbeat && !this.owns(heartbeat, agentId)) return done();
    if (heartbeat?.runs.some(run => run.status === "running")) return;
    if (heartbeat && heartbeat.status !== "paused") { try { await deleteHeartbeat(this.bridge, id); } catch { return; } }
    return done();
  }

  /** The Agent as the host records it, by a read that never loads it; null without a context or when the read failed. */
  private async agentState(agentId: string): Promise<AgentState | null> {
    const paseo = this.paseo;
    if (!paseo) return null;
    try {
      const current = await paseo.agents.ref(agentId).refresh();
      if (!current?.agent) return { missing: true, archived: false, userAt: null, sessionId: null };
      const user = Date.parse(current.agent.lastUserMessageAt ?? "");
      return { missing: false, archived: !!current.agent.archivedAt, userAt: Number.isFinite(user) ? user : null, sessionId: current.agent.persistence?.sessionId?.slice(0, 256) || null };
    } catch { return null; }
  }

  /** Whether `ms` have passed since now (a request's time to start a change, `CANCEL_START_MS`). */
  private deadline(ms: number): () => boolean { const end = this.now() + ms; return () => this.now() > end; }

  private withAgent<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    const result = previous.then(run, run);
    const settled = result.then(() => {}, () => {});
    this.locks.set(agentId, settled);
    void settled.then(() => { if (this.locks.get(agentId) === settled) this.locks.delete(agentId); });
    return result;
  }

  private async update(entry: ResumeEntry, patch: Partial<Pick<ResumeEntry, "scheduleId" | "attempt" | "status" | "reason" | "wakeAt" | "deliveredAt" | "cadence" | "attemptAt" | "identity">>): Promise<ResumeEntry> {
    const next: ResumeEntry = { ...entry, ...patch, updatedAt: iso(this.now()) };
    await this.put(next);
    return { ...next };
  }
  private async put(entry: ResumeEntry): Promise<void> {
    // A resume replacing one that ended: that one's heartbeat may still be there (its run going, or a delete that failed before a
    // reload lost track of it), and nothing would refer to it any more. It is kept to delete (codex-obs-resume-recheck8-F2), unless
    // it is surely gone (cancelled here or deleted in Paseo) or the user's (changed or paused in Paseo). Kept even past TIDY_LIMIT:
    // the record replacing it names a heartbeat 安排续跑 has just made or taken up, which a refusal would leave unrecorded (a second
    // prompt once the user asks again). Only a request under way gets here without room (a cancel makes sure of it first), one
    // heartbeat each, so `tidy` stays within TIDY_HARD_LIMIT.
    const replaced = this.replaced(entry);
    if (replaced) this.keep(replaced, entry.agentId);
    this.entries.set(entry.agentId, entry);
    this.trim();
    this.arm();
    await this.persist();
  }
  /** The heartbeat of the Agent's ended resume that `entry` would replace, still owed a delete as far as the ledger knows (`put`). */
  private replaced(entry: ResumeEntry): string | null {
    const previous = this.entries.get(entry.agentId);
    return previous && previous.scheduleId !== entry.scheduleId && owesDelete(previous) ? previous.scheduleId : null;
  }
  /**
   * Finished resumes leave after 7 days, and past RESUME_LEDGER_LIMIT Agents the oldest finished ones go first. A waiting one never
   * goes (codex-obs-resume-recheck9-F2, self-check): its heartbeat would wake the Agent with nothing to check, retry or delete it
   * after; 安排续跑 takes no new one past the limit instead. A finished one owes nothing: its heartbeat is deleted or kept in `tidy`.
   */
  private trim(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (!PENDING_RESUME.has(entry.status) && now - Date.parse(entry.updatedAt) > KEEP_FINISHED_MS) this.entries.delete(id);
    const finished = [...this.entries.values()].filter(entry => !PENDING_RESUME.has(entry.status)).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const entry of finished) { if (this.entries.size <= RESUME_LEDGER_LIMIT) break; this.entries.delete(entry.agentId); }
  }

  /** Checks every minute while a resume waits or a heartbeat waits to be deleted, and not at all otherwise. */
  private arm(): void {
    const wanted = this.timers && !this.closed && (this.pending().length > 0 || this.tidy.size > 0);
    if (wanted && !this.timer) { this.timer = setInterval(() => void this.check(), this.checkMs); this.timer.unref?.(); }
    if (!wanted && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  private checkSoon(delay: number): void {
    if (!this.timers || this.closed || this.soon) return;
    this.soon = setTimeout(() => { this.soon = null; void this.check(); }, delay);
    this.soon.unref?.();
  }

  private async load(): Promise<void> {
    try {
      if ((await stat(this.file)).size > LEDGER_MAX_BYTES) throw new Error("too large");
      const data = fileSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      for (const raw of data.entries) {
        const parsed = resumeEntrySchema.safeParse(raw);
        if (!parsed.success) continue;
        // A waiting resume from before the rule was kept (codex-obs-resume-recheck10-F1). Its rule is known only while the record
        // still holds the time first confirmed, on its first heartbeat (attempt 1, wakeAt = plannedAt): the cron the ledger makes for
        // that time, so a heartbeat it made reads as made (a restart's move is still tried again), and one in any other rule (a 2.13
        // one in a device's zone, one taken up as the user left it or changed since) as changed: followed, never deleted. Any other
        // has none known (null): its wake may be one 2.14.0 followed to the user's time, or one a retry took up as it was
        // (codex-obs-resume-recheck11-F4), so it is followed wherever it goes, never judged missed by that time nor deleted.
        const legacy = parsed.data;
        const entry = legacy.cadence === undefined && PENDING_RESUME.has(legacy.status)
          ? { ...legacy, cadence: legacy.attempt === 1 && legacy.wakeAt === legacy.plannedAt ? resumeCron(Date.parse(legacy.wakeAt)) : null } : legacy;
        const previous = this.entries.get(entry.agentId);
        if (!previous || Date.parse(entry.updatedAt) > Date.parse(previous.updatedAt)) this.entries.set(entry.agentId, entry);
      }
      // Every item: a broken one is skipped, never the ledger, and none is dropped past TIDY_LIMIT (codex-obs-resume-recheck9-F2).
      if (Array.isArray(data.tidy)) for (const raw of data.tidy) { const parsed = tidySchema.safeParse(raw); if (parsed.success) { this.tidy.set(parsed.data.id, parsed.data.agentId); if (parsed.data.identity) this.tidyIdentities.set(parsed.data.id, parsed.data.identity); } }
      // A file from before 2.14.0's reload fix keeps none: an ended resume's heartbeat may still be there (its run went on, or its
      // delete failed, and a reload lost that), so each one's is kept to delete before old records leave (`trim`); `tidyOne`
      // reads it first, and one gone, deleted or the user's leaves again.
      else for (const entry of this.entries.values()) if (owesDelete(entry)) this.keep(entry.scheduleId!, entry.agentId);
      this.trim();
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") { this.corrupt = true; this.error = t("serverResume.m058"); }
    }
  }
  /**
   * Writes the whole ledger as it is in memory when asked, after the writes asked before it. Memory is the ledger: nothing in it is
   * ever taken back, so the snapshot of one Agent's write never carries another's change that does not stand, and a write that
   * fails is made good by the next one (codex-obs-resume-recheck13-F1).
   */
  private persist(): Promise<void> {
    const serialized = JSON.stringify({ version: 1, entries: [...this.entries.values()], tidy: [...this.tidy].map(([id, agentId]) => ({ id, agentId, ...(this.tidyIdentities.has(id) ? { identity: this.tidyIdentities.get(id) } : {}) })) });
    // Never a file `load` would refuse, which would start the ledger over and lose all it owes (codex-obs-resume-recheck9-F2). The
    // limits (RESUME_LEDGER_LIMIT Agents, TIDY_HARD_LIMIT heartbeats) keep what the ledger writes under it, three-byte text in every
    // field at its longest included (about 830 KB); text JSON escapes (six bytes a character), or a file read in past the limits,
    // could still pass it.
    if (Buffer.byteLength(serialized) > LEDGER_MAX_BYTES) { this.error = t("serverResume.m059"); return this.writes; }
    this.writes = this.writes.then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await ensurePrivateDirectory(this.directory);
        if (this.corrupt) { await rename(this.file, `${this.file}.backup`).catch(() => {}); this.corrupt = false; }
        await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, this.file); this.error = null;
      } catch { this.error = t("serverResume.m060"); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    return this.writes;
  }
}

export interface RegisterResumeOptions extends ResumeLedgerOptions {
  /** `$PASEO_HOME` for the provider bases (tests). */ home?: string;
  /** A device's zone, as the schedule request reports it (DeviceZone.note). */ noteZone?: (zone: string) => void;
}
/**
 * 恢复后续跑's RPCs (schedule, the ledger's real state, cancel) and the provider bases the stop card maps a provider to its
 * usage source with. The lifecycle hooks lend the ledger their context for background reads; a turn starting (with its turn
 * id) is the evidence a heartbeat's prompt went in unless the user's own message opened it (noteTurn, F1, codex-obs-resume-F3),
 * a turn ending looks at a resume that is due. They never touch the hook input, and never hold up the other handlers: the
 * ledger works after they return. `logs`: the provider session logs, the evidence a restart can leave (codex-obs-resume-F2).
 */
export function registerResume(server: PluginServerContext, bridge: Bridge, options: RegisterResumeOptions = {}): { ledger: ResumeLedger; close(): Promise<void> } {
  const ledger = new ResumeLedger(bridge, options);
  const bases = providerBasesReader({ home: options.home });
  server.handle(scheduleResume, (input, { paseo }) => { if (input.timeZone) options.noteZone?.(input.timeZone); return ledger.schedule(paseo, input); });
  server.handle(getResumes, (input, { paseo }) => { ledger.notePaseo(paseo); return ledger.read(input); });
  server.handle(cancelResume, (input, { paseo }) => ledger.cancel(paseo, input));
  server.handle(getProviderBases, async () => ({ bases: await bases() }));
  const removers = [
    server.on("agent.turn_started", ({ agent }, { paseo }) => { ledger.notePaseo(paseo); void ledger.noteTurn(agent.id).catch(() => {}); }),
    server.on("agent.turn_ended", ({ agent }, { paseo }) => { ledger.notePaseo(paseo); ledger.nudge(agent.id); }),
  ];
  return { ledger, async close() { for (const remove of removers) remove(); await ledger.close(); } };
}

export type { ResumeStatus };

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  SCHEDULE_TOO_LATE = t("serverResume.m001");
});
