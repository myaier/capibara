import type { AgentSource } from "./model";

export function activitySignature(source: AgentSource): string {
  const pending = source.pendingPermissionCount ?? source.pendingPermissions?.length ?? 0;
  return [source.status, source.requiresAttention === true, source.attentionReason ?? "", source.attentionTimestamp ?? "", pending, source.lastUserMessageAt ?? "", source.archivedAt ?? "", source.activeTurn?.startedAt ?? ""].join("|");
}
