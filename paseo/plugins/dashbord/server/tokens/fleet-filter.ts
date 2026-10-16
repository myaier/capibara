import { matchesFleetFilters, type FleetFilters } from "../../shared/fleet-scope";
import { addTokenCounts, emptyTokenCounts } from "../../shared/tokens";
import type { StatsDirectoryAgent } from "../stats-types";
import { bucketKey, emptyData, projectHourKey, rootSession, sessionKey, type TokenData } from "./data";

/** Filter at the retained session/hour grain before any rollup. Old un-attributable totals never leak into a filter. */
export function filterTokenData(data: TokenData, filters: FleetFilters, directory: readonly StatsDirectoryAgent[], owners: ReadonlyMap<string, string>): TokenData {
  if (!filters.projects.length && !filters.providers.length && !filters.models.length && !filters.from && !filters.to) return data;
  const result = emptyData(), agents = new Map(directory.filter(agent => agent.sessionId).map(agent => [agent.sessionId, agent]));
  result.threads = data.threads;
  for (const [key, row] of data.sessionHours) {
    const root = rootSession(data, row.source, row.sessionId), agent = agents.get(root);
    if (!matchesFleetFilters({ projectId: agent?.projectKey, projectRootPath: row.cwd,
      provider: agent?.provider ?? owners.get(sessionKey(row.source, root)), model: row.model, at: row.at }, filters)) continue;
    result.sessionHours.set(key, row);
    const id = sessionKey(row.source, row.sessionId), meta = data.sessions.get(id); if (meta) result.sessions.set(id, meta);
    const hk = bucketKey(row.at, row.source, row.model), hour = result.hours.get(hk) ?? { at: row.at, source: row.source, model: row.model, lastAt: row.lastAt, ...emptyTokenCounts() };
    addTokenCounts(hour, row); hour.lastAt = Math.max(hour.lastAt, row.lastAt); result.hours.set(hk, hour);
    const pk = projectHourKey(row), project = result.projectHours.get(pk) ?? { at: row.at, cwd: row.cwd, lastAt: row.lastAt, ...emptyTokenCounts() };
    addTokenCounts(project, row); project.lastAt = Math.max(project.lastAt, row.lastAt); result.projectHours.set(pk, project);
    result.earliestAt = Math.min(result.earliestAt ?? row.firstAt, row.firstAt); result.latestAt = Math.max(result.latestAt ?? row.lastAt, row.lastAt);
  }
  for (const [key, call] of data.recent) {
    const agent = agents.get(rootSession(data, call.source, call.sessionId));
    if (matchesFleetFilters({ projectId: agent?.projectKey, projectRootPath: call.cwd, provider: agent?.provider ?? owners.get(sessionKey(call.source, call.sessionId)), model: call.model, at: call.at }, filters)) result.recent.set(key, call);
  }
  // Historical speed histograms lack session attribution; omit them instead of showing the unfiltered population.
  return result;
}
