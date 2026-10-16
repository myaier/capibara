import { t } from "../shared/text";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { archiveReadOriginSchema, getReadReceipts, markCompletionRead, readReceiptSchema, type ArchiveReadOrigin, type MarkCompletionReadInput, type MarkCompletionReadResult, type ReadReceipt, type ReadReceiptsResponse } from "../shared/read-state";
import type { AgentTelemetry } from "../shared/telemetry";
import { object } from "../shared/timeline";
import type { ProviderBridge } from "./provider-subagents";
import { telemetryDirectory } from "./telemetry";
import { ensurePrivateDirectory } from "./paseo-home";
import { contentRevision } from "./revision";

const fileSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), receipts: z.array(readReceiptSchema).max(2000), archiveOrigins: z.array(archiveReadOriginSchema).max(2000).default([]) });
export interface ReadReceiptStoreOptions { directory?: string; limit?: number }
/** Host-local completion/read metadata only: no titles, messages or prompts. */
export class ReadReceiptStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly limit: number;
  private receipts = new Map<string, ReadReceipt>();
  private archiveOrigins = new Map<string, ArchiveReadOrigin>();
  private error: string | null = null;
  private corrupt = false;
  private ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(options: ReadReceiptStoreOptions = {}) {
    this.directory = options.directory ?? telemetryDirectory(); this.file = join(this.directory, "read-receipts.json");
    this.limit = Math.max(1, Math.min(2000, options.limit ?? 2000)); this.ready = this.load();
  }
  private async load() {
    try {
      if ((await stat(this.file)).size > 4_000_000) throw new Error("receipt storage is too large");
      const data = fileSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      for (const receipt of data.receipts) {
        const previous = this.receipts.get(receipt.agentId);
        if (!previous || Date.parse(receipt.completionAt) > Date.parse(previous.completionAt)
          || receipt.completionAt === previous.completionAt && Date.parse(receipt.readAt) > Date.parse(previous.readAt)) this.receipts.set(receipt.agentId, receipt);
      }
      for (const origin of data.archiveOrigins) {
        const previous = this.archiveOrigins.get(origin.agentId);
        if (!previous || Date.parse(origin.archivedAt) >= Date.parse(previous.archivedAt)) this.archiveOrigins.set(origin.agentId, origin);
      }
      this.trim();
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") { this.corrupt = true; this.error = t("serverReadState.m001"); }
    }
  }
  private trim() {
    const newest = [...this.receipts.values()].sort((a, b) => Date.parse(b.readAt) - Date.parse(a.readAt)).slice(0, this.limit);
    this.receipts = new Map(newest.map(receipt => [receipt.agentId, receipt]));
    const origins = [...this.archiveOrigins.values()].sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt)).slice(0, this.limit);
    this.archiveOrigins = new Map(origins.map(origin => [origin.agentId, origin]));
  }
  async get(agentId: string): Promise<ReadReceipt | null> { await this.ready; const receipt = this.receipts.get(agentId); return receipt ? { ...receipt } : null; }
  async snapshot() { await this.ready; return { receipts: [...this.receipts.values()].map(receipt => ({ ...receipt })), archiveOrigins: [...this.archiveOrigins.values()].map(origin => ({ ...origin })), error: this.error }; }
  async read(revision?: string): Promise<ReadReceiptsResponse> {
    const snapshot = await this.snapshot(), current = contentRevision(snapshot);
    return revision === current ? { mode: "unchanged", unchanged: true, revision: current } : { ...snapshot, mode: "full", unchanged: false, revision: current };
  }
  async record(input: ReadReceipt): Promise<ReadReceipt> {
    await this.ready;
    const receipt = readReceiptSchema.parse(input), previous = this.receipts.get(receipt.agentId);
    if (Date.parse(receipt.readAt) < Date.parse(receipt.completionAt)) throw new Error(t("serverReadState.m002"));
    if (previous && (Date.parse(previous.completionAt) > Date.parse(receipt.completionAt)
      || Date.parse(previous.completionAt) === Date.parse(receipt.completionAt) && Date.parse(previous.readAt) >= Date.parse(receipt.readAt))) return { ...previous };
    this.receipts.set(receipt.agentId, receipt); this.trim();
    await this.persist(); return { ...receipt };
  }
  async recordArchiveOrigin(input: ArchiveReadOrigin): Promise<ArchiveReadOrigin> {
    await this.ready;
    const origin = archiveReadOriginSchema.parse(input), previous = this.archiveOrigins.get(origin.agentId);
    if (previous && Date.parse(previous.archivedAt) > Date.parse(origin.archivedAt)) return { ...previous };
    if (origin.lastUserMessageAt && Date.parse(origin.lastUserMessageAt) > Date.parse(origin.archivedAt)) origin.lastUserMessageAt = null;
    if (previous?.archivedAt === origin.archivedAt && previous.lastUserMessageAt && !origin.lastUserMessageAt) origin.lastUserMessageAt = previous.lastUserMessageAt;
    this.archiveOrigins.set(origin.agentId, origin); this.trim();
    await this.persist(); return { ...origin };
  }
  private persist(): Promise<void> {
    const serialized = JSON.stringify({ version: 2, receipts: [...this.receipts.values()], archiveOrigins: [...this.archiveOrigins.values()] });
    this.writes = this.writes.then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await ensurePrivateDirectory(this.directory);
        if (this.corrupt) { try { await rename(this.file, `${this.file}.backup`); } catch { /* missing previous file */ } this.corrupt = false; }
        await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, this.file); this.error = null;
      } catch { this.error = t("serverReadState.m003"); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    return this.writes;
  }
  async close() { await this.ready; await this.writes; }
}

let activeReadReceiptStore: ReadReceiptStore | null = null;
/** Call before a plugin-driven restore, including archives predating installation. */
export async function rememberArchiveReadOrigin(origin: ArchiveReadOrigin): Promise<ArchiveReadOrigin> {
  if (!activeReadReceiptStore) throw new Error(t("serverReadState.m004"));
  return activeReadReceiptStore.recordArchiveOrigin(origin);
}

export interface CompletionReadTransport { request(message: Record<string, unknown>, responseType: string): Promise<Record<string, unknown>> }
/**
 * What the plugin itself observed (server/telemetry.ts `TelemetryStore` is one): each Agent's latest turn, to verify the
 * completion a receipt names and the stop 知道了 is about, and the record of 知道了 on a stop. `turnStartedAt`: when that turn
 * began, which tells a heartbeat's turn from the one the host's attention stamp names (codex-obs-attn-F1); without it only a
 * newer prompt does.
 */
export interface ReadStateTelemetry {
  /** `persistenceError`: the store's own, set while its record may be incomplete (as the send's check reads it, server/send-ledger.ts). */
  snapshot(agentId: string): Promise<{ persistenceError?: string | null; agents: ReadonlyArray<Pick<AgentTelemetry, "agentId" | "outcome" | "turnEndedAt" | "stop"> & Partial<Pick<AgentTelemetry, "turnStartedAt">>> }>;
  ackStop(agentId: string, stopAt: string): Promise<boolean>;
}
/**
 * Whether the round a page names (待回复: the turn it saw start and end) is still the latest one the plugin observed: the same
 * instants, nothing observed matching nothing (codex-obs-attn-R2). A turn begun since, ended or not, is another round. A
 * round named by its start alone (a quick reply's rearm, codex-obs-attn-R4) is compared by its start.
 */
function sameRound(round: { startedAt: string | null; endedAt?: string | null }, observed: { turnStartedAt?: string | null; turnEndedAt: string | null } | null): boolean {
  const at = (value: string | null | undefined) => { const parsed = Date.parse(value ?? ""); return Number.isFinite(parsed) ? parsed : null; };
  return at(round.startedAt) === at(observed?.turnStartedAt) && (round.endedAt === undefined || at(round.endedAt) === at(observed?.turnEndedAt));
}
type ObservedTurn = Awaited<ReturnType<ReadStateTelemetry["snapshot"]>>["agents"][number];
export class CompletionReadController {
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, { token: string; promise: Promise<MarkCompletionReadResult> }>();
  private closed = false;
  constructor(private readonly store: ReadReceiptStore, private readonly transport: CompletionReadTransport, private readonly now: () => number = Date.now,
    private readonly telemetry?: ReadStateTelemetry) {}
  bump(agentId: string) {
    this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    if (this.generations.size > 4000) for (const id of this.generations.keys()) {
      if (!this.pending.has(id) && id !== agentId) { this.generations.delete(id); break; }
    }
  }
  async mark(paseo: PaseoApi, input: MarkCompletionReadInput): Promise<MarkCompletionReadResult> {
    const token = JSON.stringify([input.attentionTimestamp, input.lastUserMessageAt, input.kind ?? null, input.completionAt ?? null, input.stopAt ?? null, input.rearm === true, input.round ?? null]);
    const existing = this.pending.get(input.agentId);
    if (existing?.token === token) return existing.promise;
    if (existing) return { agentId: input.agentId, status: "stale", receipt: await this.store.get(input.agentId), message: t("serverReadState.m005") };
    const promise = this.perform(paseo, input).finally(() => this.pending.delete(input.agentId));
    this.pending.set(input.agentId, { token, promise }); return promise;
  }
  /**
   * The plugin's own record of this Agent's latest turn (`record`, null when it has none: never observed, or no telemetry here),
   * and the error its store reports, while that record may be incomplete.
   */
  private async observed(agentId: string): Promise<{ record: ObservedTurn | null; error: string | null }> {
    if (!this.telemetry) return { record: null, error: null };
    const snapshot = await this.telemetry.snapshot(agentId);
    return { record: snapshot.agents.find(item => item.agentId === agentId) ?? null, error: snapshot.persistenceError ?? null };
  }

  /**
   * The completion a receipt names. The host's attention is edge-triggered: a turn that ends while an older result is still
   * unread leaves that older stamp, so the page shows the newer, observed end as unread and sends it as `completionAt`
   * (codex-F5). The stamp names an earlier turn once the latest one began after it: a newer prompt, or a turn the plugin saw
   * start, as a heartbeat or another system notification starts one without a prompt (codex-obs-attn-F1). The receipt then
   * names exactly the end the plugin observed of that latest, completed turn (not in the future); a claim of anything else,
   * the older stamp included, is stale. While the stamp names the latest turn it is the token, as before. Older clients send
   * no claim; without telemetry nothing is verified.
   */
  private completionToken(input: MarkCompletionReadInput, native: string, observed: ObservedTurn | null): string | null {
    const claimed = input.completionAt;
    if (!claimed || !this.telemetry) return native;
    const prompt = Date.parse(input.lastUserMessageAt ?? ""), started = Date.parse(observed?.turnStartedAt ?? "");
    const since = Math.max(Number.isFinite(prompt) ? prompt : -Infinity, Number.isFinite(started) ? started : -Infinity);
    if (!(Date.parse(native) < since)) return native;
    const at = Date.parse(claimed);
    return at >= since && at <= this.now() && observed?.outcome === "completed" && observed.turnEndedAt !== null && Date.parse(observed.turnEndedAt) === at ? claimed : null;
  }

  private async perform(paseo: PaseoApi, input: MarkCompletionReadInput): Promise<MarkCompletionReadResult> {
    const { agentId } = input;
    const previous = await this.store.get(agentId);
    const result = (status: MarkCompletionReadResult["status"], message: string, receipt = previous): MarkCompletionReadResult => ({ agentId, status, receipt, message });
    if (this.closed) return result("failed", t("serverReadState.m006"));
    const generation = this.generations.get(agentId) ?? 0;
    const changed = () => this.closed || generation !== (this.generations.get(agentId) ?? 0);
    const error = input.kind === "error";
    // 知道了 on a stop names it; only the stop the plugin observed for this prompt can be acknowledged (opus-F34). Without
    // telemetry it is an ordinary 知道了 that clears native attention.
    const stopAt = error && this.telemetry ? input.stopAt ?? null : null;
    const quiet = (agent: Record<string, unknown>) => !agent.archivedAt && (error ? ["idle", "closed", "error"] : ["idle", "closed"]).includes(String(agent.status))
      && !agent.activeTurn && Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length === 0
      && agent.attentionReason !== "permission";
    const samePrompt = (agent: Record<string, unknown>) => (agent.lastUserMessageAt ?? null) === input.lastUserMessageAt;
    try {
      const handle = paseo.agents.ref(agentId), before = await handle.refresh();
      if (!before?.agent) return result("failed", t("serverReadState.m007"));
      const agent = object(before.agent);
      if (changed()) return result("stale", t("serverReadState.m008"));
      if (!quiet(agent) || !samePrompt(agent)) return result("stale", t("serverReadState.m009"));
      // A claim of the host's own stamp is checked too: a heartbeat may have run another turn since (codex-obs-attn-F1).
      const seen = stopAt !== null || input.completionAt || input.round ? await this.observed(agentId) : null, observed = seen?.record ?? null;
      if (stopAt !== null && observed?.stop?.at !== stopAt) return result("stale", t("serverReadState.m010"));
      // 待回复 names its round: a heartbeat's next round asks again under the same host tokens, and a page still on the earlier
      // question must not mark the new one read, here or in the receipt of a session the host has not loaded (codex-obs-attn-R2).
      // So does a quick reply's rearm, the round it answers (codex-obs-attn-R4). A round that cannot be checked here clears nothing:
      // no telemetry, or a store that reports an error, whose record may be behind (as the reply's own check, codex-obs-attn-R3-remaining).
      if (input.round && seen?.error) return result("failed", t("serverReadState.m011"));
      if (input.round && (!this.telemetry || !sameRound(input.round, observed))) return result("stale", t("serverReadState.m012"));
      if (agent.requiresAttention !== true || (error ? !["finished", "error"].includes(String(agent.attentionReason)) : agent.attentionReason !== "finished")) {
        // No native attention to clear: a turn the host closed mid-way raised none (and one opened in Paseo has none left).
        // 知道了 is then the plugin's own record on the stop, the only way such a stop is seen.
        if (stopAt === null) return result("not_unread", error ? t("serverReadState.m013") : t("serverReadState.m014"));
        if (changed()) return result("stale", t("serverReadState.m015"));
        return await this.telemetry!.ackStop(agentId, stopAt) ? result("read", t("serverReadState.m016"), previous) : result("stale", t("serverReadState.m017"));
      }
      if (agent.attentionTimestamp !== input.attentionTimestamp) return result("stale", t("serverReadState.m018"));
      // An Agent the host has not loaded: clearing its attention loads it (a provider process that then stays), and an ACP
      // Agent cannot be loaded again at all, so the request fails (P2-3, P2-4). Its token was checked above; the receipt here,
      // for that token or the newer completion it stands for, is what the page counts as read, and the host's flag goes when
      // the session is next loaded. A quick reply (`rearm`) loads the Agent to send anyway and clears it as before.
      const unloaded = agent.status === "closed" && input.rearm !== true;
      const receiptFor = (completionAt: string) => this.store.record({ agentId, completionAt, lastUserMessageAt: input.lastUserMessageAt, readAt: new Date(this.now()).toISOString() });
      if (unloaded && error) {
        if (changed()) return result("stale", t("serverReadState.m019"));
        if (stopAt !== null && !await this.telemetry!.ackStop(agentId, stopAt)) return result("stale", t("serverReadState.m020"));
        // 知道了 as clearing would have made it: a failure's token says it was seen; a finished turn's result is seen with its
        // stop (that token, or the newer completion it stands for when the server can verify it).
        const token = agent.attentionReason === "finished" ? this.completionToken(input, input.attentionTimestamp!, observed) : input.attentionTimestamp!;
        const receipt = token ? await receiptFor(token).catch(() => previous) : previous;
        return result("read", t("serverReadState.m021"), receipt);
      }
      const completionAt = error ? null : this.completionToken(input, input.attentionTimestamp!, observed);
      if (!error && completionAt === null) return result("stale", t("serverReadState.m022"));
      if (unloaded) {
        if (changed()) return result("stale", t("serverReadState.m023"));
        return result("read", t("serverReadState.m024"), await receiptFor(completionAt!));
      }
      // The native RPC (still in 0.9) has no compare-and-swap token. Exact preconditions,
      // lifecycle generations and postchecks detect races; never claim atomicity.
      const response = await this.transport.request({ type: "clear_agent_attention", agentId }, "clear_agent_attention_response");
      if (response.agentId !== agentId || !Array.isArray(response.agents)) return result("failed", t("serverReadState.m025"));
      const acknowledged = response.agents.map(object).find(agent => agent.id === agentId);
      if (!acknowledged || changed() || !quiet(acknowledged) || !samePrompt(acknowledged) || acknowledged.requiresAttention !== false)
        return result("stale", t("serverReadState.m026"));
      const after = await handle.refresh();
      const confirmed = object(after?.agent);
      if (!after?.agent || changed() || !quiet(confirmed) || !samePrompt(confirmed) || confirmed.requiresAttention !== false)
        return result("stale", t("serverReadState.m027"));
      if (error) {
        // The same record as without native attention, so a stop seen here stays seen whichever way it was seen.
        if (stopAt !== null) await this.telemetry?.ackStop(agentId, stopAt).catch(() => false);
        return result("read", t("serverReadState.m028"), previous);
      }
      return result("read", t("serverReadState.m029"), await receiptFor(completionAt!));
    } catch (error) {
      return result("failed", t("serverReadState.m030", { value1: error instanceof Error ? error.message.replaceAll(t("serverReadState.m031"), t("serverReadState.m032")) : t("serverReadState.m033") }));
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()].map(entry => entry.promise)); await this.store.close(); }
}

/**
 * `telemetry`: the plugin's own observations (pass the `TelemetryStore`). Without it a stop the host raised no attention for
 * cannot be acknowledged, and a receipt always names the host's attention stamp.
 */
export function registerReadState(server: PluginServerContext, bridge: Pick<ProviderBridge, "request">, telemetry?: ReadStateTelemetry) {
  const store = new ReadReceiptStore();
  activeReadReceiptStore = store;
  const controller = new CompletionReadController(store, bridge, Date.now, telemetry);
  server.handle(getReadReceipts, ({ revision }) => store.read(revision));
  server.handle(markCompletionRead, (input, { paseo }) => controller.mark(paseo, input));
  const removers = [
    server.on("agent.turn_started", ({ agent }) => controller.bump(agent.id)),
    server.on("agent.turn_ended", ({ agent }) => controller.bump(agent.id)),
    server.on("agent.permission_requested", ({ agent }) => controller.bump(agent.id)),
    server.on("agent.permission_resolved", ({ agent }) => controller.bump(agent.id)),
    server.on("agent.archived", async ({ agent, archivedAt }) => { controller.bump(agent.id); await store.recordArchiveOrigin({ agentId: agent.id, archivedAt, lastUserMessageAt: null }); }),
  ];
  return { store, async close() { removers.forEach(remove => remove()); await controller.close(); if (activeReadReceiptStore === store) activeReadReceiptStore = null; } };
}
