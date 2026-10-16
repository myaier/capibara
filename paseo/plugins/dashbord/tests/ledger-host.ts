import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeferredSend } from "../server/deferred-send";
import { answeringGuard } from "../server/send-ledger";
import type { AgentState, DeliverMessage } from "../client/send-check";
import type { SendCapabilities } from "../shared/steer";

/** What the daemon received: the text and the options it went out with. */
export type Delivery = { text: string; options: { activeTurnBehavior?: "steer" | "interrupt"; messageId: string } };

/**
 * A host for sends through the plugin's real ledger (server/deferred-send.ts): one Agent whose state the test sets, read by
 * the client (`client`, logged "read") and by the plugin server (`server`, logged "server-read"), and the daemon's `send`
 * (logged "send"), which records each delivery and fails with the queued errors. A send that arrives starts a turn and moves
 * `lastUserMessageAt`, as the host does. `deliver` is `observatory.deferred.send` for that Agent; `lose()` makes its next
 * answer get lost after the server handled it (an RPC timeout). The ledger checks a quick reply's turn as the plugin does
 * (`answeringGuard`), against `turns` (the plugin's telemetry) or, without them, the turn start `observe()` set last (a send
 * that went in starts one).
 */
export async function ledgerHost(initial: AgentState | null, capabilities: SendCapabilities = { steerable: [], slashSteerable: [], bases: {} },
  options: { turns?: Parameters<typeof answeringGuard>[0] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "observatory-ledger-"));
  let state = initial;
  const log: string[] = [], delivered: Delivery[] = [], failures: unknown[] = [];
  let lostAnswers = 0, observed: string | null = null;
  const snapshot = () => state ? { agent: structuredClone(state) as AgentState } : null;
  const client = { agents: { ref: (_id: string) => ({ refresh: async () => { log.push("read"); return snapshot(); } }) } };
  const server = { agents: { ref: (_id: string) => ({
    refresh: async () => { log.push("server-read"); return snapshot() as { agent: never } | null; },
    send: async (text: string, options: Delivery["options"]) => {
      log.push("send"); delivered.push({ text, options: { ...options } });
      const failure = failures.shift();
      if (failure) throw failure;
      if (state) state = { ...state, status: "running", activeTurn: { turnId: `turn-${delivered.length}`, startedAt: new Date().toISOString() }, lastUserMessageAt: new Date().toISOString(), pendingPermissions: [] };
      observed = new Date().toISOString();
    },
    timeline: { refetch: async () => ({ entries: delivered.map(entry => ({ item: { type: "user_message", clientMessageId: entry.options.messageId } })) }) },
  }) } };
  const turns = options.turns ?? { snapshot: async (agentId: string) => ({ agents: [{ agentId, turnStartedAt: observed }] }) };
  const ledger = new DeferredSend({ file: join(root, "plugin-data", "agent-observatory", "deferred-send.json"), capabilities: () => capabilities, pollMs: 3_600_000, log: () => undefined,
    guard: answeringGuard(turns) });
  const deliver: DeliverMessage = async input => {
    const answer = await ledger.send({ agentId: "a", ...input }, server);
    if (lostAnswers > 0) { lostAnswers--; throw new Error("rpc timeout"); }
    return answer;
  };
  return {
    client, server, ledger, deliver, log, delivered, failures, capabilities,
    get state() { return state; },
    set(next: Partial<AgentState> | null) { state = next === null ? null : { ...state!, ...next }; },
    lose(count = 1) { lostAnswers += count; },
    /** The plugin saw a turn of the Agent start at `at` (a heartbeat round, a message). */
    observe(at: string | null) { observed = at; },
    enqueue: (input: Omit<Parameters<DeferredSend["enqueue"]>[0], "agentId">) => ledger.enqueue({ agentId: "a", ...input }, server),
    list: () => ledger.list({ agentId: "a" }),
    async close() { ledger.stop(); await ledger.flush(); await rm(root, { recursive: true, force: true }); },
  };
}
export type LedgerHost = Awaited<ReturnType<typeof ledgerHost>>;
