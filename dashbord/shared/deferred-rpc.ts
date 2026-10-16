import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { addDefaults, t } from "./i18n";
import { kitDeferred } from "./locales/kit/zh-CN.json";

addDefaults({ kitDeferred });

/** Longest name for the message in a confirmation (`what`: "message", "answer", a translated word such as "Eingabeaufforderung"). */
export const SEND_NOUN_LIMIT = 80;

/**
 * Sending to existing agents through a plugin's server ledger (`server/deferred-send.ts`): 「等这一轮结束再发」 and
 * sending now. The calls, named under the plugin's own RPC prefix, and the words every plugin uses for them.
 */

export const DeferredViewSchema = z.object({
  messageId: z.string(),
  agentId: z.string(),
  /** What makes two messages the same request: one per agent and key is on its way at a time. */
  key: z.string(),
  source: z.string(),
  preview: z.string(),
  createdAt: z.number(),
  at: z.number(),
  state: z.enum(["queued", "held", "sending", "sent", "maybe-sent", "canceled", "discarded", "expired"]),
  note: z.string(),
});
export type DeferredView = z.infer<typeof DeferredViewSchema>;

/** What the user agreed to in a confirmation (`consentFor` in send-plan.ts). */
export const ConsentSchema = z.object({ interrupt: z.boolean(), approvals: z.array(z.string().max(200)).max(100), turn: z.string().max(300).nullable().optional() });

/**
 * A plugin's own condition for one message (`DeferredSendOptions.guard`, checked by its server right before the message goes
 * out): a few named short values, e.g. the turn a quick reply answers.
 */
export const DeferredGuardSchema = z.record(z.string().min(1).max(40), z.string().max(200).nullable()).refine((value) => Object.keys(value).length <= 8, "at most 8 conditions");

export const DeferredSendResultSchema = z.union([
  /** sent, still sending, held for the user (failed or unknown outcome), or the same content already on its way. */
  z.object({ status: z.enum(["sent", "sending", "held", "existing"]), view: DeferredViewSchema }),
  /** What sending would do now needs the user's OK: ask `plan.confirm`, then send again with `consent`. */
  z.object({ status: z.literal("confirm"), plan: z.object({ label: z.string(), note: z.string(), confirm: z.string() }), consent: ConsentSchema }),
  /**
   * Nothing was sent: another send to the agent is going on (or the plugin could not check the message's `guard`), the agent
   * is archived or deleted, or the plugin's own condition for this message (`guard`) no longer holds.
   */
  z.object({ status: z.enum(["busy", "gone", "refused"]), message: z.string() }),
]);
export type DeferredSendResult = z.infer<typeof DeferredSendResultSchema>;

// Not `key`: a top-level `key` makes esbuild rename its interop helper's loop variable, and Paseo's Hermes patch
// (which rewrites the exact text `from[key]`) then misses it.
const sendKey = z.string().min(1).max(120);

/** `prefix` is the plugin's RPC namespace, e.g. "skills" gives "skills.deferred.enqueue". */
export function deferredSendContracts(prefix: string) {
  return {
    /**
     * Send now. The server plans again from the agent as it is and sends only if `consent` covers what that would do;
     * otherwise it answers "confirm". Retry with the same `messageId` after a lost answer: it never sends twice. `group`:
     * messages answering one question (one per group goes out; the others answer with it, "existing"); `guard`: the plugin's
     * own condition, checked right before the send ("refused" once it no longer holds).
     */
    send: defineRpc({
      name: `${prefix}.deferred.send`,
      input: z.object({
        group: sendKey.optional(), guard: DeferredGuardSchema.optional(),
        agentId: z.string().min(1), text: z.string().min(1).max(200_000), messageId: z.string().min(8).max(100), source: z.string().max(200).optional(),
        key: sendKey.optional(), what: z.string().max(SEND_NOUN_LIMIT).optional(), consent: ConsentSchema.nullable().optional(),
      }),
      output: DeferredSendResultSchema,
    }),
    /**
     * Queue a message (or send it now if the agent is already free); the same `messageId` again returns its state.
     * Content already on its way (same agent and key), or the answer to its `group`, answers with that message under its own
     * id. A `guard` that no longer holds is answered with the message dropped (未发送, its note says why).
     */
    enqueue: defineRpc({
      name: `${prefix}.deferred.enqueue`,
      input: z.object({ agentId: z.string().min(1), text: z.string().min(1).max(200_000), messageId: z.string().min(8).max(100), source: z.string().max(200).optional(), key: sendKey.optional(),
        group: sendKey.optional(), guard: DeferredGuardSchema.optional() }),
      output: DeferredViewSchema,
    }),
    /** Queued, held and sending messages, plus the last half hour's outcomes; newest first. */
    list: defineRpc({ name: `${prefix}.deferred.list`, input: z.object({ agentId: z.string().optional() }), output: z.array(DeferredViewSchema) }),
    cancel: defineRpc({ name: `${prefix}.deferred.cancel`, input: z.object({ messageId: z.string().min(1) }), output: DeferredViewSchema.nullable() }),
    /** Send a held message anyway (same id and options, once the agent is free). */
    resume: defineRpc({ name: `${prefix}.deferred.resume`, input: z.object({ messageId: z.string().min(1) }), output: DeferredViewSchema.nullable() }),
  };
}

/** Still on its way: queued, held for the user's OK, or sending. At most one per agent and key. */
export function isOnItsWay(view: Pick<DeferredView, "state">): boolean {
  return view.state === "queued" || view.state === "held" || view.state === "sending";
}

/** The message with this content that is still on its way to this agent, if any. */
export function onItsWay(views: readonly DeferredView[] | null | undefined, agentId: string, key: string): DeferredView | null {
  return views?.find((view) => view.agentId === agentId && view.key === key && isOnItsWay(view)) ?? null;
}

/**
 * The extra choice next to a send confirmation (`sendPlan(...).kind === "confirm"`, or a "confirm" answer from the
 * server): wait for the turn to end instead of interrupting it, or for the approval to be handled instead of
 * cancelling it. `null` when there is nothing to wait for: the agent is idle, takes the message mid-turn, or is gone.
 */
export function deferOffer(
  agent: { provider?: string; status?: string; pendingPermissions?: number; requiresAttention?: boolean; attentionReason?: string | null } | null | undefined,
  plan: { kind: string },
): { label: string; note: string } | null {
  if (!agent || plan.kind !== "confirm") return null;
  const approval = (agent.pendingPermissions ?? 0) > 0 || (agent.requiresAttention === true && agent.attentionReason === "permission");
  return approval
    ? { label: t("kitDeferred.afterApprovalLabel"), note: t("kitDeferred.afterApprovalNote") }
    : { label: t("kitDeferred.afterTurnLabel"), note: t("kitDeferred.afterTurnNote") };
}

/** Short status for a chip, and its tone (kit `Tone`): amber while waiting or sending, orange when it needs you, green once sent. */
export function deferredBadge(view: Pick<DeferredView, "state">): { label: string; tone: "warning" | "orange" | "success" | "neutral" | "danger" } {
  switch (view.state) {
    case "queued": return { label: t("kitDeferred.queued"), tone: "warning" };
    case "held": return { label: t("kitDeferred.held"), tone: "orange" };
    case "sending": return { label: t("kitDeferred.sending"), tone: "warning" };
    case "sent": return { label: t("kitDeferred.sent"), tone: "success" };
    case "maybe-sent": return { label: t("kitDeferred.maybeSent"), tone: "warning" };
    case "canceled": return { label: t("kitDeferred.canceled"), tone: "neutral" };
    case "discarded": return { label: t("kitDeferred.discarded"), tone: "danger" };
    case "expired": return { label: t("kitDeferred.expired"), tone: "danger" };
  }
}
