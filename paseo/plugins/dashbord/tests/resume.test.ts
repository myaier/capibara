import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseCronExpression } from "@getpaseo/protocol/schedule/cron-expression";
import type { PaseoApi } from "../server/paseo-types";
import { RESUME_LEDGER_LIMIT, RESUME_PROMPT, RESUME_WINDOW_MS, getResumes, handoverKey, handoverPrompt, handoverTitle, legacyResume, quotaWindowReset, resumeCron, resumeFor, resumeLook, resumeTime, type ResumeEntry } from "../shared/resume";
import { LEDGER_MAX_BYTES, ResumeLedger, TIDY_HARD_LIMIT, TIDY_LIMIT, createResume, freeMinute, registerResume, wallLabel, type ResumeLedgerOptions, type SessionLogs } from "../server/resume";
import { DigestService } from "../server/digest";
import { TokenIngester } from "../server/tokens/ingester";
import { LocalTokenCallSource } from "../server/tokens/source";

const MINUTE = 60_000, HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const now0 = Date.parse("2026-10-11T04:00:00Z"); // 21:00 PDT
const A = "6f1c2a3b-0000-4000-8000-00000000000a", B = "6f1c2a3b-0000-4000-8000-00000000000b", C = "6f1c2a3b-0000-4000-8000-00000000000c";
const D = "6f1c2a3b-0000-4000-8000-00000000000d", E = "6f1c2a3b-0000-4000-8000-00000000000e";
/** What a Claude-style Agent last said when it hit the limit: the host makes a failed turn's error this text (its last assistant message). */
const LIMIT_REPLY = "You've hit your usage limit. Try again at 9:45 PM.";
/** The host's run ids are UUIDs; it writes the one of each run into the prompt it sends (`run=<id>`). */
const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A promise opened from outside (two requests out at once, a run held mid-way). */
const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; };

/**
 * The daemon's `computeNextRunAt` for cron cadences (Paseo 0.11.1 schedule/cron.js, with the protocol's own cron parser): minute
 * by minute from the next minute, the fields read in the cron's zone (UTC getters without one), giving up after 366 days.
 */
function computeNextRunAt(cadence: { expression: string; timezone?: string }, after: number): number {
  const cron = parseCronExpression(cadence.expression);
  const fields = (at: number) => {
    if (cadence.timezone === undefined || cadence.timezone === "UTC") { const date = new Date(at); return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth() + 1, weekday: date.getUTCDay() }; }
    const value = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: cadence.timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(at).filter(part => part.type !== "literal").map(part => [part.type, Number.parseInt(part.value, 10)])) as Record<string, number>;
    return { minute: value.minute!, hour: value.hour!, day: value.day!, month: value.month!, weekday: new Date(Date.UTC(value.year!, value.month! - 1, value.day!)).getUTCDay() };
  };
  let cursor = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let index = 0; index < 366 * 24 * 60; index++, cursor += MINUTE) {
    const at = fields(cursor);
    if (cron.minute.matches(at.minute) && cron.hour.matches(at.hour) && cron.dayOfMonth.matches(at.day) && cron.month.matches(at.month) && cron.dayOfWeek.matches(at.weekday)) return cursor;
  }
  throw new Error(`Unable to compute next run time for cron expression: ${cadence.expression}`);
}

interface Run { id: string; scheduledFor: string; startedAt: string; endedAt: string | null; status: "running" | "succeeded" | "failed"; agentId: string | null; output: null; error: string | null }
interface Stored { id: string; name: string | null; prompt: string; cadence: { type: "cron"; expression: string; timezone?: string }; target: { type: "agent"; agentId: string }; status: "active" | "paused" | "completed";
  createdAt: string; nextRunAt: string | null; maxRuns: number | null; expiresAt: string | null; runs: Run[] }
/**
 * The host's schedule store, session requests and ticks as schedule/service.js, session/schedule/schedule-session.js and
 * agent-manager.js behave: a scheduled prompt goes in as a system envelope without a clientMessageId, so it never sets the Agent's
 * lastUserMessageAt; agent.turn_started reaches the plugin for its turn (`onTurn`); a failed turn fails the run with the Agent's
 * last assistant text as the error; a failed run counts against maxRuns; a restart fails the running run and moves a missed wake
 * to the cron's next match.
 */
class FakeHost {
  now = now0;
  schedules = new Map<string, Stored>();
  sent: Array<Record<string, unknown>> = [];
  /** Minutes the host's computed time is off by (a host that disagrees with the cron). */
  skew = 0;
  /** Requests that fail as a reconnect would: the host did the work, the answer is lost (type → how many more times). */
  lose = new Map<string, number>();
  /** Requests that fail before reaching the host (type → how many more times). */
  refuse = new Map<string, number>();
  /** Requests the host answers with an error, doing nothing (type → how many more times). */
  deny = new Map<string, number>();
  /** Awaited as a request arrives, before the host handles it (two creates out at once). */
  before: (message: Record<string, unknown>) => Promise<void> = async () => {};
  private sequence = 0;
  bridge = { request: async (message: Record<string, unknown>, responseType: string) => {
    this.sent.push({ ...message, responseType });
    const type = String(message.type);
    await this.before(message);
    if ((this.refuse.get(type) ?? 0) > 0) { this.refuse.set(type, this.refuse.get(type)! - 1); throw new Error("宿主未响应子任务请求。可重试，或确认 Paseo 宿主支持子任务观察。"); }
    if ((this.deny.get(type) ?? 0) > 0) { this.deny.set(type, this.deny.get(type)! - 1); return { error: "宿主拒绝了这个请求" }; }
    const answer = this.handle(message);
    if ((this.lose.get(type) ?? 0) > 0) { this.lose.set(type, this.lose.get(type)! - 1); throw new Error("宿主未响应：插件会话已重新连接，请重试。"); }
    return answer;
  } };
  /** As fetch_agent has them: `attentionTimestamp` is raised when a turn ends, `persistence` names the provider session. */
  agents = new Map<string, { title: string; archivedAt: string | null; lastUserMessageAt: string | null; attentionTimestamp?: string | null; persistence?: { provider: string; sessionId: string } | null }>();
  /** The snapshot read fails (the host busy, the session reconnecting). */
  unreadable = false;
  paseo = { agents: { ref: (id: string) => ({ refresh: async () => {
    if (this.unreadable) throw new Error("宿主暂时没有回应");
    const agent = this.agents.get(id); return agent ? { agent: { id, ...agent } } : null;
  } }) } } as unknown as PaseoApi;
  /** Agents with a turn going: a run that finds one fails before its prompt. */
  busy = new Set<string>();
  /** Prompts that went into each Agent's session. */
  prompts = new Map<string, number>();
  /** Agents whose turn fails (the limit still holds), with their last assistant text. */
  failing = new Map<string, string>();
  /** Agents whose turn is still going after the tick: the run stays running. */
  holding = new Set<string>();
  /** The lifecycle hook agent.turn_started, as the plugin receives it. */
  onTurn: (agentId: string, at: number, turnId: string) => Promise<void> = async () => {};
  /**
   * Each provider session's own log, as Claude Code, Codex and Pi keep one: every prompt sent into it as it went out, the host's
   * envelope and fire line included (`Schedule "<name>" fired (id=<scheduleId>, run=<runId>).`). Read whole, a log without a
   * run's line shows its prompt never went in. An Agent in `noLog` runs on a provider that keeps none the plugin reads (an ACP
   * one, Grok): its prompts leave nothing to find, and nothing shows one is not there either; nor does a session in
   * `unreadableLogs` (its log cannot be opened). A session in `unscanned` has logs the plugin's scans have not listed since the
   * run ended: a decision about it is still pending.
   */
  sessionLogs = new Map<string, string[]>();
  noLog = new Set<string>();
  unreadableLogs = new Set<string>();
  unscanned = new Set<string>();
  /** How each look read the logs: whole (a decision, a cancel) or only their tails (a look while a run goes). */
  markerReads: Array<"whole" | "tail"> = [];
  logs: SessionLogs = { findMarker: async (sessionIds, marker, options = {}) => {
    this.markerReads.push(options.whole || options.run ? "whole" : "tail");
    if (sessionIds.some(id => !this.unreadableLogs.has(id) && (this.sessionLogs.get(id) ?? []).some(text => text.includes(marker)))) return "found";
    if (!options.run) return "unknown";
    if (sessionIds.some(id => this.unscanned.has(id))) return "pending";
    return sessionIds.length > 0 && sessionIds.every(id => this.readsLog(id)) ? "absent" : "unknown";
  } };
  /** Whether the plugin reads this session's log: an Agent's, on a provider that keeps one, and it can be opened. */
  private readsLog(sessionId: string): boolean {
    const owner = [...this.agents].find(([, agent]) => agent.persistence?.sessionId === sessionId)?.[0];
    return owner !== undefined && !this.noLog.has(owner) && !this.unreadableLogs.has(sessionId);
  }
  /** A prompt into an Agent's session: logged where its provider keeps a log. */
  write(agentId: string, text: string): void {
    const session = this.agents.get(agentId)?.persistence?.sessionId;
    if (session && !this.noLog.has(agentId)) this.sessionLogs.set(session, [...(this.sessionLogs.get(session) ?? []), text]);
  }
  private handle(message: Record<string, unknown>): Record<string, unknown> {
    const id = message.scheduleId as string;
    switch (message.type) {
      case "schedule/create": {
        const cadence = message.cadence as Stored["cadence"], schedule: Stored = { id: `sched-${++this.sequence}`, name: message.name as string, prompt: message.prompt as string, cadence,
          target: message.target as Stored["target"], status: "active", createdAt: iso(this.now), nextRunAt: iso(computeNextRunAt(cadence, this.now) + this.skew * MINUTE),
          maxRuns: (message.maxRuns as number) ?? null, expiresAt: (message.expiresAt as string) ?? null, runs: [] };
        this.schedules.set(schedule.id, schedule);
        const { runs: _runs, ...summary } = schedule;
        return { schedule: summary, error: null };
      }
      case "schedule/inspect": { const schedule = this.schedules.get(id); if (!schedule) throw new Error(`Schedule not found: ${id}`); return { schedule: structuredClone(schedule), error: null }; }
      case "schedule/delete": if (!this.schedules.delete(id)) throw new Error(`Schedule not found: ${id}`); return { scheduleId: id, error: null };
      case "schedule/list": return { schedules: [...this.schedules.values()].map(({ runs: _runs, ...summary }) => structuredClone(summary)), error: null };
      default: throw new Error(`unexpected ${String(message.type)}`);
    }
  }
  /** A schedule the host already has (2.13 made them in the device's zone; the user may have made others). */
  add(schedule: Partial<Stored> & Pick<Stored, "name" | "target">): Stored {
    const stored: Stored = { id: `sched-${++this.sequence}`, prompt: RESUME_PROMPT, cadence: { type: "cron", expression: "2 5 12 10 *", timezone: "US/Pacific" }, status: "active",
      createdAt: iso(this.now), nextRunAt: iso(this.now + HOUR), maxRuns: 1, expiresAt: null, runs: [], ...schedule };
    this.schedules.set(stored.id, stored);
    return stored;
  }
  /** One run of the heartbeat that ends like this (a failed one counts against `maxRuns` too). */
  fire(id: string, status: Run["status"], error: string | null = null): void {
    const schedule = this.schedules.get(id)!;
    schedule.runs.push({ id: runId(++this.sequence), scheduledFor: schedule.nextRunAt ?? iso(this.now), startedAt: iso(this.now), endedAt: status === "running" ? null : iso(this.now), status, agentId: null, output: null, error });
    this.settle(schedule);
  }
  /** The running run ends: its turn finished or failed. */
  end(id: string, status: "succeeded" | "failed", error: string | null = null): void {
    const schedule = this.schedules.get(id)!;
    Object.assign(schedule.runs.find(run => run.status === "running")!, { status, endedAt: iso(this.now), error });
    this.settle(schedule);
  }
  /** The host's tick: an expired heartbeat completes; a due one runs as executeSchedule runs it. */
  async tick(): Promise<void> {
    for (const schedule of [...this.schedules.values()]) {
      if (schedule.status !== "active" || !schedule.nextRunAt || schedule.runs.some(run => run.status === "running")) continue;
      if (schedule.expiresAt && Date.parse(schedule.expiresAt) <= this.now) { Object.assign(schedule, { status: "completed", nextRunAt: null }); continue; }
      if (Date.parse(schedule.nextRunAt) > this.now) continue;
      await this.run(schedule);
    }
  }
  /** A host tick that read its list before this heartbeat ran, reaching it now (F2): it runs it again unless its file is gone. */
  async staleRun(id: string): Promise<boolean> {
    const schedule = this.schedules.get(id);
    if (!schedule) return false; // appendRunningRun → "Schedule not found": the old tick gives up
    await this.run(schedule);
    return true;
  }
  private async run(schedule: Stored): Promise<void> {
    const agentId = schedule.target.agentId, agent = this.agents.get(agentId);
    if (!agent) return this.fire(schedule.id, "failed", `Agent ${agentId} no longer exists`);
    if (agent.archivedAt) return this.fire(schedule.id, "failed", `Agent ${agentId} is archived`);
    if (this.busy.has(agentId)) return this.fire(schedule.id, "failed", `Agent ${agentId} already has an active run`);
    this.prompts.set(agentId, (this.prompts.get(agentId) ?? 0) + 1);
    this.fire(schedule.id, "running");
    this.write(agentId, `<paseo-system>\nSchedule "${schedule.name}" fired (id=${schedule.id}, run=${schedule.runs.at(-1)!.id}).\n${schedule.prompt}\n</paseo-system>`);
    await this.onTurn(agentId, this.now, `turn-${this.sequence}`);
    if (this.holding.has(agentId)) return;
    this.end(schedule.id, this.failing.has(agentId) ? "failed" : "succeeded", this.failing.get(agentId) ?? null);
  }
  /** A daemon restart: the running run fails, a past wake moves to the cron's next match (next month with the open-month cron). */
  restart(): void {
    for (const schedule of this.schedules.values()) {
      for (const run of schedule.runs) if (run.status === "running") Object.assign(run, { status: "failed", endedAt: iso(this.now), error: "Daemon restarted before the scheduled run completed" });
      if (schedule.status === "active" && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= this.now) {
        let next = computeNextRunAt(schedule.cadence, Date.parse(schedule.nextRunAt));
        while (next <= this.now) next = computeNextRunAt(schedule.cadence, next);
        schedule.nextRunAt = iso(next);
      }
      this.settle(schedule);
    }
  }
  private settle(schedule: Stored): void {
    if (schedule.status === "active" && schedule.maxRuns !== null && schedule.runs.filter(run => run.status !== "running").length >= schedule.maxRuns) Object.assign(schedule, { status: "completed", nextRunAt: null });
  }
  creates() { return this.sent.filter(message => message.type === "schedule/create"); }
  /** The heartbeats that could still wake this Agent. */
  live(agentId: string) { return [...this.schedules.values()].filter(schedule => schedule.target.agentId === agentId && schedule.status === "active"); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function withLedger(run: (host: FakeHost, ledger: ResumeLedger, directory: string) => Promise<void>, options: ResumeLedgerOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-resume-"));
  const host = new FakeHost();
  for (const id of [A, B, C, D, E]) host.agents.set(id, { title: id === A ? "修复登录" : "整理日志", archivedAt: null, lastUserMessageAt: iso(now0 - HOUR), persistence: { provider: "claude", sessionId: `session-${id.slice(-1)}` } });
  const ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, zone: () => "US/Pacific", log: () => {}, logs: host.logs, ...options });
  host.onTurn = (agentId, at, turnId) => ledger.noteTurn(agentId, at, turnId);
  try { await run(host, ledger, directory); } finally { await ledger.close(); await rm(directory, { recursive: true, force: true }); }
}
const entryOf = async (ledger: ResumeLedger, agentId: string) => (await ledger.list(agentId))[0]!;
const clock = (at: number) => iso(at).slice(11, 16);

test("the wake time is two minutes after the reset, rounded up to a minute, never sooner than a minute from now", () => {
  assert.equal(iso(resumeTime("2026-10-11T12:00:00.000Z", now0)), "2026-10-11T12:02:00.000Z");
  assert.equal(iso(resumeTime("2026-10-11T12:00:30.000Z", now0)), "2026-10-11T12:03:00.000Z");
  assert.equal(iso(resumeTime("2026-10-11T03:00:00.000Z", now0)), "2026-10-11T04:01:00.000Z", "a reset in the past wakes a minute from now");
});

test("the heartbeat's cron is written in UTC with the month left open, so the daemon fires it exactly at the confirmed minute (codex-F7, opus-F37, F5)", () => {
  assert.deepEqual(resumeCron(Date.parse("2026-10-11T12:02:00Z")), { expression: "2 12 11 * *", timezone: "UTC" });
  const cases: Array<[wake: string, created: string]> = [
    ["2026-10-11T12:02:00Z", "2026-10-11T04:00:00Z"],
    ["2026-11-01T08:32:00Z", "2026-11-01T07:00:00Z"], // the first 01:32 in Los Angeles (PDT)
    ["2026-11-01T09:32:00Z", "2026-11-01T07:00:00Z"], // the second 01:32 (PST)
    ["2026-11-01T09:32:00Z", "2026-11-01T08:40:00Z"], // created during the first 01:xx
    ["2027-03-14T10:02:00Z", "2027-03-14T07:30:00Z"], // 03:02 PDT, just past the spring-forward skip
    ["2027-01-01T00:05:00Z", "2026-12-31T23:59:00Z"], // across a year
    ["2026-11-01T00:05:00Z", "2026-10-24T00:10:00Z"], // eight days ahead, across a month: still the first match
    ["2028-02-29T12:02:00Z", "2028-02-27T12:00:00Z"],
  ];
  for (const [wake, created] of cases) assert.equal(iso(computeNextRunAt(resumeCron(Date.parse(wake)), Date.parse(created))), new Date(wake).toISOString(), wake);
  // The 2.13 wall-clock cron in the device's zone fires an hour early for the second 01:32.
  assert.equal(iso(computeNextRunAt({ expression: "32 1 1 11 *", timezone: "US/Pacific" }, Date.parse("2026-11-01T07:00:00Z"))), "2026-11-01T08:32:00.000Z");
  // A 29 February wake the daemon restarted across: the fixed month found nothing within a year, and its start-up recovery threw.
  const leap = Date.parse("2028-02-29T12:02:00Z"), restarted = Date.parse("2028-02-29T12:20:00Z");
  assert.throws(() => computeNextRunAt({ expression: "2 12 29 2 *", timezone: "UTC" }, restarted), /Unable to compute next run time/);
  assert.equal(iso(computeNextRunAt(resumeCron(leap), restarted)), "2028-03-29T12:02:00.000Z", "now it moves to next month, which the ledger reads as missed");
});

test("replies word times in the devices' zone", () => {
  // 04:00Z is 21:00 on October 10 in Los Angeles: 12:02Z is the next morning there, the same day in UTC.
  assert.equal(wallLabel(Date.parse("2026-10-11T12:02:00Z"), "US/Pacific", now0), "明天 05:02");
  assert.equal(wallLabel(Date.parse("2026-10-11T05:02:00Z"), "US/Pacific", now0), "22:02");
  assert.equal(wallLabel(Date.parse("2026-10-12T12:02:00Z"), "US/Pacific", now0), "10月12日 05:02");
  assert.equal(wallLabel(Date.parse("2026-10-11T12:02:00Z"), "Asia/Singapore", now0), "20:02");
  assert.equal(wallLabel(Date.parse("2026-10-11T12:02:00Z"), null, now0), "12:02", "UTC without a zone");
});

test("scheduling sends one schedule/create (UTC cron, maxRuns 1, the retry window as expiry) after checking the Agent, and keeps it only at the confirmed minute", async () => {
  const host = new FakeHost(), at = "2026-10-11T12:02:00.000Z";
  host.agents.set(A, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  host.agents.set(B, { title: "旧会话", archivedAt: "2026-10-10T00:00:00Z", lastUserMessageAt: null });
  const result = await createResume(host.paseo, host.bridge, { agentId: A, at, timeZone: "US/Pacific" }, now0);
  assert.equal(result.status, "scheduled"); assert.equal(result.scheduleId, "sched-1"); assert.equal(result.runAt, at);
  assert.match(result.message, /^已安排 明天 05:02 续跑。/);
  assert.deepEqual(host.sent, [{ type: "schedule/create", prompt: RESUME_PROMPT, name: "恢复后续跑 · 修复登录", cadence: { type: "cron", expression: "2 12 11 * *", timezone: "UTC" },
    target: { type: "agent", agentId: A }, maxRuns: 1, expiresAt: iso(Date.parse(at) + RESUME_WINDOW_MS), responseType: "schedule/create/response" }]);
  assert.equal(host.schedules.get("sched-1")!.nextRunAt, at);
  assert.equal((await createResume(host.paseo, host.bridge, { agentId: C, at }, now0)).status, "failed", "an Agent the host does not know");
  assert.match((await createResume(host.paseo, host.bridge, { agentId: B, at }, now0)).message, /已归档/);
  assert.match((await createResume(host.paseo, host.bridge, { agentId: A, at: "2026-10-11T03:00:00.000Z" }, now0)).message, /唤醒时间/);
  assert.equal(host.sent.length, 1, "nothing else was sent");
  // A host that would wake it at another time: the heartbeat is deleted again and nothing stays scheduled.
  host.skew = 60;
  const skewed = await createResume(host.paseo, host.bridge, { agentId: A, at, timeZone: "US/Pacific" }, now0);
  assert.equal(skewed.status, "failed");
  assert.match(skewed.message, /宿主算出的唤醒时间是 明天 06:02，和确认的 明天 05:02 不一致，已撤销/);
  assert.deepEqual(host.sent.slice(1).map(message => message.type), ["schedule/create", "schedule/delete"]);
  assert.deepEqual([...host.schedules.keys()], ["sched-1"]);
  // No answer: it may have been made. It comes back scheduled without a heartbeat, a resume to confirm for the ledger to record,
  // nothing looked for or made again here, and the reply promises no remake (codex-obs-resume-recheck11-F3, recheck12).
  let asked = 0;
  const unconfirmed = await createResume(host.paseo, { request: async () => { asked++; throw new Error("宿主拒绝了子任务读取请求"); } }, { agentId: A, at }, now0);
  assert.deepEqual([unconfirmed.status, unconfirmed.scheduleId, unconfirmed.runAt, unconfirmed.message, asked],
    ["scheduled", null, at, "安排续跑时宿主没有回话（宿主拒绝了续跑读取请求），还不知道续跑建好没有。已记下 12:02 的续跑：观测台会在下一分钟核对，确认不了时，停下卡片上会请你到 Paseo 的「计划」里查看。", 1]);
});

test("one waiting resume per Agent: a second tap, a second device or a 2.13 heartbeat returns the one already waiting (opus-F38)", async () => withLedger(async (host, ledger) => {
  const at = "2026-10-11T12:02:00.000Z";
  const first = await ledger.schedule(host.paseo, { agentId: A, at, timeZone: "US/Pacific", stopAt: "2026-10-11T03:59:00.000Z" });
  assert.equal(first.status, "scheduled"); assert.equal(first.entry?.status, "scheduled"); assert.equal(first.entry?.attempt, 1);
  const again = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T14:00:00.000Z", timeZone: "US/Pacific" });
  assert.equal(again.existing, true); assert.equal(again.scheduleId, first.scheduleId); assert.equal(again.runAt, at);
  assert.match(again.message, /已在 明天 05:02 安排续跑，没有重复安排/);
  // Two devices at once.
  const [one, two] = await Promise.all([ledger.schedule(host.paseo, { agentId: B, at }), ledger.schedule(host.paseo, { agentId: B, at })]);
  assert.equal(one.scheduleId, two.scheduleId);
  assert.equal(host.creates().length, 2, "one heartbeat each for A and B");
  // A heartbeat 2.13 made for C (in the device's zone) is adopted; a dead one moved a month out is removed.
  const old = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: C }, nextRunAt: iso(now0 + 3 * HOUR) });
  const dead = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: C }, nextRunAt: "2026-11-11T12:02:00.000Z" });
  const adopted = await ledger.schedule(host.paseo, { agentId: C, at });
  assert.equal(adopted.existing, true); assert.equal(adopted.scheduleId, old.id);
  assert.equal(host.creates().length, 2, "nothing new for C");
  assert.equal(host.schedules.has(dead.id), false);
  assert.deepEqual((await ledger.list()).map(entry => [entry.agentId, entry.status]).sort(), [[A, "scheduled"], [B, "scheduled"], [C, "scheduled"]]);
}));

test("a 2.13 heartbeat due this very minute is adopted rather than doubled; one long past is removed unless it is running", async () => withLedger(async (host, ledger) => {
  const due = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, nextRunAt: iso(host.now - MINUTE) });
  const adopted = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  assert.equal(adopted.scheduleId, due.id); assert.equal(adopted.existing, true);
  const stale = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: B }, nextRunAt: iso(host.now - HOUR) });
  const fresh = await ledger.schedule(host.paseo, { agentId: B, at: "2026-10-11T12:02:00.000Z" });
  assert.notEqual(fresh.scheduleId, stale.id); assert.equal(host.schedules.has(stale.id), false);
  // One whose wake passed long ago and is still active is waking the Agent right now (a one-off keeps its wake until the run ends).
  const waking = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: C }, nextRunAt: iso(host.now - HOUR) });
  waking.runs.push({ id: "run-x", scheduledFor: waking.nextRunAt!, startedAt: waking.nextRunAt!, endedAt: null, status: "running", agentId: null, output: null, error: null });
  await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T12:30:00.000Z" });
  assert.equal(host.schedules.has(waking.id), true, "never deleted mid-run");
  assert.equal(host.creates().length, 2);
}));

test("only this Agent's own one-off 恢复后续跑 heartbeats are adopted, deleted or cancelled: a recurring copy or another prompt is the user's (F7)", async () => withLedger(async (host, ledger) => {
  const recurring = host.add({ name: "恢复后续跑 · 修复登录（每天）", target: { type: "agent", agentId: A }, maxRuns: null, cadence: { type: "cron", expression: "0 9 * * *", timezone: "US/Pacific" }, nextRunAt: iso(now0 + 2 * HOUR) });
  const reworded = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, prompt: "继续做发布检查", nextRunAt: iso(now0 + 2 * HOUR) });
  const farCopy = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, maxRuns: 3, nextRunAt: "2026-11-11T12:02:00.000Z" });
  const scheduled = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  assert.equal(scheduled.existing, undefined, "none of them is adopted");
  assert.ok(![recurring.id, reworded.id, farCopy.id].includes(scheduled.scheduleId!));
  assert.deepEqual([recurring.id, reworded.id, farCopy.id].map(id => host.schedules.has(id)), [true, true, true], "nor deleted, even the one far out");
  for (const id of [recurring.id, reworded.id]) assert.match((await ledger.cancel(host.paseo, { agentId: B, scheduleId: id })).message, /不是这个 Agent 的「恢复后续跑」心跳，没有删除/);
  // The ledger's own heartbeat goes once it went in; the user's stay.
  host.now = Date.parse("2026-10-11T12:02:00Z");
  await host.tick(); await ledger.check();
  assert.equal((await entryOf(ledger, A)).status, "delivered");
  assert.deepEqual([...host.schedules.keys()].sort(), [recurring.id, reworded.id, farCopy.id].sort());
}));

test("a busy Agent is tried again ten minutes later, and only a run that went in counts (grok-F5)", async () => withLedger(async (host, ledger) => {
  const scheduled = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z", stopAt: "2026-10-11T03:59:00.000Z" });
  host.now = Date.parse("2026-10-11T12:02:00Z");
  await ledger.check();
  assert.equal((await entryOf(ledger, A)).status, "scheduled", "due, not yet run");
  host.busy.add(A);
  await host.tick();
  assert.equal(host.schedules.get(scheduled.scheduleId!)!.status, "completed", "the failed run used up maxRuns");
  host.now += 30_000;
  await ledger.check();
  const retry = await entryOf(ledger, A);
  assert.deepEqual([retry.status, retry.reason, retry.attempt, retry.wakeAt, retry.plannedAt], ["retrying", "busy", 2, "2026-10-11T12:13:00.000Z", "2026-10-11T12:02:00.000Z"]);
  assert.equal(host.schedules.has(scheduled.scheduleId!), false, "the spent heartbeat is deleted");
  const second = host.schedules.get(retry.scheduleId!)!;
  assert.deepEqual([second.name, second.cadence.expression, second.cadence.timezone, second.maxRuns, second.nextRunAt], ["恢复后续跑 · 修复登录（第 2 次）", "13 12 11 * *", "UTC", 1, "2026-10-11T12:13:00.000Z"]);
  assert.equal(second.expiresAt, iso(Date.parse("2026-10-11T12:02:00Z") + RESUME_WINDOW_MS), "the window counts from the first wake");
  assert.deepEqual(resumeLook(retry, clock), { hue: "amber", icon: "Hourglass", pill: "正忙 · 12:13 再试", text: "到点时它正忙，续跑提示没送出；12:13 再试（第 2 次）。", cancellable: true, again: false, pending: true });
  // The turn it was busy with ended (a background job, not the user: lastUserMessageAt stayed before the stop).
  host.busy.delete(A);
  host.now = Date.parse("2026-10-11T12:13:00Z");
  await host.tick(); await ledger.check();
  const done = await entryOf(ledger, A);
  assert.deepEqual([done.status, done.deliveredAt, done.attempt], ["delivered", "2026-10-11T12:13:00.000Z", 2]);
  assert.equal(resumeLook(done, clock).pill, "已续跑 · 12:13");
  assert.equal(host.prompts.get(A), 1);
  assert.equal(host.schedules.has(second.id), false, "deleted once it went in (F2)");
  const sent = host.sent.length;
  await ledger.check();
  assert.equal(host.sent.length, sent, "nothing is checked once it went in");
}));

test("a prompt that went in while the limit still holds is sent once, not every ten minutes for six hours (F1)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  await ledger.schedule(host.paseo, { agentId: A, at: iso(planned), stopAt: "2026-10-11T03:59:00.000Z" });
  // The reset was a guess: the turn the prompt opens fails on the limit again, and the run's error is the Agent's last reply.
  host.failing.set(A, LIMIT_REPLY);
  for (host.now = planned - MINUTE; host.now <= planned + 7 * HOUR; host.now += MINUTE) { await host.tick(); await ledger.check(); }
  const entry = await entryOf(ledger, A);
  assert.equal(host.prompts.get(A), 1, "one prompt");
  assert.deepEqual([entry.status, entry.deliveredAt, entry.attempt], ["delivered", iso(planned), 1]);
  assert.equal(host.creates().length, 1);
  assert.equal(resumeLook(entry, clock).text, "12:02 已把续跑提示送进会话。");
  assert.equal(host.live(A).length, 0);
}));

test("a restart in the middle of the resumed turn is never sent again: 已续跑 when its prompt is in the session's own log, else 未能确认 (F1, codex-obs-resume-F2)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  for (const id of [A, B]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned) });
  const [a, b] = [await entryOf(ledger, A), await entryOf(ledger, B)];
  assert.deepEqual([a.wakeAt, b.wakeAt], [iso(planned), iso(planned + MINUTE)], "never two resumes in one minute (F2)");
  host.holding.add(A); host.holding.add(B);
  // A runs on a provider whose session log holds the prompt; B on one that keeps none the plugin reads (an ACP one), and its
  // hook is lost too (the plugin was reloading). Both prompts went in.
  host.noLog.add(B);
  host.now = planned; await host.tick();
  host.onTurn = async () => {};
  host.now = planned + MINUTE; await host.tick();
  host.onTurn = (agentId, at, turnId) => ledger.noteTurn(agentId, at, turnId);
  await ledger.check();
  const [deliveredA, wakingB] = [await entryOf(ledger, A), await entryOf(ledger, B)];
  assert.deepEqual([deliveredA.status, deliveredA.deliveredAt], ["delivered", iso(planned)], "delivered while the turn still runs: its prompt is in the log");
  assert.deepEqual([...new Set(host.markerReads)], ["tail"], "while a run goes only the logs' tails are read");
  assert.equal(host.schedules.has(a.scheduleId!), true, "a running heartbeat is not deleted");
  assert.equal(wakingB.status, "waking");
  assert.equal(resumeLook(wakingB, () => "12:03").cancellable, false, "not while it wakes the Agent");
  // The daemon restarts mid-turn: both runs fail "Daemon restarted before the scheduled run completed".
  host.now = Date.parse("2026-10-11T12:20:00Z");
  host.restart(); host.holding.clear();
  const creates = host.creates().length;
  await ledger.check();
  assert.equal((await entryOf(ledger, A)).status, "delivered");
  assert.equal(host.schedules.has(a.scheduleId!), false, "its heartbeat goes once the run ended (F2)");
  // Nothing ties anything to B's run, a hook or not: 未能确认, for the user to look and decide.
  const unsureB = await entryOf(ledger, B);
  assert.deepEqual([unsureB.status, unsureB.reason, unsureB.attempt, unsureB.deliveredAt], ["failed", "restart-unsure", 1, null]);
  assert.deepEqual(resumeLook(unsureB, clock), { hue: "amber", icon: "CircleHelp", pill: "未能确认续跑",
    text: "宿主重启打断了这次续跑，没能确认续跑是否送达。为免重复，观测台不会自动重发；先看一下会话，需要时再「重新安排」。", cancellable: false, again: true, pending: false });
  assert.equal(host.creates().length, creates, "no retry heartbeat");
  assert.equal(host.live(B).length, 0, "the spent heartbeat (moved a month out by the host) is deleted");
  for (host.now = Date.parse("2026-10-11T12:21:00Z"); host.now <= Date.parse("2026-10-11T13:00:00Z"); host.now += MINUTE) { await host.tick(); await ledger.check(); }
  assert.deepEqual([host.prompts.get(A), host.prompts.get(B)], [1, 1], "neither prompt is sent twice");
  // 重新安排 is the user's call, and starts over.
  const again = await ledger.schedule(host.paseo, { agentId: B, at: iso(host.now + 10 * MINUTE) });
  assert.deepEqual([again.existing, again.entry?.status, again.entry?.attempt], [undefined, "scheduled", 1]);
}));

test("after a restart, only proof read without loading the Agent settles it: the prompt in the provider's own log is 已续跑, attention raised since is not (codex-obs-resume-F2, recheck-F1)", async () => {
  const markers: Array<[string[], string]> = [];
  let logged = new Set<string>();
  const logs: SessionLogs = { findMarker: async (sessionIds, marker) => { markers.push([[...sessionIds], marker]); return sessionIds.some(id => logged.has(`${id} ${marker}`)) ? "found" : "absent"; } };
  await withLedger(async (host, ledger, directory) => {
    const planned = Date.parse("2026-10-11T12:02:00Z");
    for (const id of [A, B, C, D, E]) {
      host.agents.get(id)!.persistence = { provider: "my-claude", sessionId: `session-${id.slice(-1)}` };
      await ledger.schedule(host.paseo, { agentId: id, at: iso(planned), stopAt: "2026-10-11T03:59:00.000Z" });
    }
    // Every prompt goes in, and every turn_started is lost: the plugin is down with the daemon.
    for (const id of [A, B, C, D, E]) host.holding.add(id);
    host.onTurn = async () => {};
    for (host.now = planned; host.now <= planned + 4 * MINUTE; host.now += MINUTE) await host.tick();
    const runs = Object.fromEntries(await Promise.all([A, B].map(async id => [id, host.schedules.get((await entryOf(ledger, id)).scheduleId!)!.runs[0]!])));
    const fired = async (id: string, run: { id: string }) => `fired (id=${(await entryOf(ledger, id)).scheduleId}, run=${run.id}).`;
    // A: attention raised after its run began, which another turn (a subagent's notification) or the user marking it unread
    // raises as well: no proof of this run (codex-obs-resume-recheck-F1). B: the prompt is in its log, with its run's ids.
    host.agents.get(A)!.attentionTimestamp = iso(Date.parse(runs[A].startedAt) + 40_000);
    logged = new Set([`session-b ${await fired(B, runs[B])}`, `session-a run=${runs[A].id}`]);
    // C: attention from the stop itself (raised before the run, still unread) proves nothing; neither does a log without it.
    host.agents.get(C)!.attentionTimestamp = "2026-10-11T03:59:00.000Z";
    // D: the user carried on by hand since the stop. E: the logs cannot be read.
    host.agents.get(D)!.lastUserMessageAt = "2026-10-11T12:10:00.000Z";
    host.now = Date.parse("2026-10-11T12:20:00Z");
    host.restart(); host.holding.clear();
    await ledger.close();
    // The plugin comes back with the daemon: until an RPC or a hook lends it a context, nothing can be read, so nothing is decided.
    const unreadable: SessionLogs = { findMarker: async (ids, marker) => { const found = await logs.findMarker(ids, marker); if (ids[0] === "session-e") throw new Error("EACCES"); return found; } };
    const reloaded = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {}, logs: unreadable });
    try {
      await reloaded.check();
      assert.deepEqual((await reloaded.list()).map(entry => entry.status), ["scheduled", "scheduled", "scheduled", "scheduled", "scheduled"]);
      assert.equal(markers.length, 0, "no log is read without the Agent's session");
      reloaded.notePaseo(host.paseo);
      await reloaded.check();
      const entries = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async id => [id, await entryOf(reloaded, id)])));
      assert.deepEqual([A, B, C, D, E].map(id => [entries[id].status, entries[id].reason]), [["failed", "restart-unsure"], ["delivered", null], ["failed", "restart-unsure"], ["canceled", "resumed"], ["failed", "restart-unsure"]]);
      assert.equal(entries[B].deliveredAt, runs[B].startedAt, "delivered when its run began");
      // Looked for by the schedule's and the run's ids together (a bare run id elsewhere in A's log is no proof), in the Agent's own session.
      assert.deepEqual(markers.map(([ids, marker]) => [ids, marker.replace(/id=[\w-]+, run=[\w-]+/, "id=<schedule>, run=<run>")]),
        ["a", "b", "c", "d", "e"].map(key => [[`session-${key}`], "fired (id=<schedule>, run=<run>)."]), "only the run's ids, only the Agent's own session");
      assert.deepEqual([A, B, C, D, E].map(id => host.prompts.get(id)), [1, 1, 1, 1, 1]);
      assert.deepEqual([A, B, C, D, E].map(id => host.live(id).length), [0, 0, 0, 0, 0], "every spent heartbeat is deleted");
      for (host.now = Date.parse("2026-10-11T12:21:00Z"); host.now <= Date.parse("2026-10-11T12:40:00Z"); host.now += MINUTE) { await host.tick(); await reloaded.check(); }
      assert.equal(host.creates().length, 5, "nothing is made again");
    } finally { await reloaded.close(); }
  });
});

test("a restart without a context for six hours is 未能确认 at the end of the window, not left waiting (codex-obs-resume-F2)", async () => withLedger(async (host, ledger, directory) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  await ledger.schedule(host.paseo, { agentId: A, at: iso(planned) });
  host.holding.add(A); host.onTurn = async () => {};
  host.now = planned; await host.tick();
  host.now = planned + 5 * MINUTE; host.restart(); host.holding.clear();
  await ledger.close();
  const reloaded = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {} });
  try {
    await reloaded.check();
    assert.equal((await entryOf(reloaded, A)).status, "scheduled");
    host.now = planned + RESUME_WINDOW_MS + MINUTE;
    await reloaded.check();
    assert.deepEqual([(await entryOf(reloaded, A)).status, (await entryOf(reloaded, A)).reason, host.prompts.get(A), host.creates().length], ["failed", "restart-unsure", 1, 1]);
  } finally { await reloaded.close(); }
}));

test("a turn seen while the heartbeat wakes the Agent proves nothing: a system notification's, or one whose source cannot be read, is never 已续跑 (codex-obs-resume-recheck-F1)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  for (const id of [A, B]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned), stopAt: "2026-10-11T03:59:00.000Z" });
  const [a, b] = [await entryOf(ledger, A), await entryOf(ledger, B)];
  // The host has written each run as running and is still loading the Agent: no prompt has gone out. A subagent finishing
  // notifies A meanwhile (a system notification: a turn, and no message time); B's snapshots cannot be read at all.
  host.now = planned; host.fire(a.scheduleId!, "running");
  host.now = planned + MINUTE; host.fire(b.scheduleId!, "running");
  host.now += 1000;
  await ledger.noteTurn(A, host.now, "turn-from-subagent-notification");
  host.unreadable = true;
  await ledger.noteTurn(B, host.now, "turn-with-unknown-origin");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, (await entryOf(ledger, B)).status], ["waking", "waking"], "no proof: still waking");
  // The host's runner then finds A busy with the notification's turn: tried again, as for any busy Agent (the user wrote nothing).
  host.now += 20_000;
  host.end(a.scheduleId!, "failed", `Agent ${A} already has an active run`);
  host.unreadable = false;
  await ledger.check();
  const retry = await entryOf(ledger, A);
  assert.deepEqual([retry.status, retry.reason, retry.attempt, retry.deliveredAt], ["retrying", "busy", 2, null]);
  host.now = Date.parse(retry.wakeAt); await host.tick(); await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, host.prompts.get(A)], ["delivered", 1], "the retry's own prompt went in, and only it");
  // B's run ends in an error that may have come after its prompt, with nothing to read: 未能确认, never 已续跑, never sent again.
  host.unreadable = true;
  host.end(b.scheduleId!, "failed", "Provider connection lost");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, B)).status, (await entryOf(ledger, B)).reason], ["failed", "unsure"]);
  host.unreadable = false;
  const creates = host.creates().length;
  for (let minute = 0; minute < 30; minute++) { host.now += MINUTE; await host.tick(); await ledger.check(); }
  assert.equal(host.creates().length, creates, "nothing made again");
  // A load the host timed out ended a run before any turn; a turn the user started afterwards changes nothing.
  const late = await ledger.schedule(host.paseo, { agentId: C, at: iso(host.now + 10 * MINUTE) });
  host.now = Date.parse(late.runAt!);
  host.fire(late.scheduleId!, "failed", "Timed out refreshing Claude after 30000ms");
  host.now += MINUTE;
  await ledger.noteTurn(C, host.now);
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, C)).status, (await entryOf(ledger, C)).reason], ["retrying", "error"]);
}));

test("a wake the host missed (down that minute, then restarted) is retried two minutes later, after deleting the heartbeat the host moved a month out", async () => withLedger(async (host, ledger) => {
  const scheduled = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  host.now = Date.parse("2026-10-11T12:40:00Z");
  host.restart();
  assert.equal(host.schedules.get(scheduled.scheduleId!)!.nextRunAt, "2026-11-11T12:02:00.000Z", "the host's own recovery: the cron's next match");
  const before = host.sent.length;
  await ledger.check();
  const retry = await entryOf(ledger, A);
  assert.deepEqual([retry.status, retry.reason, retry.attempt, retry.wakeAt], ["retrying", "missed", 2, "2026-10-11T12:42:00.000Z"]);
  assert.deepEqual(host.sent.slice(before).map(message => message.type), ["schedule/inspect", "schedule/delete", "schedule/list", "schedule/create"], "never two heartbeats that could fire");
  assert.deepEqual([...host.schedules.keys()], [retry.scheduleId]);
  // Active, but past its minute with no run: missed as well.
  host.now = Date.parse("2026-10-11T12:46:00Z");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).reason, (await entryOf(ledger, A)).attempt], ["missed", 3]);
  // Completed without any run (its expiry passed while the host was down).
  const third = await entryOf(ledger, A);
  Object.assign(host.schedules.get(third.scheduleId!)!, { status: "completed", nextRunAt: null });
  host.now = Date.parse("2026-10-11T12:50:00Z");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).reason, (await entryOf(ledger, A)).attempt], ["missed", 4]);
}));

test("resumes are kept a minute apart, so the host's overlapping ticks never run one twice; a finished heartbeat is deleted at once (F2)", async () => withLedger(async (host, ledger) => {
  // Several Agents on one account hit the same limit: every card offers the same wake. Another kind of heartbeat wakes at 12:04.
  const daily = host.add({ name: "每日巡检", target: { type: "agent", agentId: E }, maxRuns: null, prompt: "巡检", cadence: { type: "cron", expression: "4 12 * * *", timezone: "UTC" }, nextRunAt: "2026-10-11T12:04:00.000Z" });
  const results = [];
  for (const id of [A, B, C, D]) results.push(await ledger.schedule(host.paseo, { agentId: id, at: "2026-10-11T12:02:00.000Z", timeZone: "UTC" }));
  assert.deepEqual(results.map(result => result.runAt), ["2026-10-11T12:02:00.000Z", "2026-10-11T12:03:00.000Z", "2026-10-11T12:05:00.000Z", "2026-10-11T12:06:00.000Z"]);
  assert.equal(results[0]!.message.includes("顺延"), false);
  assert.match(results[1]!.message, /^已安排 12:03 续跑（12:02 已有别的定时任务，顺延 1 分钟）。/);
  assert.match(results[2]!.message, /^已安排 12:05 续跑（12:02 已有别的定时任务，顺延 3 分钟）。/);
  assert.deepEqual(results.map(result => result.entry?.plannedAt), results.map(result => result.runAt), "the window counts from the real wake");
  // A daemon restart missed them all: the retries are planned in one pass, still a minute apart.
  host.now = Date.parse("2026-10-11T12:40:00Z");
  host.restart();
  await ledger.check();
  const wakes = await Promise.all([A, B, C, D].map(async id => (await entryOf(ledger, id)).wakeAt));
  assert.deepEqual(wakes, ["2026-10-11T12:42:00.000Z", "2026-10-11T12:43:00.000Z", "2026-10-11T12:44:00.000Z", "2026-10-11T12:45:00.000Z"]);
  assert.equal(new Set([...host.schedules.values()].filter(schedule => schedule.status === "active").map(schedule => schedule.nextRunAt)).size, 5, "no two live heartbeats share a minute");
  // A goes in; a host tick that listed A before it ran reaches it afterwards: its file is gone, so nothing runs twice.
  host.now = Date.parse("2026-10-11T12:42:00Z");
  await host.tick(); await ledger.check();
  const a = await entryOf(ledger, A);
  assert.equal(a.status, "delivered");
  assert.equal(await host.staleRun(a.scheduleId!), false);
  assert.equal(host.prompts.get(A), 1);
  assert.equal(host.schedules.has(daily.id), true);
  assert.equal(freeMinute(Date.parse("2026-10-11T12:02:00Z"), new Set()), Date.parse("2026-10-11T12:02:00Z"));
}));

test("one allocator for every Agent's wake: two Agents asked at once, or a retry racing a first wake, never share a minute; a minute stays held while its create is out (codex-obs-resume-F1)", async () => withLedger(async (host, ledger) => {
  const [F, G, H] = ["6f1c2a3b-0000-4000-8000-00000000000f", "6f1c2a3b-0000-4000-8000-000000000010", "6f1c2a3b-0000-4000-8000-000000000011"];
  for (const id of [F, G, H]) host.agents.set(id, { title: "整理日志", archivedAt: null, lastUserMessageAt: iso(now0 - HOUR) });
  // Both schedule/list answers come back empty, and neither create is answered before the other went out.
  const together = () => { const all = gate(); let arrived = 0; host.before = async message => { if (message.type !== "schedule/create") return; if (++arrived === 2) all.open(); await all.wait; }; };
  together();
  const [a, b] = await Promise.all([A, B].map(agentId => ledger.schedule(host.paseo, { agentId, at: "2026-10-11T12:02:00.000Z", timeZone: "UTC" })));
  assert.deepEqual([a!.runAt, b!.runAt], ["2026-10-11T12:02:00.000Z", "2026-10-11T12:03:00.000Z"]);
  assert.match(b!.message, /^已安排 12:03 续跑（12:02 已有别的定时任务，顺延 1 分钟）。/);
  assert.equal(new Set([...host.schedules.values()].map(schedule => schedule.nextRunAt)).size, 2, "two heartbeats, two minutes");
  // C's retry (busy at 12:30, ten minutes on) and D's first wake both want 12:41.
  await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T12:30:00.000Z" });
  host.now = Date.parse("2026-10-11T12:30:00Z"); host.busy.add(C); await host.tick(); host.busy.delete(C);
  host.now = Date.parse("2026-10-11T12:30:30Z");
  together();
  const [, d] = await Promise.all([ledger.check(), ledger.schedule(host.paseo, { agentId: D, at: "2026-10-11T12:41:00.000Z", timeZone: "UTC" })]);
  const c = await entryOf(ledger, C);
  assert.deepEqual([c.status, c.reason, c.attempt], ["retrying", "busy", 2]);
  assert.deepEqual([c.wakeAt, d.runAt].sort(), ["2026-10-11T12:41:00.000Z", "2026-10-11T12:42:00.000Z"]);
  host.before = async () => {};
  // A create the host refused made nothing: its minute is free again at once.
  host.deny.set("schedule/create", 1);
  assert.match((await ledger.schedule(host.paseo, { agentId: E, at: "2026-10-11T13:00:00.000Z", timeZone: "UTC" })).message, /宿主没有建立续跑：宿主拒绝了这个请求/);
  assert.equal((await ledger.schedule(host.paseo, { agentId: F, at: "2026-10-11T13:00:00.000Z", timeZone: "UTC" })).runAt, "2026-10-11T13:00:00.000Z");
  // A create whose answer never came may have made one: recorded as a resume to confirm, whose wake keeps its minute
  // (codex-obs-resume-recheck11-F3).
  host.refuse.set("schedule/create", 1);
  const g = await ledger.schedule(host.paseo, { agentId: G, at: "2026-10-11T13:10:00.000Z", timeZone: "UTC" });
  assert.deepEqual([g.status, g.scheduleId, (await entryOf(ledger, G)).wakeAt], ["scheduled", null, "2026-10-11T13:10:00.000Z"]);
  assert.equal((await ledger.schedule(host.paseo, { agentId: H, at: "2026-10-11T13:10:00.000Z", timeZone: "UTC" })).runAt, "2026-10-11T13:11:00.000Z");
  assert.equal(new Set([...host.schedules.values()].filter(schedule => schedule.status === "active").map(schedule => schedule.nextRunAt)).size,
    [...host.schedules.values()].filter(schedule => schedule.status === "active").length, "no two live heartbeats share a minute");
}));

test("a retry whose schedule/create answer was lost takes over the heartbeat the host made instead of making a second one (F4)", async () => withLedger(async (host, ledger) => {
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z", stopAt: "2026-10-11T03:59:00.000Z" });
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.busy.add(A); await host.tick(); host.busy.delete(A);
  // The host makes the retry, then the plugin session reconnects and the answer never arrives.
  host.lose.set("schedule/create", 1);
  host.now = Date.parse("2026-10-11T12:02:30Z");
  await ledger.check();
  const pending = await entryOf(ledger, A);
  assert.deepEqual([pending.status, pending.scheduleId, pending.attempt, pending.wakeAt], ["retrying", null, 2, "2026-10-11T12:13:00.000Z"]);
  assert.equal(resumeLook(pending, clock).pill, "正在重排");
  host.now = Date.parse("2026-10-11T12:03:30Z");
  await ledger.check();
  const claimed = await entryOf(ledger, A), live = host.live(A);
  assert.equal(host.creates().length, 2, "no second retry heartbeat");
  assert.deepEqual([live.length, claimed.scheduleId, claimed.wakeAt, claimed.attempt], [1, live[0]!.id, "2026-10-11T12:13:00.000Z", 2]);
  host.now = Date.parse("2026-10-11T12:13:00Z");
  await host.tick(); await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, host.prompts.get(A)], ["delivered", 1]);
}));

test("a lost retry that already woke the Agent while the host could not be read is taken over as it went, not made again (F4)", async () => withLedger(async (host, ledger) => {
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.busy.add(A); await host.tick(); host.busy.delete(A);
  host.lose.set("schedule/create", 1);
  host.now = Date.parse("2026-10-11T12:02:30Z");
  await ledger.check();
  // Unreadable for a while: the orphan fires on time, its prompt goes in and the turn fails on the limit again.
  host.refuse.set("schedule/list", 2);
  host.failing.set(A, LIMIT_REPLY);
  host.now = Date.parse("2026-10-11T12:12:00Z"); await ledger.check();
  host.now = Date.parse("2026-10-11T12:13:00Z"); await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).scheduleId, (await entryOf(ledger, A)).wakeAt], [null, "2026-10-11T12:13:00.000Z"], "the wake stays the time asked of the host");
  await host.tick();
  host.now = Date.parse("2026-10-11T12:14:00Z");
  await ledger.check();
  const entry = await entryOf(ledger, A);
  assert.deepEqual([entry.status, entry.deliveredAt, host.prompts.get(A), host.creates().length], ["delivered", "2026-10-11T12:13:00.000Z", 1, 2]);
  assert.equal(host.live(A).length, 0);
}));

test("a lost retry that a restart moved a month out is this attempt's own, judged as read like any of the ledger's: its wake missed, it is deleted and the next one is made (F4, codex-obs-resume-recheck9-F1)", async () => withLedger(async (host, ledger) => {
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.busy.add(A); await host.tick(); host.busy.delete(A);
  host.lose.set("schedule/create", 1);
  host.now = Date.parse("2026-10-11T12:02:30Z");
  await ledger.check();
  const orphan = host.live(A)[0]!;
  // The daemon is down over the orphan's 12:13 and moves it to next month when it comes back.
  host.now = Date.parse("2026-10-11T12:20:00Z");
  host.restart();
  assert.equal(host.schedules.get(orphan.id)!.nextRunAt, "2026-11-11T12:13:00.000Z");
  await ledger.check();
  // Its cron still fires at 12:13, the time asked: the host moved it, not the user. Missed like any of the ledger's own: the third
  // attempt two minutes on.
  const entry = await entryOf(ledger, A), live = host.live(A);
  assert.deepEqual([host.schedules.has(orphan.id), live.length, entry.scheduleId, entry.wakeAt, entry.attempt, entry.reason], [false, 1, live[0]!.id, "2026-10-11T12:22:00.000Z", 3, "missed"]);
  assert.match(live[0]!.name!, /（第 3 次）$/);
}));

test("a run that failed after the prompt went in counts; any other failure is 未能确认 and never sent again on its own (F1)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  for (const id of [A, B, C, D, E]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned) });
  const ids = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async id => [id, (await entryOf(ledger, id)).scheduleId!])));
  host.now = planned + 5 * MINUTE;
  // A: its turn failed with A's last reply, and its prompt is in the session's log. B: no assistant message yet, the host's own
  // fallback text (written only after the prompt went in).
  host.fire(ids[A], "failed", LIMIT_REPLY);
  host.write(A, `<paseo-system>\nSchedule "恢复后续跑 · 修复登录" fired (id=${ids[A]}, run=${host.schedules.get(ids[A])!.runs[0]!.id}).\n${RESUME_PROMPT}\n</paseo-system>`);
  host.fire(ids[B], "failed", `Scheduled agent ${B} failed`);
  // C: a failure with any text, a turn seen meanwhile (anyone's), nothing in its log: it may well be in, nothing proves it.
  await ledger.noteTurn(C, host.now); host.fire(ids[C], "failed", "Provider session could not be started");
  // D: the host timed out loading it, before any prompt. E: an ACP session its provider cannot load again.
  host.fire(ids[D], "failed", "Timed out refreshing Claude after 30000ms");
  host.fire(ids[E], "failed", "my-acp does not support ACP session resume");
  await ledger.check();
  const entries = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async id => [id, await entryOf(ledger, id)])));
  assert.deepEqual([A, B, C, D, E].map(id => [entries[id].status, entries[id].reason]), [["delivered", null], ["delivered", null], ["failed", "unsure"], ["retrying", "error"], ["failed", "error"]]);
  assert.equal(entries[A].deliveredAt, iso(host.now), "when its run began");
  assert.equal(entries[D].wakeAt, "2026-10-11T12:17:00.000Z", "a load error waits ten minutes, like a busy Agent");
  assert.deepEqual(resumeLook(entries[C], clock), { hue: "amber", icon: "CircleHelp", pill: "未能确认续跑", text: "宿主报告这次续跑出错，提示可能已经送进会话；先看一下会话，需要时再「重新安排」。",
    cancellable: false, again: true, pending: false });
  assert.deepEqual([resumeLook(entries[E], clock).hue, resumeLook(entries[E], clock).text, resumeLook(entries[E], clock).again], ["red", "宿主没能载入它（ACP 会话不能重新载入），续跑没送出。", false]);
  assert.equal(resumeLook(entries[D], clock).text, "宿主没能载入它，续跑提示没送出；12:17 再试（第 2 次）。");
  assert.equal(host.creates().length, 6, "only D's retry is made");
  assert.deepEqual([A, B, C, E].map(id => host.schedules.has(ids[id])), [false, false, false, false], "finished heartbeats are deleted");
  // 重新安排 after 未能确认 starts over.
  const again = await ledger.schedule(host.paseo, { agentId: C, at: iso(host.now + 30 * MINUTE) });
  assert.deepEqual([again.existing, again.entry?.status, again.entry?.attempt], [undefined, "scheduled", 1]);
}));

/** The fire line the host wrote into this Agent's session for the heartbeat's latest run: proof that run's prompt went in. */
function promptLogged(host: FakeHost, agentId: string, scheduleId: string): void {
  const schedule = host.schedules.get(scheduleId)!;
  host.write(agentId, `<paseo-system>\nSchedule "${schedule.name}" fired (id=${schedule.id}, run=${schedule.runs.at(-1)!.id}).\n${RESUME_PROMPT}\n</paseo-system>`);
}

test("a failed run's error is the host's only in its own words for this Agent, and proof of this run's prompt comes first: a reply quoting a busy or load-timeout error is never sent again (codex-obs-resume-recheck2-F1)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  for (const id of [A, B, C, D, E]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned) });
  const ids = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async id => [id, (await entryOf(ledger, id)).scheduleId!])));
  host.now = planned + MINUTE;
  // A, B: each prompt went in (its run's fire line is in the session's log), then the turn failed, and the host made the
  // Agent's last reply the run's error: one quoting the host's busy error, one a load timeout.
  host.fire(ids[A], "failed", `The command reported: Agent ${A} already has an active run`); promptLogged(host, A, ids[A]);
  host.fire(ids[B], "failed", "Provider said: Timed out refreshing Claude after 30000ms"); promptLogged(host, B, ids[B]);
  // C, D: the host's own wording, word for word, and yet this run's prompt is in the log: the proof decides.
  host.fire(ids[C], "failed", `Agent ${C} already has an active run`); promptLogged(host, C, ids[C]);
  host.fire(ids[D], "failed", "Timed out refreshing Claude after 30000ms; pending: initialize"); promptLogged(host, D, ids[D]);
  // E: a reply that quotes the busy error, from a provider that keeps no log: nothing tells, so 未能确认, not 正忙.
  host.noLog.add(E);
  host.fire(ids[E], "failed", `Agent ${E} already has an active run.`); promptLogged(host, E, ids[E]);
  await ledger.check();
  const entries = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async id => [id, await entryOf(ledger, id)])));
  assert.deepEqual([A, B, C, D, E].map(id => [entries[id].status, entries[id].reason]), [["delivered", null], ["delivered", null], ["delivered", null], ["delivered", null], ["failed", "unsure"]]);
  assert.equal(entries[A].deliveredAt, iso(planned + MINUTE), "when its run began");
  for (let minute = 0; minute < 30; minute++) { host.now += MINUTE; await host.tick(); await ledger.check(); }
  assert.equal(host.creates().length, 5, "no heartbeat made again: nothing prompts them a second time");
  assert.equal([A, B, C, D, E].reduce((sum, id) => sum + (host.prompts.get(id) ?? 0), 0), 0, "no run of theirs went again");
  // The host's busy wording naming another Agent is not this Agent's error either; this Agent's own still means busy.
  const other = await ledger.schedule(host.paseo, { agentId: E, at: iso(host.now + 10 * MINUTE) });
  host.now = Date.parse(other.runAt!); host.fire(other.scheduleId!, "failed", `Agent ${A} already has an active run`);
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, E)).status, (await entryOf(ledger, E)).reason], ["failed", "unsure"]);
  // A reply that quotes a load timeout, with nothing in a log: 未能确认, not a load error to try again.
  const quoted = await ledger.schedule(host.paseo, { agentId: E, at: iso(host.now + 10 * MINUTE) });
  host.now = Date.parse(quoted.runAt!); host.fire(quoted.scheduleId!, "failed", "Provider said: Timed out refreshing Claude after 30000ms");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, E)).status, (await entryOf(ledger, E)).reason], ["failed", "unsure"]);
  host.noLog.delete(E);
  const busy = await ledger.schedule(host.paseo, { agentId: E, at: iso(host.now + 10 * MINUTE) });
  host.now = Date.parse(busy.runAt!); host.busy.add(E); await host.tick();
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, E)).status, (await entryOf(ledger, E)).reason], ["retrying", "busy"]);
}));

test("the host's own words count only once the session's log, read whole, shows no prompt: without that, busy, a load timeout, gone, archived or an ACP session that cannot be loaded is 未能确认, unless the Agent itself settles it (codex-obs-resume-recheck3-F1)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  for (const id of [A, B, C, D, E]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned), stopAt: "2026-10-11T03:59:00.000Z" });
  const ids = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async id => [id, (await entryOf(ledger, id)).scheduleId!])));
  host.now = planned + MINUTE;
  // Each run's error is the host's own wording for this Agent, word for word, and nothing can show whether its prompt went in:
  // A, B, D and E run on providers that keep no log the plugin reads (Grok, an ACP one); C's log cannot be opened.
  for (const id of [A, B, D, E]) host.noLog.add(id);
  host.unreadableLogs.add("session-c");
  host.fire(ids[A], "failed", `Agent ${A} already has an active run`);
  host.fire(ids[B], "failed", "Timed out refreshing Grok after 30000ms; pending: initialize");
  host.fire(ids[C], "failed", `Agent ${C} already has an active run`);
  host.fire(ids[D], "failed", `Agent ${D} is archived`);
  host.fire(ids[E], "failed", "acp does not support ACP session resume");
  await ledger.check();
  const entries = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async id => [id, await entryOf(ledger, id)])));
  assert.deepEqual([A, B, C, D, E].map(id => [entries[id].status, entries[id].reason]), [["failed", "unsure"], ["failed", "unsure"], ["failed", "unsure"], ["failed", "unsure"], ["failed", "unsure"]]);
  assert.deepEqual(host.markerReads, ["whole", "whole", "whole", "whole", "whole"], "each decision reads the logs whole");
  assert.deepEqual(resumeLook(entries[A], clock), { hue: "amber", icon: "CircleHelp", pill: "未能确认续跑", text: "宿主报告这次续跑出错，提示可能已经送进会话；先看一下会话，需要时再「重新安排」。",
    cancellable: false, again: true, pending: false }, "重新安排 is offered");
  const creates = host.creates().length;
  for (let minute = 0; minute < 30; minute++) { host.now += MINUTE; await host.tick(); await ledger.check(); }
  assert.equal(host.creates().length, creates, "nothing made again");
  assert.equal([A, B, C, D, E].reduce((sum, id) => sum + (host.prompts.get(id) ?? 0), 0), 0, "no run of theirs went again");
  assert.deepEqual([A, B, C, D, E].map(id => host.schedules.has(ids[id])), [false, false, false, false, false], "their heartbeats are deleted");
  // The Agent itself can settle it: the user carried on by hand since the stop (你已接着做), or it is archived or gone (未能续跑).
  const again = Object.fromEntries(await Promise.all([A, B, C].map(async id => [id, (await ledger.schedule(host.paseo, { agentId: id, at: iso(host.now + 10 * MINUTE), stopAt: "2026-10-11T03:59:00.000Z" })).scheduleId!])));
  host.now += 10 * MINUTE;
  host.agents.get(A)!.lastUserMessageAt = iso(host.now - 5 * MINUTE);
  host.agents.get(B)!.archivedAt = iso(host.now - MINUTE);
  host.fire(again[A], "failed", `Agent ${A} already has an active run`);
  host.fire(again[B], "failed", `Agent ${B} is archived`);
  host.fire(again[C], "failed", `Agent ${C} no longer exists`);
  host.agents.delete(C);
  await ledger.check();
  assert.deepEqual(await Promise.all([A, B, C].map(async id => { const entry = await entryOf(ledger, id); return [entry.status, entry.reason]; })), [["canceled", "resumed"], ["failed", "archived"], ["failed", "gone"]]);
}));

test("a failed run waits for a context to read the Agent with: right after the plugin starts nothing can be read, so nothing is decided (codex-obs-resume-recheck3-F1)", async () => withLedger(async (host, ledger, directory) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  for (const id of [A, B]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned) });
  const ids = Object.fromEntries(await Promise.all([A, B].map(async id => [id, (await entryOf(ledger, id)).scheduleId!])));
  await ledger.close();
  // The plugin restarts (a reload); then A's wake finds it busy, before any prompt; B's prompt goes in and its turn fails with the host's words.
  host.now = planned; host.fire(ids[A], "failed", `Agent ${A} already has an active run`);
  host.now = planned + MINUTE; host.fire(ids[B], "failed", `Agent ${B} already has an active run`); promptLogged(host, B, ids[B]);
  const reloaded = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {}, logs: host.logs });
  try {
    await reloaded.check();
    assert.deepEqual(await Promise.all([A, B].map(async id => (await entryOf(reloaded, id)).status)), ["scheduled", "scheduled"], "nothing decided without the Agents' sessions");
    reloaded.notePaseo(host.paseo);
    await reloaded.check();
    assert.deepEqual(await Promise.all([A, B].map(async id => { const entry = await entryOf(reloaded, id); return [entry.status, entry.reason, entry.attempt]; })), [["retrying", "busy", 2], ["delivered", null, 1]]);
  } finally { await reloaded.close(); }
  // Without a context all through the window: 未能确认 at its end, never left waiting.
  const late = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {}, logs: host.logs });
  try {
    const schedule = (await entryOf(late, A)).scheduleId!;
    host.now = Date.parse((await entryOf(late, A)).wakeAt); host.fire(schedule, "failed", `Agent ${A} already has an active run`);
    await late.check();
    assert.equal((await entryOf(late, A)).status, "retrying");
    host.now = planned + RESUME_WINDOW_MS + MINUTE;
    await late.check();
    assert.deepEqual([(await entryOf(late, A)).status, (await entryOf(late, A)).reason], ["failed", "unsure"]);
  } finally { await late.close(); }
}));

test("取消续跑 also looks for this run's prompt in the log first, whatever its error says (codex-obs-resume-recheck2-F1)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  for (const id of [A, B, C]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned) });
  const ids = Object.fromEntries(await Promise.all([A, B, C].map(async id => [id, (await entryOf(ledger, id)).scheduleId!])));
  host.now = planned + MINUTE;
  // A: the host's own busy wording, and this run's prompt in the log. B: a reply quoting a load timeout, its prompt in the log.
  host.fire(ids[A], "failed", `Agent ${A} already has an active run`); promptLogged(host, A, ids[A]);
  host.fire(ids[B], "failed", "Stopped: Timed out refreshing Claude after 30000ms"); promptLogged(host, B, ids[B]);
  // C: the host's busy error and nothing in the log: cancelled as asked.
  host.fire(ids[C], "failed", `Agent ${C} already has an active run`);
  for (const id of [A, B]) {
    const answer = await ledger.cancel(host.paseo, { agentId: id });
    assert.deepEqual([answer.status, answer.message, answer.entry?.status, answer.entry?.deliveredAt], ["failed", "续跑已经送进会话，不需要取消。", "delivered", iso(planned + MINUTE)], id);
  }
  const canceled = await ledger.cancel(host.paseo, { agentId: C });
  assert.deepEqual([canceled.status, canceled.entry?.status, canceled.entry?.reason, host.schedules.has(ids[C])], ["canceled", "canceled", "user", false]);
}));

test("the user carrying on by hand cancels the resume instead of prompting it again: busy, missed or still waiting (F3)", async () => withLedger(async (host, ledger) => {
  const stopAt = "2026-10-11T03:59:00.000Z";
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z", stopAt });
  await ledger.schedule(host.paseo, { agentId: B, at: "2026-10-11T13:00:00.000Z", stopAt });
  // A: the user saw the limit lift and wrote 继续 at 12:00; that turn is still going when the heartbeat fires, and ends at 12:03.
  host.agents.get(A)!.lastUserMessageAt = "2026-10-11T12:00:00.000Z"; host.busy.add(A);
  for (host.now = Date.parse("2026-10-11T12:02:00Z"); host.now <= Date.parse("2026-10-11T12:30:00Z"); host.now += MINUTE) {
    if (host.now === Date.parse("2026-10-11T12:03:00Z")) host.busy.delete(A);
    await host.tick(); await ledger.check();
  }
  const a = await entryOf(ledger, A);
  assert.deepEqual([a.status, a.reason, host.prompts.get(A) ?? 0, host.live(A).length, host.creates().length], ["canceled", "resumed", 0, 0, 2]);
  assert.deepEqual(resumeLook(a, clock), { hue: "muted", icon: "MessageSquareText", pill: "你已接着做", text: "停下之后你已经给它发过消息，续跑已取消，免得重复。", cancellable: false, again: true, pending: false });
  // B's wake was missed (the daemon was down at 13:00), and the user wrote before the retry.
  host.agents.get(B)!.lastUserMessageAt = "2026-10-11T13:10:00.000Z";
  host.now = Date.parse("2026-10-11T13:20:00Z");
  host.restart(); await ledger.check();
  assert.deepEqual([(await entryOf(ledger, B)).reason, host.live(B).length, host.prompts.get(B) ?? 0], ["resumed", 0, 0]);
  // C waits for tomorrow; the user carries on by hand tonight: the routine look before the wake notices and deletes it.
  const later = await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-12T05:00:00.000Z", stopAt });
  host.now = Date.parse("2026-10-11T22:00:00Z");
  await ledger.check();
  assert.equal((await entryOf(ledger, C)).status, "scheduled", "nothing sent to it yet: still waiting");
  host.agents.get(C)!.lastUserMessageAt = "2026-10-11T22:01:00.000Z";
  host.now = Date.parse("2026-10-11T22:11:00Z");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, C)).reason, host.schedules.has(later.scheduleId!)], ["resumed", false]);
  // A message from before the stop is the one that hit the limit, not the user carrying on.
  host.agents.get(D)!.lastUserMessageAt = "2026-10-11T03:58:00.000Z";
  await ledger.schedule(host.paseo, { agentId: D, at: "2026-10-12T05:00:00.000Z", stopAt });
  host.now = Date.parse("2026-10-11T22:30:00Z");
  await ledger.check();
  assert.equal((await entryOf(ledger, D)).status, "scheduled");
}));

test("the user's own message while the heartbeat wakes the Agent is 你已接着做, never 已续跑; the resume's own prompt still counts, by proof or by the run's end (codex-obs-resume-F3, recheck-F1)", async () => withLedger(async (host, ledger) => {
  const stopAt = "2026-10-11T03:59:00.000Z";
  for (const [id, at] of [[A, "12:02"], [B, "12:10"], [C, "12:20"], [D, "12:30"]] as const) await ledger.schedule(host.paseo, { agentId: id, at: `2026-10-11T${at}:00.000Z`, stopAt });
  const scheduleOf = async (id: string) => (await entryOf(ledger, id)).scheduleId!;
  const fired = (id: string, schedule: string) => `<paseo-system>\nSchedule "恢复后续跑 · 整理日志" fired (id=${schedule}, run=${host.schedules.get(schedule)!.runs.at(-1)!.id}).\n${RESUME_PROMPT}\n</paseo-system>`;
  // A: the run is still loading the Agent (no prompt yet) when the user writes 继续; their turn starts a second later. A turn
  // proves nothing either way: still waking.
  const a = await scheduleOf(A);
  host.now = Date.parse("2026-10-11T12:02:00Z"); host.fire(a, "running");
  host.now += 1000; host.agents.get(A)!.lastUserMessageAt = iso(host.now);
  await ledger.noteTurn(A, host.now, "turn-of-the-user");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, (await entryOf(ledger, A)).deliveredAt], ["waking", null]);
  // The host then finds the user's turn going and fails the run: the user carried on by hand, so nothing is tried again.
  host.end(a, "failed", `Agent ${A} already has an active run`);
  host.now += MINUTE; await ledger.check();
  const resumed = await entryOf(ledger, A);
  assert.deepEqual([resumed.status, resumed.reason, resumed.deliveredAt, host.schedules.has(a), host.creates().length], ["canceled", "resumed", null, false, 4]);
  assert.equal(resumeLook(resumed, clock).pill, "你已接着做");
  // B: the resume's own prompt opens the turn (it is in the session's log); the user writes half a minute into it. Still 已续跑.
  const b = await scheduleOf(B);
  host.now = Date.parse("2026-10-11T12:10:00Z"); host.fire(b, "running"); host.write(B, fired(B, b));
  host.now += 2000; await ledger.noteTurn(B, host.now, "turn-of-the-resume");
  host.now += 30_000; host.agents.get(B)!.lastUserMessageAt = iso(host.now);
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, B)).status, (await entryOf(ledger, B)).deliveredAt], ["delivered", "2026-10-11T12:10:00.000Z"]);
  // C: the same on a provider that keeps no log the plugin reads: waking until the run ends, then the host's own record says.
  host.noLog.add(C);
  const c = await scheduleOf(C);
  host.now = Date.parse("2026-10-11T12:20:00Z"); host.fire(c, "running"); host.write(C, fired(C, c));
  host.now += 2000; await ledger.noteTurn(C, host.now, "turn-of-the-resume");
  host.now += 30_000; host.agents.get(C)!.lastUserMessageAt = iso(host.now);
  await ledger.check();
  assert.equal((await entryOf(ledger, C)).status, "waking", "the user's message meanwhile does not decide it");
  host.now += 5 * MINUTE; host.end(c, "succeeded");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, C)).status, (await entryOf(ledger, C)).deliveredAt], ["delivered", "2026-10-11T12:20:00.000Z"]);
  // D: the user's turn came first and ended before the host looked; then the resume's own run went through: it counts.
  const d = await scheduleOf(D);
  host.now = Date.parse("2026-10-11T12:30:00Z"); host.fire(d, "running");
  host.now += 1000; host.agents.get(D)!.lastUserMessageAt = iso(host.now); await ledger.noteTurn(D, host.now, "turn-of-the-user");
  host.now += 20_000; await ledger.noteTurn(D, host.now, "turn-of-the-resume");
  host.end(d, "succeeded");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, D)).status, (await entryOf(ledger, D)).deliveredAt], ["delivered", "2026-10-11T12:30:00.000Z"]);
  assert.deepEqual([A, B, C, D].map(id => host.prompts.get(id) ?? 0), [0, 0, 0, 0], "no prompt was sent by the plugin itself");
}));

test("a heartbeat the user changed in Paseo is theirs from then on: never taken as a resume, tried again or deleted, in the deferred clean-up either (codex-obs-resume-F4)", async () => withLedger(async (host, ledger) => {
  for (const [id, at] of [[A, "12:02"], [B, "12:10"], [C, "12:20"], [D, "14:00"], [E, "12:40"]] as const) await ledger.schedule(host.paseo, { agentId: id, at: `2026-10-11T${at}:00.000Z` });
  const ids = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async id => [id, (await entryOf(ledger, id)).scheduleId!])));
  const deleted = () => host.sent.filter(message => message.type === "schedule/delete").map(message => message.scheduleId);
  const creates = host.creates().length;
  // A: made into a nightly report (its own prompt, 20 runs, every day), the name kept; it runs at 12:02 and succeeds.
  Object.assign(host.schedules.get(ids[A])!, { prompt: "整理今天的提交，写一份日报", maxRuns: 20, cadence: { type: "cron", expression: "2 12 * * *", timezone: "UTC" } });
  host.now = Date.parse("2026-10-11T12:02:00Z"); await host.tick();
  host.schedules.get(ids[A])!.nextRunAt = "2026-10-12T12:02:00.000Z"; // the host moves a recurring heartbeat on after its run
  await ledger.check();
  const edited = await entryOf(ledger, A);
  assert.deepEqual([edited.status, edited.reason, edited.deliveredAt], ["canceled", "edited", null], "its run was the user's report, not a resume");
  assert.deepEqual(resumeLook(edited, clock), { hue: "muted", icon: "FilePen", pill: "心跳被改过",
    text: "续跑的心跳在 Paseo 里被改过，观测台不再管理它：不会把它当续跑核对，也不会删除它；它照你改过的样子运行，要停掉请到 Paseo 的「计划」里处理。", cancellable: false, again: true, pending: false });
  // B: only renamed before its wake; the look before the wake notices.
  host.schedules.get(ids[B])!.name = "每日巡检";
  host.now = Date.parse("2026-10-11T12:08:30Z"); await ledger.check();
  assert.deepEqual([(await entryOf(ledger, B)).status, (await entryOf(ledger, B)).reason], ["canceled", "edited"]);
  // C: busy at its wake, then made recurring before the check: not replaced by a retry.
  host.now = Date.parse("2026-10-11T12:20:00Z"); host.busy.add(C); await host.tick(); host.busy.delete(C);
  Object.assign(host.schedules.get(ids[C])!, { maxRuns: null, status: "active", nextRunAt: "2026-10-12T12:20:00.000Z" });
  host.now += 30_000; await ledger.check();
  assert.deepEqual([(await entryOf(ledger, C)).status, (await entryOf(ledger, C)).reason, host.creates().length], ["canceled", "edited", creates]);
  // D: 取消续跑 on one the user gave three runs: kept, and the ledger lets go of it.
  host.schedules.get(ids[D])!.maxRuns = 3;
  const canceled = await ledger.cancel(host.paseo, { agentId: D });
  assert.deepEqual([canceled.status, canceled.message, canceled.entry?.status, canceled.entry?.reason],
    ["failed", "续跑的心跳在 Paseo 里被改过，观测台不再管理它，也没有删除它；要停掉它，请到 Paseo 的「计划」里处理。", "canceled", "edited"]);
  // E: delivered while its run still went (its heartbeat left for the clean-up); the user changes it before the run ends.
  host.holding.add(E);
  host.now = Date.parse("2026-10-11T12:40:00Z"); await host.tick(); await ledger.check();
  assert.equal((await entryOf(ledger, E)).status, "delivered");
  host.schedules.get(ids[E])!.prompt = "每天 12:40 汇报一次进度";
  host.holding.delete(E); host.end(ids[E], "succeeded");
  host.now += MINUTE; await ledger.check(); await ledger.check();
  assert.deepEqual(deleted(), [], "none of the five is deleted");
  assert.deepEqual([A, B, C, D, E].map(id => host.schedules.has(ids[id])), [true, true, true, true, true]);
  assert.equal(host.creates().length, creates, "and nothing is made in their place");
}));

test("waiting for permission is delivered; an archived or vanished Agent stops; a heartbeat deleted or paused in Paseo is cancelled", async () => withLedger(async (host, ledger) => {
  for (const id of [A, B, C]) await ledger.schedule(host.paseo, { agentId: id, at: "2026-10-11T12:02:00.000Z" });
  const ids = Object.fromEntries(await Promise.all([A, B, C].map(async id => [id, (await entryOf(ledger, id)).scheduleId!])));
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.fire(ids[A], "failed", `Scheduled agent ${A} is waiting for permission`);
  host.fire(ids[B], "failed", `Agent ${B} is archived`);
  host.schedules.delete(ids[C]);
  await ledger.check();
  assert.deepEqual(await Promise.all([A, B, C].map(async id => { const entry = await entryOf(ledger, id); return [entry.status, entry.reason]; })), [["delivered", null], ["failed", "archived"], ["canceled", "deleted"]]);
  assert.equal(resumeLook(await entryOf(ledger, B), () => "x").again, false, "an archived Agent is not offered 重新安排");
  assert.equal(resumeLook(await entryOf(ledger, C), () => "x").again, true);
  // Paused in Paseo's 计划: it would never fire. Long before its wake the heartbeat is looked at every 10 minutes only.
  await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T14:00:00.000Z" });
  host.schedules.get((await entryOf(ledger, C)).scheduleId!)!.status = "paused";
  const before = host.sent.length;
  host.now += 4 * MINUTE;
  await ledger.check();
  assert.equal(host.sent.length, before, "nothing asked of the host yet");
  assert.equal((await entryOf(ledger, C)).status, "scheduled");
  host.now += 7 * MINUTE;
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, C)).status, (await entryOf(ledger, C)).reason], ["canceled", "paused"]);
  assert.equal(host.schedules.has((await entryOf(ledger, C)).scheduleId!), true, "a paused heartbeat is the user's to keep");
  // Archived while its retry was due: the read before trying again ends it.
  await ledger.schedule(host.paseo, { agentId: D, at: "2026-10-11T12:30:00.000Z" });
  host.now = Date.parse("2026-10-11T12:30:00Z");
  host.busy.add(D); await host.tick(); host.busy.delete(D);
  host.agents.get(D)!.archivedAt = "2026-10-11T12:29:00.000Z";
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, D)).status, (await entryOf(ledger, D)).reason, host.live(D).length], ["failed", "archived", 0]);
}));

test("past the six-hour window a resume that never went in is 未能续跑, and 重新安排 starts over", async () => withLedger(async (host, ledger) => {
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  let entry = await entryOf(ledger, A);
  // Busy at every try until the window is nearly over.
  host.busy.add(A);
  for (host.now = Date.parse(entry.wakeAt); entry.status !== "failed"; host.now = Date.parse(entry.wakeAt)) {
    await host.tick();
    host.now += 20_000;
    await ledger.check();
    entry = await entryOf(ledger, A);
    assert.ok(entry.attempt < 40, "bounded by the window");
  }
  assert.deepEqual([entry.status, entry.reason], ["failed", "expired"]);
  assert.ok(Date.parse(entry.updatedAt) <= Date.parse("2026-10-11T12:02:00Z") + RESUME_WINDOW_MS);
  assert.equal([...host.schedules.values()].filter(schedule => schedule.status === "active").length, 0, "nothing left to fire");
  assert.equal(host.prompts.get(A) ?? 0, 0);
  const look = resumeLook(entry, clock);
  assert.deepEqual([look.hue, look.pill, look.again, look.text], ["red", "未能续跑", true, "从 12:02 起 6 小时内一直没能送出（正忙、宿主不在线或没能载入它）。"]);
  const again = await ledger.schedule(host.paseo, { agentId: A, at: iso(host.now + 10 * MINUTE) });
  assert.equal(again.existing, undefined); assert.equal(again.entry?.attempt, 1); assert.equal(again.entry?.status, "scheduled");
}));

test("取消续跑 deletes only this Agent's own 恢复后续跑 heartbeat, and not while it wakes the Agent (opus-F42)", async () => withLedger(async (host, ledger) => {
  assert.match((await ledger.cancel(host.paseo, { agentId: A })).message, /没有在等的续跑/);
  const scheduled = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  const canceled = await ledger.cancel(host.paseo, { agentId: A, scheduleId: scheduled.scheduleId! });
  assert.equal(canceled.status, "canceled"); assert.deepEqual([canceled.entry?.status, canceled.entry?.reason], ["canceled", "user"]);
  assert.equal(host.schedules.size, 0);
  assert.equal(resumeLook(canceled.entry!, () => "x").again, true);
  // A 2.13 heartbeat the ledger never saw, and another schedule on the same Agent that is not a resume.
  const legacy = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: B } });
  const daily = host.add({ name: "每日巡检", target: { type: "agent", agentId: B } });
  assert.match((await ledger.cancel(host.paseo, { agentId: B, scheduleId: daily.id })).message, /不是这个 Agent 的「恢复后续跑」心跳/);
  assert.match((await ledger.cancel(host.paseo, { agentId: C, scheduleId: legacy.id })).message, /不是这个 Agent 的「恢复后续跑」心跳/, "another Agent's resume");
  assert.equal((await ledger.cancel(host.paseo, { agentId: B, scheduleId: legacy.id })).status, "canceled");
  assert.deepEqual([...host.schedules.keys()], [daily.id]);
  // While the heartbeat runs, the prompt may already be in.
  const waking = await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T12:02:00.000Z" });
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.fire(waking.scheduleId!, "running");
  assert.match((await ledger.cancel(host.paseo, { agentId: C })).message, /正在唤醒它/);
  assert.equal(host.schedules.has(waking.scheduleId!), true);
  // Its prompt went in (its session's log has it) and the turn then failed on the limit, before any check: nothing to cancel.
  const run = host.schedules.get(waking.scheduleId!)!.runs[0]!;
  host.write(C, `<paseo-system>\nSchedule "恢复后续跑 · 整理日志" fired (id=${waking.scheduleId}, run=${run.id}).\n${RESUME_PROMPT}\n</paseo-system>`);
  await ledger.noteTurn(C, host.now + 1000);
  host.now += 5 * MINUTE; host.end(waking.scheduleId!, "failed", LIMIT_REPLY);
  const late = await ledger.cancel(host.paseo, { agentId: C });
  assert.deepEqual([late.status, late.message, late.entry?.status, late.entry?.deliveredAt], ["failed", "续跑已经送进会话，不需要取消。", "delivered", "2026-10-11T12:02:00.000Z"]);
  assert.equal(host.schedules.has(waking.scheduleId!), false);
  // The same failure with nothing to prove the prompt went in (a turn seen is anyone's): cancelled as asked, nothing sent again.
  const unproven = await ledger.schedule(host.paseo, { agentId: D, at: "2026-10-11T12:20:00.000Z" });
  host.now = Date.parse("2026-10-11T12:20:00Z"); host.fire(unproven.scheduleId!, "running");
  await ledger.noteTurn(D, host.now + 1000);
  host.now += 5 * MINUTE; host.end(unproven.scheduleId!, "failed", LIMIT_REPLY);
  const dropped = await ledger.cancel(host.paseo, { agentId: D });
  assert.deepEqual([dropped.status, dropped.entry?.status, dropped.entry?.reason, host.schedules.has(unproven.scheduleId!)], ["canceled", "canceled", "user", false]);
}));

test("the ledger keeps ids, times and states only, survives a plugin restart and answers unchanged reads in a few bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-resume-"));
  const host = new FakeHost();
  host.agents.set(A, { title: "修复登录的秘密项目", archivedAt: null, lastUserMessageAt: null });
  try {
    let ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false });
    const scheduled = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z", stopAt: "2026-10-11T03:59:00.000Z" });
    const read = await ledger.read({ agentId: A });
    assert.equal(read.mode, "full");
    assert.deepEqual(await ledger.read({ agentId: A, revision: read.revision }), { mode: "unchanged", unchanged: true, revision: read.revision });
    await ledger.close();
    const text = await readFile(join(directory, "resume-ledger.json"), "utf8");
    assert.ok(!text.includes("修复登录") && !text.includes(RESUME_PROMPT), "no title, no prompt");
    assert.deepEqual(Object.keys(JSON.parse(text).entries[0]).sort(), ["agentId", "attempt", "cadence", "createdAt", "deliveredAt", "plannedAt", "reason", "scheduleId", "status", "stopAt", "updatedAt", "wakeAt"]);
    assert.deepEqual(JSON.parse(text).entries[0].cadence, { expression: "2 12 11 * *", timezone: "UTC" }, "the rule it was made with: a cron and a zone");
    // A ledger 2.14.0 wrote may carry the turn it saw (turnAt, turnId, turnUser): it still reads, and proves nothing now.
    const old = JSON.parse(text);
    Object.assign(old.entries[0], { turnAt: "2026-10-11T12:02:02.000Z", turnId: "turn-1", turnUser: false });
    await writeFile(join(directory, "resume-ledger.json"), JSON.stringify(old));
    ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false });
    assert.equal((await entryOf(ledger, A)).scheduleId, scheduled.scheduleId);
    // The run starts and a turn is seen, then the plugin restarts before the run ends: a fresh process keeps checking, and the
    // run's end decides.
    host.now = Date.parse("2026-10-11T12:02:00Z");
    host.fire(scheduled.scheduleId!, "running");
    await ledger.noteTurn(A, host.now + 2000);
    await ledger.check();
    assert.equal((await entryOf(ledger, A)).status, "waking");
    await ledger.close();
    host.now = Date.parse("2026-10-11T12:10:00Z");
    ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false });
    host.end(scheduled.scheduleId!, "succeeded");
    await ledger.check();
    assert.deepEqual([(await entryOf(ledger, A)).status, (await entryOf(ledger, A)).deliveredAt], ["delivered", "2026-10-11T12:02:00.000Z"], "a fresh process keeps checking");
    await ledger.close();
    // A torn file is kept aside and a new ledger starts.
    await writeFile(join(directory, "resume-ledger.json"), "{ not json");
    ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false });
    const torn = await ledger.read({});
    assert.equal(torn.mode === "full" && torn.error !== null, true);
    await ledger.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("background reads never load an Agent: only the snapshot read refresh() is used", async () => withLedger(async (host, ledger) => {
  const touched: string[] = [];
  const strict = { agents: { ref: (id: string) => new Proxy({ refresh: async () => ({ agent: { id, title: "x", archivedAt: null, lastUserMessageAt: "2026-10-11T03:00:00.000Z", persistence: { provider: "claude", sessionId: `session-${id.slice(-1)}` } } }) }, {
    get: (target, key) => { touched.push(String(key)); if (key !== "refresh") throw new Error(`${String(key)} would load the Agent`); return Reflect.get(target, key); } }) } } as unknown as PaseoApi;
  const scheduled = await ledger.schedule(strict, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  // Busy first (read before trying again), then the retry's run, its prompt in the session's log (read for its session id).
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.fire(scheduled.scheduleId!, "failed", `Agent ${A} already has an active run`);
  await ledger.check();
  const retry = await entryOf(ledger, A);
  host.now = Date.parse(retry.wakeAt);
  host.fire(retry.scheduleId!, "running");
  host.write(A, `<paseo-system>\nSchedule "x" fired (id=${retry.scheduleId}, run=${host.schedules.get(retry.scheduleId!)!.runs[0]!.id}).\n${RESUME_PROMPT}\n</paseo-system>`);
  await ledger.noteTurn(A, host.now);
  await ledger.check();
  assert.equal((await entryOf(ledger, A)).status, "delivered");
  assert.deepEqual([...new Set(touched)], ["refresh"]);
}));

test("registerResume handles the schedule, list, cancel and provider-base RPCs; turn_started only brings a check forward, neither hook touches its input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-resume-"));
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>(), hooks = new Map<string, Array<(input: unknown, context: unknown) => unknown>>();
  const removed: string[] = [];
  const server = { handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => { handlers.set(contract.name, handler); },
    on: (name: string, handler: (input: unknown, context: unknown) => unknown) => { hooks.set(name, [...(hooks.get(name) ?? []), handler]); return () => removed.push(name); } } as never;
  const host = new FakeHost();
  try {
    const zones: string[] = [];
    const registered = registerResume(server, host.bridge, { directory, home: directory, now: () => host.now, timers: false, noteZone: zone => zones.push(zone) });
    assert.deepEqual([...handlers.keys()].sort(), ["observatory.providers.bases", "observatory.resume.cancel", "observatory.resume.list", "observatory.resume.schedule"]);
    assert.deepEqual([...hooks.keys()].sort(), ["agent.turn_ended", "agent.turn_started"]);
    const input = Object.freeze({ agent: Object.freeze({ id: A }), turnId: "t", timeline: Object.freeze([]) });
    for (const [, list] of hooks) for (const hook of list) assert.doesNotThrow(() => hook(input, { paseo: host.paseo }));
    assert.deepEqual(await handlers.get("observatory.providers.bases")!({}, { paseo: host.paseo }), { bases: {} }, "no config: no custom providers");
    host.agents.set(A, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
    const scheduled = await handlers.get("observatory.resume.schedule")!({ agentId: A, at: "2026-10-11T12:02:00.000Z", timeZone: "US/Pacific" }, { paseo: host.paseo }) as { status: string };
    assert.equal(scheduled.status, "scheduled");
    assert.deepEqual(zones, ["US/Pacific"], "the device's zone is passed on");
    // The hook returns at once and records nothing: a turn proves nothing about the resume (codex-obs-resume-recheck-F1).
    host.now = Date.parse("2026-10-11T12:02:03Z");
    const before = await registered.ledger.list(A);
    for (const hook of hooks.get("agent.turn_started")!) assert.equal(hook(input, { paseo: host.paseo }), undefined, "the hub is not held up");
    for (let index = 0; index < 10; index++) await settle();
    assert.deepEqual(await registered.ledger.list(A), before);
    const listed = await handlers.get("observatory.resume.list")!({ agentId: A }, { paseo: host.paseo }) as { mode: string; entries: unknown[] };
    assert.equal(listed.mode, "full"); assert.equal(listed.entries.length, 1);
    const canceled = await handlers.get("observatory.resume.cancel")!({ agentId: A }, { paseo: host.paseo }) as { status: string };
    assert.equal(canceled.status, "canceled");
    await registered.close();
    assert.deepEqual(removed.sort(), ["agent.turn_ended", "agent.turn_started"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the stop card shows a waiting resume whatever stop it was for, a finished one only with its own stop", () => {
  const entry = (patch: Partial<ResumeEntry>): ResumeEntry => ({ agentId: A, scheduleId: "s", stopAt: "2026-10-11T03:59:00.000Z", plannedAt: "2026-10-11T12:02:00.000Z", wakeAt: "2026-10-11T12:02:00.000Z",
    attempt: 1, status: "scheduled", reason: null, createdAt: "2026-10-11T04:00:00.000Z", updatedAt: "2026-10-11T04:00:00.000Z", deliveredAt: null, ...patch });
  assert.equal(resumeFor([entry({})], A, "2026-10-12T00:00:00.000Z")?.status, "scheduled", "a resume still waiting, for an older stop");
  assert.equal(resumeFor([entry({ status: "delivered" })], A, "2026-10-12T00:00:00.000Z"), null, "a new stop starts fresh");
  assert.equal(resumeFor([entry({ status: "failed", reason: "expired" })], A, "2026-10-11T03:59:00.000Z")?.status, "failed");
  assert.equal(resumeFor([entry({ status: "canceled", stopAt: null, createdAt: "2026-10-11T04:01:00.000Z" })], A, "2026-10-11T03:59:00.000Z")?.status, "canceled", "no stop recorded: by time");
  assert.equal(resumeFor([entry({})], B, "2026-10-11T03:59:00.000Z"), null);
  assert.deepEqual(resumeLook(entry({}), clock), { hue: "pink", icon: "AlarmClock", pill: "12:02 续跑", text: "已安排 12:02 自动续跑一次。", cancellable: true, again: false, pending: true });
  assert.equal(resumeLook(entry({ status: "waking" }), clock).hue, "blue");
  assert.equal(resumeLook(entry({ status: "retrying", reason: "missed", attempt: 2 }), clock).text, "上次唤醒没有执行（宿主重启或不在线）；12:02 再试（第 2 次）。");
  assert.equal(resumeLook(entry({ status: "retrying", reason: "restart", attempt: 2 }), clock).text, "宿主重启打断了上次续跑，提示没送出；12:02 再试（第 2 次）。");
  assert.equal(resumeLook(entry({ status: "retrying", reason: "busy", attempt: 3, scheduleId: null }), clock).text, "上次续跑没送出，正在重新安排第 3 次。");
  // The first heartbeat, its create's answer lost: a resume to confirm, never made again (codex-obs-resume-recheck11-F3, recheck12);
  // none told for it, 未能确认 and 重新安排; cancelled with none found, no promise that it will not wake the Agent.
  assert.deepEqual(resumeLook(entry({ scheduleId: null }), clock), { hue: "amber", icon: "RotateCw", pill: "正在核对", text: "安排续跑时宿主没有回话，正在核对 12:02 的续跑建好没有；确认不了时，这里会请你到 Paseo 的「计划」里查看。",
    cancellable: true, again: false, pending: true });
  assert.deepEqual(resumeLook(entry({ status: "failed", reason: "unsure", scheduleId: null }), clock), { hue: "amber", icon: "CircleHelp", pill: "未能确认续跑",
    text: "没能确认续跑建好没有（安排时宿主没有回话）。请到 Paseo 的「计划」里查看：没有这条续跑就「重新安排」，有多条就删掉多余的。", cancellable: false, again: true, pending: false });
  assert.equal(resumeLook(entry({ status: "canceled", reason: "user", scheduleId: null }), clock).text, "已停止核对和补建。如果之后在 Paseo 的「计划」里出现这条续跑，请删除它。");
  assert.equal(resumeLook(entry({ status: "canceled", reason: "user" }), clock).text, "续跑已取消。");
  assert.equal(resumeLook(entry({ status: "canceled", reason: "deleted" }), clock).text, "续跑的心跳已在 Paseo 的「计划」里删除，到点不会唤醒它。");
  // Each state reads apart: 未能确认 amber, a load the host cannot do red and final, the user carrying on grey.
  const unsure = resumeLook(entry({ status: "failed", reason: "unsure" }), clock), unloadable = resumeLook(entry({ status: "failed", reason: "error" }), clock);
  const resumed = resumeLook(entry({ status: "canceled", reason: "resumed" }), clock);
  assert.deepEqual([unsure.hue, unsure.pill, unsure.again], ["amber", "未能确认续跑", true]);
  assert.deepEqual([unloadable.hue, unloadable.pill, unloadable.again], ["red", "未能续跑", false]);
  assert.deepEqual([resumed.hue, resumed.pill, resumed.again, resumed.cancellable], ["muted", "你已接着做", true, false]);
});

test("the stop card's fallback for 2.13 heartbeats shows only one the ledger does not know, never one it let go of after the user changed it (codex-obs-resume-F4)", () => {
  const heartbeat = (patch: Partial<NonNullable<Parameters<typeof legacyResume>[0]>[number]> = {}) =>
    ({ scheduleId: "s-1", status: "active" as const, name: "恢复后续跑 · 修复登录", maxRuns: 1, nextRunAt: "2026-10-11T12:02:00.000Z", ...patch });
  assert.deepEqual(legacyResume([heartbeat()], now0), { scheduleId: "s-1", at: Date.parse("2026-10-11T12:02:00Z") });
  assert.equal(legacyResume([heartbeat()], now0, new Set(["s-1"])), null, "the ledger's own: its entry shows it (here one it let go of, edited)");
  assert.equal(legacyResume([heartbeat(), heartbeat({ scheduleId: "s-2" })], now0, new Set(["s-1"]))?.scheduleId, "s-2");
  assert.equal(legacyResume([heartbeat({ maxRuns: 20 })], now0), null, "made recurring");
  assert.equal(legacyResume([heartbeat({ name: "每日巡检" })], now0), null);
  assert.equal(legacyResume([heartbeat({ nextRunAt: "2026-11-11T12:02:00.000Z" })], now0), null, "moved a month out");
  assert.equal(legacyResume([heartbeat({ status: "completed" })], now0), null);
});

test("按额度窗口: the latest exhausted own window of the base's only, current account, two minutes later (opus-B18)", () => {
  const at = Date.parse("2026-10-11T10:00:00Z");
  const window = (id: string, usedPct: number | null, resetsInHours: number, summary = true, state: "live" | "reset" = "live") => ({ id, label: id, summary, usedPct, resetsAt: iso(at + resetsInHours * HOUR), state }) as never;
  const account = (patch: Record<string, unknown> = {}) => ({ provider: "claude", name: "Claude", status: "available" as const, stale: false, windows: [window("five_hour", 100, 2), window("weekly", 40, 50)], ...patch });
  assert.deepEqual(quotaWindowReset([account()], "claude", at), { resetAt: at + 2 * HOUR, window: "five_hour", account: "Claude" });
  assert.equal(iso(resumeTime(quotaWindowReset([account()], "claude", at)!.resetAt, at)), "2026-10-11T12:02:00.000Z");
  assert.equal(quotaWindowReset([account({ windows: [window("five_hour", 100, 2), window("weekly", 99.6, 30)] })], "claude", at)?.resetAt, at + 30 * HOUR, "both spent: the later reset");
  assert.equal(quotaWindowReset([account({ windows: [window("five_hour", 99, 2)] })], "claude", at), null, "not spent");
  assert.equal(quotaWindowReset([account({ windows: [window("weekly_opus", 100, 2, false)] })], "claude", at), null, "a model's own window");
  assert.equal(quotaWindowReset([account({ windows: [window("five_hour", 100, 2), window("code_review:five_hour", 100, 9, true)] })], "claude", at)?.resetAt, at + 2 * HOUR);
  assert.equal(quotaWindowReset([account({ windows: [window("five_hour", 100, 2, false), window("weekly", 20, 50, true)] })], "claude", at), null, "the summary windows decide when there are any");
  assert.equal(quotaWindowReset([account({ windows: [window("five_hour", 100, -1)] })], "claude", at), null, "reset already passed");
  assert.equal(quotaWindowReset([account({ windows: [window("five_hour", 100, 2, true, "reset")] })], "claude", at), null);
  assert.equal(quotaWindowReset([account({ stale: true })], "claude", at), null, "an old reading");
  assert.equal(quotaWindowReset([account({ status: "error" })], "claude", at), null);
  assert.equal(quotaWindowReset([account(), account({ name: "Claude 账号 2" })], "claude", at), null, "two logins: which one is unknown");
  assert.equal(quotaWindowReset([account()], "codex", at), null);
  assert.equal(quotaWindowReset([account()], null, at), null);
});

test("交给另一个 Provider: the first message points at the original instead of pasting it; one key per stop and profile (opus-B23)", () => {
  const prompt = handoverPrompt({ id: A, title: "修复登录" });
  assert.match(prompt, new RegExp(`paseo inspect ${A}`));
  assert.match(prompt, new RegExp(`paseo logs ${A} --tail 200`));
  assert.match(prompt, /git status、git diff/);
  assert.match(prompt, /不要让它续跑|也不要让它续跑/);
  assert.match(prompt, /原会话「修复登录」/);
  assert.equal(handoverPrompt({ id: A, title: "  " }).includes("「未命名会话」"), true);
  assert.equal(handoverKey(A, "2026-10-11T03:59:00.000Z", "fast"), `observatory-handover:${A}:2026-10-11T03:59:00.000Z:fast`);
  assert.ok(handoverKey(A, "2026-10-11T03:59:00.000Z", "x".repeat(900)).length <= 512);
  assert.equal(handoverTitle("修复登录", "my-claude"), "修复登录（接手自 my-claude）");
});

test("a busy run whose session's logs have not been scanned since it ended is decided at a later check, not before; past the window, 未能确认 (codex-obs-resume-recheck5-F2)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  for (const id of [A, B]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned) });
  host.busy.add(A); host.busy.add(B);
  host.unscanned.add("session-a"); host.unscanned.add("session-b");
  for (host.now = planned; host.now <= planned + MINUTE; host.now += MINUTE) await host.tick();
  const creates = host.creates().length;
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, (await entryOf(ledger, B)).status], ["scheduled", "scheduled"], "not decided while the logs are not scanned since");
  assert.equal(host.creates().length, creates, "nothing tried again on a guess");
  // The ledger's next rescan lists A's logs: the busy error is the host's own, from before the prompt, and A is tried again.
  host.unscanned.delete("session-a"); host.busy.clear();
  host.now += MINUTE; await ledger.check();
  const a = await entryOf(ledger, A);
  assert.deepEqual([a.status, a.reason, a.attempt], ["retrying", "busy", 2]);
  // B's never are, within the window (B woke a minute after A): then nothing is sent again on its own.
  host.now = planned + MINUTE + RESUME_WINDOW_MS; await ledger.check();
  assert.equal((await entryOf(ledger, B)).status, "scheduled", "the window's last minute still waits");
  host.now += MINUTE; await ledger.check();
  const b = await entryOf(ledger, B);
  assert.deepEqual([b.status, b.reason, b.attempt], ["failed", "unsure", 1]);
  assert.equal(host.prompts.get(B), undefined, "B never got a prompt");
}));

test("取消续跑 and 安排续跑 change nothing once the request has waited too long for its answer to reach the device (codex-obs-resume-recheck5-F2)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  await ledger.schedule(host.paseo, { agentId: A, at: iso(planned) });
  const heartbeat = (await entryOf(ledger, A)).scheduleId!;
  // A check holds A while the host is slow to answer; the cancel waits for it, past its time.
  let held = gate(), holding = true;
  host.before = async message => { if (holding && message.type === "schedule/inspect") await held.wait; };
  const checking = ledger.check();
  await settle();
  const late = ledger.cancel(host.paseo, { agentId: A });
  await settle();
  host.now += 16_000; holding = false; held.open(); await checking;
  const answer = await late;
  assert.deepEqual([answer.status, answer.message], ["failed", "观测台正忙，这次请求等得太久，没有取消续跑；请再试一次。"]);
  assert.deepEqual([host.schedules.has(heartbeat), (await entryOf(ledger, A)).status], [true, "scheduled"], "the heartbeat and the ledger as they were");
  // A run that failed busy, its session's log read for the cancel: the read takes past its time too.
  host.busy.add(A);
  host.now = planned; await host.tick();
  let reading = gate();
  const logs = host.logs.findMarker;
  host.logs.findMarker = async (...args) => { const answer = await logs(...args); await reading.wait; return answer; };
  const slow = ledger.cancel(host.paseo, { agentId: A });
  await settle(); await settle();
  host.now += 16_000; reading.open();
  assert.equal((await slow).status, "failed");
  assert.equal(host.schedules.has(heartbeat), true, "not deleted after its time");
  host.logs.findMarker = logs;
  // In time, it does.
  const canceled = await ledger.cancel(host.paseo, { agentId: A });
  assert.deepEqual([canceled.status, host.schedules.has(heartbeat)], ["canceled", false]);
  // 安排续跑 waiting behind a slow request for the same Agent (a cancel the host is slow to answer) likewise makes no heartbeat.
  held = gate(); holding = true;
  const creates = host.creates().length;
  const slowCancel = ledger.cancel(host.paseo, { agentId: C, scheduleId: "sched-gone" });
  await settle();
  const scheduleLate = ledger.schedule(host.paseo, { agentId: C, at: iso(planned + 2 * HOUR) });
  await settle();
  host.now += 7_000; holding = false; held.open(); await slowCancel;
  const tooLate = await scheduleLate;
  assert.deepEqual([tooLate.status, tooLate.message], ["failed", "观测台正忙，这次请求等得太久，没有安排续跑；请再试一次。"]);
  assert.equal(host.creates().length, creates, "no heartbeat made");
  // In time, it does.
  assert.equal((await ledger.schedule(host.paseo, { agentId: C, at: iso(planned + 2 * HOUR) })).status, "scheduled");
}));

test("安排续跑 starts no change past its time after any wait inside it: a slow snapshot of the Agent makes no heartbeat and lets its minute go; a slow inspect or delete while adopting deletes and adopts nothing more (codex-obs-resume-recheck6-F2)", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z"), TOO_LATE = "观测台正忙，这次请求等得太久，没有安排续跑；请再试一次。";
  const changes = (from: number) => host.sent.slice(from).filter(message => message.type === "schedule/create" || message.type === "schedule/delete").map(message => String(message.type));
  // Codex's repros, by the host's clock: the Agent's snapshot read answers 7001 ms after the request arrived.
  const agents = host.paseo.agents, ref = agents.ref.bind(agents);
  let slowRead = true;
  (agents as { ref: typeof ref }).ref = id => ({ ...ref(id), refresh: async () => { const answer = await ref(id).refresh(); if (slowRead) host.now += 7001; return answer; } });
  let sent = host.sent.length;
  const slow = await ledger.schedule(host.paseo, { agentId: A, at: iso(planned) });
  assert.deepEqual([slow.status, slow.message], ["failed", TOO_LATE]);
  assert.deepEqual([changes(sent), (await ledger.list()).length], [[], 0], "no heartbeat made, nothing in the ledger");
  // Its minute is free again: the next request for it gets that very minute, not the one after.
  slowRead = false;
  const next = await ledger.schedule(host.paseo, { agentId: B, at: iso(planned) });
  assert.deepEqual([next.status, next.runAt], ["scheduled", iso(planned)]);
  // Adopting C's own heartbeats: one waiting (2.13 made it), read in time and found, then one long past whose inspect answers past
  // the request's time.
  const waiting = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: C }, nextRunAt: iso(host.now + 3 * HOUR) });
  const past = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: C }, nextRunAt: iso(host.now - HOUR) });
  let slowInspect = true;
  host.before = async message => { if (slowInspect && message.type === "schedule/inspect" && message.scheduleId === past.id) host.now += 7001; };
  sent = host.sent.length;
  const adopting = await ledger.schedule(host.paseo, { agentId: C, at: iso(planned + HOUR) });
  assert.deepEqual([adopting.status, adopting.message], ["failed", TOO_LATE]);
  assert.deepEqual(changes(sent), [], "the dead one is not deleted after its inspect, nor is anything made");
  assert.deepEqual([host.schedules.has(waiting.id), host.schedules.has(past.id), (await ledger.list(C)).length], [true, true, 0], "nor the waiting one adopted");
  // In time, the waiting one is adopted and the dead one deleted.
  slowInspect = false;
  const adopted = await ledger.schedule(host.paseo, { agentId: C, at: iso(planned + HOUR) });
  assert.deepEqual([adopted.existing, adopted.scheduleId, host.schedules.has(past.id)], [true, waiting.id, false]);
  // Two of D's moved a month out (a restart moved their missed wake): the first delete answers past the time, the second is not sent.
  const moved = [1, 2].map(() => host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: D }, nextRunAt: "2026-11-11T12:02:00.000Z" }));
  let slowDelete = true;
  host.before = async message => { if (slowDelete && message.type === "schedule/delete") { slowDelete = false; host.now += 7001; } };
  sent = host.sent.length;
  const clearing = await ledger.schedule(host.paseo, { agentId: D, at: iso(planned + 2 * HOUR) });
  assert.deepEqual([clearing.status, clearing.message], ["failed", TOO_LATE]);
  assert.deepEqual([changes(sent), moved.map(heartbeat => host.schedules.has(heartbeat.id))], [["schedule/delete"], [false, true]]);
  // In time: the other goes, and D's resume is made.
  const made = await ledger.schedule(host.paseo, { agentId: D, at: iso(planned + 2 * HOUR) });
  assert.deepEqual([made.status, host.schedules.has(moved[1]!.id)], ["scheduled", false]);
}));

// The old re-adoption (codex-obs-resume-recheck5/6, obs6's A): a one-off resume heartbeat delivered while its run still goes keeps
// its wake as nextRunAt, and was taken up as the one waiting when the resume was asked for again.
const deletesOf = (host: FakeHost, id: string | null | undefined) => host.sent.filter(message => message.type === "schedule/delete" && message.scheduleId === id).length;

test("asked again while the resume just delivered still runs, 安排续跑 makes a new heartbeat at the new time and its cancel works; the running one is neither taken up nor deleted until its run ends; asked again after the run ended, likewise", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(planned) });
  // At its wake the prompt goes in and the turn it opened goes on: the prompt in the log delivers it while the run still goes.
  host.holding.add(A);
  host.now = planned; await host.tick(); await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, host.schedules.get(first.scheduleId!)!.runs.map(run => run.status), host.schedules.get(first.scheduleId!)!.nextRunAt],
    ["delivered", ["running"], iso(planned)], "its wake stays its nextRunAt while it runs");
  // Asked again then: a new heartbeat at the time asked for, not the running one at its old time.
  const at = planned + 2 * HOUR;
  const again = await ledger.schedule(host.paseo, { agentId: A, at: iso(at) });
  assert.deepEqual([again.status, again.existing, again.runAt], ["scheduled", undefined, iso(at)]);
  assert.notEqual(again.scheduleId, first.scheduleId);
  assert.match(again.message, /^已安排 .*续跑/);
  assert.deepEqual([host.schedules.get(first.scheduleId!)?.runs.map(run => run.status), deletesOf(host, first.scheduleId)], [["running"], 0], "the running one is left alone");
  // The cancel works on the new one; the running one is still left alone.
  const canceled = await ledger.cancel(host.paseo, { agentId: A });
  assert.deepEqual([canceled.status, host.schedules.has(again.scheduleId!), host.schedules.has(first.scheduleId!)], ["canceled", false, true]);
  await ledger.check();
  assert.equal(deletesOf(host, first.scheduleId), 0, "never deleted while its run goes");
  // Its run ends: the ledger deletes it then.
  host.holding.delete(A); host.end(first.scheduleId!, "succeeded");
  await ledger.check();
  assert.equal(host.schedules.has(first.scheduleId!), false);
  // Asked again after the run ended: a new one again, and its cancel works.
  const after = await ledger.schedule(host.paseo, { agentId: A, at: iso(at + HOUR) });
  assert.deepEqual([after.status, after.existing, after.runAt], ["scheduled", undefined, iso(at + HOUR)]);
  assert.equal((await ledger.cancel(host.paseo, { agentId: A })).status, "canceled");
  assert.equal(host.prompts.get(A), 1, "one resume prompt in all");
}));

test("within the grace window a heartbeat whose wake passed but that the host has not started yet is still taken up, read first: one running is not, and one whose read comes back past the request's time is not either", async () => withLedger(async (host, ledger) => {
  // Due two minutes ago (the host was busy, or down that minute), no run yet: it still waits, so it is adopted, never doubled.
  const due = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, nextRunAt: iso(host.now - 2 * MINUTE) });
  const adopted = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  assert.deepEqual([adopted.existing, adopted.scheduleId, host.creates().length], [true, due.id, 0]);
  // The same, but its run has begun: not waiting; a new one is made and the running one stays.
  const running = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: B }, nextRunAt: iso(host.now - 2 * MINUTE) });
  running.runs.push({ id: runId(901), scheduledFor: running.nextRunAt!, startedAt: running.nextRunAt!, endedAt: null, status: "running", agentId: null, output: null, error: null });
  const fresh = await ledger.schedule(host.paseo, { agentId: B, at: "2026-10-11T12:02:00.000Z" });
  assert.deepEqual([fresh.existing, fresh.scheduleId === running.id, host.schedules.has(running.id), deletesOf(host, running.id)], [undefined, false, true, 0]);
  // Moved out a month (as a restart moves a missed wake) but run by hand in Paseo right now: not deleted while that run goes.
  const handRun = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: D }, nextRunAt: "2026-11-11T12:02:00.000Z" });
  handRun.runs.push({ id: runId(903), scheduledFor: handRun.nextRunAt!, startedAt: iso(host.now), endedAt: null, status: "running", agentId: null, output: null, error: null });
  assert.equal((await ledger.schedule(host.paseo, { agentId: D, at: "2026-10-11T12:02:00.000Z" })).status, "scheduled");
  assert.deepEqual([host.schedules.has(handRun.id), deletesOf(host, handRun.id)], [true, 0]);
  // Waiting, but its read comes back past the request's time (codex-obs-resume-recheck6-F2): nothing taken up or made.
  const late = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: C }, nextRunAt: iso(host.now - 2 * MINUTE) });
  let slow = true;
  host.before = async message => { if (slow && message.type === "schedule/inspect" && message.scheduleId === late.id) host.now += 7001; };
  const creates = host.creates().length;
  const tooLate = await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T12:30:00.000Z" });
  assert.deepEqual([tooLate.status, tooLate.message, host.creates().length, (await ledger.list(C)).length], ["failed", "观测台正忙，这次请求等得太久，没有安排续跑；请再试一次。", creates, 0]);
  slow = false;
  assert.deepEqual([(await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T12:30:00.000Z" })).scheduleId], [late.id], "in time it is taken up");
}));

test("the read decides, not the list: a heartbeat whose run finished, or that was deleted, between the list and its read is not taken up, and a new one is made", async () => withLedger(async (host, ledger) => {
  const finished = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, nextRunAt: iso(host.now - MINUTE) });
  const gone = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: B }, nextRunAt: iso(host.now - MINUTE) });
  host.before = async message => {
    if (message.type !== "schedule/inspect") return;
    if (message.scheduleId === finished.id && finished.status === "active") host.fire(finished.id, "succeeded");
    if (message.scheduleId === gone.id) host.schedules.delete(gone.id);
  };
  const [a, b] = [await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" }), await ledger.schedule(host.paseo, { agentId: B, at: "2026-10-11T12:02:00.000Z" })];
  assert.deepEqual([a.status, a.existing, a.scheduleId === finished.id], ["scheduled", undefined, false]);
  assert.deepEqual([b.status, b.existing, b.scheduleId === gone.id], ["scheduled", undefined, false]);
  // Paused in 计划 between the list and its read (a host that keeps the wake of a paused one): the user's, neither taken up nor deleted.
  const paused = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: C }, nextRunAt: iso(host.now + HOUR) });
  host.before = async message => { if (message.type === "schedule/inspect" && message.scheduleId === paused.id) paused.status = "paused"; };
  const c = await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T12:02:00.000Z" });
  assert.deepEqual([c.status, c.existing, c.scheduleId === paused.id, host.schedules.has(paused.id), deletesOf(host, paused.id)], ["scheduled", undefined, false, true, 0]);
}));

test("the heartbeat of a resume the ledger has ended is never taken up again, though the host keeps it active (a run made by hand in Paseo leaves it so): after a plugin restart too, asking again makes a new one and deletes the ended one", async () => withLedger(async (host, ledger, directory) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(planned) });
  // Run by hand in Paseo's 计划 (立即运行): the run succeeded and the heartbeat stays active at its wake. The ledger delivers on it,
  // but its delete fails, and again in the same check's clean-up: it is kept to delete later, in memory only.
  const heartbeat = host.schedules.get(first.scheduleId!)!;
  heartbeat.runs.push({ id: runId(902), scheduledFor: heartbeat.nextRunAt!, startedAt: iso(host.now), endedAt: iso(host.now), status: "succeeded", agentId: null, output: null, error: null });
  host.refuse.set("schedule/delete", 2);
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, host.schedules.get(first.scheduleId!)?.status], ["delivered", "active"]);
  // The plugin restarts: what was still to delete is forgotten; the ended resume, with its heartbeat's id, is not.
  await ledger.close();
  const restarted = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, zone: () => "US/Pacific", log: () => {}, logs: host.logs });
  try {
    const again = await restarted.schedule(host.paseo, { agentId: A, at: iso(planned + HOUR) });
    assert.deepEqual([again.status, again.existing, again.runAt], ["scheduled", undefined, iso(planned + HOUR)]);
    assert.equal(host.schedules.has(first.scheduleId!), false, "the ended one is deleted, not taken up");
    assert.equal((await restarted.cancel(host.paseo, { agentId: A })).status, "canceled");
  } finally { await restarted.close(); }
}));

test("the ledger never takes up a heartbeat it is done with, though it still waits in the host: the ended resume's (after a reload that lost what was kept to delete, as a file from before this fix), nor one kept to delete since another resume replaced that one (codex-obs-resume-recheck8-F2)", async () => withLedger(async (host, ledger, directory) => {
  const first = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  // The Agent is archived: the resume ends (未能续跑), but its heartbeat's delete fails, here and in the same check's clean-up.
  host.agents.get(A)!.archivedAt = iso(host.now);
  host.refuse.set("schedule/delete", 3);
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, (await entryOf(ledger, A)).reason, host.schedules.has(first.scheduleId!)], ["failed", "archived", true]);
  // Reloaded with the file as ec1f466 left it: nothing kept to delete; only the ended resume still names the heartbeat.
  await ledger.close();
  const file = join(directory, "resume-ledger.json"), saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete saved.tidy; await writeFile(file, JSON.stringify(saved));
  const reloaded = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, zone: () => "US/Pacific", log: () => {}, logs: host.logs });
  try {
    host.agents.get(A)!.archivedAt = null;
    const second = await reloaded.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:30:00.000Z" });
    assert.deepEqual([second.status, second.existing, second.scheduleId === first.scheduleId, host.schedules.has(first.scheduleId!)], ["scheduled", undefined, false, true],
      "the ended resume's is not taken up (its delete fails once more)");
    assert.equal((await reloaded.cancel(host.paseo, { agentId: A })).status, "canceled");
    // The second resume replaced the ended one, so the first is kept to delete: deleted when asked again, not taken up.
    const third = await reloaded.schedule(host.paseo, { agentId: A, at: "2026-10-11T13:00:00.000Z" });
    assert.deepEqual([third.status, third.existing, third.scheduleId === first.scheduleId, host.schedules.has(first.scheduleId!)], ["scheduled", undefined, false, false]);
  } finally { await reloaded.close(); }
}));

test("a ledger file whose list of heartbeats to delete misses the ended resume's (an empty list, edited by hand: nothing to migrate) still never takes that heartbeat up, and the resume replacing it keeps it to delete (codex-obs-resume-recheck8-F2, recheck9 self-check)", async () => withLedger(async (host, ledger, directory) => {
  const first = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  host.agents.get(A)!.archivedAt = iso(host.now);
  host.refuse.set("schedule/delete", 3);
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, host.schedules.has(first.scheduleId!)], ["failed", true]);
  await ledger.close();
  const file = join(directory, "resume-ledger.json"), saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...saved, tidy: [] }));
  const reloaded = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, zone: () => "US/Pacific", log: () => {}, logs: host.logs });
  try {
    host.agents.get(A)!.archivedAt = null;
    const second = await reloaded.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:30:00.000Z" });
    assert.deepEqual([second.status, second.existing, second.scheduleId === first.scheduleId], ["scheduled", undefined, false], "the ended resume's is not taken up");
    assert.equal((await reloaded.cancel(host.paseo, { agentId: A })).status, "canceled");
    const third = await reloaded.schedule(host.paseo, { agentId: A, at: "2026-10-11T13:00:00.000Z" });
    assert.deepEqual([third.status, third.scheduleId === first.scheduleId, host.schedules.has(first.scheduleId!)], ["scheduled", false, false], "kept to delete when replaced, deleted");
  } finally { await reloaded.close(); }
}));

test("a retry never takes up an earlier resume's heartbeat still running after its delivery, nor deletes it: the new resume gets a heartbeat of its own, and each resume one prompt", async () => withLedger(async (host, ledger) => {
  const planned = Date.parse("2026-10-11T12:02:00Z");
  const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(planned) });
  host.holding.add(A);
  host.now = planned; await host.tick(); await ledger.check();
  assert.equal((await entryOf(ledger, A)).status, "delivered");
  // Asked again for the next minute while that turn still goes: its wake finds A busy, and a check decides it (the log read whole
  // shows no prompt of that run): tried again 10 minutes later.
  await ledger.schedule(host.paseo, { agentId: A, at: iso(planned + MINUTE) });
  host.busy.add(A);
  host.now = planned + MINUTE; await host.tick();
  host.now += MINUTE; await ledger.check();
  const retrying = await entryOf(ledger, A);
  assert.deepEqual([retrying.status, retrying.reason, retrying.attempt], ["retrying", "busy", 2]);
  assert.notEqual(retrying.scheduleId, first.scheduleId, "not the earlier resume's heartbeat, whose run is that turn");
  assert.deepEqual([host.schedules.get(first.scheduleId!)?.runs.map(run => run.status), deletesOf(host, first.scheduleId)], [["running"], 0]);
  // That turn ends, and with it the earlier run; the retry wakes A once.
  host.busy.delete(A); host.holding.delete(A); host.end(first.scheduleId!, "succeeded");
  host.now = Date.parse(retrying.wakeAt); await host.tick(); await ledger.check();
  const done = await entryOf(ledger, A);
  assert.deepEqual([done.status, done.attempt, done.scheduleId], ["delivered", 2, retrying.scheduleId]);
  assert.deepEqual([host.prompts.get(A), host.schedules.has(first.scheduleId!)], [2, false], "one prompt per resume; the earlier heartbeat deleted once its run ended");
}));

test("an own heartbeat whose runs cannot be read leaves 安排续跑 undone and the retry to the next check: nothing is taken up, deleted or made on a guess", async () => withLedger(async (host, ledger) => {
  const unreachable = new Set<string>();
  host.before = async message => { if (message.type === "schedule/inspect" && unreachable.has(String(message.scheduleId))) throw new Error("宿主未响应子任务请求。可重试，或确认 Paseo 宿主支持子任务观察。"); };
  // Due a minute ago and not started (it waits), but the host cannot tell now: no answer either way.
  const due = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, nextRunAt: iso(host.now - MINUTE) });
  unreachable.add(due.id);
  let sent = host.sent.length;
  const answer = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  assert.deepEqual([answer.status, answer.message], ["failed", "读不到这个 Agent 已有的续跑心跳，没有安排续跑：宿主未响应续跑请求。可重试，或确认 Paseo 宿主支持续跑观察。"]);
  assert.deepEqual([host.sent.slice(sent).map(message => message.type), (await ledger.list(A)).length], [["schedule/list", "schedule/inspect"], 0]);
  unreachable.delete(due.id);
  assert.deepEqual([(await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" })).scheduleId], [due.id], "readable again: it waits, so it is taken up");
  // A retry: B's wake finds B busy; an older own heartbeat of B's (long past) cannot be read while the retry is made.
  const planned = Date.parse("2026-10-11T12:30:00Z");
  const scheduled = await ledger.schedule(host.paseo, { agentId: B, at: iso(planned) });
  host.busy.add(B);
  host.now = planned; await host.tick();
  const old = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: B }, nextRunAt: iso(planned - 30 * MINUTE), createdAt: iso(now0 - HOUR) });
  unreachable.add(old.id);
  host.now += MINUTE; sent = host.sent.length; await ledger.check();
  const waiting = await entryOf(ledger, B);
  assert.deepEqual([waiting.status, waiting.reason, waiting.attempt, waiting.scheduleId], ["retrying", "busy", 2, null], "kept as a retry to make");
  assert.deepEqual([host.sent.slice(sent).filter(message => message.type === "schedule/create").length, host.schedules.has(old.id), host.schedules.has(scheduled.scheduleId!)], [0, true, false]);
  // Readable at the next check, but nothing is made before the last two minutes ahead of its 12:41 (a create whose answer was lost
  // could still land, codex-obs-resume-recheck11-F3); then the dead one goes and the retry is made, at 12:41.
  unreachable.delete(old.id);
  host.now += MINUTE; await ledger.check();
  assert.deepEqual([(await entryOf(ledger, B)).scheduleId, host.schedules.has(old.id)], [null, true]);
  host.now = Date.parse("2026-10-11T12:39:00Z"); await ledger.check();
  const made = await entryOf(ledger, B);
  assert.deepEqual([made.status, made.attempt, made.scheduleId !== null, made.wakeAt, host.schedules.has(old.id)], ["retrying", 2, true, "2026-10-11T12:41:00.000Z", false]);
}));

test("three cancels at once and a 复盘 read never wait on the token index: none of them queue behind another or a slow scan (codex-obs-resume-recheck5-F2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-resume-queue-"));
  const ingester = new TokenIngester({ roots: [{ source: "claude", path: root }], onCall: () => {} }), source = new LocalTokenCallSource(ingester);
  try {
    await withLedger(async (host, ledger) => {
      for (const id of [A, B, C]) await writeFile(join(root, `session-${id.slice(-1)}.jsonl`), JSON.stringify({ type: "user", sessionId: `session-${id.slice(-1)}`, timestamp: iso(now0), message: { content: "earlier" } }) + "\n");
      await ingester.backfillAll();
      const planned = Date.parse("2026-10-11T12:02:00Z");
      for (const id of [A, B, C]) await ledger.schedule(host.paseo, { agentId: id, at: iso(planned) });
      // Each wake finds its Agent busy: each heartbeat holds a failed run whose prompt a cancel looks for.
      for (const id of [A, B, C]) host.busy.add(id);
      for (host.now = planned; host.now <= planned + 2 * MINUTE; host.now += MINUTE) await host.tick();
      // A rescan going on holds the ingester's queue (Codex's repro: slow I/O behind a poll).
      const held = gate(), scan = ingester.scan.bind(ingester);
      ingester.scan = async () => { await held.wait; return scan(); };
      const polling = ingester.poll(true);
      const digest = new DigestService({ tokens: source, telemetry: { snapshot: async () => ({ events: [] }) } });
      const paseo = { agents: { ref: (id: string) => ({ ...host.paseo.agents.ref(id), timeline: { refetch: async () => ({ epoch: "e", entries: [], hasOlder: false, hasNewer: false }) } }) } } as unknown as PaseoApi;
      const started = performance.now();
      const done = await Promise.race([Promise.all([...[A, B, C].map(id => ledger.cancel(host.paseo, { agentId: id })), digest.read({ agentId: A }, paseo).then(() => "read")]), delay(5000).then(() => null)]);
      assert.ok(done, "everything answered while the scan was still held");
      assert.deepEqual(done.slice(0, 3).map(result => typeof result === "string" ? result : result.status), ["canceled", "canceled", "canceled"]);
      assert.equal(done[3], "read");
      assert.ok(performance.now() - started < 3000);
      assert.deepEqual([A, B, C].map(id => host.live(id).length), [0, 0, 0]);
      held.open(); await polling; await digest.close();
    }, { logs: source });
  } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
});

// Round 9 (codex-obs-resume-recheck9), the self-check: no bounded store drops what is owed (a delete, a waiting resume), and a wake
// moved in 计划 is told from one the host moved by the heartbeat's own cron.
test("the rule a waiting resume's heartbeat was made or taken up with is kept with it: the ledger's own cron for one it makes, the rule read for one it takes up; a ledger from before reads it from the wake only while the record holds the time first confirmed on its first heartbeat, else none is known, and one that does not read is dropped, never the resume (codex-obs-resume-recheck10-F1, recheck11-F4)", async () => withLedger(async (host, ledger, directory) => {
  const at = "2026-10-11T12:02:00.000Z";
  await ledger.schedule(host.paseo, { agentId: A, at });
  // B's was made by 2.13, in the device's zone.
  const legacy = host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: B }, nextRunAt: "2026-10-12T12:02:00.000Z" });
  assert.equal((await ledger.schedule(host.paseo, { agentId: B, at })).scheduleId, legacy.id);
  assert.deepEqual([(await entryOf(ledger, A)).cadence, (await entryOf(ledger, B)).cadence], [{ expression: "2 12 11 * *", timezone: "UTC" }, { expression: "2 5 12 10 *", timezone: "US/Pacific" }]);
  // Read back as the page reads it, the rule included.
  const read = getResumes.output.parse(await ledger.read({}));
  assert.equal(read.mode === "full" && read.entries.find(entry => entry.agentId === A)?.cadence?.expression, "2 12 11 * *");
  // A file from before: C waiting without a rule at the time first confirmed, D's rule unreadable, E finished without one. F's wake
  // is not the time first confirmed (2.14.0 followed the user's time there), G is a retry: neither has a rule known
  // (codex-obs-resume-recheck11-F4).
  const [F, G] = ["6f1c2a3b-0000-4000-8000-00000000000f", "6f1c2a3b-0000-4000-8000-000000000010"];
  const file = join(directory, "resume-ledger.json"), saved = JSON.parse(await readFile(file, "utf8")) as { entries: Array<Record<string, unknown>> };
  const base: Record<string, unknown> = { ...saved.entries.find(entry => entry.agentId === A)!, plannedAt: "2026-10-11T13:07:00.000Z", wakeAt: "2026-10-11T13:07:00.000Z" };
  delete base.cadence;
  const entries = [{ ...base, agentId: C }, { ...base, agentId: D, cadence: { expression: "0 2 * *; rm -rf", timezone: "UTC" } }, { ...base, agentId: E, status: "delivered", deliveredAt: at },
    { ...base, agentId: F, wakeAt: "2026-10-11T15:00:00.000Z" }, { ...base, agentId: G, attempt: 2, status: "retrying", reason: "missed" }];
  await writeFile(file, JSON.stringify({ version: 1, entries, tidy: [] }));
  const reloaded = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {} });
  try {
    assert.deepEqual(await Promise.all([C, D, E, F, G].map(async id => (await entryOf(reloaded, id)).cadence)), [{ expression: "7 13 11 * *", timezone: "UTC" }, { expression: "7 13 11 * *", timezone: "UTC" }, undefined, null, null]);
  } finally { await reloaded.close(); }
}));

test("waiting resumes are never dropped past RESUME_LEDGER_LIMIT Agents: finished ones give way, and once the waiting ones fill it 安排续跑 is refused, saying why; every one is kept across a reload (codex-obs-resume-recheck9-F2, self-check)", async () => withLedger(async (host, ledger, directory) => {
  const ids = Array.from({ length: RESUME_LEDGER_LIMIT + 6 }, (_, index) => `7e1c2a3b-0000-4000-8000-${String(index).padStart(12, "0")}`);
  for (const id of ids) host.agents.set(id, { title: "整理日志", archivedAt: null, lastUserMessageAt: iso(now0 - HOUR) });
  // Five finished first (cancelled), then the waiting ones up to the limit.
  for (const id of ids.slice(0, 5)) { await ledger.schedule(host.paseo, { agentId: id, at: "2026-10-11T12:02:00.000Z" }); assert.equal((await ledger.cancel(host.paseo, { agentId: id })).status, "canceled"); }
  host.now += MINUTE;
  const waiting = ids.slice(5, 5 + RESUME_LEDGER_LIMIT);
  for (const id of waiting) assert.equal((await ledger.schedule(host.paseo, { agentId: id, at: "2026-10-11T12:02:00.000Z" })).status, "scheduled");
  const creates = host.creates().length;
  const refused = await ledger.schedule(host.paseo, { agentId: ids.at(-1)!, at: "2026-10-11T12:02:00.000Z" });
  assert.deepEqual([refused.status, refused.message, host.creates().length], ["failed", `已经有 ${RESUME_LEDGER_LIMIT} 个 Agent 的续跑在等（含正在安排的），观测台最多同时跟进 ${RESUME_LEDGER_LIMIT} 个；等其中一些送达或取消后再安排。`, creates]);
  const listed = await ledger.list();
  assert.deepEqual([listed.length, listed.filter(entry => entry.status === "scheduled").length, waiting.every(id => listed.some(entry => entry.agentId === id))], [RESUME_LEDGER_LIMIT, RESUME_LEDGER_LIMIT, true], "the finished ones gave way, no waiting one did");
  const reloaded = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {} });
  try { assert.equal((await reloaded.list()).filter(entry => entry.status === "scheduled").length, RESUME_LEDGER_LIMIT); } finally { await reloaded.close(); }
  // A file holding more waiting ones than the limit (an older or edited one) loses none of them either.
  const file = join(directory, "resume-ledger.json"), saved = JSON.parse(await readFile(file, "utf8")) as { entries: ResumeEntry[] };
  const extra = { ...saved.entries.find(entry => entry.status === "scheduled")!, agentId: ids.at(-1)!, scheduleId: "sched-extra" };
  await writeFile(file, JSON.stringify({ ...saved, entries: [...saved.entries, extra] }));
  const over = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {} });
  try {
    assert.equal((await over.list()).filter(entry => entry.status === "scheduled").length, RESUME_LEDGER_LIMIT + 1);
    // The page reads every one: the answer stays within what the devices accept.
    const read = getResumes.output.parse(await over.read({}));
    assert.equal(read.mode === "full" && read.entries.length, RESUME_LEDGER_LIMIT + 1);
  } finally { await over.close(); }
}));

test("a retry's own heartbeat whose answer was lost is found however many schedules the host lists, the newest last: never made a second time (codex-obs-resume-recheck9-F2, self-check)", async () => withLedger(async (host, ledger) => {
  for (let index = 0; index < 2100; index++) host.add({ name: `日报 ${index}`, prompt: "写日报", target: { type: "agent", agentId: B }, maxRuns: null, nextRunAt: iso(now0 + 9 * 24 * HOUR) });
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.busy.add(A); await host.tick(); host.busy.delete(A);
  host.lose.set("schedule/create", 1);
  host.now = Date.parse("2026-10-11T12:02:30Z");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).scheduleId, host.creates().length, host.live(A).length], [null, 2, 1]);
  host.now = Date.parse("2026-10-11T12:03:30Z");
  await ledger.check();
  const claimed = await entryOf(ledger, A);
  assert.deepEqual([host.creates().length, host.live(A).length, claimed.scheduleId, claimed.attempt], [2, 1, host.live(A)[0]!.id, 2], "the 2101st schedule, taken over");
}));

test("heartbeats kept to delete are never dropped for room (codex-obs-resume-recheck9-F2): a full ledger with the longest ids stays far below the file limit and loads whole, one holding more than the limit loses none, and while full a retry whose old heartbeat cannot be deleted waits and a cancel keeps the record that still names one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-resume-"));
  const file = join(directory, "resume-ledger.json"), stamp = "2026-10-11T04:00:00.000+05:30", at = Date.parse(stamp);
  const long = (prefix: string, length: number, fill = "x") => (prefix + fill.repeat(length)).slice(0, length);
  const open = async (host: FakeHost) => { const ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {}, logs: host.logs }); await ledger.ready; return ledger; };
  try {
    // The most Agents, every bounded field at its longest (its text three-byte characters where any may go; a rule's cron and zone
    // are ASCII), and the most heartbeats to delete (TIDY_HARD_LIMIT) with the longest ids: about 830 KB, under the limit.
    const cadence = { expression: ("1".repeat(192) + " 1 1 1 1").slice(0, 200), timezone: long("A", 64, "a") };
    const entries = Array.from({ length: RESUME_LEDGER_LIMIT }, (_, index) => ({ agentId: long(`agent-${index}-`, 256, "汉"), scheduleId: long(`s${index}-`, 80, "汉"), stopAt: stamp, plannedAt: stamp, wakeAt: stamp,
      attempt: 999, status: "failed", reason: "restart-unsure", createdAt: stamp, updatedAt: stamp, deliveredAt: stamp, cadence, attemptAt: stamp, turnAt: stamp,
      turnId: long("t", 200, "汉"), turnUser: false }));
    const full = JSON.stringify({ version: 1, entries, tidy: Array.from({ length: TIDY_HARD_LIMIT }, (_, index) => ({ id: long(`h${index}-`, 128), agentId: long(`agent-${index}-`, 256, "汉") })) });
    assert.ok(Buffer.byteLength(full) > 820_000 && Buffer.byteLength(full) < LEDGER_MAX_BYTES, `${Buffer.byteLength(full)} bytes`);
    await writeFile(file, full);
    const host = new FakeHost(); host.now = at;
    let ledger = await open(host);
    assert.equal((await ledger.list()).length, RESUME_LEDGER_LIMIT);
    assert.deepEqual((await ledger.list())[0]!.cadence, cadence, "the rule read back whole");
    assert.equal((await ledger.schedule(host.paseo, { agentId: A, at: iso(at + HOUR) })).message, `还有 ${TIDY_HARD_LIMIT} 条续跑心跳等着删除（它们的运行还没结束，或者宿主暂时删不掉），删掉之前先不安排新的续跑；请稍后再试。`);
    await ledger.close();
    // More than the limit (an older or edited file): none dropped.
    await writeFile(file, JSON.stringify({ version: 1, entries: [], tidy: Array.from({ length: TIDY_HARD_LIMIT + 50 }, (_, index) => ({ id: `h${index}`, agentId: B })) }));
    ledger = await open(host);
    assert.match((await ledger.schedule(host.paseo, { agentId: A, at: iso(at + HOUR) })).message, new RegExp(`^还有 ${TIDY_HARD_LIMIT + 50} 条续跑心跳等着删除`));
    await ledger.close();
    // Full with B's heartbeats the host cannot delete for now. A's resume missed its wake (completed without a run, its delete
    // failing too); A also has an ended resume whose heartbeat may still be there, and a 2.13 heartbeat to cancel.
    for (const id of [A, B]) host.agents.set(id, { title: "修复登录", archivedAt: null, lastUserMessageAt: null, persistence: { provider: "claude", sessionId: `session-${id.slice(-1)}` } });
    const owed = Array.from({ length: TIDY_LIMIT }, () => host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: B }, status: "completed", nextRunAt: null }));
    const missed = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, status: "completed", nextRunAt: null, expiresAt: iso(at) });
    const waitingA = { agentId: A, scheduleId: missed.id, stopAt: null, plannedAt: iso(at - 10 * MINUTE), wakeAt: iso(at - 10 * MINUTE), attempt: 1, status: "scheduled", reason: null,
      createdAt: iso(at - HOUR), updatedAt: iso(at - HOUR), deliveredAt: null };
    await writeFile(file, JSON.stringify({ version: 1, entries: [waitingA], tidy: owed.map(heartbeat => ({ id: heartbeat.id, agentId: B })) }));
    host.refuse.set("schedule/delete", 1_000_000);
    ledger = await open(host); ledger.notePaseo(host.paseo);
    const creates = host.creates().length;
    await ledger.check();
    assert.deepEqual([(await entryOf(ledger, A)).status, (await entryOf(ledger, A)).scheduleId, host.creates().length], ["scheduled", missed.id, creates], "the retry waits: nothing made, its old heartbeat still named");
    // Deletes go through again: the retry goes ahead and every one owed is deleted.
    host.refuse.delete("schedule/delete");
    await ledger.check();
    const retried = await entryOf(ledger, A);
    assert.deepEqual([retried.status, retried.attempt, host.schedules.has(missed.id), owed.filter(heartbeat => host.schedules.has(heartbeat.id)).length], ["retrying", 2, false, 0]);
    await ledger.close();
    // Full again, A's last resume ended naming a heartbeat that may still be there: cancelling a 2.13 heartbeat of A's keeps that record.
    const legacy = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, nextRunAt: iso(at + 3 * HOUR) });
    const endedA = { ...waitingA, scheduleId: "sched-old", status: "delivered", deliveredAt: iso(at - 10 * MINUTE) };
    await writeFile(file, JSON.stringify({ version: 1, entries: [endedA], tidy: owed.map(heartbeat => ({ id: heartbeat.id, agentId: B })) }));
    ledger = await open(host);
    const canceled = await ledger.cancel(host.paseo, { agentId: A, scheduleId: legacy.id });
    assert.deepEqual([canceled.status, host.schedules.has(legacy.id), (await entryOf(ledger, A)).scheduleId, (await entryOf(ledger, A)).status], ["canceled", false, "sched-old", "delivered"]);
    await ledger.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a retry's own heartbeat whose answer was lost: a read of it that fails leaves the retry to the next check, nothing made; one found past the window's last minute that already woke the Agent is delivered, never left behind as 未能续跑 (codex-obs-resume-recheck9-F1)", async () => withLedger(async (host, ledger, directory) => {
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.busy.add(A); await host.tick(); host.busy.delete(A);
  host.lose.set("schedule/create", 1);
  host.now = Date.parse("2026-10-11T12:02:30Z");
  await ledger.check();
  const pending = await entryOf(ledger, A);
  assert.deepEqual([pending.status, pending.scheduleId, pending.attempt, pending.wakeAt], ["retrying", null, 2, "2026-10-11T12:13:00.000Z"]);
  // Its read fails: left as it was, nothing made.
  host.refuse.set("schedule/inspect", 1);
  host.now = Date.parse("2026-10-11T12:03:30Z");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).scheduleId, (await entryOf(ledger, A)).wakeAt, host.creates().length], [null, "2026-10-11T12:13:00.000Z", 2]);
  host.now = Date.parse("2026-10-11T12:04:30Z");
  await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).scheduleId, host.creates().length], [host.live(A)[0]!.id, 2], "the next check takes it over");
  // Another Agent's fifth try was asked for 18:00, the window's last minutes, and its answer was lost; the heartbeat woke B at 18:00.
  // Its record as the ledger writes it, the try's start with it (`attemptAt`, without which none is taken, recheck14-F1).
  host.now = Date.parse("2026-10-11T11:00:00Z");
  const made = host.add({ name: "恢复后续跑 · 整理日志（第 5 次）", target: { type: "agent", agentId: B }, nextRunAt: "2026-10-11T18:00:00.000Z", expiresAt: "2026-10-11T18:10:00.000Z" });
  const waitingB = { agentId: B, scheduleId: null, stopAt: null, plannedAt: "2026-10-11T12:02:00.000Z", wakeAt: "2026-10-11T18:00:00.000Z", attempt: 5, status: "retrying", reason: "busy",
    createdAt: "2026-10-11T10:00:00.000Z", updatedAt: "2026-10-11T17:50:00.000Z", deliveredAt: null, attemptAt: "2026-10-11T11:00:00.000Z" };
  await ledger.close();
  const saved = JSON.parse(await readFile(join(directory, "resume-ledger.json"), "utf8")) as { entries: unknown[] };
  await writeFile(join(directory, "resume-ledger.json"), JSON.stringify({ ...saved, entries: [...saved.entries, waitingB] }));
  host.now = Date.parse("2026-10-11T18:00:00Z"); host.fire(made.id, "succeeded");
  host.now = Date.parse("2026-10-11T18:00:30Z");
  const reloaded = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {}, logs: host.logs });
  try {
    reloaded.notePaseo(host.paseo);
    await reloaded.check();
    const b = await entryOf(reloaded, B);
    assert.deepEqual([b.status, b.scheduleId, b.deliveredAt, host.schedules.has(made.id), host.creates().length], ["delivered", made.id, "2026-10-11T18:00:00.000Z", false, 2]);
  } finally { await reloaded.close(); }
}));

test("the ledger never writes a file it could not read back: one change past LEDGER_MAX_BYTES is kept in memory and reported, the file on disk stays whole and loads again (codex-obs-resume-recheck9-F2)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-resume-"));
  const file = join(directory, "resume-ledger.json");
  try {
    const host = new FakeHost();
    host.agents.set(A, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
    const heartbeat = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, nextRunAt: iso(now0 + 3 * HOUR) });
    // A waiting resume, written as the ledger writes it (its fields in order), and heartbeats to delete up to the file limit to the byte.
    const waiting = { agentId: A, scheduleId: heartbeat.id, stopAt: null, plannedAt: heartbeat.nextRunAt, wakeAt: heartbeat.nextRunAt, attempt: 1, status: "scheduled", reason: null,
      createdAt: iso(now0), updatedAt: iso(now0), deliveredAt: null };
    const item = (index: number, length = 256) => ({ id: `h${String(index).padStart(6, "0")}${"x".repeat(121)}`, agentId: `a${"y".repeat(length - 1)}` });
    const size = (tidy: Array<{ id: string; agentId: string }>) => Buffer.byteLength(JSON.stringify({ version: 1, entries: [waiting], tidy }));
    // Every item costs the same but for its Agent's length: `least` with one character, `full` with 256.
    const tidy = [item(0)], full = size([item(0), item(1)]) - size(tidy), least = size([item(0), item(1, 1)]) - size(tidy);
    for (let count = Math.floor((LEDGER_MAX_BYTES - size(tidy) - least) / full); count > 0; count--) tidy.push(item(tidy.length));
    // What is left takes one item, or two when it is more than one can hold.
    let gap = LEDGER_MAX_BYTES - size(tidy);
    if (gap > full) { tidy.push(item(tidy.length, gap - least - (least - 1))); gap = LEDGER_MAX_BYTES - size(tidy); }
    tidy.push(item(tidy.length, gap - (least - 1)));
    assert.equal(size(tidy), LEDGER_MAX_BYTES, "exactly the limit");
    await writeFile(file, JSON.stringify({ version: 1, entries: [waiting], tidy }));
    host.now = now0 + MINUTE;
    const ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {} });
    try {
      // Cancelled: 「canceled」, reason 「user」 make its record a byte longer.
      assert.equal((await ledger.cancel(host.paseo, { agentId: A })).status, "canceled");
      const read = await ledger.read({});
      assert.equal(read.mode === "full" ? read.error : null, "续跑记录超出了大小上限，这次没有写入磁盘，当前状态保留在内存里。");
      assert.equal((await entryOf(ledger, A)).status, "canceled", "kept in memory");
    } finally { await ledger.close(); }
    const again = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {} });
    try {
      const read = await again.read({});
      assert.deepEqual([read.mode === "full" ? read.error : "?", (await entryOf(again, A)).status], [null, "scheduled"], "the file on disk still loads, as it was");
    } finally { await again.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("安排续跑 requests under way when the heartbeats to delete fill up still record the heartbeat each made: RESUME_LEDGER_LIMIT at once, each replacing an ended resume, go past TIDY_LIMIT one each and never past TIDY_HARD_LIMIT; one more asking meanwhile is refused, so the waiting resumes stay within the limit; all kept across a reload and cleared once deletes go through (codex-obs-resume-recheck9 follow-up)", async () => withLedger(async (host, _ledger, directory) => {
  const file = join(directory, "resume-ledger.json"), stamp = iso(now0 - 2 * HOUR), asked = "2026-10-11T12:02:00.000Z";
  const ids = Array.from({ length: RESUME_LEDGER_LIMIT + 1 }, (_, index) => `7e1c2a3b-0000-4000-8000-${String(index).padStart(12, "0")}`);
  for (const id of ids) host.agents.set(id, { title: "整理日志", archivedAt: null, lastUserMessageAt: iso(now0 - 3 * HOUR) });
  const asking = ids.slice(0, RESUME_LEDGER_LIMIT), extra = ids.at(-1)!;
  // Each asking Agent's last resume was delivered (its heartbeat deleted since; as far as the ledger knows, still owed a delete),
  // and one short of TIDY_LIMIT heartbeats of B's wait to be deleted, which the host cannot delete for now.
  const ended = asking.map((agentId, index) => ({ agentId, scheduleId: `sched-old-${index}`, stopAt: null, plannedAt: stamp, wakeAt: stamp, attempt: 1, status: "delivered", reason: null,
    createdAt: stamp, updatedAt: stamp, deliveredAt: stamp }));
  const owed = Array.from({ length: TIDY_LIMIT - 1 }, () => host.add({ name: "恢复后续跑 · 整理日志", target: { type: "agent", agentId: B }, status: "completed", nextRunAt: null }));
  await writeFile(file, JSON.stringify({ version: 1, entries: ended, tidy: owed.map(heartbeat => ({ id: heartbeat.id, agentId: B })) }));
  host.refuse.set("schedule/delete", 1_000_000);
  const open = () => new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {}, logs: host.logs });
  let ledger = open();
  try {
    // They all ask at once: each passes the opening checks before any records its heartbeat. One more asks at that moment.
    const listed = gate();
    let lists = 0, more = null as ReturnType<ResumeLedger["schedule"]> | null;
    host.before = async message => {
      if (message.type !== "schedule/list" || ++lists > asking.length) return;
      if (lists === asking.length) { more = ledger.schedule(host.paseo, { agentId: extra, at: asked }); await settle(); listed.open(); }
      await listed.wait;
    };
    const replies = await Promise.all(asking.map(agentId => ledger.schedule(host.paseo, { agentId, at: asked })));
    host.before = async () => {};
    assert.deepEqual(replies.filter(reply => reply.status !== "scheduled" || reply.existing).map(reply => reply.message), []);
    const refused = await more!;
    assert.deepEqual([refused.status, refused.message], ["failed", `已经有 ${RESUME_LEDGER_LIMIT} 个 Agent 的续跑在等（含正在安排的），观测台最多同时跟进 ${RESUME_LEDGER_LIMIT} 个；等其中一些送达或取消后再安排。`]);
    // Each recorded the one heartbeat it made and kept the one its ended resume named: past TIDY_LIMIT, within TIDY_HARD_LIMIT.
    for (const [index, agentId] of asking.entries()) {
      const entry = await entryOf(ledger, agentId);
      assert.deepEqual([entry.status, entry.scheduleId, host.live(agentId).map(heartbeat => heartbeat.id)], ["scheduled", replies[index]!.scheduleId, [replies[index]!.scheduleId]]);
    }
    assert.deepEqual([host.creates().length, host.live(extra).length], [RESUME_LEDGER_LIMIT, 0]);
    const kept = (JSON.parse(await readFile(file, "utf8")) as { tidy: Array<{ id: string }> }).tidy.map(item => item.id);
    assert.deepEqual([kept.length, kept.length <= TIDY_HARD_LIMIT], [TIDY_LIMIT - 1 + RESUME_LEDGER_LIMIT, true]);
    assert.deepEqual([ended.filter(entry => !kept.includes(entry.scheduleId)).length, owed.filter(heartbeat => !kept.includes(heartbeat.id)).length], [0, 0]);
    // Reloaded: every one kept; still past TIDY_LIMIT, a new request is refused.
    await ledger.close(); ledger = open();
    assert.equal((await ledger.list()).filter(entry => entry.status === "scheduled").length, RESUME_LEDGER_LIMIT);
    assert.match((await ledger.schedule(host.paseo, { agentId: extra, at: asked })).message, new RegExp(`^还有 ${TIDY_LIMIT - 1 + RESUME_LEDGER_LIMIT} 条续跑心跳等着删除`));
    // Deletes go through again: one check clears every one, and the heartbeats just made are left to wake their Agents.
    host.refuse.delete("schedule/delete");
    await ledger.check();
    assert.deepEqual([(JSON.parse(await readFile(file, "utf8")) as { tidy: unknown[] }).tidy.length, owed.filter(heartbeat => host.schedules.has(heartbeat.id)).length], [0, 0]);
    assert.equal(asking.filter(agentId => host.live(agentId).length !== 1).length, 0);
    // One cancelled: there is room for one more.
    assert.equal((await ledger.cancel(host.paseo, { agentId: asking[0]! })).status, "canceled");
    assert.equal((await ledger.schedule(host.paseo, { agentId: extra, at: asked })).status, "scheduled");
  } finally { await ledger.close(); }
}));

test("a create whose answer was lost is a resume to confirm, never looked for by what the user can change nor made again (codex-obs-resume-recheck12): it holds its minute and asking again returns it; at the check the one heartbeat for this Agent made since the request is it, whatever its name; two (another device's made meanwhile) are not told apart, and none for two minutes from the request is not taken as made: 未能确认 both, nothing deleted or made. A create answered at another minute is still deleted again, a lost answer to that delete counted, its minute let go (lost answer, after 5061e0d; codex-obs-resume-recheck11-F3)", async () => withLedger(async (host, ledger) => {
  const [F, H] = ["6f1c2a3b-0000-4000-8000-00000000000f", "6f1c2a3b-0000-4000-8000-000000000011"];
  for (const id of [F, H]) host.agents.set(id, { title: "整理日志", archivedAt: null, lastUserMessageAt: iso(now0 - HOUR) });
  const LOST = "宿主未响应：插件会话已重新连接，请重试。";
  const MAYBE = (at: string, detail = LOST) => `安排续跑时宿主没有回话（${detail.slice(0, -1)}），还不知道续跑建好没有。已记下 ${at} 的续跑：观测台会在下一分钟核对，确认不了时，停下卡片上会请你到 Paseo 的「计划」里查看。`;
  /** As the create for `agentId` reaches the host, `meanwhile` runs; the answer is then lost. */
  const lose = (agentId: string, meanwhile: () => void = () => {}) => {
    host.lose.set("schedule/create", 1);
    host.before = async message => { if (message.type === "schedule/create" && (message.target as { agentId: string }).agentId === agentId) { host.before = async () => {}; meanwhile(); } };
  };
  const creates = (agentId: string) => host.creates().filter(message => (message.target as { agentId: string }).agentId === agentId).length;
  // A: made, its answer lost: a resume to confirm, nothing looked for or made at once.
  lose(A);
  let sent = host.sent.length;
  const a = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  assert.deepEqual([a.status, a.scheduleId, a.message, host.sent.slice(sent).map(message => message.type), host.live(A).length], ["scheduled", null, MAYBE("明天 05:02"), ["schedule/list", "schedule/create"], 1]);
  // B: as its create reaches the host, another device makes one for B too: two. Asked again, it is the one waiting, nothing made;
  // its minute is kept (H asking for it gets the next one).
  lose(B, () => host.add({ name: "恢复后续跑 · 另一台设备", target: { type: "agent", agentId: B }, cadence: { type: "cron", expression: "2 14 11 10 *" }, nextRunAt: "2026-10-11T14:02:00.000Z" }));
  const b = await ledger.schedule(host.paseo, { agentId: B, at: "2026-10-11T12:10:00.000Z" });
  assert.deepEqual([b.status, b.scheduleId, b.message, host.live(B).length], ["scheduled", null, MAYBE("明天 05:10"), 2]);
  const againB = await ledger.schedule(host.paseo, { agentId: B, at: "2026-10-11T12:10:00.000Z" });
  assert.deepEqual([againB.existing, againB.scheduleId, againB.runAt, againB.message, host.live(B).length, creates(B)],
    [true, null, "2026-10-11T12:10:00.000Z", "已记下 明天 05:10 的续跑，正在核对它建好没有，没有重复安排。要换时间，先取消这一次。", 2, 1]);
  assert.equal((await ledger.schedule(host.paseo, { agentId: H, at: "2026-10-11T12:10:00.000Z" })).runAt, "2026-10-11T12:11:00.000Z");
  // C: the host puts it at another minute; deleted again, the answer to that delete lost (the host deleted it). Its minute is let
  // go: F gets it.
  host.skew = 60; host.lose.set("schedule/delete", 1);
  const c = await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T12:20:00.000Z" });
  host.skew = 0;
  assert.deepEqual([c.status, c.message, host.live(C).length], ["failed", "宿主算出的唤醒时间是 明天 06:20，和确认的 明天 05:20 不一致，已撤销，没有安排续跑。", 0]);
  assert.equal((await ledger.schedule(host.paseo, { agentId: F, at: "2026-10-11T12:20:00.000Z" })).runAt, "2026-10-11T12:20:00.000Z");
  // E: the create never reaches the host: nothing made, which the observatory cannot tell from an answer lost.
  host.refuse.set("schedule/create", 1);
  const e = await ledger.schedule(host.paseo, { agentId: E, at: "2026-10-11T12:40:00.000Z" });
  assert.deepEqual([e.status, e.scheduleId, e.message, host.live(E).length], ["scheduled", null, MAYBE("明天 05:40", "宿主未响应续跑请求。可重试，或确认 Paseo 宿主支持续跑观察。"), 0]);
  // A minute on: A's one heartbeat made since the request is taken up as its first, whatever its name; B's two are not told apart:
  // 未能确认, both left as they are; E's none yet is looked for again. Nothing made or deleted.
  host.now += MINUTE; sent = host.sent.length; await ledger.check();
  const [checkedA, checkedB, checkedE] = [await entryOf(ledger, A), await entryOf(ledger, B), await entryOf(ledger, E)];
  assert.deepEqual([checkedA.status, checkedA.scheduleId, checkedA.attempt], ["scheduled", host.live(A)[0]!.id, 1]);
  assert.deepEqual([checkedB.status, checkedB.reason, checkedB.scheduleId, host.live(B).length], ["failed", "unsure", null, 2]);
  assert.deepEqual([checkedE.status, checkedE.scheduleId], ["scheduled", null]);
  assert.equal(host.sent.slice(sent).filter(message => message.type === "schedule/create" || message.type === "schedule/delete").length, 0);
  // Two minutes from E's request, still none: 未能确认, never made.
  host.now = Date.parse(e.entry!.createdAt) + 2 * MINUTE; await ledger.check();
  const unconfirmed = await entryOf(ledger, E);
  assert.deepEqual([unconfirmed.status, unconfirmed.reason, unconfirmed.scheduleId, host.live(E).length, creates(E)], ["failed", "unsure", null, 0, 1]);
}));

test("a resume to confirm (its first create's answer lost): a list that fails keeps it as it is, the first heartbeat at its wake; a cancel finds the heartbeat the host made and deletes it, one that cannot list cancels nothing, and one with none made yet stops the checks, deletes nothing and promises nothing (codex-obs-resume-recheck11-F3, recheck12)", async () => withLedger(async (host, ledger) => {
  // A: the create reaches the host and its answer is lost.
  host.lose.set("schedule/create", 1);
  const a = await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  assert.deepEqual([a.status, a.scheduleId, host.live(A).length], ["scheduled", null, 1]);
  // B: the create never reaches the host.
  host.refuse.set("schedule/create", 1);
  const b = await ledger.schedule(host.paseo, { agentId: B, at: "2026-10-11T12:03:00.000Z" });
  assert.deepEqual([b.status, b.scheduleId, host.live(B).length], ["scheduled", null, 0]);
  // A's check cannot list: kept as it is, the first heartbeat still to confirm.
  host.refuse.set("schedule/list", 1); host.now += MINUTE; await ledger.check();
  const kept = await entryOf(ledger, A);
  assert.deepEqual([kept.status, kept.reason, kept.scheduleId, kept.attempt, kept.wakeAt], ["scheduled", null, null, 1, "2026-10-11T12:02:00.000Z"]);
  // Cancelled from the card: a list that fails cancels nothing; then the one the host made is found and deleted.
  host.refuse.set("schedule/list", 1);
  const refused = await ledger.cancel(host.paseo, { agentId: A });
  assert.deepEqual([refused.status, refused.message, (await entryOf(ledger, A)).status, host.live(A).length],
    ["failed", "读不到续跑的心跳，没有取消：宿主未响应续跑请求。可重试，或确认 Paseo 宿主支持续跑观察。", "scheduled", 1]);
  const canceled = await ledger.cancel(host.paseo, { agentId: A });
  assert.deepEqual([canceled.status, canceled.message, (await entryOf(ledger, A)).reason, (await entryOf(ledger, A)).scheduleId !== null, host.live(A).length], ["canceled", "已取消续跑，到点不会唤醒它。", "user", true, 0]);
  const deletes = host.sent.filter(message => message.type === "schedule/delete").length;
  const stopped = await ledger.cancel(host.paseo, { agentId: B });
  assert.deepEqual([stopped.status, stopped.message, (await entryOf(ledger, B)).reason, host.sent.filter(message => message.type === "schedule/delete").length],
    ["canceled", "已停止核对和补建。如果之后在 Paseo 的「计划」里出现这条续跑，请删除它。", "user", deletes]);
}));

test("a resume to confirm whose heartbeat the host made, the user carrying on meanwhile, is found before it is settled: 你已接着做 with that heartbeat deleted first, never left to wake the Agent (codex-obs-resume-recheck11-F3)", async () => withLedger(async (host, ledger) => {
  host.lose.set("schedule/create", 1);
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z", stopAt: "2026-10-11T03:59:00.000Z" });
  assert.deepEqual([(await entryOf(ledger, A)).scheduleId, host.live(A).length], [null, 1]);
  host.agents.get(A)!.lastUserMessageAt = iso(host.now + 30_000);
  host.now += MINUTE; await ledger.check();
  const entry = await entryOf(ledger, A);
  assert.deepEqual([entry.status, entry.reason, host.live(A).length], ["canceled", "resumed", 0]);
}));

test("a retry whose create answer was lost, another heartbeat made for the Agent meanwhile (another device's), cannot be told apart: 未能确认 at the check, neither deleted, nothing made in its place (codex-obs-resume-recheck12)", async () => withLedger(async (host, ledger) => {
  await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
  host.now = Date.parse("2026-10-11T12:02:00Z");
  host.busy.add(A); await host.tick(); host.busy.delete(A);
  // The retry reaches the host and its answer is lost; another device makes one for A meanwhile.
  host.lose.set("schedule/create", 1);
  host.before = async message => {
    if (message.type !== "schedule/create") return;
    host.before = async () => {};
    host.add({ name: "恢复后续跑 · 另一台设备", target: { type: "agent", agentId: A }, nextRunAt: "2026-10-11T12:30:00.000Z" });
  };
  host.now = Date.parse("2026-10-11T12:02:30Z"); await ledger.check();
  assert.deepEqual([(await entryOf(ledger, A)).status, (await entryOf(ledger, A)).scheduleId, host.live(A).length], ["retrying", null, 2]);
  // The checks, up to two minutes before its wake (12:13) and past it: two could be it, 未能确认; neither deleted, nothing made.
  const sent = host.sent.length;
  for (const at of ["2026-10-11T12:03:30Z", "2026-10-11T12:11:30Z"]) { host.now = Date.parse(at); await ledger.check(); }
  const entry = await entryOf(ledger, A);
  assert.deepEqual([entry.status, entry.reason, entry.scheduleId, host.live(A).length, host.sent.slice(sent).filter(message => message.type === "schedule/create" || message.type === "schedule/delete").length],
    ["failed", "unsure", null, 2, 0]);
}));

test("a delivered resume whose heartbeat delete lost its answer, the host having deleted it, ends delivered even with the heartbeats to delete full: never left waiting on a heartbeat gone, then taken for one the user deleted (lost answer, after 5061e0d)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-resume-"));
  const file = join(directory, "resume-ledger.json"), wake = Date.parse("2026-10-11T12:02:00Z");
  try {
    const host = new FakeHost();
    for (const id of [A, B]) host.agents.set(id, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
    // A's resume ran at 12:02 and went in; B has TIDY_LIMIT heartbeats left to delete: no room for another.
    const ran = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: A }, status: "completed", nextRunAt: null,
      runs: [{ id: runId(1), scheduledFor: iso(wake), startedAt: iso(wake), endedAt: iso(wake + MINUTE), status: "succeeded", agentId: null, output: null, error: null }] });
    const owed = Array.from({ length: TIDY_LIMIT }, () => host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: B }, status: "completed", nextRunAt: null }));
    const waiting = { agentId: A, scheduleId: ran.id, stopAt: null, plannedAt: iso(wake), wakeAt: iso(wake), attempt: 1, status: "scheduled", reason: null,
      createdAt: iso(wake - HOUR), updatedAt: iso(wake - HOUR), deliveredAt: null };
    await writeFile(file, JSON.stringify({ version: 1, entries: [waiting], tidy: owed.map(heartbeat => ({ id: heartbeat.id, agentId: B })) }));
    host.now = wake + 2 * MINUTE;
    // The first delete of the check, A's, goes through; its answer is lost.
    host.lose.set("schedule/delete", 1);
    const ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {}, logs: host.logs });
    try {
      await ledger.check();
      const delivered = await entryOf(ledger, A);
      assert.deepEqual([delivered.status, delivered.deliveredAt, host.schedules.has(ran.id)], ["delivered", iso(wake), false]);
      host.now += MINUTE; await ledger.check();
      assert.deepEqual([(await entryOf(ledger, A)).status, (await entryOf(ledger, A)).reason], ["delivered", null]);
    } finally { await ledger.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the rule kept is the one each heartbeat was made or taken up with: a retry's own, a 2.13 heartbeat a retry takes up; a restart moving either is still tried again. A retry from a ledger before the rule was kept has none known: a restart's move is followed, never deleted on a guess, and unrun at its expiry it ends (codex-obs-resume-recheck10-F1, recheck11-F4)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-resume-"));
  const file = join(directory, "resume-ledger.json");
  try {
    const host = new FakeHost();
    for (const id of [A, B, C]) host.agents.set(id, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
    // B's retry, from a ledger that kept no rule: its 12:30 may be the cron the ledger made or a heartbeat it took up as it was.
    const legacyRetry = host.add({ name: "恢复后续跑 · 修复登录（第 2 次）", target: { type: "agent", agentId: B }, cadence: { type: "cron", expression: "30 12 11 * *", timezone: "UTC" }, nextRunAt: "2026-10-11T12:30:00.000Z",
      expiresAt: "2026-10-11T18:00:00.000Z" });
    await writeFile(file, JSON.stringify({ version: 1, tidy: [], entries: [{ agentId: B, scheduleId: legacyRetry.id, stopAt: null, plannedAt: "2026-10-11T12:00:00.000Z", wakeAt: "2026-10-11T12:30:00.000Z",
      attempt: 2, status: "retrying", reason: "missed", createdAt: iso(now0), updatedAt: iso(now0), deliveredAt: null }] }));
    const ledger = new ResumeLedger(host.bridge, { directory, now: () => host.now, timers: false, log: () => {}, logs: host.logs });
    try {
      await ledger.schedule(host.paseo, { agentId: A, at: "2026-10-11T12:02:00.000Z" });
      await ledger.schedule(host.paseo, { agentId: C, at: "2026-10-11T12:05:00.000Z" });
      // C also has a heartbeat 2.13 made, in the device's zone: 05:15 Pacific, 12:15 UTC.
      const legacy = host.add({ name: "恢复后续跑 · 修复登录", target: { type: "agent", agentId: C }, cadence: { type: "cron", expression: "15 5 11 10 *", timezone: "US/Pacific" }, nextRunAt: "2026-10-11T12:15:00.000Z" });
      // 12:10: the daemon was down over A's and C's wakes and moves them on: A's retry is made, C's takes up the 2.13 one.
      host.now = Date.parse("2026-10-11T12:10:00Z"); host.restart(); await ledger.check();
      const [a, c] = [await entryOf(ledger, A), await entryOf(ledger, C)];
      assert.deepEqual([[a.attempt, a.wakeAt, a.cadence], [c.attempt, c.scheduleId, c.cadence]],
        [[2, "2026-10-11T12:12:00.000Z", { expression: "12 12 11 * *", timezone: "UTC" }], [2, legacy.id, { expression: "15 5 11 10 *", timezone: "US/Pacific" }]]);
      // 12:40: down again over all three; each moved by its own rule. A's and C's are tried again; B's, its rule unknown, is
      // followed where the host moved it.
      host.now = Date.parse("2026-10-11T12:40:00Z"); host.restart(); await ledger.check();
      const after = await Promise.all([A, B, C].map(id => entryOf(ledger, id)));
      assert.deepEqual(after.map(entry => [entry.status, entry.reason, entry.attempt]), [["retrying", "missed", 3], ["retrying", "missed", 2], ["retrying", "missed", 3]]);
      assert.deepEqual([after[1]!.scheduleId, after[1]!.wakeAt, after[1]!.cadence], [legacyRetry.id, "2026-11-11T12:30:00.000Z", null]);
      assert.deepEqual([A, B, C].map(id => host.live(id).length), [1, 1, 1], "A's and C's only the new one, B's its own");
      // 18:00: B's expiry (the window's end) passes unrun: 未能续跑, which the card offers to 重新安排.
      host.now = Date.parse("2026-10-11T18:00:00Z"); await host.tick(); await ledger.check();
      assert.deepEqual([(await entryOf(ledger, B)).status, (await entryOf(ledger, B)).reason, host.live(B).length], ["failed", "expired", 0]);
    } finally { await ledger.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
