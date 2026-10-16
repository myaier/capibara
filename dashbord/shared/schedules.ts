import { joinList, onTextChange } from "./i18n";
import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { completionReadState, type AgentRecord } from "./model";
import { withoutUserinfo } from "./change-request";

/**
 * 定时运行: every run of every Paseo schedule on this host, joined with the Agent and workspace it produced.
 * Pure helpers here are shared by the server index and the native/web client.
 */
export const RUN_STATUSES = ["running", "succeeded", "failed", "unknown"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const runStatusSchema = z.enum(RUN_STATUSES);
/** `schedule`: the live schedule file · `ledger`: kept by the observatory after the file was deleted · `agent`: rebuilt from Agent labels only. */
export const runSourceSchema = z.enum(["schedule", "ledger", "agent"]);
export type RunSource = z.infer<typeof runSourceSchema>;

export const runLinkSchema = z.object({ url: z.string().max(2000), label: z.string().max(24), kind: z.enum(["mr", "pr"]), state: z.enum(["open", "merged", "closed"]).nullable() });
export type RunLink = z.infer<typeof runLinkSchema>;

export const scheduleRunRowSchema = z.object({
  id: z.string().max(120), scheduleId: z.string().max(80), scheduleName: z.string().max(200),
  kind: z.enum(["new-agent", "heartbeat"]), status: runStatusSchema, source: runSourceSchema,
  scheduledFor: z.string().nullable(), startedAt: z.string(), endedAt: z.string().nullable(),
  /** First lines of the recorded final reply, Markdown stripped; the full text is read on demand. */
  preview: z.string().max(400).nullable(), hasOutput: z.boolean(), error: z.string().max(2000).nullable(),
  agent: z.object({ id: z.string().max(256), title: z.string().max(240).nullable(), status: z.string().max(40).nullable(), archivedAt: z.string().nullable(), known: z.boolean(),
    /** false: only Paseo's record still has it — its project was removed, so the host no longer lists it nor opens its session or workspace. */
    listed: z.boolean().optional() }).nullable(),
  workspace: z.object({ id: z.string().max(256), name: z.string().max(240).nullable(), branch: z.string().max(240).nullable(), archivedAt: z.string().nullable() }).nullable(),
  projectName: z.string().max(240).nullable(), link: runLinkSchema.nullable(),
});
export type ScheduleRunRow = z.infer<typeof scheduleRunRowSchema>;

export const scheduleSummarySchema = z.object({
  id: z.string().max(80), name: z.string().max(200), kind: z.enum(["new-agent", "heartbeat"]),
  status: z.enum(["active", "paused", "completed", "deleted"]), cadence: z.string().max(160),
  /** IANA zone a cron cadence runs in (Paseo's default is UTC); null for intervals and unknown schedules. */
  timezone: z.string().max(80).nullable(),
  /** What it runs against: the heartbeat's Agent title, or the working directory's name. */
  target: z.string().max(240).nullable(),
  nextRunAt: z.string().nullable(), lastRunAt: z.string().nullable(), provider: z.string().max(120).nullable(),
  /** Up to the last 10 run statuses, oldest first: the health strip. */
  recent: z.array(runStatusSchema).max(10), total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
  /** The raw cron (null for intervals): a fixed date in it is the wall date a one-shot's local time is compared with. */
  expression: z.string().max(120).nullable().optional(),
  /** Paseo completes the schedule after this many finished runs; 1 is a one-shot. */
  maxRuns: z.number().int().positive().nullable().optional(),
  /** A one-shot's absolute time: its next run, or when its last run was due. */
  onceAt: z.string().nullable().optional(),
});
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;

/** 「最近」: the last 30 days, at most 200 runs plus 100 heartbeat runs (a phone's first load stays small). 「全部」: up to 500 + 250. */
export const RUN_WINDOWS = { recent: { days: 30, runs: 200, heartbeats: 100 }, all: { days: null, runs: 500, heartbeats: 250 } } as const;
export type RunWindow = keyof typeof RUN_WINDOWS;
const revision = z.string().min(1).max(80);
export const listScheduleRuns = defineRpc({
  name: "observatory.schedules.list",
  /** `query` searches on the server, through each run's full recorded reply (see `normalizeRunQuery`). */
  input: z.object({ revision: revision.optional(), window: z.enum(["recent", "all"]).optional(), query: z.string().max(400).optional() }),
  output: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("full"), unchanged: z.literal(false), revision, generatedAt: z.string(), window: z.enum(["recent", "all"]),
      /** The normalized query the runs were filtered by ("" for none); runs, older and truncated count matches only. */
      query: z.string().max(200).optional(),
      /** Some replies were too long to search in one request: those runs matched on their name, error and links only. */
      searchLimited: z.boolean().optional(),
      schedules: z.array(scheduleSummarySchema).max(400), runs: z.array(scheduleRunRowSchema).max(800),
      /** Runs left out by the window or the cap; 「加载更早」 asks for the 「全部」 window. */
      older: z.number().int().nonnegative(), olderHeartbeats: z.number().int().nonnegative(), truncated: z.boolean(),
      /** The last 7 days over every run (not just the window), split so the 心跳 switch can include heartbeats. */
      week: z.object({ runs: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), heartbeats: z.number().int().nonnegative(), heartbeatsFailed: z.number().int().nonnegative() }),
      /** Runs whose schedule file is gone and that only Agent labels still describe. */
      reconstructed: z.number().int().nonnegative(),
      /** The schedules directory could not be read. */ error: z.string().max(500).nullable(),
      /** Ledger trouble worth a quiet banner (reset after corruption, could not save). */ notice: z.string().max(500).nullable() }),
    z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
  ]),
});
export type ScheduleRunsResponse = z.infer<typeof listScheduleRuns.output>;
export type ScheduleRunsState = Extract<ScheduleRunsResponse, { mode: "full" }>;
export function mergeScheduleRuns(previous: ScheduleRunsState | undefined, response: ScheduleRunsResponse): ScheduleRunsState {
  if (response.mode === "full") return response;
  if (!previous) throw new Error(t("sharedSchedules.m001"));
  return previous;
}

/** The full recorded reply of one run, read only when its detail opens. */
export const getScheduleRun = defineRpc({
  name: "observatory.schedules.run",
  input: z.object({ runId: z.string().min(1).max(120) }),
  output: z.object({ runId: z.string(), output: z.string().max(60_000).nullable(), outputTruncated: z.boolean(), prompt: z.string().max(8000).nullable(),
    /** Why the reply is not available (schedule deleted, still running…). */ note: z.string().max(300).nullable(),
    /** The run and its schedule as the feed shows them, for an Agent's 定时任务 card; null when nothing describes the run. */
    row: scheduleRunRowSchema.nullable(), schedule: scheduleSummarySchema.nullable() }),
});
export type ScheduleRunDetail = z.infer<typeof getScheduleRun.output>;

/**
 * A heartbeat (a schedule that prompts an existing Agent) as the Agent it wakes shows it: on its session row
 * (「22:35 唤醒」) and on top of its 结果. Built from the schedule files only; nothing about the Agent is read.
 */
export const heartbeatSummarySchema = z.object({
  scheduleId: z.string().max(80), agentId: z.string().max(256), name: z.string().max(200),
  status: z.enum(["active", "paused", "completed"]), cadence: z.string().max(160), timezone: z.string().max(80).nullable(),
  expression: z.string().max(120).nullable(), maxRuns: z.number().int().positive().nullable(), once: z.boolean(),
  nextRunAt: z.string().nullable(), onceAt: z.string().nullable(),
  /** Runs recorded so far (a running one included); with `maxRuns` this reads 第 2/3 次. */
  runs: z.number().int().nonnegative(),
  lastRun: z.object({ status: runStatusSchema, startedAt: z.string(), endedAt: z.string().nullable(), error: z.string().max(300).nullable() }).nullable(),
});
export type HeartbeatSummary = z.infer<typeof heartbeatSummarySchema>;
/** The heartbeats RPC lists the 500 most relevant heartbeats and names at most 5000 Agents a live one wakes. */
export const HEARTBEAT_LIST_MAX = 500, HEARTBEAT_TARGETS_MAX = 5000;
/**
 * Active and paused heartbeats, and completed ones whose last run is at most 7 days old; unchanged polls are a few bytes. The fields
 * after `heartbeats` are what 归档已读完成 needs to show that a session has no heartbeat (codex-F16); a response without them (an older
 * server) shows nothing of the kind.
 */
export const getScheduleHeartbeats = defineRpc({
  name: "observatory.schedules.heartbeats",
  /** `fresh` reads the schedule files now instead of reusing a build up to 10 minutes old (归档已读完成's second tap). */
  input: z.object({ revision: revision.optional(), fresh: z.boolean().optional() }),
  output: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("full"), unchanged: z.literal(false), revision, generatedAt: z.string(), heartbeats: z.array(heartbeatSummarySchema).max(HEARTBEAT_LIST_MAX),
      /** `heartbeats` left some out (the least relevant). */ truncated: z.boolean().optional(),
      /** The schedules directory or a schedule file could not be read, in one Chinese sentence: whom heartbeats wake is not fully known. */
      error: z.string().max(300).nullable().optional(),
      /** The scan read every schedule file and `targets` names every Agent a live heartbeat wakes. */ complete: z.boolean().optional(),
      /** Every Agent an active or paused heartbeat wakes, beyond the listed ones too: archiving it would complete those heartbeats. */
      targets: z.array(z.string().max(256)).max(HEARTBEAT_TARGETS_MAX).optional() }),
    z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
  ]),
});
export type HeartbeatsResponse = z.infer<typeof getScheduleHeartbeats.output>;
export type HeartbeatsState = Extract<HeartbeatsResponse, { mode: "full" }>;
export function mergeHeartbeats(previous: HeartbeatsState | undefined, response: HeartbeatsResponse): HeartbeatsState {
  if (response.mode === "full") return response;
  if (!previous) throw new Error(t("sharedSchedules.m002"));
  return previous;
}

/**
 * Whether a heartbeat read can show that a session has no heartbeat (codex-F16). Only a successful read of every schedule file can: a
 * failed request, a read error or an incomplete scan leaves it `ready: false` with a Chinese reason for the menu. `targets` are the
 * Agents an active or paused heartbeat wakes; archiving one would complete those heartbeats (Paseo's `completeForAgent`).
 */
export type HeartbeatGuard = { ready: true; targets: ReadonlySet<string> } | { ready: false; reason: string };
export function heartbeatGuard(state: HeartbeatsState | null | undefined, failed = false): HeartbeatGuard {
  if (failed) return { ready: false, reason: t("sharedSchedules.m003") };
  if (!state) return { ready: false, reason: t("sharedSchedules.m004") };
  if (state.error) return { ready: false, reason: state.error };
  if (state.complete !== true || !state.targets) return { ready: false, reason: t("sharedSchedules.m005") };
  const targets = new Set(state.targets);
  for (const heartbeat of state.heartbeats) if (heartbeat.status !== "completed") targets.add(heartbeat.agentId);
  return { ready: true, targets };
}
/** 归档已读完成 waits while the session list is cut short: an Agent below a read session may be among those not loaded. */
export let ARCHIVE_PARTIAL_LIST = t("sharedSchedules.m006");
/** `truncated`: `agents` is not every unarchived Agent (the directory read was cut short, its `truncated`). */
export interface ArchiveListState { truncated?: boolean }
export interface ArchiveOffer {
  candidates: AgentRecord[];
  /** Sessions that would be offered but wait: the heartbeat read cannot be trusted yet, or the session list was cut short. */
  withheld: number;
  /** Why the `withheld` sessions wait, in one Chinese sentence; absent when none do. */
  reason?: string;
  /**
   * Read sessions left out for an Agent below them that has to stay (unread, stopped on a limit, running, not completed or woken by a
   * heartbeat): Paseo archives an archived Agent's children with it and completes their heartbeats.
   */
  sparedForChildren: number;
}
const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "waiting", "initializing"]);
/** A session 归档已读完成 may take on its own account: completed, its result read, no stop to come back for. */
const settledAlone = (agent: AgentRecord) => !agent.archivedAt && agent.status === "completed" && completionReadState(agent) === "read" && !agent.stop;
/**
 * The sessions of `scope` that may go on their own account, with nothing running above them, and `keptBelow`: whether an Agent below
 * one of them must stay. Archiving an Agent makes Paseo archive every unarchived Agent whose parent label names it, in its workspace and
 * without an open tab, and theirs in turn (`cascadeArchiveChildren`), and complete each one's heartbeats (`completeForAgent`). Which
 * children Paseo would only detach (another workspace, an open tab) is not visible here, so every unarchived descendant counts.
 */
function archiveReview(agents: readonly AgentRecord[], scope: readonly AgentRecord[]) {
  const byId = new Map(agents.map(agent => [agent.id, agent])), children = new Map<string, AgentRecord[]>();
  for (const agent of agents) if (agent.parentAgentId && !agent.archivedAt) { const list = children.get(agent.parentAgentId); if (list) list.push(agent); else children.set(agent.parentAgentId, [agent]); }
  const ancestors = (agent: AgentRecord) => {
    const ids: string[] = [];
    for (let parent = agent.parentAgentId; parent && !ids.includes(parent); parent = byId.get(parent)?.parentAgentId ?? null) ids.push(parent);
    return ids;
  };
  const live = new Set(agents.filter(agent => LIVE_STATUSES.has(agent.status)).map(agent => agent.id));
  // Anything running anywhere below keeps its whole line of ancestors; anything running above keeps its descendants.
  const busy = new Set([...live].flatMap(id => [id, ...ancestors(byId.get(id)!)]));
  const settled = scope.filter(agent => settledAlone(agent) && !ancestors(agent).some(id => live.has(id)));
  /** Breadth first through unarchived children (a cycle of parent labels ends where it began): one not settled, or woken by `targets`, stays. */
  const keptBelow = (agent: AgentRecord, targets: ReadonlySet<string>) => {
    if (busy.has(agent.id)) return true;
    const seen = new Set([agent.id]), queue = [agent.id];
    for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]!) ?? []) {
      if (seen.has(child.id)) continue;
      if (!settledAlone(child) || targets.has(child.id)) return true;
      seen.add(child.id); queue.push(child.id);
    }
    return false;
  };
  return { settled, keptBelow };
}
/**
 * 归档已读完成 (opus-B18): completed sessions of `scope` whose result was read, with no stop to come back for, nothing running anywhere
 * above or below them, no active or paused heartbeat, and no Agent below them (in `agents`) that would have to stay: archiving takes
 * those along (see `archiveReview`); they count in `sparedForChildren`. While `guard` is not ready nothing can be shown to have no
 * heartbeat, and while the session list is cut short (`list.truncated`) not every Agent below is known: there are no candidates, and
 * `withheld` counts the sessions that would be offered otherwise, with the `reason` the menu shows.
 */
export function archiveReadCandidates(agents: readonly AgentRecord[], scope: readonly AgentRecord[], guard: HeartbeatGuard, list: ArchiveListState = {}): ArchiveOffer {
  const { settled, keptBelow } = archiveReview(agents, scope), targets = guard.ready ? guard.targets : new Set<string>();
  const own = settled.filter(agent => !targets.has(agent.id)), clear = own.filter(agent => !keptBelow(agent, targets));
  const sparedForChildren = own.length - clear.length, reason = list.truncated ? ARCHIVE_PARTIAL_LIST : guard.ready ? null : guard.reason;
  if (reason !== null) return { candidates: [], withheld: clear.length, ...(clear.length ? { reason } : {}), sparedForChildren };
  return { candidates: clear, withheld: 0, sparedForChildren };
}
/**
 * 归档已读完成's second tap: the marked sessions still eligible under `fresh`, a heartbeat read made for this tap, and the Agents below
 * them as they are now. A read that cannot be trusted, or a cut session list, archives nothing. `spared` counts marked sessions a
 * heartbeat now wakes, `sparedForChildren` those an Agent below now keeps (it has a heartbeat, a new turn, an unread result or a stop),
 * `changed` those that moved on themselves (a new turn).
 */
export function confirmArchive(marked: ReadonlySet<string>, agents: readonly AgentRecord[], scope: readonly AgentRecord[], fresh: HeartbeatGuard, list: ArchiveListState = {}):
  { ok: false; reason: string } | { ok: true; ids: string[]; spared: number; sparedForChildren: number; changed: number } {
  if (list.truncated) return { ok: false, reason: ARCHIVE_PARTIAL_LIST };
  if (!fresh.ready) return { ok: false, reason: fresh.reason };
  const { settled, keptBelow } = archiveReview(agents, scope), ids: string[] = [];
  let still = 0, spared = 0, sparedForChildren = 0;
  for (const agent of settled) {
    if (!marked.has(agent.id)) continue;
    still++;
    if (fresh.targets.has(agent.id)) spared++;
    else if (keptBelow(agent, fresh.targets)) sparedForChildren++;
    else ids.push(agent.id);
  }
  return { ok: true, ids, spared, sparedForChildren, changed: marked.size - still };
}

// ---------- pure helpers ----------

const PULL_REQUEST = /https?:\/\/[^\s<>()[\]"'`]+?\/(?:pull|pulls|merge_requests)\/(\d+)(?=[^\w/]|$)/;
/** First merge/pull request URL in a text: GitLab-style merge requests (`/merge_requests/12`) read `!12`, GitHub PRs `#34`. */
export function findChangeRequest(text: string | null | undefined): RunLink | null {
  if (!text) return null;
  const match = PULL_REQUEST.exec(text);
  if (!match) return null;
  const mr = /\/merge_requests\//.test(match[0]);
  return { url: withoutUserinfo(match[0]).slice(0, 2000), label: `${mr ? "!" : "#"}${match[1]}`, kind: mr ? "mr" : "pr", state: null };
}

/** A preview only needs the start of a reply; a run's output can be megabytes of agent-written text. */
const PREVIEW_SOURCE_MAX = 4000;
/**
 * Drop Markdown noise and the daemon's leading rule, collapse whitespace: one paragraph for a list row. Only the first
 * 4000 characters are read, and every pattern is bounded (link text, link target, bold span) or line-local, so hostile
 * input (thousands of unclosed `[`, blank lines, `**` markers) costs linear time.
 */
export function previewOf(text: string | null | undefined, max = 280): string | null {
  if (!text) return null;
  const source = text.length > PREVIEW_SOURCE_MAX ? text.slice(0, PREVIEW_SOURCE_MAX) : text;
  const plain = source.replace(/^\s*---\s*\n/, "").replace(/```[^\n]*\n?/g, "").replace(/!?\[([^[\]]{0,500})\]\([^)]{0,1000}\)/g, "$1").replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "").replace(/^[ \t]{0,3}>[ \t]?/gm, "").replace(/(\*\*|__)(?=\S)([\s\S]{0,300}?\S)\1/g, "$2").replace(/`([^`]*)`/g, "$1").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  return plain.length <= max ? plain : `${plain.slice(0, max - 1).trimEnd()}…`;
}

let WEEKDAYS = [t("sharedSchedules.m007"), t("sharedSchedules.m008"), t("sharedSchedules.m009"), t("sharedSchedules.m010"), t("sharedSchedules.m011"), t("sharedSchedules.m012"), t("sharedSchedules.m013")];
let WEEKDAY_TAILS = [t("sharedSchedules.shortSunday"), t("sharedSchedules.shortMonday"), t("sharedSchedules.shortTuesday"), t("sharedSchedules.shortWednesday"), t("sharedSchedules.shortThursday"), t("sharedSchedules.shortFriday"), t("sharedSchedules.shortSaturday")];
const pad = (value: number) => String(value).padStart(2, "0");

/**
 * One cron field as Paseo 0.11 reads it (its `parseCronExpression`): `*`, numbers, `a-b` ranges, `/n` steps and comma lists; no
 * names, no `?` `L` `W` `#`; weekdays 0–6. `step` is set for a lone `*\/n`, `range` for a lone `a-b` without a step.
 */
interface CronField { values: readonly number[]; all: boolean; step: number | null; range: readonly [number, number] | null }
export interface CronSpec { minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField }
const CRON_BOUNDS: readonly (readonly [number, number])[] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
function cronField(source: string, [min, max]: readonly [number, number]): CronField | null {
  const parts = source.split(","), values = new Set<number>();
  let step: number | null = null, range: [number, number] | null = null;
  for (const raw of parts) {
    const part = raw.trim(), pieces = part.split("/");
    if (!part || pieces.length > 2) return null;
    const [base, stepText] = pieces as [string, string | undefined];
    const by = stepText === undefined ? 1 : Number.parseInt(stepText.trim(), 10);
    // Like Paseo: a step is a plain positive integer ("05" and "2x" are errors).
    if (!Number.isInteger(by) || by <= 0 || (stepText !== undefined && String(by) !== stepText.trim())) return null;
    let from = min, to = max, stride = by;
    if (base !== "*") {
      const match = /^(\d+)(?:-(\d+))?$/.exec(base);
      if (!match) return null;
      from = Number(match[1]); to = match[2] === undefined ? from : Number(match[2]);
      if (from > to || from < min || to > max) return null;
      // A single value ignores its step, as in Paseo ("5/10" is minute 5 only).
      if (match[2] === undefined) stride = 1; else if (parts.length === 1 && by === 1) range = [from, to];
    } else if (parts.length === 1 && by > 1) step = by;
    for (let value = from; value <= to; value += stride) values.add(value);
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { values: sorted, all: sorted.length === max - min + 1, step, range };
}
/** A five-field cron in Paseo's dialect, or null when Paseo would reject it. */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed = fields.map((field, index) => cronField(field, CRON_BOUNDS[index]!));
  if (parsed.some(field => !field)) return null;
  const [minute, hour, day, month, weekday] = parsed as CronField[];
  return { minute: minute!, hour: hour!, day: day!, month: month!, weekday: weekday! };
}

const clockText = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
/** Every n minutes from :00 — `*`, `*\/n`, or an evenly spaced list such as 0,30 — else null. */
function minuteInterval(field: CronField): number | null {
  if (field.all) return 1;
  if (field.step) return field.step;
  const [first, second] = field.values;
  if (first !== 0 || second === undefined) return null;
  const gap = second;
  return 60 % gap === 0 && field.values.length === 60 / gap && field.values.every((value, index) => value === index * gap) ? gap : null;
}
/** Times of day (at most 6, 09:00、18:00) or a repeating part (每 15 分钟, 9–18 点每 15 分钟, 每 6 小时, 每小时（整点后 5 分）). */
function timePart(minute: CronField, hour: CronField): { at: string[] } | { every: string } | null {
  const interval = minuteInterval(minute);
  if (interval) {
    const every = interval === 1 ? t("sharedSchedules.m014") : t("sharedSchedules.m015", { interval: interval });
    if (hour.all) return { every };
    const span = hour.range ? t("sharedSchedules.m016", { value1: hour.range[0], value2: hour.range[1] }) : hour.values.length <= 4 ? t("sharedSchedules.m017", { value1: joinList(hour.values.map(String)) }) : null;
    return span ? { every: t("sharedSchedules.hourlySpan", { span, every }) } : null;
  }
  if (minute.values.length === 1) {
    const at = minute.values[0]!, offset = at ? t("sharedSchedules.m018", { at: at }) : "";
    if (hour.all) return { every: t("sharedSchedules.m019", { offset: offset }) };
    if (hour.step) return { every: t("sharedSchedules.m020", { value1: hour.step, offset: offset }) };
    if (hour.values.length <= 6) return { at: hour.values.map(value => clockText(value, at)) };
    return hour.range ? { every: t("sharedSchedules.m021", { value1: hour.range[0], value2: hour.range[1], offset: offset }) } : null;
  }
  return !hour.all && minute.values.length * hour.values.length <= 6 ? { at: hour.values.flatMap(value => minute.values.map(at => clockText(value, at))) } : null;
}
/** 工作日 / 周末 / 每周五 / 周一至周三 / 每周一、三、五 (Monday first). */
function weekdayText(field: CronField): string {
  const days = [...field.values].sort((a, b) => (a + 6) % 7 - (b + 6) % 7), key = days.join(",");
  if (key === "1,2,3,4,5") return t("sharedSchedules.m022");
  if (key === "6,0") return t("sharedSchedules.m023");
  if (days.length === 1) return t("sharedSchedules.m024", { value1: WEEKDAYS[days[0]!] });
  if (field.range && field.range[1] - field.range[0] >= 2) return t("sharedSchedules.m025", { value1: WEEKDAYS[field.range[0]], value2: WEEKDAYS[field.range[1]] });
  return t("sharedSchedules.m026", { value1: WEEKDAYS[days[0]!], value2: joinList(days.slice(1).map(day => WEEKDAY_TAILS[day]!)) });
}
/** 1 日 / 1、15 日 / 1–7 日 (or months), at most 6 listed values. */
function listText(field: CronField, unit: string): string | null {
  if (field.range) return t("sharedSchedules.unitRange", { from: field.range[0], to: field.range[1], unit });
  return field.values.length <= 6 ? t("sharedSchedules.unitList", { values: joinList(field.values.map(String)), unit }) : null;
}
function dayPart(day: CronField, month: CronField, weekday: CronField): { text: string; date: boolean } | null {
  // A day of month and a weekday together: Paseo 0.11 runs only when both match, standard cron when either does. Neither
  // reading is claimed; the expression is shown as written (the next run time always comes from Paseo itself).
  if (!day.all && !weekday.all) return null;
  const weekdays = weekday.all ? null : weekdayText(weekday), months = month.all ? null : listText(month, t("sharedSchedules.m027"));
  if (!month.all && !months) return null;
  if (day.all) return { text: months ? t("sharedSchedules.monthWeekdays", { months, weekdays: weekdays ?? t("sharedSchedules.m028") }) : weekdays ?? t("sharedSchedules.m029"), date: false };
  if (!months) { const days = listText(day, t("sharedSchedules.m030")); return days ? { text: t("sharedSchedules.m031", { days: days }), date: false } : null; }
  if (month.values.length === 1 && day.values.length === 1) return { text: t("sharedSchedules.m032", { value1: month.values[0], value2: day.values[0] }), date: true };
  const days = listText(day, t("sharedSchedules.m033"));
  return days ? { text: t("sharedSchedules.m034", { months: months, days: days }), date: false } : null;
}
function describeCron(expression: string, maxRuns: number | null): string | null {
  const spec = parseCron(expression);
  const time = spec && timePart(spec.minute, spec.hour), day = spec && dayPart(spec.day, spec.month, spec.weekday);
  if (!time || !day) return null;
  const once = maxRuns === 1, dayText = day.date ? t("sharedSchedules.m035", { value1: day.text }) : day.text;
  if ("every" in time) return once ? t("sharedSchedules.m036") : spec!.day.all && spec!.month.all && spec!.weekday.all ? time.every : `${dayText} ${time.every}`;
  const times = joinList(time.at);
  if (!once) return `${dayText} ${times}`;
  return t("sharedSchedules.m038", { value1: spec!.day.all && spec!.month.all && spec!.weekday.all ? "" : `${day.text} `, times: times });
}

/**
 * A cadence in Chinese, without its zone: 每 30 分钟 / 每天 09:00、18:00 / 工作日 9–18 点每 15 分钟 / 每月 1 日 09:00 /
 * 每周一、三、五 09:00 / 每年 10月11日 22:35, and 一次性 · 10月11日 22:35 when Paseo stops after one run (`maxRuns` 1). What it
 * cannot say exactly stays as written. `cadenceText` adds the zone, 共 N 次 and a one-shot's local time.
 */
export function cadenceLabel(cadence: { type: "cron"; expression: string; timezone?: string | null } | { type: "every"; everyMs: number }, maxRuns: number | null = null): string {
  if (cadence.type === "every") {
    if (maxRuns === 1) return t("sharedSchedules.m040");
    const minutes = Math.round(cadence.everyMs / 60_000);
    return minutes % 1440 === 0 ? t("sharedSchedules.m041", { value1: minutes / 1440 }) : minutes % 60 === 0 ? t("sharedSchedules.m042", { value1: minutes / 60 }) : t("sharedSchedules.m043", { minutes: minutes });
  }
  const expression = cadence.expression.trim();
  const text = describeCron(expression, maxRuns) ?? (maxRuns === 1 ? t("sharedSchedules.m044", { expression: expression }) : expression);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
/** The wall date of a fixed-date cron (`35 22 11 10 *`), else null. */
function fixedDate(expression: string | null | undefined): { month: number; day: number } | null {
  const spec = expression ? parseCron(expression) : null;
  if (!spec || !spec.weekday.all || ![spec.minute, spec.hour, spec.day, spec.month].every(field => field.values.length === 1)) return null;
  return { month: spec.month.values[0]!, day: spec.day.values[0]! };
}

// A display-name table only: no zone is ever assumed. A cron without one runs in UTC (Paseo's rule), the device's comes from Intl.
let ZONE_NAMES: Record<string, string> = { UTC: "UTC", "Etc/UTC": "UTC", GMT: "UTC", "Asia/Shanghai": t("sharedSchedules.m045"), "Asia/Hong_Kong": t("sharedSchedules.m046"), "Asia/Taipei": t("sharedSchedules.m047"), "Asia/Tokyo": t("sharedSchedules.m048"),
  "America/Los_Angeles": t("sharedSchedules.m049"), "America/Denver": t("sharedSchedules.m050"), "America/Chicago": t("sharedSchedules.m051"), "America/New_York": t("sharedSchedules.m052"), "Europe/London": t("sharedSchedules.m053"), "Europe/Berlin": t("sharedSchedules.m054") };
const sameZone = (a: string, b: string) => (ZONE_NAMES[a] === "UTC" && ZONE_NAMES[b] === "UTC") || a === b;
/** The device's IANA zone, or null where the runtime cannot tell. */
export function deviceTimeZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}
/** 「北京时间」「UTC」「Los Angeles」. */
export function zoneLabel(zone: string): string { return ZONE_NAMES[zone] ?? zone.split("/").at(-1)!.replaceAll("_", " "); }

/** 22:35 in the device's zone. */
export function clockOf(ms: number): string { const date = new Date(ms); return clockText(date.getHours(), date.getMinutes()); }
/** 今天 / 明天 / 昨天, else 10月13日: the device-local day of `ms` seen from `now`. */
export function dayWord(ms: number, now: number): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  return days === 0 ? t("sharedSchedules.m055") : days === 1 ? t("sharedSchedules.m056") : days === -1 ? t("sharedSchedules.m057") : monthDay(ms);
}

export interface CadenceInfo { cadence: string; timezone: string | null; expression?: string | null; maxRuns?: number | null; onceAt?: string | null }
/**
 * A cadence as cards show it: the zone when it differs from the device's (Paseo runs zone-less crons in UTC), 共 N 次 when Paseo stops
 * after N runs, and for a one-shot the device's own time of its run, from the absolute time Paseo computed: 一次性 · 10月11日 22:35（东京时间）·
 * 本地 09:35, with the local date when it is not the cron's. A one-shot without a fixed date reads 一次性 · 明天 09:35 in device time.
 */
export function cadenceText(schedule: CadenceInfo, device: string | null, now = Date.now()): string {
  if (!schedule.cadence) return schedule.cadence;
  const zone = schedule.timezone && !(device && sameZone(schedule.timezone, device)) ? schedule.timezone : null;
  // A full-width bracket already spaces the dot: 「（东京时间）· 本地 09:35」.
  const zoned = zone ? t("sharedSchedules.m058", { value1: schedule.cadence, value2: zoneLabel(zone) }) : schedule.cadence, dot = zone ? "· " : " · ";
  if (schedule.maxRuns !== 1) return schedule.maxRuns ? t("sharedSchedules.m059", { zoned: zoned, dot: dot, value3: schedule.maxRuns }) : zoned;
  const at = parseTime(schedule.onceAt);
  if (!at) return zoned;
  const wall = fixedDate(schedule.expression);
  if (!wall) return t("sharedSchedules.m060", { value1: zone ? t("sharedSchedules.m061") : "", value2: dayWord(at, now), value3: clockOf(at) });
  if (!zone) return zoned;
  const local = new Date(at), sameDate = local.getMonth() + 1 === wall.month && local.getDate() === wall.day;
  return t("sharedSchedules.m062", { zoned: zoned, dot: dot, value3: sameDate ? "" : `${monthDay(at)} `, value4: clockOf(at) });
}
/** 第 2/3 次 for a schedule Paseo stops after `maxRuns` (还没运行 before the first), else 共 7 次. */
export function runQuota(total: number, maxRuns: number | null | undefined): string {
  return maxRuns ? total ? t("sharedSchedules.m063", { total: total, maxRuns: maxRuns }) : t("sharedSchedules.m064") : t("sharedSchedules.m065", { total: total });
}

const HEARTBEAT_ORDER = { active: 0, paused: 1, completed: 2 } as const;
const lastRunAt = (heartbeat: HeartbeatSummary) => parseTime(heartbeat.lastRun?.endedAt) || parseTime(heartbeat.lastRun?.startedAt);
/** Heartbeats by the Agent they wake: active ones by next run, then paused ones, then finished ones (latest first). */
export function heartbeatsByAgent(heartbeats: readonly HeartbeatSummary[]): Map<string, HeartbeatSummary[]> {
  const sorted = [...heartbeats].sort((a, b) => HEARTBEAT_ORDER[a.status] - HEARTBEAT_ORDER[b.status]
    || (a.status === "completed" ? lastRunAt(b) - lastRunAt(a) : (parseTime(a.nextRunAt) || Infinity) - (parseTime(b.nextRunAt) || Infinity)) || a.scheduleId.localeCompare(b.scheduleId));
  const byAgent = new Map<string, HeartbeatSummary[]>();
  for (const heartbeat of sorted) { const list = byAgent.get(heartbeat.agentId); if (list) list.push(heartbeat); else byAgent.set(heartbeat.agentId, [heartbeat]); }
  return byAgent;
}
export interface HeartbeatWake { state: "running" | "scheduled" | "due" | "paused"; label: string; description: string; at: number | null; soon: boolean }
/**
 * What an Agent's session row says about its heartbeats: 心跳唤醒中 while one runs; else the next wake in device time — 22:35 唤醒
 * today, 明天 07:35 唤醒, 10月13日 07:35 唤醒 (即将唤醒 once it is due); 心跳已暂停 when every live one is paused; null when all finished.
 */
export function heartbeatWake(heartbeats: readonly HeartbeatSummary[] | null | undefined, now: number): HeartbeatWake | null {
  if (!heartbeats?.length) return null;
  if (heartbeats.some(item => item.lastRun?.status === "running")) return { state: "running", label: t("sharedSchedules.m066"), description: t("sharedSchedules.m067"), at: null, soon: true };
  let next: { at: number; once: boolean } | null = null;
  for (const item of heartbeats) { const at = item.status === "active" ? parseTime(item.nextRunAt) : 0; if (at && (!next || at < next.at)) next = { at, once: item.once }; }
  if (next) {
    const day = dayWord(next.at, now), description = t("sharedSchedules.m068", { value1: monthDay(next.at), value2: clockOf(next.at), value3: next.once ? t("sharedSchedules.m069") : "" });
    if (next.at <= now) return { state: "due", label: t("sharedSchedules.m070"), description, at: next.at, soon: true };
    return { state: "scheduled", label: t("sharedSchedules.m071", { value1: startOfDay(next.at) === startOfDay(now) ? "" : `${day} `, value2: clockOf(next.at) }), description, at: next.at, soon: next.at - now <= 15 * 60_000 };
  }
  return heartbeats.some(item => item.status === "paused") ? { state: "paused", label: t("sharedSchedules.m073"), description: t("sharedSchedules.m074"), at: null, soon: false } : null;
}

/** Search text: NFKC (full-width letters and digits read as plain ones) in lower case. Chinese matches as substrings. */
export function searchFold(text: string): string {
  let folded = text;
  try { folded = text.normalize("NFKC"); } catch { /* a runtime without normalization compares the text as typed */ }
  return folded.toLowerCase();
}
/** At most 8 distinct folded words of a query; a run must contain every one. */
export function searchWords(query: string): string[] {
  return [...new Set(searchFold(query.slice(0, 400)).split(/\s+/).filter(Boolean))].slice(0, 8);
}
/**
 * The query as the server applies and echoes it, so the page can tell whose results it holds: folded words joined by single spaces,
 * at most 200 characters (a word cut short still matches as a prefix).
 */
export function normalizeRunQuery(query: string): string {
  return searchWords(query).join(" ").slice(0, 200).trim();
}
/** A run's searchable fields besides its reply, folded: schedule, Agent, workspace, branch, preview, error, link and project. */
export function runSearchText(run: ScheduleRunRow): string {
  return searchFold([run.scheduleName, run.agent?.title, run.workspace?.name, run.workspace?.branch, run.preview, run.error, run.link?.label, run.link?.url, run.projectName].filter(Boolean).join("\n"));
}

export function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface RunGroup { key: string; label: string; runs: ScheduleRunRow[] }
const DAY = 86_400_000;
const startOfDay = (ms: number) => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };
const startOfWeek = (ms: number) => { const date = new Date(startOfDay(ms)); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date.getTime(); };
const monthDay = (ms: number) => { const date = new Date(ms); return t("sharedSchedules.m075", { value1: date.getMonth() + 1, value2: date.getDate() }); };
/**
 * 今天 / 昨天 / 10月6日 周二 for the past week, one group per week (周一起) for the month before, then per month, then per year.
 * Runs arrive newest first and keep their order inside a group.
 */
export function groupRunsByDay(runs: readonly ScheduleRunRow[], now: number): RunGroup[] {
  const today = startOfDay(now), dayFloor = today - 6 * DAY, weekFloor = startOfWeek(dayFloor - 30 * DAY);
  const groups = new Map<string, RunGroup & { start: number }>();
  for (const run of runs) {
    const time = parseTime(run.startedAt) || parseTime(run.scheduledFor);
    let key: string, label: string, start: number;
    if (!time) { key = "undated"; label = t("sharedSchedules.m076"); start = 0; }
    else if (time >= dayFloor) {
      start = Math.min(startOfDay(time), today); key = `d${start}`;
      const date = new Date(start);
      label = start === today ? t("sharedSchedules.m077") : start === today - DAY || start === startOfDay(today - DAY) ? t("sharedSchedules.m078") : `${monthDay(start)} ${WEEKDAYS[date.getDay()]}`;
    } else if (time >= weekFloor) {
      start = startOfWeek(time); key = `w${start}`;
      const end = Math.min(start + 6 * DAY, dayFloor - DAY);
      label = end <= start ? monthDay(start) : `${monthDay(start)} – ${monthDay(end)}`;
    } else {
      const date = new Date(time), thisYear = new Date(now).getFullYear();
      if (time >= new Date(thisYear - 1, new Date(now).getMonth(), 1).getTime()) {
        start = new Date(date.getFullYear(), date.getMonth(), 1).getTime(); key = `m${start}`;
        label = date.getFullYear() === thisYear ? t("sharedSchedules.m079", { value1: date.getMonth() + 1 }) : t("sharedSchedules.m080", { value1: date.getFullYear(), value2: date.getMonth() + 1 });
      } else { start = new Date(date.getFullYear(), 0, 1).getTime(); key = `y${start}`; label = t("sharedSchedules.m081", { value1: date.getFullYear() }); }
    }
    const group = groups.get(key);
    if (group) group.runs.push(run); else groups.set(key, { key, label, runs: [run], start });
  }
  return [...groups.values()].sort((a, b) => b.start - a.start).map(({ key, label, runs: items }) => ({ key, label, runs: items }));
}

export interface RunFilter { status: RunStatus | "all"; scheduleId: string | "all"; heartbeats: boolean; query: string }
export const EMPTY_RUN_FILTER: RunFilter = { status: "all", scheduleId: "all", heartbeats: false, query: "" };
/**
 * Status, schedule and heartbeat choices; `query` matches what a row carries (schedule name, Agent title, workspace, branch,
 * preview, error, link) — the server's search also reads each full reply, so the page passes "" once the server applied it.
 */
export function filterRuns(runs: readonly ScheduleRunRow[], filter: RunFilter): ScheduleRunRow[] {
  const words = searchWords(filter.query);
  return runs.filter(run => {
    if (!filter.heartbeats && run.kind === "heartbeat" && filter.scheduleId !== run.scheduleId) return false;
    if (filter.scheduleId !== "all" && run.scheduleId !== filter.scheduleId) return false;
    if (filter.status !== "all" && run.status !== filter.status) return false;
    if (!words.length) return true;
    const haystack = runSearchText(run);
    return words.every(word => haystack.includes(word));
  });
}

/**
 * Paseo's run errors are English and ACP ones repeat themselves ("Internal error: … code: -32603 Internal error: … | data=…").
 * Known causes get a short Chinese summary; the cleaned original stays available for the detail view.
 */
export function describeRunError(error: string | null | undefined): { summary: string; detail: string; known: boolean } | null {
  if (!error?.trim()) return null;
  const detail = error.replace(/^Internal error:\s*/i, "").split(/\n\s*\n|\s+\|\s+code=/)[0]!.replace(/\s*code:\s*-?\d+\s*$/i, "").trim() || error.trim();
  const known: Array<[RegExp, (match: RegExpExecArray) => string]> = [
    [/Working directory (.+) (?:no longer exists|is not a directory)/, match => t("sharedSchedules.m082", { value1: match[1] })],
    [/is waiting for permission/, () => t("sharedSchedules.m083")],
    [/Daemon restarted before the scheduled run completed/, () => t("sharedSchedules.m084")],
    [/Timed out refreshing (.+?) after \d+ms/, match => t("sharedSchedules.m085", { value1: match[1] })],
    [/already has an active run/, () => t("sharedSchedules.m086")],
    [/does not support ACP session resume/, () => t("sharedSchedules.m087")],
    [/was canceled/, () => t("sharedSchedules.m088")],
    [/Agent \S+ (?:no longer exists|is archived)/, () => t("sharedSchedules.m089")],
  ];
  for (const [pattern, summarize] of known) { const match = pattern.exec(detail); if (match) return { summary: summarize(match), detail, known: true }; }
  return { summary: detail.split("\n")[0]!.slice(0, 200), detail, known: false };
}
/** The Chinese summary of a known Paseo / ACP error, or null (other errors are shown as they are). */
export function knownRunError(error: string | null | undefined): string | null {
  const described = describeRunError(error);
  return described?.known ? described.summary : null;
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  WEEKDAY_TAILS = [t("sharedSchedules.shortSunday"), t("sharedSchedules.shortMonday"), t("sharedSchedules.shortTuesday"), t("sharedSchedules.shortWednesday"), t("sharedSchedules.shortThursday"), t("sharedSchedules.shortFriday"), t("sharedSchedules.shortSaturday")];
  ARCHIVE_PARTIAL_LIST = t("sharedSchedules.m006");
  WEEKDAYS = [t("sharedSchedules.m007"), t("sharedSchedules.m008"), t("sharedSchedules.m009"), t("sharedSchedules.m010"), t("sharedSchedules.m011"), t("sharedSchedules.m012"), t("sharedSchedules.m013")];
  ZONE_NAMES = { UTC: "UTC", "Etc/UTC": "UTC", GMT: "UTC", "Asia/Shanghai": t("sharedSchedules.m045"), "Asia/Hong_Kong": t("sharedSchedules.m046"), "Asia/Taipei": t("sharedSchedules.m047"), "Asia/Tokyo": t("sharedSchedules.m048"),
  "America/Los_Angeles": t("sharedSchedules.m049"), "America/Denver": t("sharedSchedules.m050"), "America/Chicago": t("sharedSchedules.m051"), "America/New_York": t("sharedSchedules.m052"), "Europe/London": t("sharedSchedules.m053"), "Europe/Berlin": t("sharedSchedules.m054") };
});
