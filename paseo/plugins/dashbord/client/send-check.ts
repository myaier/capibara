import { t } from "../shared/text";
import { confirmFingerprint, consentFor, coversConsent, newMessageId, permissionIds, sendPlan, usableTarget, type Consent, type SendPlan } from "./send-plan";
import { deferOffer, type DeferredSendResult } from "../shared/deferred-rpc";
import type { SendCapabilities } from "../shared/steer";
import { confirmOffer, messageKey } from "./deferred-state";

/** The parts of `agents.ref(id).refresh()` a send decision reads. */
export interface AgentState {
  id?: string;
  provider: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  archivedAt?: string | null;
  activeTurn?: unknown;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: string | null;
  lastUserMessageAt?: string | null;
  labels?: Record<string, string>;
  pendingPermissions?: readonly unknown[] | null;
}
interface ReadApi {
  agents: { ref(agentId: string): { refresh(): Promise<{ agent?: AgentState | null } | null> } };
}
export type SendCheck = { plan: SendPlan; fingerprint: string };

/**
 * One message to an Agent, sent by the plugin server's ledger (server/deferred-send.ts): its text, the key that makes two
 * messages the same request (one per Agent and key is on its way at a time) and the one id every try goes out with: a send
 * now, a confirmed send, a queueing for 「等这一轮结束再发」. The ledger answers a repeated id with what became of that message,
 * so a try whose answer was lost is asked about again, never sent twice.
 */
export interface OutgoingMessage {
  readonly agentId: string;
  readonly text: string;
  /** Names it in the confirmations: 消息, 回复. */
  readonly what: string;
  /** Names its row in the ledger's list: 快捷回复「继续做完」. */
  readonly source: string;
  readonly key: string;
  readonly messageId: string;
  /**
   * A quick reply's: the question it answers (`quickReplyGroup`: one reply of a turn goes out, on every device) and the turn
   * it answers (`quickReplyGuard`), which the server checks under the Agent's lock right before sending (codex-obs-attn-R3).
   */
  readonly group?: string;
  readonly guard?: Readonly<Record<string, string | null>>;
  /** A try's answer never came back: it may have reached the server, and the Agent. */
  tried?: boolean;
}
export function outgoingMessage(agentId: string, text: string, options: { what?: string; source?: string; key?: string; messageId?: string; group?: string; guard?: Readonly<Record<string, string | null>> } = {}): OutgoingMessage {
  const source = options.source ?? t("secondarySendCheck.observatory");
  // i18n-ignore: the default source forms a persisted deduplication key; keep its original identity across languages.
  const keySource = options.source ?? "观测台";
  return { agentId, text, what: options.what ?? t("secondarySendCheck.message"), source, key: options.key ?? messageKey(keySource, text), messageId: options.messageId ?? newMessageId(),
    ...(options.group ? { group: options.group } : {}), ...(options.guard ? { guard: options.guard } : {}) };
}
/** What the ledger is given for a message: its words, id, key and name, and a quick reply's group and turn. */
export interface LedgerInput { text: string; messageId: string; key: string; source: string; group?: string; guard?: Readonly<Record<string, string | null>> }
export function ledgerInput(message: OutgoingMessage): LedgerInput {
  return { text: message.text, messageId: message.messageId, key: message.key, source: message.source, ...(message.group ? { group: message.group } : {}), ...(message.guard ? { guard: message.guard } : {}) };
}

/** The pending requests a confirmation is shown for, by id; one without an id (never seen on 0.11) is named by what it asks. */
export function pendingRequestIds(agent: Pick<AgentState, "pendingPermissions"> | null | undefined): string[] {
  return (agent?.pendingPermissions ?? []).map(entry => {
    const request = (entry ?? {}) as { id?: unknown; kind?: unknown; name?: unknown; title?: unknown };
    return typeof request.id === "string" && request.id ? request.id : `request:${JSON.stringify([request.kind ?? null, request.name ?? null, request.title ?? null])}`;
  });
}

/**
 * How this message would reach the Agent right now (opus-F10, codex-F4): steered into a running turn where the provider takes
 * it (a slash command only into Claude-based ones), otherwise only after the user confirms that it interrupts the turn or a
 * pending request. The fingerprint names exactly what is shown (requests, turn, plan) for the screen; whether it goes out is
 * the server's to decide. Reads only this Agent's snapshot (never its timeline, so it never loads the Agent).
 */
export async function checkSend(paseo: ReadApi, message: Pick<OutgoingMessage, "agentId" | "text" | "what">, capabilities: SendCapabilities): Promise<SendCheck & { agent: AgentState | null }> {
  const agent = (await paseo.agents.ref(message.agentId).refresh())?.agent ?? null;
  const pendingIds = pendingRequestIds(agent);
  // Archived ones stay archived (sending would restore them); closed only means not loaded: the daemon loads it to send.
  // `bases`: a command into a custom id is planned as its built-in runs it (codex-obs-send-ui-F3).
  const plan = sendPlan(usableTarget(agent) ? { ...agent, pendingPermissions: pendingIds.length } : null,
    { what: message.what, text: message.text, steerable: capabilities.steerable, slashSteerable: capabilities.slashSteerable, bases: capabilities.bases });
  return { plan, fingerprint: confirmFingerprint(agent ? { ...agent, id: message.agentId } : null, plan, pendingIds), agent };
}

/**
 * The Agent is no longer where this message belongs (`expect` said why): it was not sent, and sending it again would not help.
 * A tagged plain Error, not a class: the default Hermes evaluator has none, so callers check `isSendRefused`, never `instanceof`.
 */
export type SendRefused = Error & { readonly sendRefused: true };
export function createSendRefused(message: string): SendRefused {
  return Object.assign(new Error(message), { name: "SendRefused", sendRefused: true as const });
}
export function isSendRefused(error: unknown): error is SendRefused {
  return typeof error === "object" && error !== null && "sendRefused" in error && error.sendRefused === true;
}

export interface SendHooks {
  /**
   * Why this Agent no longer fits the message, or null when it does: asked after every read of it, so nothing goes out to an
   * Agent that moved on. `retry`: an earlier try may have gone out (its answer was lost).
   */
  expect?: (agent: AgentState, retry: boolean) => string | null;
  /** Runs once sending is decided, with the snapshot it was decided on (a quick reply clears the turn's attention here). */
  beforeSend?: (agent: AgentState) => Promise<void>;
  /**
   * Why the message no longer fits, from what the Agent's own state cannot show (a quick reply's round, `sameRound`): asked once
   * before the Agent is read, so a refused message reads, clears and sends nothing.
   */
  precheck?: (retry: boolean) => Promise<string | null>;
}

/**
 * A confirmation to show: what sending now would do, the consent the user gives by saying yes (bound to the turn and the
 * requests it was shown for; `null` when only the way out changed), and 「等这一轮结束再发」 beside it where there is something to
 * wait for. `server`: the server planned it, from the Agent as it was at the last moment.
 */
export interface SendConfirmation { check: SendCheck; consent: Consent | null; offer: { label: string; note: string } | null; server: boolean }
/** What sends the message: `observatory.deferred.send` (`useDeferredQueue().send`). */
export type DeliverMessage = (input: LedgerInput & { what: string; consent: Consent | null }) => Promise<DeferredSendResult>;
/** What the ledger did with it: sent, still sending, held for the user, the same message already on its way, or busy / gone. */
export type LedgerAnswer = Exclude<DeferredSendResult, { status: "confirm" }>;

/**
 * Sends through the ledger when the plan needs no confirmation, or when `consent` (what the user agreed to in the one shown)
 * covers it; otherwise returns the confirmation to show. The server plans again under the Agent's send lock and sends only
 * while the consent still covers what it would do; when it does not, its own confirmation comes back the same way. Every try
 * carries the message's one id. An Agent `expect` or `precheck` refuses, or the server's own check of a quick reply's turn
 * refuses ("refused", codex-obs-attn-R3), throws a SendRefused error (`isSendRefused`), nothing sent. `beforeSend` takes
 * round trips (clearing attention reads the Agent twice), so after it `precheck` runs again and the Agent is read again, the
 * send decided afresh: one that started a turn (or ran a heartbeat round, codex-obs-attn-R1) meanwhile is never sent the plan
 * read before (P1-1); a way out that changed is returned to confirm. A thrown error (an answer that never came back) leaves
 * the message `tried`: the next try asks the server about the same id first, before any confirmation of its own.
 */
export async function sendChecked(paseo: ReadApi, message: OutgoingMessage, capabilities: SendCapabilities, deliver: DeliverMessage, consent: Consent | null = null,
  hooks: SendHooks = {}): Promise<{ answered: LedgerAnswer; plan: SendPlan } | { confirm: SendConfirmation }> {
  const retry = !!message.tried;
  const verify = async () => {
    const early = hooks.precheck ? await hooks.precheck(retry) : null;
    if (early) throw createSendRefused(early);
  };
  await verify();
  const decide = async () => {
    const { agent, ...check } = await checkSend(paseo, message, capabilities);
    if (check.plan.kind === "unavailable") throw new Error(check.plan.note);
    const refused = agent && hooks.expect ? hooks.expect(agent, retry) : null;
    if (refused) throw createSendRefused(refused);
    return { agent, check, needed: consentFor(check.plan, permissionIds(agent?.pendingPermissions), agent?.activeTurn) };
  };
  const ask = (decided: Awaited<ReturnType<typeof decide>>): { confirm: SendConfirmation } => ({ confirm: { check: decided.check, consent: decided.needed, server: false,
    offer: deferOffer(decided.agent ? { ...decided.agent, pendingPermissions: decided.agent.pendingPermissions?.length ?? 0 } : null, decided.check.plan) } });
  // A try whose answer was lost is asked about before anything is confirmed: the server answers with what became of that
  // id (nothing goes out twice), or, when it never got it, with its own confirmation.
  const unconsented = (next: Awaited<ReturnType<typeof decide>>) => !retry && !!next.needed && !coversConsent(consent, next.needed);
  let decided = await decide();
  if (unconsented(decided)) return ask(decided);
  if (decided.agent && hooks.beforeSend) {
    await hooks.beforeSend(decided.agent);
    const before = decided.check.plan;
    // The hook takes round trips (clearing attention reads the Agent twice): a heartbeat round may have started and ended
    // meanwhile, leaving the Agent's own state as it was, so the round is checked again too (codex-obs-attn-R1).
    await verify();
    decided = await decide();
    // Same way out (a closed Agent the hook loaded is idle now; both just receive it), or the user confirms the new one.
    if (decided.check.plan.kind !== before.kind || (decided.check.plan.options?.activeTurnBehavior ?? null) !== (before.options?.activeTurnBehavior ?? null)
      || unconsented(decided)) return ask(decided);
  }
  message.tried = true;
  const answer = await deliver({ ...ledgerInput(message), what: message.what, consent });
  // Nothing went out: the next try is a first one again.
  if (answer.status === "confirm" || answer.status === "busy" || answer.status === "gone" || answer.status === "refused") message.tried = false;
  // The server's own check of a quick reply's turn, under the Agent's lock (codex-obs-attn-R3): it moved on.
  if (answer.status === "refused") throw createSendRefused(answer.message);
  if (answer.status !== "confirm") return { answered: answer, plan: decided.check.plan };
  // The Agent changed between this read and the server's: a message bound to its turn is checked against it again first.
  if (hooks.precheck || hooks.expect) { await verify(); await decide(); }
  const plan: SendPlan = { kind: "confirm", label: answer.plan.label, note: answer.plan.note, confirm: answer.plan.confirm, options: undefined };
  return { confirm: { check: { plan, fingerprint: JSON.stringify(["server", message.agentId, answer.consent, answer.plan.confirm]) }, consent: answer.consent, offer: confirmOffer(answer.consent), server: true } };
}

/**
 * What a message bound to a turn passes before it is queued for 「等这一轮结束再发」, as before a send: `precheck`, then the Agent
 * read once and `expect`. Throws `SendRefused` when it no longer fits; nothing is queued then.
 */
export async function checkFits(paseo: ReadApi, message: OutgoingMessage, hooks: Pick<SendHooks, "expect" | "precheck">): Promise<void> {
  const retry = !!message.tried;
  const early = hooks.precheck ? await hooks.precheck(retry) : null;
  if (early) throw createSendRefused(early);
  if (!hooks.expect) return;
  const agent = (await paseo.agents.ref(message.agentId).refresh())?.agent;
  const refused = agent ? hooks.expect(agent, retry) : null;
  if (refused) throw createSendRefused(refused);
}

/**
 * The host attention a reply to a finished turn leaves behind. Sending never clears it, and the host raises a new one only
 * once it is cleared (agent-manager checkAndSetAttention), so a quick reply clears it first, as opening the conversation
 * would, and the turn the reply starts is announced when it ends. Null when there is none to clear.
 */
export function attentionToClear(agent: AgentState): { attentionTimestamp: string; lastUserMessageAt: string | null } | null {
  const quiet = (agent.status === "idle" || agent.status === "closed") && !agent.activeTurn && !agent.pendingPermissions?.length && !agent.archivedAt;
  return quiet && agent.requiresAttention === true && agent.attentionReason === "finished" && agent.attentionTimestamp
    ? { attentionTimestamp: agent.attentionTimestamp, lastUserMessageAt: agent.lastUserMessageAt ?? null } : null;
}

/**
 * `beforeSend` for a reply to a finished turn: clears that turn's attention first. Best effort: the reply goes out either way.
 * `rearm`: sending loads an Agent the host has not loaded anyway, so the server clears its attention too (a plain 标记已读
 * leaves an unloaded Agent's attention to the host, never loading it for that). `round`: when the plugin saw the turn the
 * reply answers start; the server clears only while that is still the latest turn it observed (codex-obs-attn-R4), so a
 * heartbeat round that asks again meanwhile, under the same host tokens, keeps its 需要处理 when the reply is then refused.
 */
export function clearingAttention(clear: (input: { agentId: string; attentionTimestamp: string; lastUserMessageAt: string | null; rearm: true; round?: { startedAt: string } }) => Promise<unknown>,
  agentId: string, round?: string | null) {
  return async (agent: AgentState) => {
    const attention = attentionToClear(agent);
    if (attention) await clear({ agentId, ...attention, rearm: true, ...(round ? { round: { startedAt: round } } : {}) }).catch(() => undefined);
  };
}

const instant = (value: string | null | undefined) => { const at = value ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
/**
 * `expect` for a reply bound to the turn it answers (快捷回复, P1-1): only while the Agent still rests after that turn, idle or
 * not loaded, no turn open and no message since `prompt` (that turn's `lastUserMessageAt`). Otherwise 「继续，按你说的做」
 * would land in a turn it was never meant for (a heartbeat's, one started from another device) as an approval of whatever
 * that turn is doing; it is never sent, steered or not, and a retry is not offered. After a try that may have gone out, a
 * new turn may well be that reply itself: it is not sent again either, the user looks first.
 */
export function answering(prompt: string | null | undefined, title: string) {
  return (agent: AgentState, retry: boolean): string | null => {
    const moved = instant(agent.lastUserMessageAt) !== instant(prompt) || !!agent.activeTurn || agent.status === "running";
    if (!moved && (agent.status === "idle" || agent.status === "closed")) return null;
    if (!moved) return t("secondarySendCheck.changedStateThisQuickReplyNo", { value1: title });
    return retry ? t("secondarySendCheck.hasStartedANewTurnPossibly", { value1: title }) : t("secondarySendCheck.hasStartedANewTurnThis", { value1: title });
  };
}
/**
 * `precheck` for a reply bound to one round (快捷回复): a heartbeat, like any system notification, starts a turn without a
 * message, so once the Agent rests again `answering` cannot tell the round the reply answers from a later one (codex-obs-attn-F1).
 * `latest` reads when the plugin last saw this Agent's turn start; later than `round`, the start of the turn the reply answers,
 * another round has run since. Nothing to compare (no round given, none observed): the Agent's state decides alone, as
 * before. A round given but the read failing stops the send with an error to retry after a refresh (codex-obs-attn-R1):
 * that read is the only thing that tells the rounds apart. These are the client's checks, not one step with the host's
 * send: they narrow the window, they do not close it.
 */
export function sameRound(latest: () => Promise<string | null | undefined>, round: string | null | undefined, title: string) {
  return async (retry: boolean): Promise<string | null> => {
    const expected = instant(round);
    if (expected === null) return null;
    let read: string | null | undefined;
    try { read = await latest(); }
    catch { throw new Error(t("secondarySendCheck.couldNotReadTheLatestTurn", { value1: title })); }
    const seen = instant(read);
    if (seen === null || seen <= expected) return null;
    return retry ? t("secondarySendCheck.hasStartedANewTurnPossibly", { value1: title }) : t("secondarySendCheck.hasStartedANewTurnThis", { value1: title });
  };
}
