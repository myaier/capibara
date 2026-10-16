import { onTextChange } from "./i18n";
import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { QuotaAccount } from "./quota";
import type { HeartbeatSummary } from "./schedules";

/**
 * 恢复后续跑 (opus-B9): after a usage limit, one tap (and a confirmation) schedules a one-off heartbeat that prompts the same
 * Agent again a couple of minutes after the limit resets. Nothing happens on its own: the user picks it and sees the exact
 * wake time; the schedule is an ordinary Paseo heartbeat (listed in 计划 and 定时运行) that the stop card can cancel.
 *
 * The host gives a heartbeat one chance: busy at that minute, a daemon restart or the host offline, and the run fails or
 * never happens (grok-F5, opus-F38). The server keeps a small ledger (server/resume.ts) and counts a resume done only once
 * the prompt went in: it checks the heartbeat every minute while one waits and tries again within RESUME_WINDOW_MS, but only
 * when the prompt surely did not go in and the user has not carried on by hand (F1, F3). Where it cannot tell (a restart cut
 * the run short, codex-obs-resume-F2) it says so and leaves it to the user; a heartbeat the user changed in Paseo is theirs.
 */
// i18n-ignore: Original heartbeat prompt is a persisted ownership guard for pre-i18n schedules.
export const LEGACY_RESUME_PROMPT = "额度已经恢复。请先看一下这段对话和工作区的当前状态，再接着完成之前没做完的任务；如果已经做完，就简要汇报结果。";
export let RESUME_PROMPT = t("sharedResume.m001");
/** How long after the reset the Agent is woken, so the provider's own clock has surely rolled over. */
export const RESUME_DELAY_MS = 2 * 60_000;
/**
 * The heartbeats behind 恢复后续跑 are named 「恢复后续跑 · <title>」. Only such a heartbeat that wakes the Agent once (`maxRuns` 1)
 * with RESUME_PROMPT is ever adopted, replaced, deleted or cancelled (F7): the name alone could be a copy the user made recurring.
 */
// i18n-ignore: Original heartbeat name prefix identifies pre-i18n schedules.
export const LEGACY_RESUME_NAME = "恢复后续跑";
export let RESUME_NAME = t("sharedResume.m002");
/** Delivery is retried until this long after the wake time first confirmed; past it the resume is 未能续跑 (重新安排 starts over). */
export const RESUME_WINDOW_MS = 6 * 3_600_000;
/** The window as the card and the confirmation word it (「6 小时内自动再试」). */
export let RESUME_WINDOW_TEXT = t("sharedResume.m003", { value1: RESUME_WINDOW_MS / 3_600_000 });
/** A busy Agent (the host fails a run that finds a turn going), or one the host timed out loading, is tried again this much later. */
export const RESUME_BUSY_RETRY_MS = 10 * 60_000;
/** A missed wake (host offline, daemon restarted) is tried again this soon. */
export const RESUME_MISSED_RETRY_MS = 2 * 60_000;
/** A wake this far past with no run recorded was missed. */
export const RESUME_MISSED_GRACE_MS = 3 * 60_000;
/** The ledger keeps at most this many Agents' latest resume. */
export const RESUME_LEDGER_LIMIT = 200;

const iso = z.iso.datetime({ offset: true });
const zone = z.string().min(1).max(64).regex(/^[A-Za-z][\w+-]*(\/[\w+-]+){0,2}$/);
/** A cron as the host takes one (five fields of digits, `*`, `,`, `-` and `/`), one space apart, as the ledger keeps it. */
export const CRON_TEXT = /^[\d*,/-]+(?: [\d*,/-]+){4}$/;
/** A heartbeat's rule as the ledger keeps it: its cron and zone (none: UTC). */
export const resumeCadenceSchema = z.object({ expression: z.string().max(200).regex(CRON_TEXT), timezone: zone.nullable() });
export type ResumeCadence = z.infer<typeof resumeCadenceSchema>;
export const RESUME_STATUSES = ["scheduled", "waking", "retrying", "delivered", "failed", "canceled"] as const;
export type ResumeStatus = (typeof RESUME_STATUSES)[number];
/**
 * Why a resume is where it is: busy (the Agent had a turn going at the minute), missed (the wake never ran: host offline or
 * restarted before it), restart (2.14.0 tried again after a restart cut the run short; kept for its ledgers), error (the host
 * could not load the Agent: tried again after a load timeout, final when its ACP session cannot be loaded again), unsure (the
 * run failed after it may have prompted the Agent: never tried again on its own; without a heartbeat, a create whose answer was
 * lost and none could be told for it, codex-obs-resume-recheck12), restart-unsure (a daemon restart cut the run short and
 * nothing shows whether its prompt went in, codex-obs-resume-F2: never tried again on its own), expired (the window passed),
 * archived / gone (the Agent), user (取消续跑), resumed (the user messaged the Agent after it stopped, so a resume would come
 * twice), deleted / paused (the heartbeat, in Paseo's 计划), edited (the heartbeat was changed there into something else,
 * codex-obs-resume-F4: the user's from then on, never deleted).
 */
export const RESUME_REASONS = ["busy", "missed", "restart", "error", "unsure", "restart-unsure", "expired", "archived", "gone", "user", "resumed", "deleted", "paused", "edited"] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];
/** One Agent's latest resume: ids, times, the attempt and the state only (no prompt, no reply). */
export const resumeEntrySchema = z.object({
  agentId: z.string().min(1).max(256),
  /**
   * The heartbeat waiting now (or the last one); null while one is still to be confirmed or made: a retry's create is out (it is
   * recorded so before it goes out, `attemptAt`), a create's answer was lost (the first one's too, codex-obs-resume-recheck11-F3)
   * or the create failed, and the ledger's checks look for it; only a retry's is made again (codex-obs-resume-recheck12). Null on
   * one ended so, too: none was found, or it could not be told (more than one, or one not a resume heartbeat).
   */
  scheduleId: z.string().max(80).nullable(),
  /** Fingerprint of the generated name and prompt; language changes never alter ownership. No text is stored. */
  identity: z.string().regex(/^[a-f0-9]{64}$/).optional().catch(undefined),
  /** The stop it resumes (`StopReason.at`), when the card said. */
  stopAt: iso.nullable(),
  /** 原定唤醒时刻: the wake time first confirmed; the retry window counts from it. */
  plannedAt: iso,
  /** 当前唤醒时刻: the waiting heartbeat's (or the last one's). */
  wakeAt: iso,
  /** 第几次: 1 for the first heartbeat, one more for each retry. */
  attempt: z.number().int().min(1).max(999),
  status: z.enum(RESUME_STATUSES),
  reason: z.enum(RESUME_REASONS).nullable(),
  createdAt: iso,
  updatedAt: iso,
  /** When the prompt went in (delivered only). */
  deliveredAt: iso.nullable(),
  /**
   * The rule the heartbeat was made or taken up with (codex-obs-resume-recheck10-F1): its cron and zone as the ledger asked
   * for it or read it then; null when not a cron, or not known. Changed since, the user changed it in 计划; the same rule at
   * another time is the host's doing. A ledger from before it has none: `ResumeLedger` takes the cron it makes for the wake only
   * where the record still holds the time first confirmed, else none is known (codex-obs-resume-recheck11-F4). One that does not
   * read is dropped, never the entry.
   */
  cadence: resumeCadenceSchema.nullable().optional().catch(undefined),
  /**
   * When this attempt began, written with the record before its create goes out (a retry's; the first attempt's is `createdAt`):
   * a heartbeat for this Agent the host made since then is the one its create may have made, its answer lost
   * (codex-obs-resume-recheck13-F2). One that does not read is dropped, never the entry. A retry without one (the live ledger's)
   * takes none it finds as its own (codex-obs-resume-recheck14-F1).
   */
  attemptAt: iso.optional().catch(undefined),
  /**
   * A turn seen starting after the wake, its id and whether the user's message opened it, as ledgers written before the
   * recheck kept them. Read so those files still load, never relied on: a turn proves nothing about a resume (a system
   * notification opens one too), only the host's run record or the prompt in the session's own log do
   * (codex-obs-resume-recheck-F1).
   */
  turnAt: iso.nullable().optional(),
  turnId: z.string().max(200).nullable().optional(),
  turnUser: z.boolean().nullable().optional(),
});
export type ResumeEntry = z.infer<typeof resumeEntrySchema>;
export const PENDING_RESUME: ReadonlySet<ResumeStatus> = new Set<ResumeStatus>(["scheduled", "waking", "retrying"]);

export const scheduleResume = defineRpc({
  name: "observatory.resume.schedule",
  input: z.object({
    agentId: z.string().min(1).max(256),
    /** The wake time the user confirmed (the button says it). */
    at: iso,
    /** The device's time zone, for the reply's wording (已在 05:02 安排); the heartbeat itself runs on a UTC cron. */
    timeZone: zone.optional(),
    title: z.string().max(160).optional(),
    /** The stop this resumes (`StopReason.at`). */
    stopAt: iso.optional(),
  }),
  output: z.object({ status: z.enum(["scheduled", "failed"]), scheduleId: z.string().nullable(), runAt: iso.nullable(), message: z.string(),
    /** The Agent already had a resume waiting: that one is returned and nothing new was created. */
    existing: z.boolean().optional(),
    entry: resumeEntrySchema.nullable().optional() }),
});
export type ScheduleResumeResult = z.infer<typeof scheduleResume.output>;

const revision = z.string().min(1).max(80);
/** The ledger's real state, for one Agent or all; unchanged polls are a few bytes. */
export const getResumes = defineRpc({
  name: "observatory.resume.list",
  input: z.object({ agentId: z.string().min(1).max(256).optional(), revision: revision.optional() }),
  output: z.discriminatedUnion("mode", [
    // As many as a ledger file may hold: waiting resumes are never dropped, so one read from a file with more than the limit
    // (an older or edited one) can hold up to twice as many.
    z.object({ mode: z.literal("full"), unchanged: z.literal(false), revision, generatedAt: iso, entries: z.array(resumeEntrySchema).max(RESUME_LEDGER_LIMIT * 2),
      /** The ledger could not be read or saved (Chinese, one sentence). */ error: z.string().max(300).nullable() }),
    z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
  ]),
});
export type ResumesResponse = z.infer<typeof getResumes.output>;
export type ResumesState = Extract<ResumesResponse, { mode: "full" }>;
export function mergeResumes(previous: ResumesState | undefined, response: ResumesResponse): ResumesState {
  if (response.mode === "full") return response;
  if (!previous) throw new Error(t("sharedResume.m004"));
  return previous;
}

/** 取消续跑: deletes the waiting heartbeat, after checking it is a 恢复后续跑 heartbeat of this Agent. */
export const cancelResume = defineRpc({
  name: "observatory.resume.cancel",
  input: z.object({ agentId: z.string().min(1).max(256), /** A heartbeat the ledger does not know (made by 2.13). */ scheduleId: z.string().min(1).max(80).optional() }),
  output: z.object({ status: z.enum(["canceled", "failed"]), message: z.string(), entry: resumeEntrySchema.nullable() }),
});
export type CancelResumeResult = z.infer<typeof cancelResume.output>;

/** When to wake: two minutes after the reset, rounded up to a whole minute, and never sooner than a minute from now. */
export function resumeTime(resetAt: string | number, now = Date.now()): number {
  const reset = typeof resetAt === "number" ? resetAt : Date.parse(resetAt);
  const at = Math.max(Number.isFinite(reset) ? reset + RESUME_DELAY_MS : now, now + 60_000);
  return Math.ceil(at / 60_000) * 60_000;
}

/**
 * The one-off heartbeat's cron, in UTC: the minute, hour and day of `at`, in any month. A wall-clock cron in the device's zone
 * fires an hour early when `at` falls in the hour a fall-back repeats, because the daemon takes the first matching minute
 * (codex-F7, opus-F37). The month stays open (F5): `maxRuns` 1 and the expiry keep it to one run, a wake within 8 days is
 * still its first match, and a missed one moves to next month, never to a date the daemon may not find within a year (a
 * 29 February made its start-up recovery throw). Cards and 定时运行 show the host's computed time in device time either way.
 */
export function resumeCron(at: number): { expression: string; timezone: "UTC" } {
  const date = new Date(at);
  return { expression: `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} * *`, timezone: "UTC" };
}
export const sameMinute = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.floor(a / 60_000) === Math.floor(b / 60_000);
export const isResumeName = (name: string | null | undefined) => typeof name === "string" && (name.startsWith(LEGACY_RESUME_NAME) || name.startsWith(RESUME_NAME));
/** The heartbeat's name: 「恢复后续跑 · <title>」, with 第 N 次 on a retry. */
export function resumeName(title: string | null | undefined, attempt = 1): string {
  return `${RESUME_NAME} · ${(title || "Agent").slice(0, 60)}${attempt > 1 ? t("sharedResume.m005", { attempt: attempt }) : ""}`;
}

/**
 * A 恢复后续跑 heartbeat the ledger does not know (made by 2.13) still waiting to wake this Agent, for the stop card: a one-off one
 * (a recurring copy the user made keeps the name, F7) due within the next 8 days; one the host moved out after missing its
 * minute wakes nothing in time (opus-F38). One the ledger knows (`known`: its entries' heartbeats) is its entry's to show, also
 * once the ledger let go of it because the user changed it in Paseo (codex-obs-resume-F4).
 */
export function legacyResume(heartbeats: readonly Pick<HeartbeatSummary, "scheduleId" | "status" | "name" | "maxRuns" | "nextRunAt">[] | undefined, now: number,
  known: ReadonlySet<string | null> = new Set()): { scheduleId: string; at: number } | null {
  for (const heartbeat of heartbeats ?? []) {
    const at = Date.parse(heartbeat.nextRunAt ?? "");
    if (known.has(heartbeat.scheduleId)) continue;
    if (heartbeat.status === "active" && isResumeName(heartbeat.name) && heartbeat.maxRuns === 1 && Number.isFinite(at) && at > now - 60_000 && at <= now + 8 * 86_400_000) return { scheduleId: heartbeat.scheduleId, at };
  }
  return null;
}

/**
 * The resume the stop card shows for an Agent: one still waiting always (whatever stop it was for); a finished one only with
 * the stop it resumed, so a new limit starts fresh.
 */
export function resumeFor(entries: readonly ResumeEntry[] | undefined, agentId: string, stopAt: string | null | undefined): ResumeEntry | null {
  const entry = entries?.find(item => item.agentId === agentId);
  if (!entry) return null;
  if (PENDING_RESUME.has(entry.status)) return entry;
  if (!stopAt) return null;
  return entry.stopAt ? entry.stopAt === stopAt ? entry : null : Date.parse(entry.createdAt) >= Date.parse(stopAt) ? entry : null;
}

export type ResumeHue = "pink" | "amber" | "blue" | "green" | "red" | "muted";
export interface ResumeLook {
  hue: ResumeHue; icon: string; pill: string; text: string;
  /** 取消续跑 is offered. */ cancellable: boolean;
  /** 恢复后续跑 / 重新安排 is offered again. */ again: boolean;
  /** Still waiting: poll it. */ pending: boolean;
}
/**
 * How the stop card shows a resume: 已安排 pink, 正在唤醒 blue, 正忙稍后再试 amber, 已续跑 green, 未能确认续跑 amber (look at the
 * session first, then 重新安排; after a restart too, codex-obs-resume-F2), 未能续跑 red (重新安排, unless the Agent cannot be woken at
 * all), 已取消, 你已接着做 and 心跳被改过 (codex-obs-resume-F4) grey. `clock` formats an instant in device time (`clockLabel`).
 */
export function resumeLook(entry: ResumeEntry, clock: (at: number) => string): ResumeLook {
  const wake = clock(Date.parse(entry.wakeAt)), nth = t("sharedResume.m006", { value1: entry.attempt });
  switch (entry.status) {
    case "scheduled": {
      // Its create's answer was lost: the ledger's checks look for the heartbeat, never make it again (codex-obs-resume-recheck12).
      if (!entry.scheduleId) return { hue: "amber", icon: "RotateCw", pill: t("sharedResume.m007"), text: t("sharedResume.m008", { wake: wake }),
        cancellable: true, again: false, pending: true };
      return { hue: "pink", icon: "AlarmClock", pill: t("sharedResume.m009", { wake: wake }), text: t("sharedResume.m010", { wake: wake }), cancellable: true, again: false, pending: true };
    }
    // Until the host's run record or the session's log proves the prompt went in (codex-obs-resume-recheck-F1), a whole turn long.
    case "waking": return { hue: "blue", icon: "BellRing", pill: t("sharedResume.m011"), text: t("sharedResume.m012", { wake: wake }), cancellable: false, again: false, pending: true };
    case "retrying": {
      if (!entry.scheduleId) return { hue: "amber", icon: "RotateCw", pill: t("sharedResume.m013"), text: t("sharedResume.m014", { value1: entry.attempt }), cancellable: true, again: false, pending: true };
      const why = entry.reason === "busy" ? t("sharedResume.m015") : entry.reason === "missed" ? t("sharedResume.m016")
        : entry.reason === "restart" ? t("sharedResume.m017") : entry.reason === "error" ? t("sharedResume.m018") : t("sharedResume.m019");
      return { hue: "amber", icon: entry.reason === "busy" ? "Hourglass" : "RotateCw", pill: entry.reason === "busy" ? t("sharedResume.m020", { wake: wake }) : t("sharedResume.m021", { wake: wake }),
        text: t("sharedResume.m022", { why: why, wake: wake, nth: nth }), cancellable: true, again: false, pending: true };
    }
    case "delivered": {
      const at = clock(Date.parse(entry.deliveredAt ?? entry.wakeAt));
      return { hue: "green", icon: "CircleCheck", pill: t("sharedResume.m023", { at: at }), text: t("sharedResume.m024", { at: at, value2: entry.attempt > 1 ? nth : "" }), cancellable: false, again: false, pending: false };
    }
    case "failed": {
      // Its create's answer was lost, and none could be told for it: none found, more than one, or one that is not a resume
      // heartbeat (codex-obs-resume-recheck12, recheck13-F2).
      if (entry.reason === "unsure" && !entry.scheduleId) return { hue: "amber", icon: "CircleHelp", pill: t("sharedResume.m025"),
        text: t("sharedResume.m026"), cancellable: false, again: true, pending: false };
      // The run erred after it may have prompted the Agent: sending again on its own could prompt it twice.
      if (entry.reason === "unsure") return { hue: "amber", icon: "CircleHelp", pill: t("sharedResume.m027"), text: t("sharedResume.m028"),
        cancellable: false, again: true, pending: false };
      // A restart cut the run short and nothing shows whether the prompt went in: never sent again on its own.
      if (entry.reason === "restart-unsure") return { hue: "amber", icon: "CircleHelp", pill: t("sharedResume.m029"),
        text: t("sharedResume.m030"), cancellable: false, again: true, pending: false };
      const final = entry.reason === "archived" || entry.reason === "gone" || entry.reason === "error";
      const text = entry.reason === "archived" ? t("sharedResume.m031") : entry.reason === "gone" ? t("sharedResume.m032")
        : entry.reason === "error" ? t("sharedResume.m033")
        : entry.reason === "expired" ? t("sharedResume.m034", { value1: clock(Date.parse(entry.plannedAt)), RESUME_WINDOW_TEXT: RESUME_WINDOW_TEXT }) : t("sharedResume.m035");
      return { hue: "red", icon: "AlarmClockOff", pill: t("sharedResume.m036"), text, cancellable: false, again: !final, pending: false };
    }
    case "canceled": {
      if (entry.reason === "resumed") return { hue: "muted", icon: "MessageSquareText", pill: t("sharedResume.m037"), text: t("sharedResume.m038"), cancellable: false, again: true, pending: false };
      if (entry.reason === "edited") return { hue: "muted", icon: "FilePen", pill: t("sharedResume.m039"),
        text: t("sharedResume.m040"), cancellable: false, again: true, pending: false };
      // Cancelled while its create's answer was still to be confirmed and none was found: one the host is still writing may land.
      const text = entry.reason === "deleted" ? t("sharedResume.m041") : entry.reason === "paused" ? t("sharedResume.m042")
        : entry.scheduleId ? t("sharedResume.m043") : t("sharedResume.m044");
      return { hue: "muted", icon: "AlarmClockOff", pill: t("sharedResume.m045"), text, cancellable: false, again: true, pending: false };
    }
  }
}

/** Window ids scoped to a model, surface or feature (weekly_opus, code_review:five_hour, limit:<id>:weekly): not the account's own limit. */
const SCOPED_WINDOW = /:|^weekly_|^code_review$/;
/**
 * 按额度窗口 (opus-B18): when the notice gave no reset time, the reset of the exhausted usage window of the Agent's base.
 * Only with exactly one account for that base (several logins could be any of them), a current reading (not stale, the
 * account available), its own windows (the summary ones when it marks any), used ≥ 99.5 % and a reset still ahead; the
 * latest such reset. Null otherwise: the user picks how long to wait.
 */
export function quotaWindowReset(accounts: readonly Pick<QuotaAccount, "provider" | "name" | "status" | "stale" | "windows">[] | null | undefined, base: string | null | undefined, now: number): { resetAt: number; window: string; account: string } | null {
  if (!base || !accounts) return null;
  const mine = accounts.filter(account => account.provider === base);
  if (mine.length !== 1) return null;
  const account = mine[0]!;
  if (account.status !== "available" || account.stale) return null;
  const own = account.windows.filter(window => !SCOPED_WINDOW.test(window.id));
  const shown = own.some(window => window.summary) ? own.filter(window => window.summary) : own;
  let found: { resetAt: number; window: string } | null = null;
  for (const window of shown) {
    const reset = Date.parse(window.resetsAt ?? "");
    if (window.state !== "live" || window.usedPct === null || window.usedPct < 99.5 || !Number.isFinite(reset) || reset <= now) continue;
    if (!found || reset > found.resetAt) found = { resetAt: reset, window: window.label };
  }
  return found ? { ...found, account: account.name } : null;
}

/** The label a handed-over Agent carries: the id of the Agent it took over from (opus-B23). */
export const HANDOVER_LABEL = "observatory.handover-from";
/**
 * 交给另一个 Provider: the new Agent's first message. No transcript is pasted: it reads the original itself with the CLI, looks
 * at the workspace's changes and carries on; the original must not be resumed as well.
 */
export function handoverPrompt(source: { id: string; title?: string | null }): string {
  const title = source.title?.trim() || t("sharedResume.m046");
  return [
    t("sharedResume.m047", { title: title, value2: source.id }),
    "",
    t("sharedResume.m048"),
    `   paseo inspect ${source.id}`,
    `   paseo logs ${source.id} --tail 200`,
    t("sharedResume.m049"),
    t("sharedResume.m050"),
    "",
    t("sharedResume.m051"),
  ].join("\n");
}
/** One stop handed to one profile is one Agent, however often it is tapped or retried (`idempotencyKey`). */
export function handoverKey(agentId: string, stopAt: string, profileId: string): string {
  return `observatory-handover:${agentId}:${stopAt}:${profileId}`.slice(0, 512);
}
/** 「<原标题>（接手自 <provider>）」. */
export function handoverTitle(title: string | null | undefined, provider: string): string {
  return t("sharedResume.m052", { value1: (title?.trim() || t("sharedResume.m053")).slice(0, 50), value2: provider.slice(0, 24) });
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  RESUME_PROMPT = t("sharedResume.m001");
  RESUME_NAME = t("sharedResume.m002");
  RESUME_WINDOW_TEXT = t("sharedResume.m003", { value1: RESUME_WINDOW_MS / 3_600_000 });
});
