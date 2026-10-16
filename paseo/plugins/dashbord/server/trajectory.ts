import { t } from "../shared/text";
import type { PaseoApi } from "./paseo-types";
import type { SessionTrajectory, TrajectoryRow } from "../shared/trajectory";
import { normalizeTimelinePage, object, projectTimelineRows, string, type TimelineCursor, type TimelineRow } from "../shared/timeline";
import { excerptText } from "../shared/evidence";
import { isCredentialField, redactSecrets } from "./redaction";

export interface TrajectoryOptions { limit?: number; maxCharacters?: number; signal?: AbortSignal; after?: TimelineCursor }
/** Stop logical work immediately even when a host RPC cannot cancel its wire read. */
export function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const canceled = () => { cleanup(); reject(Object.assign(new Error(t("serverTrajectory.m001")), { name: "AbortError" })); };
    const cleanup = () => signal.removeEventListener("abort", canceled);
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) canceled(); else signal.addEventListener("abort", canceled, { once: true });
  });
}
const textOrNull = (value: unknown): string | null => string(value) || null;
function dateOrNull(value: unknown): string | null {
  const text = string(value); return text && Number.isFinite(Date.parse(text)) ? text : null;
}
/**
 * Summarize tool intent/result, not entire embedded source files and SDK payloads. Everything is masked before it is cut: each
 * string whole (redactSecrets), every string under a credential field name whole whatever it looks like (`AWS_SESSION_TOKEN`,
 * `password`), and the JSON of a structured value once more. A cut could part a value from its key, prefix or header, and JSON
 * escaping hides a value from the patterns.
 */
export function summarizeTrajectoryRow(row: TimelineRow): { text: string; truncated: boolean } {
  const item = row.item;
  if (typeof item.text === "string") return excerptText(redactSecrets(item.text), item.type === "reasoning" ? 1500 : 6000);
  if (typeof item.message === "string") return excerptText(redactSecrets(item.message), 6000);
  let truncated = false;
  const compact = (value: unknown, depth = 0, secret = false): unknown => {
    if (typeof value === "string") { const excerpt = excerptText(secret && value ? "[redacted]" : redactSecrets(value), 700); truncated ||= excerpt.truncated; return excerpt.text; }
    if (depth > 3) { truncated = true; return t("serverTrajectory.m002"); }
    if (Array.isArray(value)) { truncated ||= value.length > 8; return value.slice(0, 8).map(entry => compact(entry, depth + 1, secret)); }
    if (value && typeof value === "object") { const entries = Object.entries(value); truncated ||= entries.length > 15; return Object.fromEntries(entries.slice(0, 15).map(([key, entry]) => [key, compact(entry, depth + 1, secret || isCredentialField(key))])); }
    return value;
  };
  const lines: string[] = [];
  const add = (label: string, value: unknown, limit = 1200) => {
    if (value === undefined || value === null || value === "") return;
    const raw = redactSecrets(typeof value === "string" ? value : JSON.stringify(compact(value)) ?? "");
    const excerpt = excerptText(raw, limit); truncated ||= excerpt.truncated;
    lines.push(`${label}: ${excerpt.text}`);
  };
  if (item.type === "tool_call") {
    const detail = object(item.detail);
    add("tool", item.name, 180); add("status", item.status, 30); add("kind", detail.type, 40);
    add("command", detail.command, 1400); add("cwd", detail.cwd, 300); add("file", detail.filePath, 400);
    add("query", detail.query, 600); add("url", detail.url, 400); add("task", detail.description, 600);
    add("exitCode", detail.exitCode, 40);
    add("error", item.error, 1200);
    const input = detail.input ?? item.input ?? item.arguments;
    if (input !== undefined && !detail.command) add("input", input, 1200);
    const found = detail.output ?? detail.result ?? detail.log ?? detail.content ?? detail.text, output = typeof found === "string" ? redactSecrets(found) : found;
    add("output", output, item.status === "failed" || item.error ? 2800 : 2000);
    if (typeof output === "string" && output.length > 2000) {
      const signals: string[] = [];
      for (const match of output.matchAll(/^.*(?:error|failed|exception|traceback|assertion|permission denied|timed?\s*out|exit code|失败|错误|拒绝).*$/gmi)) { // i18n-ignore: Match original Chinese provider/user text; this is parser data.
        signals.push(match[0].slice(0, 220)); if (signals.length >= 5) break;
      }
      add("errorSignals", signals.join("\n"), 1100);
    }
    add("diff", detail.unifiedDiff, 800);
    if (detail.oldString !== undefined || detail.newString !== undefined) add("edit", { old: detail.oldString, next: detail.newString }, 800);
    if (!lines.length) add("data", item, 3000);
  } else add(item.type, item.type === "todo" ? item.items : item.data ?? item, 5000);
  const summary = excerptText(lines.join("\n"), 6000);
  return { text: summary.text, truncated: truncated || summary.truncated };
}
function mergePageRows(existing: TimelineRow[], incoming: TimelineRow[]): TimelineRow[] {
  const byKey = new Map(existing.map(row => [row.key, row]));
  for (const row of incoming) {
    const previous = byKey.get(row.key);
    if (!previous) byKey.set(row.key, row);
    else if (row.item.type === "tool_call") byKey.set(row.key, projectTimelineRows([previous, row])[0]);
    else if (row.seqEnd > previous.seqEnd) byKey.set(row.key, row);
  }
  return projectTimelineRows([...byKey.values()].sort((a, b) => a.seqStart - b.seqStart || a.seqEnd - b.seqEnd));
}
/** Read-only, bounded source acquisition shared by evidence and model analysis. */
export async function fetchTrajectory(paseo: PaseoApi, agentId: string, options: TrajectoryOptions = {}): Promise<SessionTrajectory> {
  if (options.signal?.aborted) throw Object.assign(new Error(t("serverTrajectory.m003")), { name: "AbortError" });
  const limit = Math.max(1, Math.min(1500, Math.floor(options.limit ?? 1500)));
  const maxCharacters = Math.max(1000, Math.min(400000, Math.floor(options.maxCharacters ?? 400000)));
  const handle = paseo.agents.ref(agentId);
  const initial = await abortable(handle.refresh(), options.signal);
  if (!initial?.agent) throw new Error(t("serverTrajectory.m004"));
  let source = object(initial.agent);
  let rows: TimelineRow[] = [];
  let epoch = "";
  let cursor: TimelineCursor | undefined = options.after;
  let direction: "after" | "before" = options.after ? "after" : "before";
  let hasOlder = false, hasNewer = false, gap = false, truncated = false;
  let pages = 0, resetCount = 0;
  let coveredEndSeq: number | undefined;
  const reasons: string[] = [];
  const visited = new Set<string>();
  for (;;) {
    let payload: unknown;
    try {
      if (options.signal?.aborted) throw Object.assign(new Error(t("serverTrajectory.m005")), { name: "AbortError" });
      payload = await abortable(handle.timeline.refetch({ direction: cursor ? direction : "tail",
        ...(cursor ? { cursor } : {}), projection: "projected", limit: Math.min(150, limit) }), options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!rows.length) throw error;
      reasons.push(t("serverTrajectory.m006", { value1: error instanceof Error ? error.message : t("serverTrajectory.m007") }));
      truncated = true; hasOlder = true; break;
    }
    const page = normalizeTimelinePage(payload);
    pages++;
    if (direction === "after" && (page.reset || options.after?.epoch !== page.epoch)) { direction = "before"; rows = []; visited.clear(); cursor = undefined; }
    if (epoch && page.epoch !== epoch) {
      rows = []; visited.clear(); resetCount++;
      if (resetCount > 1) { reasons.push(t("serverTrajectory.m008")); truncated = true; break; }
    }
    epoch = page.epoch;
    const compactRows = projectTimelineRows(page.rows).map(row => {
      const summary = summarizeTrajectoryRow(row); truncated ||= summary.truncated;
      const item = row.item;
      // Keep only bounded evidence while walking older pages, not megabytes of
      // nested source-code strings inside each original tool payload.
      return { ...row, item: { type: item.type, text: summary.text,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.callId !== undefined ? { callId: item.callId } : {}),
        ...(item.status !== undefined ? { status: item.status } : {}),
        ...(item.messageId !== undefined ? { messageId: item.messageId } : {}) } };
    });
    rows = mergePageRows(rows, compactRows);
    hasOlder = page.hasOlder;
    // Older pages naturally report hasNewer. The first tail establishes coverage
    // of the current end; later before pages do not imply a missing newer range.
    if (pages === 1 || page.reset || direction === "after") { hasNewer = page.hasNewer; coveredEndSeq = page.endCursor?.seq ?? coveredEndSeq; }
    gap ||= page.gap;
    truncated ||= page.truncated;
    if (rows.length >= limit) { if (rows.length > limit) { rows = rows.slice(-limit); hasOlder = true; } if (hasOlder) reasons.push(t("serverTrajectory.m009")); break; }
    const nextCursor = direction === "after" ? page.endCursor : page.startCursor;
    if (!(direction === "after" ? hasNewer : hasOlder) || !nextCursor || !page.rows.length) break;
    const nextKey = `${nextCursor.epoch}:${nextCursor.seq}`;
    const stalled = cursor && cursor.epoch === nextCursor.epoch && (direction === "after" ? nextCursor.seq <= cursor.seq : nextCursor.seq >= cursor.seq);
    if (visited.has(nextKey) || stalled && !page.reset) {
      reasons.push(t("serverTrajectory.m010")); truncated = true; break;
    }
    visited.add(nextKey); cursor = nextCursor;
    if (pages >= 20) { reasons.push(t("serverTrajectory.m011")); truncated = true; break; }
  }
  // Read across the available turns before allocating a fair content budget.
  // A huge recent shell script must not crowd earlier user instructions out.
  const evidence: TrajectoryRow[] = [];
  let characters = 0;
  const summaries = rows.map(summarizeTrajectoryRow);
  const weights = rows.map(row => row.item.type === "user_message" || row.item.type === "error" || row.item.status === "failed" ? 3 : row.item.type === "reasoning" ? 0.6 : 1.5);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const quotas = summaries.map((summary, index) => Math.min(summary.text.length, Math.floor(maxCharacters * weights[index] / weightTotal)));
  let spare = maxCharacters - quotas.reduce((sum, value) => sum + value, 0);
  const priority = rows.map((_, index) => index).sort((a, b) => weights[b] - weights[a] || b - a);
  for (const index of priority) { const extra = Math.min(spare, summaries[index].text.length - quotas[index]); quotas[index] += extra; spare -= extra; }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], summary = summaries[index], excerpt = excerptText(summary.text, quotas[index]);
    const text = excerpt.text;
    truncated ||= summary.truncated || excerpt.truncated;
    characters += text.length;
    evidence.push({ ref: `${agentId}:${row.epoch}:${row.seqStart}-${row.seqEnd}`, epoch: row.epoch,
      seqStart: row.seqStart, seqEnd: row.seqEnd, at: dateOrNull(row.timestamp), turnId: row.turnId ?? null,
      kind: row.item.type, text, toolName: row.item.type === "tool_call" ? textOrNull(row.item.name) : null,
      toolStatus: row.item.type === "tool_call" ? textOrNull(row.item.status) : null });
  }
  if (gap) reasons.push(t("serverTrajectory.m012"));
  if (hasOlder && !reasons.length) reasons.push(t("serverTrajectory.m013"));
  if (truncated && !reasons.length) reasons.push(t("serverTrajectory.m014"));
  source = object(handle.current?.() ?? initial.agent);
  const placement = object(initial.project), checkout = object(placement.checkout);
  const projectId = string(placement.projectKey);
  const attentionAt = dateOrNull(source.attentionTimestamp);
  const latestPromptAt = dateOrNull(source.lastUserMessageAt);
  const currentCompletion = source.attentionReason === "finished" && source.status !== "running" && !source.activeTurn
    && (!attentionAt || !latestPromptAt || Date.parse(attentionAt) >= Date.parse(latestPromptAt));
  return {
    agent: { id: agentId, title: string(source.title) || agentId, provider: string(source.provider), model: textOrNull(source.model),
      cwd: textOrNull(source.cwd), workspaceId: textOrNull(source.workspaceId), archivedAt: dateOrNull(source.archivedAt),
      status: string(source.status), attentionReason: textOrNull(source.attentionReason) },
    project: projectId ? { id: projectId, name: string(placement.projectName) || projectId,
      rootPath: textOrNull(checkout.mainRepoRoot) || textOrNull(checkout.repoRoot) || textOrNull(checkout.rootPath)
        || textOrNull(checkout.worktreeRoot) || textOrNull(checkout.cwd) } : null,
    capturedAt: new Date().toISOString(), rows: evidence,
    coverage: { complete: !hasOlder && !hasNewer && !gap && !truncated, hasOlder, hasNewer, gap, truncated,
      reason: reasons.length ? [...new Set(reasons)].join(t("serverTrajectory.m015")) : null, projectedItems: evidence.length, characters, pages,
      firstAt: evidence.find(row => row.at)?.at ?? null, lastAt: [...evidence].reverse().find(row => row.at)?.at ?? null, epoch, endSeq: coveredEndSeq },
    counts: { userTurns: evidence.filter(row => row.kind === "user_message").length,
      assistantMessages: evidence.filter(row => row.kind === "assistant_message").length,
      tools: evidence.filter(row => row.kind === "tool_call").length,
      toolFailures: evidence.filter(row => row.kind === "tool_call" && row.toolStatus === "failed").length,
      errors: evidence.filter(row => row.kind === "error").length,
      observedTurnIds: new Set(evidence.map(row => row.turnId).filter(Boolean)).size },
    completionEvidence: { kind: currentCompletion ? "attention_finished" : "none", at: currentCompletion ? attentionAt : null },
  };
}
