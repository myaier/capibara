import { z } from "zod";

const ids = z.array(z.string().min(1).max(2048)).max(2000);
export const fleetFiltersSchema = z.object({
  projects: ids.default([]), providers: ids.default([]), models: ids.default([]),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
});
/** A fleet always means every connected installation; there is deliberately no host selector. */
export const fleetScopeSchema = fleetFiltersSchema.strict();
export type FleetFilters = z.infer<typeof fleetFiltersSchema>;
export type FleetScope = z.infer<typeof fleetScopeSchema>;
export const emptyFleetScope = (): FleetScope => ({ projects: [], providers: [], models: [] });
const unique = (values: readonly string[]) => [...new Set(values)].sort();

export function normalizeFleetScope(value: Partial<FleetScope>): FleetScope {
  const scope = fleetScopeSchema.parse(value);
  if (scope.from && scope.to && Date.parse(scope.from) > Date.parse(scope.to)) throw new Error("Invalid observation time range");
  return { ...scope, projects: unique(scope.projects), providers: unique(scope.providers), models: unique(scope.models) };
}

/** Stable keys include all selected filters and the caller's device clock; array ordering does not change a scope. */
export function fleetScopeKey(scope: FleetScope, clock: { timeZone?: string; utcOffsetMinutes?: number } = {}): string {
  return JSON.stringify([normalizeFleetScope(scope), clock.timeZone ?? null, clock.utcOffsetMinutes ?? null]);
}

const entityPrefix = "~h:";
export interface HostEntityRef { hostId: string; id: string }
export function hostEntityId(hostId: string, id: string): string {
  if (!hostId || !id) throw new Error("Host and entity IDs must be present");
  return `${entityPrefix}${encodeURIComponent(hostId)}:${encodeURIComponent(id)}`;
}
export function parseHostEntityId(value: string): HostEntityRef | null {
  if (!value.startsWith(entityPrefix)) return null;
  const split = value.indexOf(":", entityPrefix.length);
  try {
    if (split < 0) throw new Error();
    const hostId = decodeURIComponent(value.slice(entityPrefix.length, split)), id = decodeURIComponent(value.slice(split + 1));
    if (!hostId || !id || hostEntityId(hostId, id) !== value) throw new Error();
    return { hostId, id };
  } catch { throw new Error("Invalid host-qualified entity ID"); }
}
export const nativeEntityId = (value: string) => parseHostEntityId(value)?.id ?? value;

/** Resolve only structural ID fields. Message bodies, tool arguments, paths and arbitrary strings are untouched. */
const referenceFields = new Set(["agentId", "parentAgentId", "targetAgentId", "sourceAgentId", "workspaceId", "projectId", "runId", "jobId", "scheduleId", "heartbeatId"]);
const referenceLists = new Set(["agentIds", "workspaceIds", "projectIds", "runIds", "jobIds", "scheduleIds", "heartbeatIds"]);
export function routeEntityInput<T extends Record<string, unknown>>(input: T, fallbackHost?: string): { hostId: string; input: T } {
  const hosts = new Set<string>();
  let unqualified = false;
  const unwrap = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const ref = parseHostEntityId(value);
    if (ref) { hosts.add(ref.hostId); return ref.id; }
    unqualified = true;
    return value;
  };
  const result = Object.fromEntries(Object.entries(input).map(([field, value]) => [field,
    referenceFields.has(field) ? unwrap(value) : referenceLists.has(field) && Array.isArray(value) ? value.map(unwrap) : value]));
  if (hosts.size > 1) throw new Error("An entity operation cannot span multiple hosts");
  const hostId = [...hosts][0] ?? fallbackHost;
  if (!hostId) throw new Error("This operation is missing its owning host");
  if (unqualified && (!fallbackHost || fallbackHost !== hostId)) throw new Error("Unqualified entity IDs need an explicit owning host");
  return { hostId, input: result as T };
}

export function filtersForHost(scope: FleetScope, hostId: string): { included: boolean; filters: FleetFilters } {
  const projects = scope.projects.flatMap(project => {
    const ref = parseHostEntityId(project);
    return ref ? ref.hostId === hostId ? [ref.id] : [] : [project];
  });
  return { included: !scope.projects.length || projects.length > 0, filters: {
    projects, providers: scope.providers, models: scope.models,
    ...(scope.from ? { from: scope.from } : {}), ...(scope.to ? { to: scope.to } : {}),
  } };
}

export function matchesFleetFilters(record: { projectId?: string | null; projectKey?: string | null; projectRootPath?: string | null;
  provider?: string | null; model?: string | null; at?: string | number | null }, filters: FleetFilters): boolean {
  if (filters.projects.length && !filters.projects.some(id => [record.projectId, record.projectKey, record.projectRootPath].includes(id))) return false;
  if (filters.providers.length && (!record.provider || !filters.providers.includes(record.provider))) return false;
  if (filters.models.length && (!record.model || !filters.models.includes(record.model))) return false;
  if (filters.from || filters.to) {
    const time = typeof record.at === "number" ? record.at : typeof record.at === "string" ? Date.parse(record.at) : NaN;
    if (!Number.isFinite(time) || filters.from && time < Date.parse(filters.from) || filters.to && time > Date.parse(filters.to)) return false;
  }
  return true;
}
