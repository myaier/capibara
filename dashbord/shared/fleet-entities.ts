import { hostEntityId, parseHostEntityId } from "./fleet-scope";
import type { AgentRecord } from "./model";

export function fleetAgent(host: { serverId: string; label: string; status?: string }, agent: AgentRecord): AgentRecord {
  const q = (id: string) => hostEntityId(host.serverId, id);
  return { ...agent, id: q(agent.id), hostId: host.serverId, hostLabel: host.label, hostOnline: host.status === undefined || host.status === "online",
    parentAgentId: agent.parentAgentId ? q(agent.parentAgentId) : null,
    workspaceId: agent.workspaceId ? q(agent.workspaceId) : null,
    projectId: q(agent.projectId || agent.projectRootPath || agent.projectName),
    labels: Object.fromEntries(Object.entries(agent.labels).map(([key, value]) => [key,
      ["paseo.schedule-run", "paseo.schedule-id"].includes(key) && value ? q(value) : value])) };
}

const references = new Set(["agentId", "parentAgentId", "targetAgentId", "sourceAgentId", "restoredAgentId", "workspaceId", "projectId", "runId", "jobId", "lastJobId", "scheduleId", "heartbeatId"]);
const referenceLists = new Set(["agentIds", "workspaceIds", "projectIds", "targets", "handledIds"]);
const entityContainers = new Set(["jobs", "job", "history", "suggestions", "suggestionJob", "runs", "run", "schedules", "schedule", "workspace", "events", "usage"]);
const opaque = new Set(["arguments", "input", "raw", "labels", "params", "toolInput", "toolOutput"]);
/** Structural references only. Provider IDs, permission IDs, evidence anchors and message/tool contents stay native. */
export function qualifyFleetResult<T>(value: T, hostId: string, container = ""): T {
  const q = (id: string) => parseHostEntityId(id) ? id : hostEntityId(hostId, id);
  if (Array.isArray(value)) return value.map(item => qualifyFleetResult(item, hostId, container)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    typeof child === "string" && child && (references.has(key) || key === "id" && entityContainers.has(container)) ? q(child)
      : referenceLists.has(key) && Array.isArray(child) ? child.map(id => typeof id === "string" ? q(id) : id)
      : opaque.has(key) ? child : qualifyFleetResult(child, hostId, key)])) as T;
}
