/**
 * How a plugin sends a message to an agent that already exists, decided in one place so the button label, the
 * warning and the call agree. What Paseo 0.11.1 does (daemon source):
 * - `agents.ref(id).send(text)` defaults to `activeTurnBehavior: "interrupt"`: it stops a running turn.
 * - A send that starts or steers a turn clears the agent's pending permission requests: a steer DENIES them as
 *   superseded.
 * - Only providers that implement steering take a message mid-turn; for the rest Paseo replaces the running turn.
 * - Slash commands are parsed like the daemon does: `/name` or `/name args`, where the name has no further slash
 *   (`/tmp/a.log 请看` is text). They never steer into pi, omp, codex or opencode (Paseo replaces the turn). Claude
 *   takes them mid-turn except `/rewind` and its root-only commands (`/compact`, `/clear` …), which replace it.
 * - Some commands run out of band, beside the turn: pi and omp `/compact`, `/autocompact`; omp `/handoff`,
 *   `/steer …`, `/follow-up …`; codex `/compact`, and `/goal …` when the session has goals turned on. They neither
 *   interrupt the turn nor clear pending approvals. Only a plain-text message counts: with images or attachments the
 *   daemon builds a structured prompt, which no provider runs as a command. Claude, codex and opencode then steer it
 *   as text; pi and omp flatten it back into a slash command and replace the turn.
 * - `closed` only means the daemon has not loaded the agent: sending loads it. Plugins treat an archived agent as
 *   gone (the daemon itself would unarchive it on send).
 * - A plugin with a server queue (deferred-send.ts) sends through it instead of calling `send` itself: the server
 *   plans again from the agent as it is at that moment and sends only if the user's consent (`consentFor`) still
 *   covers what the send would do.
 * Labels, notes and confirmations come from `../shared/i18n` (`kitSend`): the plugin's language, else Chinese.
 */
import { addDefaults, t } from "../shared/i18n";
import { kitSend } from "../shared/locales/kit/zh-CN.json";

addDefaults({ kitSend });

export interface SendTarget {
  provider: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  archivedAt?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  /**
   * Permission requests the agent waits on. Read them from the agent itself: plugin snapshots don't carry them,
   * and Paseo 0.11 never sets `attentionReason: "permission"` while one waits.
   */
  pendingPermissions?: number;
}

/**
 * Built-in providers whose running turns accept a steered message: in Paseo 0.11 only these implement steering.
 * Custom provider ids built on them (`extends` in the daemon config) can steer too; the plugin server reads them
 * with `readSteerableProviders()` / `readSendCapabilities()` and passes them here. Ids are never guessed from a prefix.
 */
export const STEERING_PROVIDERS: readonly string[] = ["claude", "codex", "pi", "opencode", "omp"];
/** Built-in providers that also take a steered slash command (`/name …`): Claude only, and not every command. */
export const SLASH_STEERING_PROVIDERS: readonly string[] = ["claude"];
/** Claude commands that cannot join a running turn: Paseo replaces the turn with them. */
const CLAUDE_TURN_REPLACING = new Set(["rewind", "clear", "compact", "context", "debug", "extra-usage", "heapdump", "init", "loop", "schedule", "usage"]);
type Steerable = ReadonlySet<string> | readonly string[];
const has = (list: Steerable | undefined, id: string) => !!list && (Array.isArray(list) ? list.includes(id) : (list as ReadonlySet<string>).has(id));

export type SendOptions = { activeTurnBehavior: "steer" } | undefined;
export type SendPlan =
  | { kind: "send"; label: string; note: string | null; confirm: null; options: undefined }
  | { kind: "steer"; label: string; note: string; confirm: null; options: { activeTurnBehavior: "steer" } }
  | { kind: "confirm"; label: string; note: string; confirm: string; options: SendOptions }
  | { kind: "unavailable"; label: string; note: string; confirm: null; options: undefined };

export interface SendPlanOptions {
  /** Names the message in the confirmations, in the plugin's language: "message", "answer", "command" (default `kitSend.message`). */
  what?: string;
  /** The daemon's custom ids that can steer (`readSteerableProviders()`); the built-ins are always included. */
  steerable?: Steerable;
  /** The daemon's custom ids built on Claude (`readSendCapabilities().slashSteerable`): only they take a steered slash command. */
  slashSteerable?: Steerable;
  /**
   * The built-in provider each custom id extends (`readSendCapabilities().bases`), so a command is judged by what
   * its provider really does with it. Without it, commands into custom ids get the cautious reading.
   */
  bases?: Readonly<Record<string, string>>;
  /** The message itself, or just `slash: true` (a command whose name is unknown: read cautiously). */
  text?: string;
  slash?: boolean;
  /** The message carries images or attachments: the daemon sends a structured prompt, never run as a command. */
  structured?: boolean;
}

/** The command a provider runs for this text, parsed like Paseo 0.11.1: `/name` or `/name args`, no slash in the name. */
export function slashCommand(text: string | null | undefined): { name: string; args: string } | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("/") || trimmed.length <= 1) return null;
  const rest = trimmed.slice(1);
  const end = rest.search(/\s/);
  const name = end === -1 ? rest : rest.slice(0, end);
  if (!name || name.includes("/")) return null;
  return { name, args: end === -1 ? "" : rest.slice(end + 1).trim() };
}

/** `/name` or `/name args`: what a provider runs as a command rather than reading as text. */
export function isSlashCommand(text: string | null | undefined): boolean {
  return slashCommand(text) !== null;
}

/** The built-in provider an id is built on: itself for built-ins, its `extends` for custom ids the server reported. */
export function providerBase(provider: string, options: Pick<SendPlanOptions, "bases" | "slashSteerable"> = {}): string | null {
  if (has(STEERING_PROVIDERS, provider)) return provider;
  const base = options.bases?.[provider];
  if (base) return base;
  return has(options.slashSteerable, provider) ? "claude" : null;
}

/**
 * What a running agent does with a slash command: take it into the turn, replace the turn with it, run it beside the
 * turn, or "maybe" (codex `/goal`: beside the turn only when the session has goals on, which a plugin cannot see).
 * `null` for text that is not a command. Unknown bases and a bare `slash: true` get the cautious "replace".
 */
export function commandEffect(provider: string, options: Pick<SendPlanOptions, "bases" | "slashSteerable" | "text" | "slash" | "structured"> = {}): "steer" | "replace" | "out-of-band" | "maybe-out-of-band" | null {
  const command = options.text !== undefined ? slashCommand(options.text) : null;
  if (!command && !(options.text === undefined && options.slash)) return null;
  const base = providerBase(provider, options);
  if (!command) return "replace";
  // A structured prompt (images, attachments) skips every command parser: Claude, codex and opencode steer it as text;
  // pi and omp flatten it into text that starts with the command again, which they refuse mid-turn.
  if (options.structured) return base === "claude" || base === "codex" || base === "opencode" ? "steer" : "replace";
  const lower = command.name.toLowerCase();
  if (base === "claude") return CLAUDE_TURN_REPLACING.has(command.name) ? "replace" : "steer";
  if (base === "pi") return lower === "compact" || lower === "autocompact" ? "out-of-band" : "replace";
  if (base === "omp") {
    if (lower === "compact" || lower === "autocompact" || lower === "handoff") return "out-of-band";
    return (lower === "steer" || lower === "follow-up") && command.args ? "out-of-band" : "replace";
  }
  if (base === "codex") return command.name === "compact" ? "out-of-band" : command.name === "goal" ? "maybe-out-of-band" : "replace";
  return "replace";
}

/** Can a message be sent to it at all? Archived agents are gone; `closed` (not loaded) ones load on send. */
export function usableTarget<T extends { archivedAt?: string | null }>(agent: T | null | undefined): agent is T {
  return !!agent && !agent.archivedAt;
}

export function isActive(agent: Pick<SendTarget, "status"> | null | undefined): boolean {
  return agent?.status === "running" || agent?.status === "initializing";
}

export function canSteer(agent: Pick<SendTarget, "provider" | "status"> | null | undefined, steerable: Steerable = STEERING_PROVIDERS, options: Pick<SendPlanOptions, "text" | "slash" | "slashSteerable" | "bases" | "structured"> = {}): boolean {
  if (!agent || !isActive(agent) || !(has(STEERING_PROVIDERS, agent.provider) || has(steerable, agent.provider))) return false;
  const effect = commandEffect(agent.provider, options);
  return effect === null || effect === "steer";
}

export function sendPlan(agent: SendTarget | null | undefined, options: SendPlanOptions = {}): SendPlan {
  const what = options.what ?? t("kitSend.message");
  if (!usableTarget(agent)) return { kind: "unavailable", label: t("kitSend.send"), note: t(agent ? "kitSend.archived" : "kitSend.unavailable"), confirm: null, options: undefined };
  const effect = commandEffect(agent.provider, options);
  const waiting = (agent.pendingPermissions ?? 0) > 0 || (agent.requiresAttention && agent.attentionReason === "permission");
  // Paseo runs these beside the turn before any steer or replace: nothing is interrupted and approvals stay.
  if (effect === "out-of-band") {
    const note = isActive(agent) || waiting ? t("kitSend.outOfBandNote") : null;
    return { kind: "send", label: t("kitSend.send"), note, confirm: null, options: undefined };
  }
  // Codex runs /goal beside the turn only when the session has goals on; say both outcomes instead of promising one.
  if (effect === "maybe-out-of-band" && (isActive(agent) || waiting)) {
    return { kind: "confirm", label: t("kitSend.sendAnyway"), note: t("kitSend.maybeOutOfBandNote"), confirm: t(waiting ? "kitSend.maybeOutOfBandConfirmApproval" : "kitSend.maybeOutOfBandConfirm", { what }), options: undefined };
  }
  const steer = canSteer(agent, options.steerable, options);
  // The steering check above only covers steering providers; a slash command into one of them still replaces the turn.
  const slashBlocked = effect === "replace" && isActive(agent) && (has(STEERING_PROVIDERS, agent.provider) || has(options.steerable, agent.provider));
  if (waiting) {
    return steer
      ? { kind: "confirm", label: t("kitSend.sendAnyway"), note: t("kitSend.waitingNote"), confirm: t("kitSend.waitingSteerConfirm", { what }), options: { activeTurnBehavior: "steer" } }
      : { kind: "confirm", label: t("kitSend.sendAnyway"), note: t("kitSend.waitingNote"), confirm: t("kitSend.waitingConfirm", { what }), options: undefined };
  }
  if (isActive(agent)) {
    if (steer) return { kind: "steer", label: t("kitSend.send"), note: t("kitSend.steerNote"), confirm: null, options: { activeTurnBehavior: "steer" } };
    if (slashBlocked) return { kind: "confirm", label: t("kitSend.interruptAndSend"), note: t("kitSend.slashBlockedNote"), confirm: t("kitSend.slashBlockedConfirm", { what }), options: undefined };
    return { kind: "confirm", label: t("kitSend.interruptAndSend"), note: t("kitSend.noSteerNote"), confirm: t("kitSend.noSteerConfirm", { what }), options: undefined };
  }
  const note = agent.status === "error" ? t("kitSend.errorNote") : agent.status === "closed" ? t("kitSend.closedNote") : null;
  return { kind: "send", label: t("kitSend.send"), note, confirm: null, options: undefined };
}

/**
 * What the user agreed to in a confirmation: interrupting the running turn, cancelling these pending approvals, for
 * the turn that was running when they agreed (`turn`, from `turnIdentity`).
 */
export interface Consent {
  interrupt: boolean;
  approvals: string[];
  /** Absent in an OK given without a running turn in view. */
  turn?: string | null;
}

/** A running turn as a consent names it: its id and start (`agent.activeTurn` of a snapshot), or null without one. */
export function turnIdentity(activeTurn: unknown): string | null {
  const turn = activeTurn as { turnId?: unknown; id?: unknown; startedAt?: unknown } | null | undefined;
  const id = turn?.turnId ?? turn?.id;
  if (typeof id !== "string" || !id) return null;
  return typeof turn?.startedAt === "string" ? `${id}@${turn.startedAt}` : id;
}

/**
 * The consent a plan asks for, from the pending request ids and the running turn it was shown with; `null` when it
 * needs no confirmation. A plugin server sends a confirmed message only while this still covers what the send would
 * do (`coversConsent`).
 */
export function consentFor(plan: Pick<SendPlan, "kind" | "options">, pendingIds: readonly string[] = [], activeTurn: unknown = null): Consent | null {
  if (plan.kind !== "confirm") return null;
  return { interrupt: plan.options?.activeTurnBehavior !== "steer", approvals: [...new Set(pendingIds)].sort(), turn: turnIdentity(activeTurn) };
}

/**
 * Does the consent given cover the consent needed now? Interrupting needs an OK to interrupt; every pending request
 * needs to have been in the OK; and an OK given while another turn ran does not carry over to this one.
 */
export function coversConsent(given: Partial<Consent> | null | undefined, needed: Consent | null): boolean {
  if (!needed) return true;
  if (needed.interrupt && given?.interrupt !== true) return false;
  if ((needed.turn ?? null) !== null && (given?.turn ?? null) !== needed.turn) return false;
  const approvals = new Set(given?.approvals ?? []);
  return needed.approvals.every((id) => approvals.has(id));
}

/** The ids of an agent's pending permission requests (`pendingPermissions` of a refreshed snapshot). */
export function permissionIds(pending: readonly unknown[] | null | undefined): string[] {
  return (pending ?? []).map((entry) => (entry as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string");
}

/**
 * What a confirmation was given for. A different pending request, turn, status or plan needs a new confirmation,
 * so pass the request ids, not just their number.
 */
export function confirmFingerprint(agent: { id: string; provider?: string; status?: string; activeTurn?: unknown } | null | undefined, plan: SendPlan, pendingIds: readonly string[] = []): string {
  const turn = agent?.activeTurn as { id?: unknown; turnId?: unknown; startedAt?: unknown } | null | undefined;
  return JSON.stringify([agent?.id ?? null, agent?.provider ?? null, agent?.status ?? null, turn ? [turn.id ?? turn.turnId ?? null, turn.startedAt ?? null] : null, [...pendingIds].sort(), plan.kind, plan.confirm]);
}

/**
 * One id per logical message. Pass it as `messageId` on the first send and on every retry of the same message, with
 * the same text and the same options: the daemon then delivers it at most once. Changing the options (say steer →
 * interrupt because the agent went idle) makes the daemon refuse the retry; ask again with a new id instead.
 */
export function newMessageId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const hex = (count: number) => Array.from({ length: count }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

/**
 * A short key for what a message carries: a 53-bit hash of the parts, in base 36; the same parts give the same key
 * on every client. A plugin server keeps at most one message per agent and key on its way (deferred-send.ts), so
 * name the parts that make two messages the same request: the plugin, and the command, prompt or task.
 */
export function contentKey(parts: readonly string[]): string {
  const text = JSON.stringify(parts);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The key carried in an id of the form `<uuid>~<key>` (how plugins named queued messages before keys were explicit). */
export function messageIdKey(messageId: string): string | null {
  const at = messageId.lastIndexOf("~");
  return at > 0 ? messageId.slice(at + 1) : null;
}

/** The daemon's answers to a retried `messageId`, in words for the user. */
export function sendFailure(error: unknown): { kind: "maybe-delivered" | "changed" | "failed"; message: string } {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (text.includes("agent_request_outcome_unknown")) return { kind: "maybe-delivered", message: t("kitSend.maybeDelivered") };
  if (text.includes("agent_request_key_conflict")) return { kind: "changed", message: t("kitSend.changed") };
  return { kind: "failed", message: text || t("kitSend.failed") };
}
