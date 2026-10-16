import { t } from "../shared/text";
import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ProviderSubagentSchema, providerSubagentsRpc, providerTimelineRpc } from "../shared/provider-subagents";
import { normalizeTimelinePage, projectTimelineRows, string } from "../shared/timeline";

/**
 * Raw session requests PaseoApi 0.9 still lacks (provider subagents, workspace recovery, refresh,
 * clear attention). They ride the plugin's existing IPC session as `paseo_frame` envelopes; no
 * second connection is opened. After the host closes that session (e.g. an expired heartbeat
 * lease), frames are dropped until the SDK re-attaches, so in-flight requests fail at once and new
 * ones wait for the re-attached session's first frame instead of timing out.
 */
export interface ProviderIpcPort {
  send(message: unknown): void;
  listen(listener: (message: unknown) => void): () => void;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, unknown> : {};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const REQUEST_PREFIX = "observatory-read-";
/** Requests in flight, and those held while the host session is closed (a separate, smaller cap). */
const MAX_PENDING = 24, MAX_WAITING = 16;
export type ProviderBridge = ReturnType<typeof createProviderSubagentBridge>;
export function createProviderSubagentBridge(port: ProviderIpcPort, timeoutMs = 8000) {
  const pending = new Map<string, { type: string; resolve(value: Record<string, unknown>): void;
    reject(error: Error): void; timer: ReturnType<typeof setTimeout>; sent: boolean }>();
  /** Sends held until the session re-attaches, by request id: a timeout removes its own entry. */
  const waiting = new Map<string, () => void>();
  let disposed = false, hostOpen = true;
  const unsubscribe = port.listen((raw) => {
    const envelope = record(raw);
    if (envelope.type === "paseo_close") {
      hostOpen = false;
      for (const [id, item] of pending) if (item.sent) { pending.delete(id); clearTimeout(item.timer); item.reject(new Error(t("serverProviderSubagents.m001"))); }
      return;
    }
    if (envelope.type !== "paseo_frame" || envelope.isBinary !== false || typeof envelope.data !== "string") return;
    if (!hostOpen) { hostOpen = true; const held = [...waiting.values()]; waiting.clear(); for (const send of held) send(); }
    // The plugin's own SDK connection shares this channel; skip parsing its (often large) frames.
    if (!envelope.data.includes(REQUEST_PREFIX)) return;
    let parsed: Record<string, unknown>;
    try { parsed = record(JSON.parse(envelope.data)); } catch { return; }
    const message = parsed.type === "session" ? record(parsed.message) : parsed;
    const payload = record(message.payload);
    const id = typeof payload.requestId === "string" ? payload.requestId : "";
    const request = pending.get(id);
    if (!request || (message.type !== request.type && message.type !== "rpc_error")) return;
    pending.delete(id); clearTimeout(request.timer);
    if (payload.error || message.type === "rpc_error") request.reject(new Error(errorText(payload.error || t("serverProviderSubagents.m002"))));
    else request.resolve(payload);
  });
  /** `timeout` overrides the bridge's default for slow requests (a session restore). */
  const request = (message: Record<string, unknown>, responseType: string, timeout = timeoutMs): Promise<Record<string, unknown>> => {
    if (disposed) return Promise.reject(new Error(t("serverProviderSubagents.m003")));
    if (pending.size >= MAX_PENDING || (!hostOpen && waiting.size >= MAX_WAITING)) return Promise.reject(new Error(t("serverProviderSubagents.m004")));
    return new Promise((resolve, reject) => {
      const requestId = `${REQUEST_PREFIX}${randomUUID()}`;
      const timer = setTimeout(() => { pending.delete(requestId); waiting.delete(requestId); reject(new Error(t("serverProviderSubagents.m005"))); }, timeout);
      const entry = { type: responseType, resolve, reject, timer, sent: false };
      pending.set(requestId, entry);
      const send = () => {
        if (pending.get(requestId) !== entry) return;
        try { port.send({ type: "paseo_frame", data: JSON.stringify({ type: "session", message: { ...message, requestId } }), isBinary: false }); entry.sent = true; }
        catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
      };
      if (hostOpen) send(); else waiting.set(requestId, send);
    });
  };
  return { request, /** Requests held for a closed session (tests). */ get queued() { return waiting.size; },
    dispose() { if (disposed) return; disposed = true; unsubscribe(); waiting.clear();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(t("serverProviderSubagents.m006"))); }
    pending.clear(); } };
}
interface ContentBudget { characters: number; nodes: number; truncated: boolean }
/** A shared payload budget also bounds wide/nested tool outputs on mobile. */
function boundedData(value: unknown, budget: ContentBudget, depth = 0): unknown {
  if (depth > 8 || budget.characters <= 0 || --budget.nodes <= 0) { budget.truncated = true; return t("serverProviderSubagents.m007"); }
  if (typeof value === "string") {
    const limit = Math.min(24000, budget.characters); const result = value.slice(0, limit);
    budget.characters -= result.length;
    if (result.length < value.length) { budget.truncated = true; return t("serverProviderSubagents.m008", { result: result }); }
    return result;
  }
  if (Array.isArray(value)) { if (value.length > 200) budget.truncated = true; return value.slice(0, 200).map(item => boundedData(item, budget, depth + 1)); }
  if (value && typeof value === "object") {
    const entries = Object.entries(value); if (entries.length > 80) budget.truncated = true;
    return Object.fromEntries(entries.slice(0, 80).map(([key, item]) => [key.slice(0, 120), boundedData(item, budget, depth + 1)]));
  }
  return value;
}
export function boundProviderTimeline(payload: Record<string, unknown>): Record<string, unknown> {
  const budget: ContentBudget = { characters: 180000, nodes: 10000, truncated: false };
  // Paseo 0.8 limits projected *items*, but returns every canonical token row
  // covering those items. Project before limiting: slicing raw rows takes an old
  // prefix and can hide the latest twenty minutes of a live child conversation.
  const normalized = normalizeTimelinePage(payload);
  const projected = projectTimelineRows(normalized.rows);
  const direction = payload.reset === true ? "tail" : payload.direction;
  const cut = projected.length > 150;
  const selected = direction === "after" ? projected.slice(0, 150) : projected.slice(-150);
  const rows = new Array<Record<string, unknown>>(selected.length);
  // Prefer recent output when a large historical tool result exhausts the budget.
  const indexes = selected.map((_, index) => index);
  if (direction !== "after") indexes.reverse();
  for (const index of indexes) {
    const row = selected[index], item = row.item;
    const limited: Record<string, unknown> & { type: string } = { ...record(boundedData(item, budget)), type: item.type };
    if (item.type === "tool_call") {
      Object.assign(limited, { callId: string(item.callId).slice(0, 512), name: string(item.name).slice(0, 240), status: item.status });
      const detail = record(item.detail);
      if (!limited.detail || typeof limited.detail !== "object") {
        limited.detail = { type: string(detail.type) || "unknown", command: string(detail.command).slice(0, 320),
          filePath: string(detail.filePath).slice(0, 512), description: string(detail.description).slice(0, 320),
          output: t("serverProviderSubagents.m009") };
      }
    } else if (typeof item.text === "string" && typeof limited.text !== "string") {
      limited.text = t("serverProviderSubagents.m010");
    }
    rows[index] = { seq: row.seqEnd, seqStart: row.seqStart, seqEnd: row.seqEnd,
      sourceSeqRanges: row.sourceRanges ?? [{ startSeq: row.seqStart, endSeq: row.seqEnd }],
      timestamp: row.timestamp, turnId: row.turnId, providerMessageId: row.providerMessageId, item: limited };
  }
  const { rows: _rawRows, entries: _rawEntries, ...metadata } = payload;
  const firstSeq = selected.length ? Math.min(...selected.map(row => row.seqStart)) : undefined;
  const lastSeq = selected.length ? Math.max(...selected.map(row => row.seqEnd)) : undefined;
  return { ...metadata, rows, projection: "projected",
    startCursor: cut && direction !== "after" && firstSeq !== undefined ? { epoch: normalized.epoch, seq: firstSeq } : normalized.startCursor,
    endCursor: cut && direction === "after" && lastSeq !== undefined ? { epoch: normalized.epoch, seq: lastSeq } : normalized.endCursor,
    hasOlder: normalized.hasOlder || cut && direction !== "after", hasNewer: normalized.hasNewer || cut && direction === "after",
    truncated: budget.truncated || cut || normalized.truncated };
}
/**
 * The plugin process's one bridge to its host session. Every module that needs a raw session request shares it, so each IPC
 * frame is inspected by one listener (four used to parse every frame four times).
 */
export function createProcessBridge(): ProviderBridge {
  return createProviderSubagentBridge({
    send(message) { if (!process.send) throw new Error(t("serverProviderSubagents.m011")); process.send(message); },
    listen(listener) { process.on("message", listener); return () => process.off("message", listener); },
  });
}
export function registerProviderSubagents(server: PluginServerContext, bridge: Pick<ProviderBridge, "request">): void {
  server.handle(providerSubagentsRpc, async ({ parentAgentId }) => {
    try {
      const payload = await bridge.request({ type: "agent.provider_subagents.list.request", parentAgentId }, "agent.provider_subagents.list.response");
      if (!Array.isArray(payload.subagents)) throw new Error(t("serverProviderSubagents.m012"));
      const summaries = payload.subagents.slice(0, 500).map(value => {
        const row = record(value);
        return { ...row, title: typeof row.title === "string" ? row.title.slice(0, 240) : row.title,
          description: typeof row.description === "string" ? row.description.slice(0, 1200) : row.description,
          subtitle: typeof row.subtitle === "string" ? row.subtitle.slice(0, 400) : row.subtitle,
          cwd: typeof row.cwd === "string" ? row.cwd.slice(0, 1024) : row.cwd };
      });
      const parsed = ProviderSubagentSchema.array().safeParse(summaries);
      if (!parsed.success) throw new Error(t("serverProviderSubagents.m013"));
      return { subagents: parsed.data, error: null, truncated: payload.subagents.length > 500 };
    } catch (error) { return { subagents: [], error: errorText(error), truncated: false }; }
  });
  server.handle(providerTimelineRpc, async (input) => {
    try {
      const payload = await bridge.request({ type: "agent.provider_subagents.timeline.get.request", ...input }, "agent.provider_subagents.timeline.get.response");
      if (!Array.isArray(payload.rows) && !Array.isArray(payload.entries)) throw new Error(t("serverProviderSubagents.m014"));
      return { page: boundProviderTimeline(payload), error: null };
    } catch (error) { return { page: null, error: errorText(error) }; }
  });
}
