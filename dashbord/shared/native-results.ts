import { t } from "./text";
import type { AgentResult, ResultExcerpt } from "./results";
import type { ProviderSubagent } from "./provider-subagents";
import { normalizeTimelinePage, object, projectTimelineRows, string, type TimelinePage, type TimelineRow } from "./timeline";
import { excerptText } from "./evidence";

/** Native children expose their own history, not the parent's task or read state. */
export function nativeChildResult(parentId: string, child: ProviderSubagent, tail: TimelinePage | null, headRaw: unknown): AgentResult {
  const agentId = `provider:${parentId}:${child.id}`;
  const rows = projectTimelineRows(tail?.rows ?? []), head = normalizeTimelinePage(headRaw);
  const sameEpoch = !!tail && head.epoch === tail.epoch;
  const headRows = sameEpoch ? projectTimelineRows(head.rows) : [];
  const sourceWindow = object(object(headRaw).window);
  const firstRow = headRows[0];
  const originKnown = typeof sourceWindow.minSeq === "number" && sourceWindow.minSeq <= 1 && !!firstRow && firstRow.seqStart <= 1;
  const first = originKnown ? headRows.find(row => row.item.type === "user_message") : undefined;
  const lastUserIndex = rows.findLastIndex(row => row.item.type === "user_message");
  const lastUser = lastUserIndex >= 0 ? rows[lastUserIndex] : undefined;
  const latest = rows.slice(lastUserIndex + 1).findLast(row => row.item.type === "assistant_message" && string(row.item.text).trim());
  const excerpt = (row: TimelineRow | undefined): ResultExcerpt | null => {
    if (!row) return null;
    const text = excerptText(string(row.item.text), 60000);
    return { text: text.text, truncated: text.truncated || /内容已截断|超出当前页容量|中段已摘要/.test(text.text), // i18n-ignore: Match original Chinese provider/user text; this is parser data.
      ref: `${agentId}:${row.epoch}:${row.seqStart}-${row.seqEnd}`, at: row.timestamp || null };
  };
  const firstInput = excerpt(first), latestReply = excerpt(latest);
  const artifacts: AgentResult["artifacts"] = [];
  for (const row of rows) {
    const detail = object(row.item.detail), path = string(detail.filePath);
    if (row.item.type === "tool_call" && path && ["write", "edit"].includes(string(detail.type)) && !artifacts.some(item => item.path === path)) artifacts.push({ kind: "file", label: path.split(/[\\/]/).pop()!.slice(0, 500), path: path.slice(0, 2000), ref: `${agentId}:${row.epoch}:${row.seqStart}-${row.seqEnd}` });
    if (artifacts.length >= 40) break;
  }
  const firstInputConfirmed = !!firstInput && originKnown && sameEpoch;
  return { agentId, capturedAt: new Date().toISOString(), epoch: tail?.epoch ?? head.epoch,
    firstInput: firstInput ? { ...firstInput, completeOrigin: true } : null,
    latestUserInput: excerpt(lastUser), latestReply,
    isRunning: child.status === "running", isFinal: child.status === "completed" && !!latestReply,
    artifacts, testEvidence: [], metrics: { tools: rows.filter(row => row.item.type === "tool_call").length,
      failedTools: rows.filter(row => row.item.type === "tool_call" && row.item.status === "failed").length,
      changedFiles: artifacts.length, userTurns: rows.filter(row => row.item.type === "user_message").length },
    coverage: { firstInputConfirmed, truncated: !!tail?.truncated || head.truncated || !!latestReply?.truncated || !!firstInput?.truncated || !firstInputConfirmed,
      rows: rows.length, hasOlder: tail?.hasOlder ?? false, reason: firstInputConfirmed ? null : t("sharedNativeResults.m001") } };
}
