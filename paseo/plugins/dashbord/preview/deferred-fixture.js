// Development-only stand-in for the plugin server's ledger (server/deferred-send.ts): the same answers to
// observatory.deferred.*, planned with the same kit send-plan, over the synthetic Agents. No real Agent is sent anything.
import { consentFor, coversConsent, permissionIds, sendPlan } from "../client/send-plan";

const NOTES = {
  queued: "已排队，等 Agent 这一轮结束、没有待审批时自动发送",
  sent: "已送达",
  unknown: "没收到发送结果，可能已经送达。点「仍然发送」会先查会话记录：已经有这条就不再发，没有才重发；也可以取消。",
  canceled: "已取消，没有发送",
  gone: "这个 Agent 已归档或不存在，没有发送。",
};
const RECENT_SAME_MS = 10_000;
const LISTED_MS = 30 * 60_000;
const onWay = message => message.state === "queued" || message.state === "held" || message.state === "sending";
const busy = agent => agent.status === "running" || agent.status === "initializing" || !!agent.activeTurn || (agent.pendingPermissions?.length ?? 0) > 0;
const answerFor = view => view.state === "sent" ? "sent" : view.state === "sending" ? "sending" : view.state === "held" ? "held" : "existing";
const failure = error => {
  const text = error instanceof Error ? error.message : String(error);
  return /agent_request_outcome_unknown|agent_request_key_conflict/.test(text) ? NOTES.unknown : `发送失败：宿主返回：${text}。点「仍然发送」会先查会话记录，确认没有这条才重发；也可以取消。`;
};

/**
 * `agent(id)` reads an Agent as the host has it; `deliver(agentId, text, options)` is the host's send; `capabilities` what
 * steers; `guard(agentId, guard, agent)` the plugin's check of a quick reply's turn (null when it still fits; it throws when it
 * cannot tell, which answers busy now and holds a queued one, as the kit does). Queued messages go out (steered, under their own
 * id) once their Agent is free, checked every 300 ms, a guarded one only while it fits.
 */
export function createFixtureLedger({ agent, deliver, capabilities, guard: check = () => null }) {
  const messages = new Map();
  const view = message => ({ messageId: message.messageId, agentId: message.agentId, key: message.key, source: message.source, preview: message.text.replace(/\s+/g, " ").slice(0, 160),
    createdAt: message.createdAt, at: message.at, state: message.state, note: message.note });
  const settle = (message, state, note) => Object.assign(message, { state, note, at: Date.now() });
  const sameContent = (agentId, key) => [...messages.values()].find(message => message.agentId === agentId && message.key === key
    && (onWay(message) || (message.state === "sent" || message.state === "maybe-sent") && Date.now() - message.at < RECENT_SAME_MS)) ?? null;
  // One reply per question (a quick reply's turn): one on its way, or one that went out or may have, answers it for good.
  const sameGroup = (agentId, group) => group ? [...messages.values()].find(message => message.agentId === agentId && message.group === group
    && (onWay(message) || message.state === "sent" || message.state === "maybe-sent")) ?? null : null;
  const refused = reason => `${reason}，没有发送。`;
  const unknownNote = error => `没能确认这条消息还适用（${error}），没有发送。`;
  /** The plugin's check of a guarded message: `reason` (null when it fits), or `unknown` when it threw. */
  const verdict = async (message, current) => {
    if (!message.guard) return { reason: null };
    try { return { reason: await check(message.agentId, message.guard, current) }; } catch (error) { return { unknown: error instanceof Error ? error.message : String(error) }; }
  };
  const holdUnknown = (message, unknown) => settle(message, "held", `${unknownNote(unknown)}点「仍然发送」会再检查一次；也可以取消。`);
  async function go(message) {
    settle(message, "sending", "正在发送");
    try { await deliver(message.agentId, message.text, { activeTurnBehavior: message.behavior, messageId: message.messageId }); settle(message, "sent", NOTES.sent); }
    catch (error) { settle(message, "held", failure(error)); }
  }
  let flushing = false;
  setInterval(async () => {
    if (flushing) return;
    flushing = true;
    try {
      for (const message of messages.values()) {
        const current = message.state === "queued" ? agent(message.agentId) : null;
        if (!current) continue;
        if (current.archivedAt) { settle(message, "discarded", "Agent 已归档或不存在，没有发送"); continue; }
        if (busy(current)) continue;
        const found = await verdict(message, current);
        if ("unknown" in found) holdUnknown(message, found.unknown);
        else if (found.reason) settle(message, "discarded", refused(found.reason));
        else await go(message);
      }
    } finally { flushing = false; }
  }, 300);
  return {
    async send(input) {
      const known = messages.get(input.messageId);
      if (known) return { status: answerFor(known), view: view(known) };
      const other = sameContent(input.agentId, input.key) ?? sameGroup(input.agentId, input.group);
      if (other) return { status: "existing", view: view(other) };
      const current = agent(input.agentId);
      if (!current || current.archivedAt) return { status: "gone", message: NOTES.gone };
      const found = await verdict(input, current);
      if ("unknown" in found) return { status: "busy", message: `${unknownNote(found.unknown)}请稍后再试。` };
      if (found.reason) return { status: "refused", message: refused(found.reason) };
      const plan = sendPlan({ ...current, pendingPermissions: current.pendingPermissions?.length ?? 0 }, { ...capabilities, what: input.what, text: input.text });
      if (plan.kind === "unavailable") return { status: "gone", message: NOTES.gone };
      const needed = consentFor(plan, permissionIds(current.pendingPermissions), current.activeTurn);
      if (needed && !coversConsent(input.consent, needed)) return { status: "confirm", plan: { label: plan.label, note: plan.note ?? "", confirm: plan.confirm ?? plan.note ?? "" }, consent: needed };
      const message = { ...input, createdAt: Date.now(), at: Date.now(), state: "sending", note: "正在发送", behavior: plan.options?.activeTurnBehavior ?? "interrupt" };
      messages.set(input.messageId, message);
      await go(message);
      return { status: answerFor(message), view: view(message) };
    },
    async enqueue(input) {
      const known = messages.get(input.messageId);
      if (known) return view(known);
      const other = sameContent(input.agentId, input.key) ?? sameGroup(input.agentId, input.group);
      if (other) return view(other);
      const current = agent(input.agentId);
      if (!current || current.archivedAt) throw new Error("这个 Agent 已归档或不存在，不能排队发送。");
      const found = await verdict(input, current);
      if (found.reason) {
        const dropped = { ...input, createdAt: Date.now(), at: Date.now(), state: "discarded", note: refused(found.reason), behavior: "steer" };
        messages.set(input.messageId, dropped);
        return view(dropped);
      }
      const message = { ...input, createdAt: Date.now(), at: Date.now(), state: "queued", note: NOTES.queued, behavior: "steer" };
      messages.set(input.messageId, message);
      if ("unknown" in found) holdUnknown(message, found.unknown);
      else if (!busy(current)) await go(message);
      return view(message);
    },
    list({ agentId }) {
      return [...messages.values()].filter(message => (!agentId || message.agentId === agentId) && (onWay(message) || Date.now() - message.at < LISTED_MS))
        .sort((a, b) => b.createdAt - a.createdAt).map(view);
    },
    cancel(messageId) {
      const message = messages.get(messageId);
      if (!message) return null;
      if (message.state === "queued" || message.state === "held") settle(message, "canceled", NOTES.canceled);
      return view(message);
    },
    async resume(messageId) {
      const message = messages.get(messageId);
      if (!message) return null;
      if (message.state === "held") {
        const current = agent(message.agentId);
        settle(message, "queued", NOTES.queued);
        const found = current ? await verdict(message, current) : { reason: null };
        if ("unknown" in found) holdUnknown(message, found.unknown);
        else if (found.reason) settle(message, "discarded", refused(found.reason));
        else if (current && !busy(current)) await go(message);
      }
      return view(message);
    },
  };
}
