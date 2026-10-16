import { matchesFleetFilters, type FleetFilters } from "../shared/fleet-scope";
import { t } from "../shared/text";
import {
  emptyStatsMetrics, statsRangeDays, TOOL_KINDS, vendorNames, vendorOf,
  type StatsBreakdownRow, type StatsDay, type StatsMetrics, type StatsRange, type StatsSnapshot, type StatsTool,
} from "../shared/stats";
import {
  statsDayText, statsLocalDay, statsLocalHour, statsZone,
  type StatsAgentRecord, type StatsAttribution, type StatsDirectoryAgent, type StatsHour, type StatsToolHour,
} from "./stats-types";

export interface StatsSnapshotInput {
  complete?: boolean; filters?: FleetFilters;
  now: number; range: StatsRange; utcOffsetMinutes: number;
  /** Device IANA zone; days follow it when this server knows it and it agrees with `utcOffsetMinutes` at `now`. */
  timeZone?: string | null;
  /** All hour-keyed (UTC): each is regrouped into the device's local days, so no day boundary is baked into storage. */
  hours: readonly StatsHour[]; attributions: readonly StatsAttribution[]; toolHours: readonly StatsToolHour[];
  records: readonly StatsAgentRecord[]; running: ReadonlyMap<string, number>; directory: readonly StatsDirectoryAgent[];
  observedSince: string | null; contentSince: string | null; directoryTruncated: boolean;
  /** Open Agents whose final reply asks the user (待回复), from the reply ledger. */
  awaiting?: ReadonlySet<string>;
  /** Agents whose subagents still work after their own turn ended (后台执行中). */
  background?: ReadonlySet<string>;
  /** Agents whose turn ended after the directory walk that still shows them running. */
  ended?: ReadonlySet<string>;
  /** When `directory` was walked; hook-only turns that started later are agents the walk has not seen yet. */
  walkedAt?: number;
}

const metricKeys = Object.keys(emptyStatsMetrics()) as (keyof StatsMetrics)[];
const dayString = statsDayText;
const weekday = (day: number) => ((day + 3) % 7 + 7) % 7;
const active = (metrics: StatsMetrics) => metrics.sessions > 0 || metrics.turns > 0;
const text = (value: string | null | undefined, fallback: string, maximum = 240) => (value?.trim() || fallback).slice(0, maximum);
const titleOf = (agent: StatsDirectoryAgent | undefined) => text(agent?.title, t("serverStatsSnapshot.m001"));

function add(target: StatsMetrics, delta: StatsMetrics, includeSessions = true): void {
  // Iterate the metric allowlist: breakdown rows also contain numeric metadata that must not be added here.
  for (const key of metricKeys) {
    if (!includeSessions && (key === "sessions" || key === "childSessions")) continue;
    target[key] = key === "peakParallel" ? Math.max(target[key], delta[key]) : target[key] + delta[key];
  }
}

interface Group { row: StatsBreakdownRow; days: Set<number> }
type Dimension = "models" | "providers" | "vendors" | "projects";
const dimensions: readonly Dimension[] = ["models", "providers", "vendors", "projects"];

function identity(dimension: Dimension, agent: StatsDirectoryAgent | undefined) {
  if (!agent) return { key: "unknown", label: t("serverStatsSnapshot.m002"), vendor: dimension === "projects" ? null : "other" };
  const provider = text(agent.provider, "unknown", 1024), model = text(agent.model, provider, 1024);
  const vendor = vendorOf(agent.model, agent.provider);
  switch (dimension) {
    case "models": return { key: model, label: model.slice(0, 240), vendor };
    case "providers": return { key: provider, label: provider.slice(0, 240), vendor: vendorOf(null, agent.provider) };
    case "vendors": return { key: vendor, label: vendorNames[vendor] ?? vendor, vendor };
    case "projects": return { key: text(agent.projectKey, "unknown", 1024), label: text(agent.projectName, t("serverStatsSnapshot.m003")), vendor: null };
  }
}

function groupFor(groups: Map<string, Group>, id: { key: string; label: string; vendor: string | null }): Group {
  let group = groups.get(id.key);
  if (!group) {
    group = { row: { ...emptyStatsMetrics(), ...id, activeDays: 0, lastActiveAt: null, running: 0, open: 0, contextUsed: null, contextMax: null }, days: new Set() };
    groups.set(id.key, group);
  }
  return group;
}

function latest(group: Group, stamp: string): void {
  const at = Date.parse(stamp);
  if (Number.isFinite(at) && (group.row.lastActiveAt === null || at > Date.parse(group.row.lastActiveAt))) group.row.lastActiveAt = new Date(at).toISOString();
}

function finishGroups(groups: Map<string, Group>, limit: number, dimension: Dimension): StatsBreakdownRow[] {
  const sorted = [...groups.values()].sort((a, b) => b.row.turns - a.row.turns || b.row.sessions - a.row.sessions || a.row.label.localeCompare(b.row.label) || a.row.key.localeCompare(b.row.key));
  const visible = sorted.slice(0, sorted.length > limit ? limit - 1 : limit);
  if (sorted.length > limit) {
    const overflow = groupFor(new Map(), { key: "__other__", label: t("serverStatsSnapshot.m004"), vendor: dimension === "projects" ? null : "other" });
    for (const group of sorted.slice(limit - 1)) {
      add(overflow.row, group.row);
      overflow.row.running += group.row.running; overflow.row.open += group.row.open;
      for (const field of ["contextUsed", "contextMax"] as const) if (group.row[field] !== null) overflow.row[field] = (overflow.row[field] ?? 0) + group.row[field];
      if (group.row.lastActiveAt) latest(overflow, group.row.lastActiveAt);
      for (const day of group.days) overflow.days.add(day);
    }
    visible.push(overflow);
  }
  return visible.map(({ row, days }) => ({ ...row, activeDays: days.size }));
}

/** Pure projection. Busy-time advancement and stale-running reconciliation belong to the store. */
export function buildStatsSnapshot(input: StatsSnapshotInput): StatsSnapshot {
  const filters = input.filters;
  const filtered = !!filters && !!(filters.projects.length || filters.providers.length || filters.models.length || filters.from || filters.to);
  if (filtered) {
    const directory = input.directory.filter(agent => matchesFleetFilters({ ...agent, at: agent.createdAt }, { ...filters, from: undefined, to: undefined }));
    const ids = new Set(directory.map(agent => agent.id));
    const attributions = input.attributions.filter(row => ids.has(row.agentId) && matchesFleetFilters({ at: row.hour }, { projects: [], providers: [], models: [], from: filters.from, to: filters.to }));
    const hours = new Map<string, StatsHour>();
    for (const row of attributions) { const hour = hours.get(row.hour) ?? { ...emptyStatsMetrics(), hour: row.hour }; add(hour, { ...row, peakParallel: 0 }); hours.set(row.hour, hour); }
    input = { ...input, directory, attributions, hours: [...hours.values()], toolHours: [],
      records: input.records.filter(row => ids.has(row.agentId)), running: new Map([...input.running].filter(([id]) => ids.has(id))) };
  }
  const { now, range, utcOffsetMinutes } = input;
  const zone = statsZone(utcOffsetMinutes, input.timeZone, now);
  const dayOf = (at: number) => statsLocalDay(at, zone), hourOf = (at: number) => statsLocalHour(at, zone);
  const today = dayOf(now), count = statsRangeDays[range];
  const first = today - count + 1, previousFirst = first - count, from = dayString(first), to = dayString(today);
  const days = new Map<number, StatsMetrics>();
  const getDay = (day: number) => {
    let metrics = days.get(day);
    if (!metrics) { metrics = emptyStatsMetrics(); days.set(day, metrics); }
    return metrics;
  };
  const inRange = (day: number) => day >= first && day <= today;
  const directory = new Map(input.directory.map(agent => [agent.id, agent]));
  // The directory walk is up to a minute old: lifecycle hooks and background subagents are current.
  const isRunning = (agent: StatsDirectoryAgent) => ((agent.status === "running" || agent.activeTurn) && !input.ended?.has(agent.id))
    || input.running.has(agent.id) || !!input.background?.has(agent.id);
  const punchcard = { sessions: Array<number>(168).fill(0), turns: Array<number>(168).fill(0) };
  let peakParallel: StatsSnapshot["records"]["peakParallel"] = null;
  for (const hour of input.hours) {
    const at = Date.parse(hour.hour);
    if (!Number.isFinite(at)) continue;
    const day = dayOf(at);
    add(getDay(day), hour, false);
    if (inRange(day)) punchcard.turns[weekday(day) * 24 + hourOf(at)] += hour.turns;
    if (hour.peakParallel > 0 && (!peakParallel || hour.peakParallel > peakParallel.count || (hour.peakParallel === peakParallel.count && at < Date.parse(peakParallel.at)))) {
      peakParallel = { count: hour.peakParallel, at: new Date(at).toISOString() };
    }
  }

  const groups: Record<Dimension, Map<string, Group>> = { models: new Map(), providers: new Map(), vendors: new Map(), projects: new Map() };
  const live = { open: 0, running: 0, approvals: 0, unread: 0, idle: 0 };
  const fanouts = new Map<string, number>();
  let children = 0, maxDepth = 0;
  for (const agent of directory.values()) {
    const at = Date.parse(agent.createdAt), day = Number.isFinite(at) ? dayOf(at) : NaN;
    const selected = inRange(day), child = Boolean(agent.parentAgentId), open = agent.archivedAt === null;
    if (Number.isFinite(day)) {
      getDay(day).sessions++;
      if (child) getDay(day).childSessions++;
      if (selected) punchcard.sessions[weekday(day) * 24 + hourOf(at)]++;
    }
    if (open) {
      live.open++;
      const running = isRunning(agent);
      if (running) live.running++;
      if (agent.pendingPermissions > 0) live.approvals++;
      // 待回复 and 未读 split the same way as the session list: a question counts as 待回复 whether or not it was opened,
      // and an Agent still working in the background is neither.
      if (!running) {
        if (input.awaiting?.has(agent.id)) live.idle++;
        else if (agent.requiresAttention && agent.attentionReason === "finished") live.unread++;
      }
    }
    if (selected && agent.parentAgentId) {
      children++; fanouts.set(agent.parentAgentId, (fanouts.get(agent.parentAgentId) ?? 0) + 1);
      const seen = new Set([agent.id]);
      let parent: string | null = agent.parentAgentId, depth = 0;
      while (parent && !seen.has(parent) && depth < 32) { seen.add(parent); depth++; parent = directory.get(parent)?.parentAgentId ?? null; }
      maxDepth = Math.max(maxDepth, depth);
    }
    for (const dimension of dimensions) {
      const group = groupFor(groups[dimension], identity(dimension, agent));
      if (selected) { group.row.sessions++; if (child) group.row.childSessions++; group.days.add(day); latest(group, agent.createdAt); }
      if (open) { group.row.open++; if (isRunning(agent)) group.row.running++; }
      for (const field of ["contextUsed", "contextMax"] as const) if (agent[field] !== null) group.row[field] = (group.row[field] ?? 0) + agent[field];
    }
  }

  // Each Agent's hours in range are summed first, so the four breakdowns add one total per Agent, not one per hour.
  const agentTotals = new Map<string, { metrics: StatsMetrics; days: Set<number>; lastActiveAt: number }>();
  for (const attribution of input.attributions) {
    // An hour belongs to the local day it starts in, as the 看板 hours above (in a :30 / :45 zone, the one hour that
    // spans midnight counts for the day it starts in).
    const at = Date.parse(attribution.hour), day = Number.isFinite(at) ? dayOf(at) : NaN;
    if (!inRange(day)) continue;
    let total = agentTotals.get(attribution.agentId);
    if (!total) { total = { metrics: emptyStatsMetrics(), days: new Set(), lastActiveAt: -Infinity }; agentTotals.set(attribution.agentId, total); }
    add(total.metrics, attribution, false);
    if (attribution.turns > 0) total.days.add(day);
    const last = Date.parse(attribution.lastActiveAt);
    if (last > total.lastActiveAt) total.lastActiveAt = last;
  }
  const agentTurns = new Map<string, number>();
  for (const [agentId, total] of agentTotals) {
    const agent = directory.get(agentId), lastActiveAt = Number.isFinite(total.lastActiveAt) ? new Date(total.lastActiveAt).toISOString() : null;
    agentTurns.set(agentId, total.metrics.turns);
    for (const dimension of dimensions) {
      const group = groupFor(groups[dimension], identity(dimension, agent));
      add(group.row, total.metrics, false);
      for (const day of total.days) group.days.add(day);
      if (lastActiveAt) latest(group, lastActiveAt);
    }
  }
  // Hooks may briefly precede directory visibility. Preserve their current, unattributed running count.
  for (const [agentId, start] of input.running) if (!directory.has(agentId)) {
    // An Agent created after the walk is open and running. An older hook-only turn belongs to an Agent the walk no
    // longer lists (or that ended unobserved) and is not counted.
    if (input.walkedAt !== undefined && start <= input.walkedAt) continue;
    for (const dimension of dimensions) groupFor(groups[dimension], identity(dimension, undefined)).row.running++;
    if (input.walkedAt !== undefined) { live.open++; live.running++; }
  }

  const totals = emptyStatsMetrics(), previous = emptyStatsMetrics(), allTime = emptyStatsMetrics();
  const activeDays: number[] = [];
  let busiestDay: StatsSnapshot["records"]["busiestDay"] = null;
  for (const [day, metrics] of [...days].sort(([a], [b]) => a - b)) {
    add(allTime, metrics);
    if (inRange(day)) add(totals, metrics);
    else if (day >= previousFirst && day < first) add(previous, metrics);
    if (!active(metrics) || day > today) continue;
    activeDays.push(day);
    if (!busiestDay || metrics.sessions + metrics.turns > busiestDay.sessions + busiestDay.turns) busiestDay = { day: dayString(day), sessions: metrics.sessions, turns: metrics.turns };
  }
  const daily: StatsDay[] = Array.from({ length: count }, (_, index) => ({ ...emptyStatsMetrics(), ...days.get(first + index), day: dayString(first + index) }));
  const calendarFirst = today - weekday(today) - 52 * 7;
  const calendar = { start: dayString(calendarFirst), sessions: [] as number[], turns: [] as number[] };
  for (let day = calendarFirst; day <= today; day++) { calendar.sessions.push(days.get(day)?.sessions ?? 0); calendar.turns.push(days.get(day)?.turns ?? 0); }
  let longest = 0, longestEnd: string | null = null, length = 0, lastDay: number | null = null;
  for (const day of activeDays) {
    length = lastDay === day - 1 ? length + 1 : 1;
    if (length > longest) { longest = length; longestEnd = dayString(day); }
    lastDay = day;
  }
  let current = 0, currentDay = days.get(today) && active(days.get(today)!) ? today : today - 1;
  while (days.has(currentDay) && active(days.get(currentDay)!)) { current++; currentDay--; }

  let longestTurn: StatsSnapshot["records"]["longestTurn"] = null;
  for (const record of input.records) {
    if (record.maxTurnAt === null || !Number.isFinite(Date.parse(record.maxTurnAt))) continue;
    const at = new Date(record.maxTurnAt).toISOString(), agent = directory.get(record.agentId);
    if (!longestTurn || record.maxTurnMs > longestTurn.ms || (record.maxTurnMs === longestTurn.ms && (at < longestTurn.at || (at === longestTurn.at && record.agentId < longestTurn.agentId)))) {
      longestTurn = { ms: record.maxTurnMs, agentId: record.agentId, title: titleOf(agent), model: agent?.model?.slice(0, 240) ?? null, at };
    }
  }
  const busiest = [...agentTurns].filter(([, turns]) => turns > 0).sort(([a, aTurns], [b, bTurns]) => bTurns - aTurns || a.localeCompare(b))[0];
  const busiestSession = busiest ? { agentId: busiest[0], title: titleOf(directory.get(busiest[0])), turns: busiest[1] } : null;
  const tools = new Map<string, { row: StatsTool; kinds: Map<StatsTool["kind"], number> }>();
  const kinds = new Map(TOOL_KINDS.map(kind => [kind, { name: kind, kind, calls: 0, failures: 0 } satisfies StatsTool]));
  for (const hour of input.toolHours) {
    const at = Date.parse(hour.hour);
    if (!Number.isFinite(at) || !inRange(dayOf(at))) continue;
    for (const tool of hour.tools) {
      const name = tool.name.trim().slice(0, 160);
      let named = tools.get(name);
      if (!named) { named = { row: { name, kind: tool.kind, calls: 0, failures: 0 }, kinds: new Map() }; tools.set(name, named); }
      named.row.calls += tool.calls; named.row.failures += tool.failures;
      named.kinds.set(tool.kind, (named.kinds.get(tool.kind) ?? 0) + tool.calls);
    }
    for (const tool of hour.kinds ?? hour.tools) { const kind = kinds.get(tool.kind)!; kind.calls += tool.calls; kind.failures += tool.failures; }
  }
  const rankedTools = [...tools.values()].filter(tool => tool.row.calls > 0).map(tool => {
    tool.row.kind = [...tool.kinds].sort(([a, ac], [b, bc]) => bc - ac || TOOL_KINDS.indexOf(a) - TOOL_KINDS.indexOf(b))[0][0];
    return tool.row;
  }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, input.complete ? Infinity : 24);

  return {
    ...(input.complete ? { fleetDetails: { activeDates: activeDays.map(dayString),
      groupDates: Object.fromEntries(dimensions.map(dimension => [dimension, Object.fromEntries([...groups[dimension]].map(([key, group]) => [key, [...group.days].map(dayString)]))])),
      filtered, concurrency: filtered ? "unavailable" as const : "host" as const, toolNamesComplete: !filtered } } : {}),
    generatedAt: new Date(now).toISOString(), range, utcOffsetMinutes, timeZone: zone.name, from, to,
    observedSince: input.observedSince, contentSince: input.contentSince, directoryTruncated: input.directoryTruncated,
    totals, previous, allTime, daily, calendar, punchcard,
    streak: { current, longest, longestEnd, activeDays: activeDays.filter(inRange).length, activeDaysAllTime: activeDays.length },
    records: { busiestDay, longestTurn, peakParallel, busiestSession }, live,
    subagents: { parents: fanouts.size, children, maxFanout: Math.max(0, ...fanouts.values()), maxDepth },
    models: finishGroups(groups.models, input.complete ? Infinity : 24, "models"), providers: finishGroups(groups.providers, input.complete ? Infinity : 24, "providers"),
    vendors: finishGroups(groups.vendors, input.complete ? Infinity : 12, "vendors"), projects: finishGroups(groups.projects, input.complete ? Infinity : 24, "projects"),
    tools: rankedTools, toolKinds: [...kinds.values()].filter(tool => tool.calls > 0),
  };
}
