import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { consentFor, contentKey, coversConsent, messageIdKey, permissionIds, sendPlan, type Consent, type SendTarget } from "./send-plan";
import { addDefaults, t, type Params } from "../shared/i18n";
import { kitDeferredServer } from "../shared/locales/kit/zh-CN.json";

addDefaults({ kitDeferredServer });

/**
 * A plugin server's ledger of messages to existing agents: 「等这一轮结束再发」, and sending now.
 * - Queued messages: the user chose not to push into a running turn (a provider that cannot steer, a slash command)
 *   or past a pending approval (any send cancels it). Each plugin keeps its own ledger in one JSON file under its
 *   plugin-data folder, so it survives reloads, and sends the oldest message of an agent once that agent is idle with
 *   nothing pending. A poll runs only while something waits; `notify()` from an existing `agent.turn_ended` /
 *   `agent.permission_resolved` hook delivers sooner (a hook of its own would clone every timeline once more).
 * - Sending now (`send()`): the server plans the send again from the agent as it is at that moment and sends only
 *   if the user's consent still covers what it would do (interrupt a turn, cancel these approvals); otherwise it
 *   answers with the confirmation to show.
 * - One message per agent and content key is on its way at a time (queued, held or sending): sending or queueing the
 *   same content again answers with that message, on every client and after reloads. So does content that went out
 *   in the last few seconds (two clients at once); after that the same content is a new message.
 * - Messages answering one question share a `group` (a quick reply's round, whichever button): once one of them is on
 *   its way, went out or may have, every other one answers with it instead of going out.
 * - A message may carry the plugin's own condition (`guard`, e.g. the turn a quick reply answers). The plugin's `guard`
 *   check runs under the agent's lock with the agent just read, right before a send now goes out and before each
 *   delivery of a queued message: once it no longer holds, nothing goes out.
 * - The client picks the message id (`newMessageId()` in send-plan.ts). Sends and automatic retries reuse it with the
 *   same options, so the daemon delivers a message at most once.
 * - A send whose reply was lost (outcome unknown) or that failed is held for the user. Paseo keeps the receipt of a
 *   send that failed after it took the message as pending and refuses that id from then on, so the same id cannot
 *   simply be sent again. While the agent is loaded, the ledger looks for the message in the agent's timeline (Paseo
 *   records it there, with our id, when a turn takes it) and marks it sent once it shows up. 「仍然发送」 looks there
 *   first and sends it again, under a new id, only when the timeline since the first attempt shows it never arrived
 *   and that attempt is too old to still be on its way.
 * - Someone talked to the agent after a message was queued (`lastUserMessageAt` moved, and the latest user message in
 *   the agent's timeline is not one a queue sent, told by message id): it is held until the user says to send it
 *   anyway, instead of answering a conversation that has moved on. A message a plugin sent now counts as someone.
 * - Paseo 0.11.1 has no idle-only send, so the idle check and the send are not one step. Every plugin's ledger on the
 *   host takes the same per-agent lock (an exclusive SQLite transaction the OS drops with its process) from the check
 *   until the send returns, so two ledgers cannot both use one idle moment; a message sent outside the plugins in
 *   those few milliseconds can still be replaced.
 * - Archived or deleted agents drop their messages; a message waits at most a day. Receipts stay a week.
 * - Calls that answer an RPC return within the RPC limit; a slow send finishes in the background.
 */

export type DeferredState = "queued" | "held" | "sending" | "sent" | "maybe-sent" | "canceled" | "discarded" | "expired";

/** What the client shows for one message (the shared `DeferredViewSchema` in deferred-rpc.ts). */
export interface DeferredView {
  messageId: string;
  agentId: string;
  /** What makes two messages the same request: one per agent and key is on its way at a time. */
  key: string;
  /** Where it came from, for people ("技能 /review"); may be empty. */
  source: string;
  preview: string;
  createdAt: number;
  /** When it reached its current state. */
  at: number;
  state: DeferredState;
  note: string;
}

/** The parts of a Paseo 0.11 agent snapshot (`refresh()`) this reads. */
export interface DeferredAgentSnapshot {
  provider?: string;
  status: string;
  archivedAt?: string | null;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[] | null;
  lastUserMessageAt?: string | null;
  requiresAttention?: boolean;
  attentionReason?: string | null;
}

/**
 * The parts of the plugin's `paseo` API this uses. `refresh()` reads the record without loading the agent; the
 * timeline is read only when the conversation changed since a message was queued, or for a send whose outcome is
 * unknown while its agent is loaded.
 */
export interface DeferredPaseo {
  agents: {
    ref(id: string): {
      refresh(): Promise<{ agent: DeferredAgentSnapshot } | null>;
      send(text: string, options: { activeTurnBehavior: "steer" | "interrupt"; messageId: string }): Promise<void>;
      timeline: {
        refetch(options: { direction: "tail" | "before"; cursor?: { epoch: string; seq: number }; limit: number; projection: "projected" }): Promise<unknown>;
      };
    };
  };
}

/** What the daemon lets steer (`readSendCapabilities()` in steerable-providers.ts), for planning a send now. */
export interface SendCapabilitiesLike {
  steerable?: readonly string[];
  slashSteerable?: readonly string[];
  bases?: Readonly<Record<string, string>>;
}

export interface DeferredSendOptions {
  /** The ledger file, e.g. `$PASEO_HOME/plugin-data/<plugin id>/deferred-send.json`. */
  file: string;
  /** Per-agent locks shared by every plugin's ledger; defaults to `.deferred-send-locks` beside the plugin folders. */
  lockDirectory?: string;
  /** The daemon's send capabilities; without them custom provider ids are planned cautiously. */
  capabilities?: () => Promise<SendCapabilitiesLike> | SendCapabilitiesLike;
  pollMs?: number;
  /** How long `enqueue()` / `resume()` wait for a send they start before answering (default 5 s, under the RPC limit). */
  answerWaitMs?: number;
  /** How long `send()` waits for its message to go out before answering "sending" (default 20 s, under the RPC limit). */
  sendWaitMs?: number;
  /** The most any call answering an RPC takes (default 24 s; Paseo's plugin RPC limit is 30 s). */
  rpcBudgetMs?: number;
  now?: () => number;
  log?: (message: string, detail?: unknown) => void;
  /**
   * The plugin's own condition for a message sent or queued with a `guard`: asked under the agent's lock with the agent just
   * read, right before a send now goes out, when a message is queued, and before each delivery of a queued one. Returns why
   * the message no longer fits (one clause; the ledger says what became of the message), or null. A send now then answers
   * "refused"; a message being queued or delivered is dropped (未发送, the reason as its note), or settled as maybe-sent
   * when an earlier attempt may have gone out. Throwing means it cannot tell: nothing goes out (a send now answers busy, a
   * queued message is held for the user). Messages without a guard never ask; a guard without this check never goes out.
   */
  guard?: (input: { agentId: string; guard: DeferredGuard; agent: DeferredAgentSnapshot }) => Promise<string | null> | string | null;
}

/** A plugin's own condition for one message: a few named short values its `guard` check reads. */
export type DeferredGuard = Readonly<Record<string, string | null>>;

export interface DeferredSendInput {
  agentId: string;
  text: string;
  messageId: string;
  source?: string;
  /** What makes two messages the same (`contentKey(...)`); defaults to the key of a `<uuid>~<key>` id, else the text. */
  key?: string;
  /** Names the message in a confirmation: "消息", "命令", "回答". */
  what?: string;
  /** What the user agreed to: `consentFor(plan, pendingIds)` of the confirmation they saw; none when none was shown. */
  consent?: Partial<Consent> | null;
  /** Messages answering one question: once one is on its way or went out, the others answer with it ("existing"). */
  group?: string | null;
  /** The plugin's own condition, checked by its `guard` right before the message goes out. */
  guard?: DeferredGuard | null;
}

/**
 * - sent: it went out. sending: still going out, follow it with `list()`. held: it failed or its outcome is unknown,
 *   and waits for the user (resume looks in the conversation, then sends it again only if it never arrived; cancel
 *   drops it).
 * - existing: the same content is already on its way under `view.messageId`, or this id was used before.
 * - confirm: what it would do now needs the user's OK; ask `plan.confirm`, then send again with `consent`.
 * - busy: another send to this agent is going on (or its guard could not be checked); gone: the agent is archived or
 *   deleted; refused: its guard no longer holds. Nothing was sent.
 */
export type DeferredSendResult =
  | { status: "sent" | "sending" | "held" | "existing"; view: DeferredView }
  | { status: "confirm"; plan: { label: string; note: string; confirm: string }; consent: Consent }
  | { status: "busy" | "gone" | "refused"; message: string };

interface Message {
  messageId: string;
  agentId: string;
  key: string;
  source: string;
  text: string;
  createdAt: number;
  /** The agent's `lastUserMessageAt` when queued, when the user last said to send it, or after this queue's own send. */
  baseline: string | null;
  /** Why it waits for the user; null while queued or sending. */
  held: string | null;
  heldAt: number | null;
  attempts: number;
  nextAt: number;
  /** Claimed for a send: a retry after a lost reply skips the baseline check (the id dedupes it). */
  sendingAt: number | null;
  /** Sent now by `send()`, not queued: it never waits for the turn to end. */
  direct: boolean;
  /** The options it goes out with; a retry under the same id must repeat them for the daemon to dedupe it. */
  behavior: "steer" | "interrupt";
  /** Why a held message is held after a send: its outcome is unknown, or the send failed. */
  outcome: "unknown" | "failed" | null;
  /** The id it goes out with: `messageId`, or a new one once the user resends a message that never arrived. */
  sendId: string;
  /** Ids of its earlier sends, looked for in the timeline too. */
  priorIds: string[];
  /** When it was first and last handed to the daemon; null before that. */
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  /** The question it answers (`DeferredSendInput.group`); null for none. */
  group: string | null;
  /** The plugin's own condition (`DeferredSendInput.guard`); null for none. */
  guard: Record<string, string | null> | null;
}

interface Receipt {
  messageId: string;
  agentId: string;
  key: string;
  /** Its message's group: one that went out, or may have, answers the question for every other message of the group. */
  group: string | null;
  source: string;
  preview: string;
  createdAt: number;
  state: Exclude<DeferredState, "queued" | "held" | "sending">;
  at: number;
  note: string;
}

/** A message id this queue sent to the agent: a user message carrying it is the queue's own, not someone else's. */
interface OwnSend {
  agentId: string;
  messageId: string;
  /** When it was recorded, for pruning. */
  recordedAt: number;
}

interface Store {
  version: 1;
  messages: Message[];
  receipts: Receipt[];
  sends: OwnSend[];
}

const DAY = 24 * 3_600_000;
const HELD_POLL_MS = 60_000;
const RECEIPT_MS = 7 * DAY;
const LISTED_RECEIPT_MS = 30 * 60_000;
const MAX_MESSAGES = 100;
const MAX_PER_AGENT = 10;
const MAX_RECEIPTS = 500;
/** Copies of unreadable ledgers kept for a look (they hold message bodies): the newest few, for a week. */
const MAX_ASIDE = 3;
export const MAX_DEFERRED_TEXT = 200_000;
const MAX_KEY = 120;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 6;
const MAX_OPEN_LOCKS = 32;
/** Lock failures in a row before a message stops waiting silently and asks the user. */
const MAX_LOCK_ERRORS = 5;
const READ_TIMEOUT_MS = 15_000;
/** Timeline pages (100 entries each) searched back from the end. */
const TIMELINE_PAGES = 4;
/** Timeline pages searched for an earlier send when the user says to send it anyway. */
const RESUME_PAGES = 10;
/** Longer than Paseo's own bound on a run starting; past it the send's outcome is unknown. */
const SEND_TIMEOUT_MS = 120_000;
/** How long sending now waits for another send to the same agent (this plugin's or another's) before answering busy. */
const SEND_QUEUE_WAIT_MS = 3_000;
/** Every call that answers an RPC answers within this (Paseo's plugin RPC limit is 30 s); work left goes on in the background. */
const RPC_BUDGET_MS = 24_000;
/** How long planning a send waits for the daemon's send capabilities before planning cautiously. */
const CAPABILITIES_WAIT_MS = 3_000;
/** Content that went out this recently answers a new request for it (two clients at once) instead of going out again. */
const RECENT_SAME_MS = 10_000;
/** How often a held message whose send failed or has no outcome is looked for in its agent's timeline. */
const LOOK_EVERY_MS = 60_000;
/** Held messages looked for per poll. */
const MAX_LOOKS = 5;
/** A send this recent may still be on its way inside the daemon: it is not sent again under a new id before then. */
const SETTLE_MS = SEND_TIMEOUT_MS;
/** Entries this much older than a message's first send cannot be it (Paseo records it when a turn takes it). */
const ATTEMPT_MARGIN_MS = 60_000;
const MAX_PRIOR_IDS = 5;
/** Named values a guard keeps, and how long each name and value may be. */
const MAX_GUARD = 8;

// Notes are read when written, in the plugin's language then (`kitDeferredServer`); a stored note keeps its language.
const note = (name: string, params?: Params) => t(`kitDeferredServer.${name}`, params);
const NOTES = {
  get queued() { return note("queued"); },
  get sending() { return note("sending"); },
  get movedOn() { return note("movedOn"); },
  get unsure() { return note("unsure"); },
  get unknown() { return note("unknown"); },
  failed: (error: string) => note("failed", { error }),
  failedRepeatedly: (error: string) => note("failedRepeatedly", { error }),
  get stopped() { return note("stopped"); },
  get settling() { return note("settling"); },
  get unreadable() { return note("unreadable"); },
  get cannotTell() { return note("cannotTell"); },
  get strangers() { return note("strangers"); },
  get late() { return note("late"); },
  get sent() { return note("sent"); },
  get found() { return note("found"); },
  get foundSame() { return note("foundSame"); },
  get "maybe-sent"() { return note("maybeSent"); },
  get canceledUnknown() { return note("canceledUnknown"); },
  get canceledFailed() { return note("canceledFailed"); },
  get canceled() { return note("canceled"); },
  get discarded() { return note("discarded"); },
  get expired() { return note("expired"); },
  get busy() { return note("busy"); },
  get gone() { return note("gone"); },
  refused: (reason: string) => note("refused", { reason }),
  refusedAfterTry: (reason: string) => note("refusedAfterTry", { reason }),
  guardUnknown: (error: string) => note("guardUnknown", { error }),
  guardUnknownBusy: (error: string) => note("guardUnknownBusy", { error }),
  guardHeld: (error: string) => note("guardHeld", { error }),
  get lockBusy() { return note("lockBusy"); },
  get lockHeld() { return note("lockHeld"); },
};

class OutcomeUnknown extends Error {}

const empty = (): Store => ({ version: 1, messages: [], receipts: [], sends: [] });
const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 160);
const busy = (agent: DeferredAgentSnapshot) =>
  agent.status === "running" || agent.status === "initializing" || !!agent.activeTurn || (agent.pendingPermissions?.length ?? 0) > 0;
/** Whether a process with this id still exists (one owned by another user counts). */
const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const errorText = (error: unknown) => {
  // An error from another realm (the plugin sandbox, the RPC bridge) is not `instanceof Error` here.
  const message = (error as { message?: unknown } | null)?.message;
  return (typeof message === "string" ? message : String(error ?? "")).slice(0, 200);
};
/** A send failure for the user: known causes in the plugin's words, anything else as the host's own words after a label. */
const failureText = (error: unknown): string => {
  const text = errorText(error);
  const start = /did not start within (\d+) seconds/.exec(text);
  if (start) return note("noStart", { seconds: start[1] });
  if (/already has an active run/i.test(text)) return note("otherRun");
  if (/foreground turn is already active/i.test(text)) return note("finishingTurn");
  if (/not found|unknown agent|no such agent/i.test(text)) return note("notFound");
  if (/timed? ?out/i.test(text)) return note("timeout");
  if (/socket|connection|disconnect|ECONNRESET|EPIPE|closed/i.test(text)) return note("disconnected");
  return text ? note("hostSaid", { text }) : note("unknownError");
};
const requestOutcome = (error: unknown) => {
  if (error instanceof OutcomeUnknown) return true;
  const code = (error as { code?: unknown } | null)?.code;
  const text = `${typeof code === "string" ? code : ""} ${errorText(error)}`;
  return /agent_request_outcome_unknown|agent_request_key_conflict/.test(text);
};
/** The key of a message: given, or carried in a `<uuid>~<key>` id, or its text. */
const keyOf = (messageId: string, text: string, key?: string | null) => (key?.trim() || messageIdKey(messageId) || contentKey(["text", text])).slice(0, MAX_KEY);
const groupOf = (group?: string | null) => group?.trim().slice(0, MAX_KEY) || null;
/** A guard as given or stored: up to eight named short values. Anything else in it is left out, never the guard itself. */
function guardOf(value: unknown): Record<string, string | null> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const guard: Record<string, string | null> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_GUARD)) {
    if (typeof item === "string" || item === null) guard[name.slice(0, 40)] = typeof item === "string" ? item.slice(0, 200) : null;
  }
  return guard;
}
const STATUSES: readonly SendTarget["status"][] = ["initializing", "idle", "running", "error", "closed"];
/** A send now's answer for a message that already exists. */
const answerFor = (view: DeferredView): "sent" | "sending" | "held" | "existing" =>
  view.state === "sent" ? "sent" : view.state === "sending" ? "sending" : view.state === "held" ? "held" : "existing";

/** `work`, or `timeout()` after `ms`. The timer is cleared as soon as `work` settles. */
function within<T>(work: Promise<T>, ms: number, timeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout()), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Wait for `work` at most `ms`; it keeps running afterwards. */
async function briefly(work: Promise<unknown>, ms: number): Promise<void> {
  await within(work, ms, () => new Error("still running")).catch(() => undefined);
}

function isMessage(value: unknown): value is Message {
  const entry = value as Partial<Message> | null;
  return !!entry && typeof entry.messageId === "string" && typeof entry.agentId === "string" && typeof entry.text === "string" && typeof entry.createdAt === "number";
}

function isReceipt(value: unknown): value is Receipt {
  const entry = value as Partial<Receipt> | null;
  return !!entry && typeof entry.messageId === "string" && typeof entry.agentId === "string" && typeof entry.state === "string" && typeof entry.at === "number";
}

function isOwnSend(value: unknown): value is OwnSend {
  const entry = value as Partial<OwnSend> | null;
  return !!entry && typeof entry.agentId === "string" && typeof entry.messageId === "string" && typeof entry.recordedAt === "number";
}

interface LockStatement {
  run(...values: (string | number)[]): unknown;
  all(...values: (string | number)[]): unknown[];
}
interface LockDatabase {
  exec(sql: string): void;
  prepare(sql: string): LockStatement;
  close(): void;
}
type Lock = { kind: "held"; sent(): string[]; record(messageId: string): void; release(): void } | { kind: "busy" } | { kind: "error"; message: string };
let sqliteModule: Promise<{ DatabaseSync: new (path: string, options?: { timeout?: number }) => LockDatabase } | null> | null = null;
/** `node:sqlite` when this Node has it (22.13+ without a flag), loaded once. */
const loadSqlite = () => (sqliteModule ??= import("node:sqlite").then((module) => module as unknown as { DatabaseSync: new (path: string, options?: { timeout?: number }) => LockDatabase }, () => null));

function normalize(value: unknown): Store {
  const raw = value as { version?: unknown; messages?: unknown; receipts?: unknown; sends?: unknown } | null;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.messages) || !Array.isArray(raw.receipts)) throw new Error("unrecognized queue file");
  const messages = raw.messages.filter(isMessage).map((entry): Message => ({
    messageId: entry.messageId,
    agentId: entry.agentId,
    key: keyOf(entry.messageId, entry.text, typeof entry.key === "string" ? entry.key : null),
    source: typeof entry.source === "string" ? entry.source : "",
    text: entry.text,
    createdAt: entry.createdAt,
    baseline: typeof entry.baseline === "string" ? entry.baseline : null,
    held: typeof entry.held === "string" ? entry.held : null,
    heldAt: typeof entry.heldAt === "number" ? entry.heldAt : null,
    attempts: typeof entry.attempts === "number" ? entry.attempts : 0,
    nextAt: typeof entry.nextAt === "number" ? entry.nextAt : 0,
    sendingAt: typeof entry.sendingAt === "number" ? entry.sendingAt : null,
    direct: entry.direct === true,
    behavior: entry.behavior === "interrupt" ? "interrupt" : "steer",
    outcome: entry.outcome === "unknown" || entry.outcome === "failed" ? entry.outcome : null,
    sendId: typeof entry.sendId === "string" && entry.sendId ? entry.sendId : entry.messageId,
    priorIds: Array.isArray(entry.priorIds) ? entry.priorIds.filter((id): id is string => typeof id === "string").slice(-MAX_PRIOR_IDS) : [],
    firstAttemptAt: typeof entry.firstAttemptAt === "number" ? entry.firstAttemptAt : typeof entry.sendingAt === "number" ? entry.sendingAt : null,
    lastAttemptAt: typeof entry.lastAttemptAt === "number" ? entry.lastAttemptAt : typeof entry.sendingAt === "number" ? entry.sendingAt : null,
    group: typeof entry.group === "string" ? groupOf(entry.group) : null,
    guard: guardOf(entry.guard),
  }));
  const receipts = raw.receipts.filter(isReceipt).map((entry): Receipt => ({
    ...entry,
    key: typeof entry.key === "string" ? entry.key : messageIdKey(entry.messageId) ?? "",
    group: typeof entry.group === "string" ? groupOf(entry.group) : null,
    source: typeof entry.source === "string" ? entry.source : "",
    preview: typeof entry.preview === "string" ? entry.preview : "",
    note: typeof entry.note === "string" ? entry.note : "",
  }));
  return { version: 1, messages, receipts, sends: Array.isArray(raw.sends) ? raw.sends.filter(isOwnSend) : [] };
}

export class DeferredSend {
  private readonly file: string;
  private readonly lockDirectory: string;
  private readonly capabilities: () => Promise<SendCapabilitiesLike> | SendCapabilitiesLike;
  private readonly pollMs: number;
  private readonly answerWaitMs: number;
  private readonly sendWaitMs: number;
  private readonly rpcBudgetMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, detail?: unknown) => void;
  private paseo: DeferredPaseo | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** One delivery or send now at a time per agent; later calls run after it, so a caller sees its outcome. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Messages between their claim and the end of their send. */
  private readonly sendingIds = new Set<string>();
  private stopped = false;
  /** Whether the file held any message at the last read; null before the first. */
  private hasMessages: boolean | null = null;
  /** Open lock files by agent; their transactions are the cross-plugin locks. */
  private readonly locks = new Map<string, LockDatabase>();
  /** Lock files whose transaction is open right now. */
  private readonly lockedNames = new Set<string>();
  /** Lock failures in a row per agent (not busy: the lock file itself would not work). */
  private readonly lockErrors = new Map<string, number>();
  /** When each held message with a failed or unknown send was last looked for in its agent's timeline. */
  private readonly lookedAt = new Map<string, number>();
  /** The look for sends that did arrive going on (`lookForSent`). */
  private looking: Promise<void> = Promise.resolve();
  /** Requests going on per agent and content key (`claimKey`). */
  private readonly claims = new Map<string, { messageId: string; done: Promise<unknown> }>();
  private warnedNoLock = false;
  /** The one-time sweep of leftovers; every read waits for it, so reads keep their order. */
  private pruning: Promise<void> | null = null;
  private readonly guardCheck: DeferredSendOptions["guard"] | null;

  constructor(options: DeferredSendOptions) {
    this.file = options.file;
    this.lockDirectory = options.lockDirectory ?? join(dirname(dirname(options.file)), ".deferred-send-locks");
    this.capabilities = options.capabilities ?? (() => ({}));
    this.pollMs = options.pollMs ?? 5_000;
    this.answerWaitMs = options.answerWaitMs ?? 5_000;
    this.sendWaitMs = options.sendWaitMs ?? 20_000;
    this.rpcBudgetMs = options.rpcBudgetMs ?? RPC_BUDGET_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message, detail) => console.warn(`deferred-send: ${message}`, detail ?? ""));
    this.guardCheck = options.guard ?? null;
  }

  /** Remember an API handle from any RPC or hook context: after a reload the queue has none until one arrives. */
  use(paseo: DeferredPaseo | null | undefined): void {
    if (!paseo || this.stopped) return;
    const first = !this.paseo;
    this.paseo = paseo;
    if (first) this.schedule(0);
  }

  /** From an existing turn-ended or permission-resolved hook: look at this agent shortly, before the next poll. */
  notify(agentId: string, paseo?: DeferredPaseo | null): void {
    this.use(paseo);
    if (this.stopped || this.hasMessages === false) return;
    // The hook can run before the snapshot turns idle; the poll covers a later turn of events.
    const timer = setTimeout(() => void this.flush(agentId).catch((error) => this.log("delivery failed", error)), 400);
    (timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const name of [...this.locks.keys()]) this.closeLock(name);
  }

  /**
   * Send now. The plan is made again here, from the agent as it is, under the agent's lock: the message goes out only
   * if `consent` covers what sending would do now and its `guard` still holds (see `DeferredSendResult`). Answers within
   * `sendWaitMs` plus the agent read; a slow send goes on in the background and shows in `list()`.
   */
  async send(input: DeferredSendInput, paseo?: DeferredPaseo | null): Promise<DeferredSendResult> {
    this.use(paseo);
    const api = paseo ?? this.paseo;
    if (!api) throw new Error(note("notConnected"));
    if (!input.text.trim()) throw new Error(note("empty"));
    if (input.text.length > MAX_DEFERRED_TEXT) throw new Error(note("tooLong"));
    const key = keyOf(input.messageId, input.text, input.key), group = groupOf(input.group);
    const deadline = Date.now() + this.rpcBudgetMs;
    for (;;) {
      // The same id again (a second click, a retry after a lost reply): what happened to it answers.
      const known = await this.view(input.messageId);
      if (known) return { status: answerFor(known), view: known };
      const store = await this.read();
      const other = this.sameContent(store, input.agentId, key) ?? this.sameGroup(store, input.agentId, group);
      if (other) return { status: "existing", view: other };
      const claim = await this.claimKey(input.agentId, group ? ["group", group] : [key], input.messageId, deadline, () => this.sendClaimed(api, input, key, deadline));
      if (claim === "late") return { status: "busy", message: NOTES.busy };
      if (claim.claimed) return claim.value;
      // Another request for the same content came first (two clients at once): its message answers this one too.
      const first = await this.view(claim.messageId);
      if (first) return { status: first.messageId === input.messageId ? answerFor(first) : "existing", view: first };
      // That request sent nothing (it asked for a confirmation, or the agent was busy or gone): this one goes on.
    }
  }

  /**
   * Requests going on per agent and content key, or per agent and group for messages answering one question (`claim`).
   * One that arrives meanwhile for the same content or question waits for the first and answers with its message, even
   * when the first has already been delivered by then.
   */
  private async claimKey<T>(agentId: string, claim: readonly string[], messageId: string, deadline: number, work: () => Promise<T>): Promise<{ claimed: true; value: T } | { claimed: false; messageId: string } | "late"> {
    const name = JSON.stringify([agentId, ...claim]);
    const current = this.claims.get(name);
    if (current) {
      const waited = await within(current.done.then(() => true, () => true), Math.max(0, deadline - Date.now()), () => new Error("late")).catch(() => false);
      return waited ? { claimed: false, messageId: current.messageId } : "late";
    }
    // Nothing awaits between the check above and the claim here.
    const done = work();
    this.claims.set(name, { messageId, done });
    try {
      return { claimed: true, value: await done };
    } finally {
      if (this.claims.get(name)?.done === done) this.claims.delete(name);
    }
  }

  private async sendClaimed(api: DeferredPaseo, input: DeferredSendInput, key: string, deadline: number): Promise<DeferredSendResult> {
    // The answer is due by the request's own budget, however long it waited for another request first.
    const answerBy = Math.min(deadline, deadline - this.rpcBudgetMs + this.sendWaitMs);
    let commit: (view: DeferredView) => void = () => undefined;
    const committed = new Promise<DeferredView>((resolve) => {
      commit = resolve;
    });
    const outcome = this.exclusive(input.agentId, () => this.sendNow(api, input, key, commit, deadline));
    const first = await Promise.race([outcome, committed.then((view) => ({ status: "sending" as const, view }))]);
    if (first === "busy") return { status: "busy", message: NOTES.busy };
    if (first.status !== "sending") return first;
    // It is on its way: wait a little for the usual quick answer.
    const settled = await within(outcome, Math.max(0, answerBy - Date.now()), () => new Error("still sending")).catch(() => null);
    if (settled && settled !== "busy") return settled;
    const view = await within(this.view(input.messageId), Math.max(0, deadline - Date.now()), () => new Error("late")).catch(() => null);
    return view ? { status: answerFor(view), view } : first;
  }

  /**
   * Queue a message; an agent that is already free gets it at once. Returns within a few seconds either way, so the
   * client follows the outcome with `list()`. Repeating a message id returns its state; queueing content that is
   * already on its way (same agent and key), or a message whose question (`group`) is answered, returns that message
   * instead, under its own id. A `guard` that no longer holds drops it (未发送); one the plugin cannot check is held.
   */
  async enqueue(input: Pick<DeferredSendInput, "agentId" | "text" | "messageId" | "source" | "key" | "group" | "guard">, paseo?: DeferredPaseo | null): Promise<DeferredView> {
    this.use(paseo);
    const api = paseo ?? this.paseo;
    if (!api) throw new Error(note("notConnected"));
    if (!input.text.trim()) throw new Error(note("empty"));
    if (input.text.length > MAX_DEFERRED_TEXT) throw new Error(note("tooLongToQueue"));
    const key = keyOf(input.messageId, input.text, input.key), group = groupOf(input.group);
    const deadline = Date.now() + this.rpcBudgetMs;
    for (;;) {
      const known = await this.view(input.messageId);
      if (known) return known;
      const claim = await this.claimKey(input.agentId, group ? ["group", group] : [key], input.messageId, deadline, () => this.enqueueClaimed(api, input, key, group, deadline));
      if (claim === "late") throw new Error(NOTES.busy);
      if (claim.claimed) return claim.value;
      // Another request for the same content came first: its message answers this one too.
      const first = await this.view(claim.messageId);
      if (first) return first;
    }
  }

  private async enqueueClaimed(api: DeferredPaseo, input: Pick<DeferredSendInput, "agentId" | "text" | "messageId" | "source" | "guard">, key: string, group: string | null, deadline: number): Promise<DeferredView> {
    const agent = await this.snapshot(api, input.agentId, deadline);
    if (!agent || agent.archivedAt) throw new Error(note("goneCannotQueue"));
    // A guard is asked now as well: a message the agent has already moved past is not queued to go out later, and one the
    // plugin cannot judge waits for the user.
    const guard = guardOf(input.guard);
    let verdict: { reason: string } | { unknown: string } | null = null;
    if (guard) {
      try {
        const reason = await this.checkGuard(input.agentId, guard, agent, deadline);
        if (reason) verdict = { reason };
      } catch (error) {
        verdict = { unknown: errorText(error) };
      }
    }
    const unknown = verdict && "unknown" in verdict ? NOTES.guardHeld(verdict.unknown) : null;
    const queued = await this.change((store): Message | DeferredView => {
      const again = store.messages.find((entry) => entry.messageId === input.messageId);
      if (again) return again;
      const existing = this.sameContent(store, input.agentId, key) ?? this.sameGroup(store, input.agentId, group);
      if (existing) return existing;
      if (verdict && "reason" in verdict) {
        // Kept as a receipt: the same id asked again gets this answer, and the entry shows why nothing went out.
        const receipt: Receipt = { messageId: input.messageId, agentId: input.agentId, key, group, source: (input.source ?? "").slice(0, 200), preview: preview(input.text),
          createdAt: this.now(), state: "discarded", at: this.now(), note: NOTES.refused(verdict.reason) };
        store.receipts.push(receipt);
        return this.receiptView(receipt);
      }
      this.checkRoom(store, input.agentId);
      const message: Message = {
        messageId: input.messageId, agentId: input.agentId, key, source: (input.source ?? "").slice(0, 200), text: input.text,
        createdAt: this.now(), baseline: agent.lastUserMessageAt ?? null, held: unknown, heldAt: unknown ? this.now() : null, attempts: 0, nextAt: 0, sendingAt: null,
        direct: false, behavior: "steer", outcome: null, sendId: input.messageId, priorIds: [], firstAttemptAt: null, lastAttemptAt: null, group, guard,
      };
      store.messages.push(message);
      return message;
    });
    if (!("text" in queued)) return queued;
    if (!busy(agent)) await briefly(this.deliver(queued.agentId), Math.min(this.answerWaitMs, Math.max(0, deadline - Date.now())));
    this.schedule(this.pollMs);
    return (await this.view(input.messageId)) ?? this.messageView(queued);
  }

  /** Waiting, held and sending messages, plus what happened to messages in the last half hour; newest first. */
  async list(filter: { agentId?: string } = {}): Promise<DeferredView[]> {
    const store = await this.read();
    const since = this.now() - LISTED_RECEIPT_MS;
    const views = [
      ...store.messages.map((entry) => this.messageView(entry)),
      ...store.receipts.filter((entry) => entry.at >= since).map((entry) => this.receiptView(entry)),
    ];
    return views.filter((entry) => !filter.agentId || entry.agentId === filter.agentId).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Drop a waiting or held message. One that is being sent right now cannot be taken back. */
  async cancel(messageId: string): Promise<DeferredView | null> {
    await this.change((store) => {
      const message = store.messages.find((entry) => entry.messageId === messageId);
      if (!message) return;
      if (this.sendingIds.has(messageId)) throw new Error(note("tooLateToCancel"));
      if (message.outcome === "unknown") this.settle(store, message, "maybe-sent", NOTES.canceledUnknown);
      else if (message.outcome === "failed") this.settle(store, message, "canceled", NOTES.canceledFailed);
      else this.settle(store, message, "canceled");
    });
    return this.view(messageId);
  }

  /**
   * Send a held message anyway, once the agent is free: the conversation as it is now becomes its new baseline, so a
   * message that arrives after this OK holds it again. A message that was sent before (a lost reply, a failed send) is
   * looked for in the agent's timeline first: found, it is marked sent; shown never to have arrived, it goes out again
   * under a new id (Paseo would refuse the old one); otherwise it stays held and says why. A message older than a day
   * expires instead.
   */
  async resume(messageId: string, paseo?: DeferredPaseo | null): Promise<DeferredView | null> {
    this.use(paseo);
    const api = paseo ?? this.paseo;
    const message = (await this.read()).messages.find((entry) => entry.messageId === messageId);
    if (!message || this.sendingIds.has(messageId)) return this.view(messageId);
    if (this.now() - message.createdAt > DAY) {
      await this.change((store) => {
        const current = store.messages.find((entry) => entry.messageId === messageId);
        if (current) this.settle(store, current, current.outcome === "unknown" ? "maybe-sent" : "expired", current.outcome === "unknown" ? NOTES["maybe-sent"] : undefined);
      });
      return this.view(messageId);
    }
    if (!api) throw new Error(note("notConnected"));
    const deadline = Date.now() + this.rpcBudgetMs;
    const agent = await this.snapshot(api, message.agentId, deadline);
    if (!agent || agent.archivedAt) {
      await this.settleAgent(message.agentId, "discarded");
      return this.view(messageId);
    }
    let sendId = message.sendId;
    if (message.lastAttemptAt !== null) {
      // Reading the timeline loads an agent the daemon has not loaded: part of the user's "send anyway".
      const arrived = await this.arrived(api, message, RESUME_PAGES, deadline).catch((error: unknown) => {
        this.log("could not read the timeline to resume a message", error);
        return "unreadable" as const;
      });
      if (arrived === "found" || arrived === "same") {
        await this.change((store) => {
          const current = store.messages.find((entry) => entry.messageId === messageId);
          if (current && !this.sendingIds.has(messageId)) this.settle(store, current, "sent", arrived === "found" ? NOTES.found : NOTES.foundSame);
        });
        return this.view(messageId);
      }
      const wait =
        arrived === "unreadable" || arrived === "slow" ? NOTES.unreadable
        : arrived === "long" ? NOTES.cannotTell
        : arrived === "strangers" ? NOTES.strangers
        : this.now() - message.lastAttemptAt < SETTLE_MS ? NOTES.settling
        : null;
      if (wait) {
        await this.change((store) => {
          const current = store.messages.find((entry) => entry.messageId === messageId);
          if (current?.held && !this.sendingIds.has(messageId)) Object.assign(current, { held: wait, heldAt: this.now() });
        });
        return this.view(messageId);
      }
      sendId = randomUUID();
    }
    await this.change((store) => {
      const current = store.messages.find((entry) => entry.messageId === messageId);
      // The OK covers the conversation as it is now: check it again before sending. A message that was sent now
      // waits for the agent to be free like a queued one.
      if (!current || this.sendingIds.has(messageId)) return;
      const fresh = sendId !== current.sendId ? { sendId, priorIds: [...current.priorIds, current.sendId].slice(-MAX_PRIOR_IDS) } : {};
      Object.assign(current, { held: null, heldAt: null, attempts: 0, nextAt: 0, sendingAt: null, baseline: agent.lastUserMessageAt ?? null, direct: false, outcome: null, ...fresh });
    });
    if (!busy(agent)) await briefly(this.deliver(message.agentId), Math.min(this.answerWaitMs, Math.max(0, deadline - Date.now())));
    this.schedule(this.pollMs);
    return this.view(messageId);
  }

  /** Send what can go now: expired messages are dropped first, then each agent's oldest waiting message is tried. */
  async flush(agentId?: string): Promise<void> {
    if (this.stopped || !this.paseo) return;
    const now = this.now();
    let store = await this.read();
    if (store.messages.some((entry) => now - entry.createdAt > DAY)) {
      store = await this.change((current) => {
        for (const message of [...current.messages]) {
          if (now - message.createdAt <= DAY || this.sendingIds.has(message.messageId)) continue;
          this.settle(current, message, message.outcome === "unknown" ? "maybe-sent" : "expired", message.outcome === "unknown" ? NOTES["maybe-sent"] : undefined);
        }
        return current;
      });
    }
    const agents = new Set(store.messages.filter((entry) => (!agentId || entry.agentId === agentId) && !entry.held && entry.nextAt <= now).map((entry) => entry.agentId));
    for (const id of agents) await this.deliver(id);
  }

  private deliver(agentId: string): Promise<void> {
    const previous = this.inflight.get(agentId) ?? Promise.resolve();
    const work: Promise<void> = previous.catch(() => undefined).then(() => this.deliverNow(agentId)).finally(() => {
      if (this.inflight.get(agentId) === work) this.inflight.delete(agentId);
    });
    this.inflight.set(agentId, work);
    return work;
  }

  /**
   * `work` as this agent's only delivery or send now in this process, after the one going on; "busy" when that one
   * does not end soon. Later deliveries run after `work`.
   */
  private async exclusive<T>(agentId: string, work: () => Promise<T>): Promise<T | "busy"> {
    const until = Date.now() + SEND_QUEUE_WAIT_MS;
    for (let previous = this.inflight.get(agentId); previous; previous = this.inflight.get(agentId)) {
      const left = until - Date.now();
      if (left <= 0) return "busy";
      await within(previous.catch(() => undefined), left, () => new Error("busy")).catch(() => undefined);
    }
    // Nothing awaits between the check above and taking the agent's turn here.
    const run = work();
    const tracked: Promise<void> = run.then(() => undefined, () => undefined).finally(() => {
      if (this.inflight.get(agentId) === tracked) this.inflight.delete(agentId);
    });
    this.inflight.set(agentId, tracked);
    return run;
  }

  private async sendNow(paseo: DeferredPaseo, input: DeferredSendInput, key: string, commit: (view: DeferredView) => void, deadline: number): Promise<DeferredSendResult> {
    const { agentId, messageId } = input;
    const group = groupOf(input.group), guard = guardOf(input.guard);
    const lock = await this.lockWithin(agentId, Math.min(SEND_QUEUE_WAIT_MS, Math.max(0, deadline - Date.now())));
    if (lock.kind === "busy") return { status: "busy", message: NOTES.busy };
    if (lock.kind === "error") return { status: "busy", message: NOTES.lockBusy };
    let claimed = false;
    try {
      // Another client answered the same question while this request waited for the agent: that answer is this one's too.
      const answered = group ? this.sameGroup(await this.read(), agentId, group) : null;
      if (answered) return { status: "existing", view: answered };
      // Everything slow comes before the agent is read: from that read to the send nothing waits on more than the
      // ledger's own write (and the plugin's guard, which reads what the plugin itself observed), so the plan matches
      // the agent as closely as Paseo allows (it has no conditional send).
      const capabilities = await this.readCapabilities(Math.min(CAPABILITIES_WAIT_MS, Math.max(0, deadline - Date.now())));
      const agent = await this.snapshot(paseo, agentId, deadline);
      if (!agent || agent.archivedAt) return { status: "gone", message: NOTES.gone };
      if (guard) {
        let reason: string | null;
        try {
          reason = await this.checkGuard(agentId, guard, agent, deadline);
        } catch (error) {
          return { status: "busy", message: NOTES.guardUnknownBusy(errorText(error)) };
        }
        if (reason) return { status: "refused", message: NOTES.refused(reason) };
      }
      const plan = sendPlan(this.target(agent), { ...capabilities, what: input.what, text: input.text });
      if (plan.kind === "unavailable") return { status: "gone", message: NOTES.gone };
      const needed = consentFor(plan, permissionIds(agent.pendingPermissions), agent.activeTurn);
      if (needed && !coversConsent(input.consent, needed)) {
        return { status: "confirm", plan: { label: plan.label, note: plan.note ?? "", confirm: plan.confirm ?? plan.note ?? "" }, consent: needed };
      }
      if (this.stopped) return { status: "busy", message: NOTES.busy };
      // Past the RPC budget the caller has stopped listening: nothing goes out that it cannot learn about.
      if (Date.now() > deadline) return { status: "busy", message: NOTES.late };
      const behavior = plan.options?.activeTurnBehavior ?? "interrupt";
      const at = this.now();
      let mine = false;
      // One message per agent and key on its way: checked and recorded in one step of the ledger's write chain.
      const message = await this.change((store): Message | DeferredView | null => {
        const again = store.messages.find((entry) => entry.messageId === messageId);
        if (again) return again;
        if (store.receipts.some((entry) => entry.messageId === messageId)) return null;
        const existing = this.sameContent(store, agentId, key) ?? this.sameGroup(store, agentId, group);
        if (existing) return existing;
        this.checkRoom(store, agentId);
        const created: Message = {
          messageId, agentId, key, source: (input.source ?? "").slice(0, 200), text: input.text, createdAt: at, baseline: agent.lastUserMessageAt ?? null,
          held: null, heldAt: null, attempts: 1, nextAt: 0, sendingAt: at, direct: true, behavior, outcome: null,
          sendId: messageId, priorIds: [], firstAttemptAt: at, lastAttemptAt: at, group, guard,
        };
        store.messages.push(created);
        mine = true;
        return created;
      });
      if (!message || !mine || !("text" in message)) {
        const view = !message ? await this.view(messageId) : "text" in message ? this.messageView(message) : message;
        return view ? { status: view.messageId === messageId ? answerFor(view) : "existing", view } : { status: "busy", message: NOTES.busy };
      }
      // The ledger write took the request past its budget: take the record back, nothing goes out.
      if (Date.now() > deadline) {
        await this.change((store) => {
          store.messages = store.messages.filter((entry) => entry.messageId !== messageId);
        });
        return { status: "busy", message: NOTES.late };
      }
      claimed = true;
      this.sendingIds.add(messageId);
      commit(this.messageView(message));
      // Nothing awaits between these checks and the send.
      if (this.stopped) throw Object.assign(new Error(NOTES.stopped), { pluginStopped: true });
      await within(paseo.agents.ref(agentId).send(input.text, { activeTurnBehavior: behavior, messageId }), SEND_TIMEOUT_MS, () => new OutcomeUnknown("send did not answer in time"));
      this.sendingIds.delete(messageId);
      await this.change((store) => {
        const entry = store.messages.find((candidate) => candidate.messageId === messageId);
        if (entry) this.settle(store, entry, "sent");
      });
      const view = await this.view(messageId);
      return view ? { status: answerFor(view), view } : { status: "sent", view: { ...this.messageView(message), state: "sent", note: NOTES.sent } };
    } catch (error) {
      if (!claimed) throw error;
      this.sendingIds.delete(messageId);
      const unknown = requestOutcome(error);
      const stopped = (error as { pluginStopped?: unknown } | null)?.pluginStopped === true;
      this.log(unknown ? "send outcome unknown; held for the user" : "send failed; held for the user", { agentId, messageId, error: errorText(error) });
      await this.change((store) => {
        const entry = store.messages.find((candidate) => candidate.messageId === messageId);
        if (!entry) return;
        Object.assign(entry, { held: unknown ? NOTES.unknown : stopped ? NOTES.stopped : NOTES.failed(failureText(error)), heldAt: this.now(), sendingAt: null, outcome: unknown ? "unknown" : "failed" });
        // Stopped before the send: the daemon never saw it, so 「仍然发送」 needs no look at the timeline.
        if (stopped) Object.assign(entry, { outcome: null, firstAttemptAt: null, lastAttemptAt: null });
      });
      this.schedule(this.pollMs);
      const view = await this.view(messageId);
      if (!view) throw error;
      return { status: answerFor(view), view };
    } finally {
      this.sendingIds.delete(messageId);
      lock.release();
    }
  }

  private async deliverNow(agentId: string): Promise<void> {
    const paseo = this.paseo;
    if (!paseo || this.stopped) return;
    const head = (await this.read()).messages.find((entry) => entry.agentId === agentId && !entry.held);
    if (!head || head.nextAt > this.now()) return;
    if (head.direct) {
      // A send now whose process ended before its outcome was written (sends now run before any delivery here): it
      // may have gone out, so the user decides.
      await this.change((store) => {
        const message = store.messages.find((entry) => entry.messageId === head.messageId);
        if (message && message.direct && !message.held && !this.sendingIds.has(message.messageId)) Object.assign(message, { held: NOTES.unknown, heldAt: this.now(), sendingAt: null, outcome: "unknown" });
      });
      return;
    }
    const lock = await this.lockAgent(agentId);
    // Another plugin's ledger is sending to this agent; the next poll sees its turn.
    if (lock.kind === "busy") return;
    if (lock.kind === "error") {
      const failures = (this.lockErrors.get(agentId) ?? 0) + 1;
      this.lockErrors.set(agentId, failures);
      if (failures >= MAX_LOCK_ERRORS) {
        this.lockErrors.delete(agentId);
        await this.change((store) => {
          const message = store.messages.find((entry) => entry.messageId === head.messageId);
          if (message && !message.held) Object.assign(message, { held: NOTES.lockHeld, heldAt: this.now() });
        });
      }
      return;
    }
    this.lockErrors.delete(agentId);
    if (this.stopped) return void lock.release();
    let claimed: Message | null = null;
    // The claim's earlier state, put back when a stop lands between the claim and the send.
    let undo: Pick<Message, "sendingAt" | "firstAttemptAt" | "lastAttemptAt"> | null = null;
    try {
      const agent = await this.snapshot(paseo, agentId);
      if (!agent || agent.archivedAt) return void (await this.settleAgent(agentId, "discarded"));
      if (busy(agent) || this.stopped) return;
      // The plugin's own condition, under the lock right before the send: a message the agent has moved past goes no
      // further (an earlier attempt of it may have gone out: then that is its outcome); one it cannot judge waits for the user.
      if (head.guard && !(await this.guarded(agentId, head, agent))) return;
      const current = agent.lastUserMessageAt ?? null;
      // The conversation changed since the message was queued: only the queues' own sends may have changed it. Asked
      // by message id on the agent's latest user message; a failed read waits for the next look.
      let own: boolean | null = null;
      if (head.sendingAt === null && current !== head.baseline) {
        const ids = new Set([...(await this.read()).sends.filter((send) => send.agentId === agentId).map((send) => send.messageId), ...lock.sent()]);
        own = await this.latestUserMessageIsOwn(paseo, agentId, ids);
        if (this.stopped) return;
      }
      const claimedAt = this.now();
      // Claim the message inside the ledger's write chain: a cancel either lands first (nothing is sent) or is refused.
      // `undo` keeps the earlier claim, if any, so a stop before the send can undo only this one.
      claimed = await this.change((store) => {
        const message = store.messages.find((entry) => entry.messageId === head.messageId);
        if (!message || message.held || message.direct) return null;
        if (message.sendingAt === null && current !== message.baseline) {
          if (own !== true) {
            // Someone else spoke since (or it cannot be told): hold every message of this agent queued before that,
            // each for its own OK.
            for (const other of store.messages) {
              if (other.agentId !== agentId || other.held || other.direct || other.sendingAt !== null || other.baseline === current) continue;
              Object.assign(other, { held: own === false ? NOTES.movedOn : NOTES.unsure, heldAt: this.now() });
            }
            return null;
          }
          // The latest message is one of the queues' own: the rest of the queue is still current.
          for (const other of store.messages) if (other.agentId === agentId && !other.held && !other.direct && other.sendingAt === null) other.baseline = current;
        }
        undo = { sendingAt: message.sendingAt, firstAttemptAt: message.firstAttemptAt, lastAttemptAt: message.lastAttemptAt };
        if (message.sendingAt === null) message.sendingAt = claimedAt;
        message.firstAttemptAt ??= claimedAt;
        message.lastAttemptAt = claimedAt;
        // Remember the id before sending: if the reply is lost, the daemon may still have taken it.
        if (!store.sends.some((send) => send.messageId === message.sendId)) store.sends.push({ agentId, messageId: message.sendId, recordedAt: this.now() });
        return { ...message };
      });
      if (!claimed) return;
      lock.record(claimed.sendId);
      this.sendingIds.add(claimed.messageId);
      // Nothing awaits between this check and the send.
      if (this.stopped) {
        // Stopped between the claim and the send: nothing went out, so a later retry must check the conversation again.
        const { messageId } = claimed;
        const before = undo;
        if (before) await this.change((store) => {
          const message = store.messages.find((entry) => entry.messageId === messageId);
          if (message) Object.assign(message, before);
        });
        return;
      }
      await within(
        paseo.agents.ref(agentId).send(claimed.text, { activeTurnBehavior: claimed.behavior, messageId: claimed.sendId }),
        SEND_TIMEOUT_MS,
        () => new OutcomeUnknown("send did not answer in time"),
      );
      const messageId = claimed.messageId;
      this.sendingIds.delete(messageId);
      await this.change((store) => {
        const message = store.messages.find((entry) => entry.messageId === messageId);
        if (message) this.settle(store, message, "sent");
      });
    } catch (error) {
      if (claimed) this.sendingIds.delete(claimed.messageId);
      if (claimed && requestOutcome(error)) {
        const messageId = claimed.messageId;
        // Held, not dropped: the same content stays on its way until the user looks, so it is never sent twice.
        this.log("delivery outcome unknown; held for the user", { agentId, messageId });
        await this.change((store) => {
          const message = store.messages.find((entry) => entry.messageId === messageId);
          if (message) Object.assign(message, { held: NOTES.unknown, heldAt: this.now(), outcome: "unknown" });
        });
        return;
      }
      if (!claimed) return void this.log("could not read the agent; will retry", error);
      const messageId = claimed.messageId;
      await this.change((store) => {
        const message = store.messages.find((entry) => entry.messageId === messageId);
        if (!message) return;
        message.attempts += 1;
        if (message.attempts >= MAX_ATTEMPTS) Object.assign(message, { held: NOTES.failedRepeatedly(failureText(error)), heldAt: this.now(), outcome: "failed" });
        else message.nextAt = this.now() + Math.min(60_000, 1_000 * 2 ** message.attempts);
      });
      this.log("send failed; will retry", error);
    } finally {
      if (claimed) this.sendingIds.delete(claimed.messageId);
      lock.release();
    }
  }

  /**
   * Held messages whose send failed or has an unknown outcome: one that shows up in its agent's timeline did go out.
   * Only while the agent is loaded (reading the timeline of one that is not would load it), each at most once a
   * minute, a few per poll.
   */
  private lookForSent(): Promise<void> {
    // One look at a time: a second one starts after the first, so it never skips a message the first is still reading.
    const look = this.looking.then(() => this.lookForSentNow());
    this.looking = look.catch(() => undefined);
    return look;
  }

  private async lookForSentNow(): Promise<void> {
    const paseo = this.paseo;
    if (!paseo || this.stopped) return;
    const held = (await this.read()).messages.filter((entry) => entry.held && entry.outcome !== null && entry.lastAttemptAt !== null);
    for (const id of [...this.lookedAt.keys()]) if (!held.some((entry) => entry.messageId === id)) this.lookedAt.delete(id);
    let looks = 0;
    for (const message of held) {
      if (this.stopped || looks >= MAX_LOOKS) return;
      const now = this.now();
      if (now - (this.lookedAt.get(message.messageId) ?? Number.NEGATIVE_INFINITY) < LOOK_EVERY_MS) continue;
      this.lookedAt.set(message.messageId, now);
      looks += 1;
      try {
        const agent = await this.snapshot(paseo, message.agentId);
        if (!agent || agent.archivedAt || agent.status === "closed") continue;
        const arrived = await this.arrived(paseo, message, TIMELINE_PAGES);
        if (arrived !== "found" && arrived !== "same") continue;
        await this.change((store) => {
          const entry = store.messages.find((candidate) => candidate.messageId === message.messageId);
          if (entry?.held && entry.outcome !== null && !this.sendingIds.has(entry.messageId)) this.settle(store, entry, "sent", arrived === "found" ? NOTES.found : NOTES.foundSame);
        });
      } catch (error) {
        this.log("could not look for a held message in the timeline", error);
      }
    }
  }

  /**
   * Did a send of this message reach the agent? Paseo records it in the timeline, our id as its `clientMessageId`,
   * when a turn takes it. A user message without a client id but with this text counts as found too (a timeline
   * rebuilt from the provider's history loses the ids). "absent" only once the timeline back to before the first send
   * has been read without it and without any user message of unknown origin; otherwise "strangers", "long" (further
   * back than `pages`) or "slow" (past `deadline`). Throws when the timeline cannot be read.
   */
  private async arrived(paseo: DeferredPaseo, message: Message, pages: number, deadline = Number.POSITIVE_INFINITY): Promise<"found" | "same" | "absent" | "strangers" | "long" | "slow"> {
    const ids = new Set([message.sendId, ...message.priorIds]);
    const first = message.firstAttemptAt ?? message.createdAt;
    const since = first - ATTEMPT_MARGIN_MS;
    const text = message.text.trim();
    let strangers = false;
    let same = false;
    const walk = await this.walkTimeline(paseo, message.agentId, pages, (item, at) => {
      if (at !== null && at < since) return "past" as const;
      if (item.type !== "user_message") return undefined;
      if (typeof item.clientMessageId === "string" && item.clientMessageId) return ids.has(item.clientMessageId) ? ("found" as const) : undefined;
      // No client id (another surface, or a timeline rebuilt from the provider's history). The same words count only
      // when they came after the first send: earlier ones are an earlier message, not this one.
      if (typeof item.text === "string" && item.text.trim() === text && at !== null && at >= first) same = true;
      else strangers = true;
      return undefined;
    }, deadline);
    if ("found" in walk && walk.found === "found") return "found";
    if (same) return "same";
    if (strangers) return "strangers";
    if ("found" in walk || walk.end === "start") return "absent";
    return walk.end === "slow" ? "slow" : "long";
  }

  /**
   * Is the agent's latest user message one the queues sent (Paseo records our `messageId` as its `clientMessageId`)?
   * `null` when it is not found or carries no id. Throws when the timeline cannot be read.
   */
  private async latestUserMessageIsOwn(paseo: DeferredPaseo, agentId: string, ids: ReadonlySet<string>): Promise<boolean | null> {
    const walk = await this.walkTimeline(paseo, agentId, TIMELINE_PAGES, (item) => {
      if (item.type !== "user_message") return undefined;
      return typeof item.clientMessageId === "string" ? ids.has(item.clientMessageId) : null;
    });
    return "found" in walk ? walk.found : null;
  }

  /**
   * The agent's projected timeline from the end backwards, up to `pages` pages of 100 when a long turn hides what
   * `visit` looks for: the first value `visit` returns for an entry (`undefined` goes on; `at` is the entry's time, or
   * null), else where the walk ended: at the start of the timeline, or at the page limit. Throws when the timeline
   * cannot be read.
   */
  private async walkTimeline<T>(
    paseo: DeferredPaseo,
    agentId: string,
    pages: number,
    visit: (item: { type?: unknown; clientMessageId?: unknown; text?: unknown }, at: number | null) => T | undefined,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<{ found: T } | { end: "start" | "limit" | "slow" }> {
    let cursor: { epoch: string; seq: number } | null = null;
    for (let page = 0; page < pages; page++) {
      const left = deadline - Date.now();
      if (left <= 0) return { end: "slow" };
      const options = cursor === null
        ? { direction: "tail" as const, limit: 100, projection: "projected" as const }
        : { direction: "before" as const, cursor, limit: 100, projection: "projected" as const };
      const result = (await within(paseo.agents.ref(agentId).timeline.refetch(options), Math.min(READ_TIMEOUT_MS, left), () => new Error(note("readTimelineTimeout")))) as
        { entries?: unknown; rows?: unknown; startCursor?: { epoch: string; seq: number } | null; hasOlder?: unknown } | null;
      const rows = result?.entries ?? result?.rows;
      if (!Array.isArray(rows)) return { end: "limit" };
      for (let index = rows.length - 1; index >= 0; index--) {
        const entry = rows[index] as { item?: { type?: unknown; clientMessageId?: unknown; text?: unknown }; timestamp?: unknown } | null;
        if (!entry?.item) continue;
        const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
        const value = visit(entry.item, Number.isFinite(time) ? time : null);
        if (value !== undefined) return { found: value };
      }
      if (result?.hasOlder !== true) return { end: "start" };
      if (!result.startCursor) return { end: "limit" };
      cursor = result.startCursor;
    }
    return { end: "limit" };
  }

  private async snapshot(paseo: DeferredPaseo, agentId: string, deadline = Number.POSITIVE_INFINITY): Promise<DeferredAgentSnapshot | null> {
    const wait = Math.min(READ_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
    const result = await within(paseo.agents.ref(agentId).refresh(), wait, () => new Error(note("readAgentTimeout")));
    return result?.agent ?? null;
  }

  /** The agent as send-plan.ts reads it. A turn still on record counts as running; an unknown status too. */
  private target(agent: DeferredAgentSnapshot): SendTarget {
    const raw = agent.activeTurn && agent.status === "idle" ? "running" : agent.status;
    const status = STATUSES.find((value) => value === raw) ?? "running";
    const attention = agent.attentionReason;
    return {
      provider: agent.provider ?? "",
      status,
      archivedAt: agent.archivedAt ?? null,
      requiresAttention: agent.requiresAttention === true,
      attentionReason: attention === "finished" || attention === "error" || attention === "permission" ? attention : null,
      pendingPermissions: agent.pendingPermissions?.length ?? 0,
    };
  }

  private async readCapabilities(ms = CAPABILITIES_WAIT_MS): Promise<SendCapabilitiesLike> {
    try {
      return (await within(Promise.resolve(this.capabilities()), ms, () => new Error("reading the send capabilities timed out"))) ?? {};
    } catch (error) {
      this.log("could not read the daemon's send capabilities; planning cautiously", error);
      return {};
    }
  }

  /**
   * The message with this content (agent and key) that is on its way, or one that went out moments ago: two clients
   * sending the same thing at once get one message. Later, the same content is a new message.
   */
  private sameContent(store: Store, agentId: string, key: string): DeferredView | null {
    const waiting = store.messages.find((entry) => entry.agentId === agentId && entry.key === key);
    if (waiting) return this.messageView(waiting);
    const since = this.now() - RECENT_SAME_MS;
    for (let index = store.receipts.length - 1; index >= 0; index--) {
      const receipt = store.receipts[index];
      if (receipt && receipt.at >= since && receipt.agentId === agentId && receipt.key === key && (receipt.state === "sent" || receipt.state === "maybe-sent")) return this.receiptView(receipt);
    }
    return null;
  }

  /**
   * The answer to this question (agent and group): its message on its way, or the newest one that went out or may have.
   * Unlike the same content, a group stays answered: another button for the same question never goes out after it.
   */
  private sameGroup(store: Store, agentId: string, group: string | null): DeferredView | null {
    if (!group) return null;
    const waiting = store.messages.find((entry) => entry.agentId === agentId && entry.group === group);
    if (waiting) return this.messageView(waiting);
    for (let index = store.receipts.length - 1; index >= 0; index--) {
      const receipt = store.receipts[index];
      if (receipt && receipt.agentId === agentId && receipt.group === group && (receipt.state === "sent" || receipt.state === "maybe-sent")) return this.receiptView(receipt);
    }
    return null;
  }

  /** The plugin's reason a guarded message no longer fits, or null; throws when it cannot tell (or has no check). */
  private async checkGuard(agentId: string, guard: DeferredGuard, agent: DeferredAgentSnapshot, deadline = Number.POSITIVE_INFINITY): Promise<string | null> {
    const check = this.guardCheck;
    if (!check) throw new Error(note("noGuardCheck"));
    const wait = Math.min(READ_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
    const reason = await within(Promise.resolve().then(() => check({ agentId, guard, agent })), wait, () => new Error(note("checkTimeout")));
    return reason?.trim() || null;
  }

  /**
   * Whether a queued message's guard still holds for this delivery. Otherwise it is settled here: 未发送 with the plugin's
   * reason, maybe-sent when an earlier attempt may have gone out, or held for the user when the plugin cannot tell.
   */
  private async guarded(agentId: string, head: Message, agent: DeferredAgentSnapshot): Promise<boolean> {
    let verdict: { reason: string } | { unknown: string } | null = null;
    try {
      const reason = await this.checkGuard(agentId, head.guard ?? {}, agent);
      if (reason) verdict = { reason };
    } catch (error) {
      verdict = { unknown: errorText(error) };
    }
    if (!verdict) return true;
    const found = verdict;
    await this.change((store) => {
      const message = store.messages.find((entry) => entry.messageId === head.messageId);
      if (!message || message.held || message.direct || this.sendingIds.has(message.messageId)) return;
      if ("unknown" in found) Object.assign(message, { held: NOTES.guardHeld(found.unknown), heldAt: this.now() });
      else if (message.lastAttemptAt !== null) this.settle(store, message, "maybe-sent", NOTES.refusedAfterTry(found.reason));
      else this.settle(store, message, "discarded", NOTES.refused(found.reason));
    });
    return false;
  }

  private checkRoom(store: Store, agentId: string): void {
    if (store.messages.length >= MAX_MESSAGES) throw new Error(note("tooManyQueued"));
    if (store.messages.filter((entry) => entry.agentId === agentId).length >= MAX_PER_AGENT) throw new Error(note("tooManyForAgent"));
  }

  /** The agent's lock, trying again for up to `ms` while another ledger holds it. */
  private async lockWithin(agentId: string, ms: number): Promise<Lock> {
    const until = Date.now() + ms;
    for (;;) {
      const lock = await this.lockAgent(agentId);
      if (lock.kind !== "busy" || this.stopped || Date.now() >= until) return lock;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /**
   * The per-agent lock every plugin's ledger on the host shares: an exclusive transaction on a small SQLite file, held
   * from the idle check until the send returns. The operating system drops it when its process ends, so a crash never
   * leaves it behind and nobody ever takes it from a live holder. "busy" while another ledger holds it; "error" when
   * the lock file cannot be used (the message then waits, it is never sent unguarded). Without `node:sqlite` (Node
   * before 22.13) each ledger only serialises its own sends.
   */
  private async lockAgent(agentId: string): Promise<Lock> {
    const sqlite = await loadSqlite();
    if (this.stopped) return { kind: "busy" };
    if (!sqlite) {
      if (!this.warnedNoLock) this.log("node:sqlite is unavailable; queues of different plugins are not coordinated");
      this.warnedNoLock = true;
      return { kind: "held", sent: () => [], record: () => undefined, release: () => undefined };
    }
    const name = agentId.replace(/[^\w.-]/g, "_");
    let db = this.locks.get(name);
    try {
      if (!db) {
        await mkdir(this.lockDirectory, { recursive: true, mode: 0o700 });
        await chmod(this.lockDirectory, 0o700).catch(() => undefined);
        // SQLite would create the file under the process umask (its journal takes the file's mode): make it private first.
        const path = join(this.lockDirectory, `${name}.lock.db`);
        await (await open(path, "a", 0o600)).close();
        await chmod(path, 0o600).catch(() => undefined);
        // stop() may have run while the folder was made: then no connection may outlive it.
        if (this.stopped) return { kind: "busy" };
        db = new sqlite.DatabaseSync(path, { timeout: 0 });
        this.locks.set(name, db);
        this.trimLocks(name);
      }
      db.exec("BEGIN EXCLUSIVE");
      // The lock file also keeps the message ids every plugin's queue sent to this agent, so one queue's delivery does
      // not hold another queue's next message as if a stranger had spoken.
      db.exec("CREATE TABLE IF NOT EXISTS sent (message_id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL)");
      db.prepare("DELETE FROM sent WHERE recorded_at < ?").run(this.now() - RECEIPT_MS);
    } catch (error) {
      if (db) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // no transaction was open
        }
      }
      if (/locked|busy/i.test(errorText(error))) return { kind: "busy" };
      // A broken connection or file: drop the connection (the next try reopens it), never send without the lock.
      if (db) this.closeLock(name);
      this.log("delivery lock unavailable; the message waits", error);
      return { kind: "error", message: errorText(error) || note("lockUnusable") };
    }
    const held = db;
    this.lockedNames.add(name);
    return {
      kind: "held",
      sent: () => (held.prepare("SELECT message_id FROM sent").all() as { message_id: string }[]).map((row) => row.message_id),
      record: (messageId) => void held.prepare("INSERT OR IGNORE INTO sent (message_id, recorded_at) VALUES (?, ?)").run(messageId, this.now()),
      release: () => {
        this.lockedNames.delete(name);
        try {
          held.exec("COMMIT");
        } catch {
          try {
            held.exec("ROLLBACK");
          } catch {
            // already gone with the connection
          }
        }
      },
    };
  }

  /** Keep at most a few dozen idle lock connections open; one per agent ever used would grow without bound. */
  private trimLocks(keep: string): void {
    for (const name of this.locks.keys()) {
      if (this.locks.size <= MAX_OPEN_LOCKS) return;
      if (name !== keep && !this.lockedNames.has(name)) this.closeLock(name);
    }
  }

  private closeLock(name: string): void {
    const db = this.locks.get(name);
    this.locks.delete(name);
    this.lockedNames.delete(name);
    try {
      db?.close();
    } catch {
      // closing drops any lock it held
    }
  }

  private settle(store: Store, message: Message, state: Receipt["state"], note?: string): void {
    store.messages = store.messages.filter((entry) => entry !== message);
    store.receipts.push({
      messageId: message.messageId, agentId: message.agentId, key: message.key, group: message.group, source: message.source, preview: preview(message.text),
      createdAt: message.createdAt, state, at: this.now(), note: note ?? NOTES[state],
    });
  }

  private settleAgent(agentId: string, state: Receipt["state"]): Promise<void> {
    return this.change((store) => {
      for (const message of store.messages.filter((entry) => entry.agentId === agentId && !this.sendingIds.has(entry.messageId))) this.settle(store, message, state);
    });
  }

  private async view(messageId: string): Promise<DeferredView | null> {
    const store = await this.read();
    const message = store.messages.find((entry) => entry.messageId === messageId);
    if (message) return this.messageView(message);
    for (let index = store.receipts.length - 1; index >= 0; index--) {
      const receipt = store.receipts[index];
      if (receipt && receipt.messageId === messageId) return this.receiptView(receipt);
    }
    return null;
  }

  private messageView(message: Message): DeferredView {
    const sending = !message.held && message.sendingAt !== null && (message.direct || this.sendingIds.has(message.messageId));
    return {
      messageId: message.messageId, agentId: message.agentId, key: message.key, source: message.source, preview: preview(message.text), createdAt: message.createdAt,
      at: message.heldAt ?? message.sendingAt ?? message.createdAt,
      state: message.held ? "held" : sending ? "sending" : "queued",
      note: message.held ?? (sending ? NOTES.sending : NOTES.queued),
    };
  }

  private receiptView(receipt: Receipt): DeferredView {
    const { messageId, agentId, key, source, preview: text, createdAt, at, state, note } = receipt;
    return { messageId, agentId, key, source, preview: text, createdAt, at, state, note };
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.flush();
      await this.lookForSent();
    } catch (error) {
      this.log("delivery failed", error);
    }
    // Held messages only need the slow look that lets them expire or finds a lost send arrived.
    const store = await this.read().catch(() => null);
    if (!store || store.messages.some((entry) => !entry.held)) this.schedule(this.pollMs);
    else if (store.messages.length) this.schedule(HELD_POLL_MS);
  }

  private async read(): Promise<Store> {
    await (this.pruning ??= this.prune());
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.hasMessages = false;
      return empty();
    }
    try {
      const store = normalize(JSON.parse(text));
      this.hasMessages = store.messages.length > 0;
      return store;
    } catch (error) {
      // Keep the unreadable file for a look and start over rather than block every send. Only the error's name is
      // logged: a JSON error quotes the text around the fault, which can be part of a message.
      const aside = `${this.file}.corrupt-${this.now()}`;
      await rename(this.file, aside).catch(() => undefined);
      this.log(`unreadable queue moved to ${aside}`, error instanceof Error ? error.name : "unreadable");
      this.hasMessages = false;
      return empty();
    }
  }

  /**
   * Leftovers that keep message bodies: temp files of writes a crash cut short (their process is gone) and copies of
   * unreadable ledgers beyond the newest MAX_ASIDE or older than a week. Runs once, before the first read.
   */
  private async prune(): Promise<void> {
    const directory = dirname(this.file), base = basename(this.file);
    const names = await readdir(directory).catch(() => [] as string[]);
    const asides = names.filter((name) => name.startsWith(`${base}.corrupt-`))
      .map((name) => ({ name, at: Number(name.slice(`${base}.corrupt-`.length)) }))
      .sort((a, b) => b.at - a.at);
    for (const [index, aside] of asides.entries()) {
      if (index >= MAX_ASIDE || !(this.now() - aside.at < RECEIPT_MS)) await rm(join(directory, aside.name), { force: true }).catch(() => undefined);
    }
    for (const name of names) {
      if (!name.startsWith(`${base}.`) || !name.endsWith(".tmp")) continue;
      const pid = Number(name.slice(base.length + 1).split(".")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || processAlive(pid)) continue;
      await rm(join(directory, name), { force: true }).catch(() => undefined);
    }
  }

  private change<T>(update: (store: Store) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const store = await this.read();
      const result = update(store);
      const cutoff = this.now() - RECEIPT_MS;
      store.receipts = store.receipts.filter((entry) => entry.at >= cutoff).slice(-MAX_RECEIPTS);
      store.sends = store.sends.filter((entry) => entry.recordedAt >= this.now() - DAY).slice(-MAX_RECEIPTS);
      const text = `${JSON.stringify(store)}\n`;
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(note("tooManyQueued"));
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, this.file);
        this.hasMessages = store.messages.length > 0;
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
