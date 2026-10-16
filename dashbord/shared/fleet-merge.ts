import { outputPortion, spreadOutput } from "./token-live";
import { addStatsMetrics, emptyStatsMetrics, type StatsMetrics, type StatsSnapshot } from "./stats";
import { addTokenCounts, emptyTokenCounts, tokenTotal, type TokenCounts, type TokenSnapshot, type TokenLive } from "./tokens";
import { hostEntityId } from "./fleet-scope";
import { qualifyFleetResult } from "./fleet-entities";
import type { FleetCoverage } from "./fleet-rpc";

export interface FleetSlice<T = any> { hostId: string; label: string; data: T }
const sum = (rows: any[], field: string) => rows.reduce((n, row) => n + (row?.[field] ?? 0), 0);
const earliest = (values: (string | null | undefined)[]) => values.filter((v): v is string => !!v).sort()[0] ?? null;
const latest = (values: (string | null | undefined)[]) => values.filter((v): v is string => !!v).sort().at(-1) ?? null;
const total = (rows: any[]) => Object.fromEntries([...new Set(rows.flatMap(row => Object.keys(row ?? {})))].map(key => [key,
  rows.every(row => row?.[key] === null || row?.[key] === undefined) ? null : sum(rows, key)]));
const arraySum = (rows: number[][]) => Array.from({ length: Math.max(0, ...rows.map(row => row.length)) }, (_, i) => rows.reduce((n, row) => n + (row[i] ?? 0), 0));
const groups = <T>(rows: T[], key: (row: T) => string, merge: (rows: T[]) => T): T[] => {
  const map = new Map<string, T[]>(); for (const row of rows) { const id = key(row); map.set(id, [...map.get(id) ?? [], row]); }
  return [...map.values()].map(merge);
};
const largest = <T>(rows: (T | null | undefined)[], score: (row: T) => number): T | null => rows.filter((v): v is T => !!v).sort((a, b) => score(b) - score(a))[0] ?? null;
const metrics = (rows: StatsMetrics[]) => rows.reduce((out, row) => addStatsMetrics(out, row), emptyStatsMetrics());
const counts = (rows: TokenCounts[]) => rows.reduce((out, row) => addTokenCounts(out, row), emptyTokenCounts());
const DAY = 86_400_000;

export function mergeFleetStats(slices: FleetSlice<StatsSnapshot>[]): StatsSnapshot {
  const rows = slices.map(slice => slice.data), first = rows[0]!;
  const dates = [...new Set(rows.flatMap(row => row.fleetDetails?.activeDates ?? row.daily.filter(day => day.sessions || day.turns).map(day => day.day)))].sort();
  let longest = 0, longestEnd: string | null = null, length = 0, previousDay = -Infinity;
  for (const date of dates) { const day = Date.parse(date); length = day - previousDay === DAY ? length + 1 : 1; previousDay = day; if (length > longest) { longest = length; longestEnd = date; } }
  const dateSet = new Set(dates); let current = 0, day = Date.parse(first.to); if (!dateSet.has(first.to)) day -= DAY;
  while (dateSet.has(new Date(day).toISOString().slice(0, 10))) { current++; day -= DAY; }
  const groupDates: Record<string, Record<string, string[]>> = {};
  const dimension = (name: "models" | "providers" | "vendors" | "projects") => {
    groupDates[name] = {};
    const entries = slices.flatMap(slice => slice.data[name].map(row => {
      const key = name === "projects" ? hostEntityId(slice.hostId, row.key) : row.key;
      const days = slice.data.fleetDetails?.groupDates[name]?.[row.key] ?? [];
      groupDates[name][key] = [...new Set([...groupDates[name][key] ?? [], ...days])];
      return { ...row, key, ...(name === "projects" ? { label: `${row.label} · ${slice.label}` } : {}) };
    }));
    return groups(entries, row => row.key, entries => ({ ...entries[0], ...metrics(entries), activeDays: groupDates[name][entries[0].key].length,
      running: sum(entries, "running"), open: sum(entries, "open"), lastActiveAt: latest(entries.map(row => row.lastActiveAt)),
      contextUsed: entries.every(row => row.contextUsed === null) ? null : sum(entries, "contextUsed"),
      contextMax: entries.every(row => row.contextMax === null) ? null : sum(entries, "contextMax") }))
      .sort((a, b) => b.turns - a.turns || b.sessions - a.sessions || a.key.localeCompare(b.key));
  };
  const models = dimension("models"), providers = dimension("providers"), vendors = dimension("vendors"), projects = dimension("projects");
  const daily = groups(rows.flatMap(row => row.daily), row => row.day, days => ({ ...metrics(days), day: days[0].day })).sort((a, b) => a.day.localeCompare(b.day));
  const tools = (name: "tools" | "toolKinds") => groups(rows.flatMap(row => row[name]), row => name === "tools" ? row.name : row.kind,
    entries => ({ ...entries[0], calls: sum(entries, "calls"), failures: sum(entries, "failures") })).sort((a, b) => b.calls - a.calls);
  return { ...first, generatedAt: latest(rows.map(row => row.generatedAt))!,
    observedSince: earliest(rows.map(row => row.observedSince)), contentSince: earliest(rows.map(row => row.contentSince)),
    directoryTruncated: rows.some(row => row.directoryTruncated), totals: metrics(rows.map(row => row.totals)),
    previous: metrics(rows.map(row => row.previous)), allTime: metrics(rows.map(row => row.allTime)), daily,
    calendar: { start: first.calendar.start, sessions: arraySum(rows.map(row => row.calendar.sessions)), turns: arraySum(rows.map(row => row.calendar.turns)) },
    punchcard: { sessions: arraySum(rows.map(row => row.punchcard.sessions)), turns: arraySum(rows.map(row => row.punchcard.turns)) },
    streak: { current, longest, longestEnd, activeDays: dates.filter(date => date >= first.from && date <= first.to).length, activeDaysAllTime: dates.length },
    records: { busiestDay: largest(daily, row => row.sessions + row.turns),
      longestTurn: largest(rows.map(row => row.records.longestTurn), row => row.ms), peakParallel: largest(rows.map(row => row.records.peakParallel), row => row.count),
      busiestSession: largest(rows.map(row => row.records.busiestSession), row => row.turns) },
    live: total(rows.map(row => row.live)) as StatsSnapshot["live"],
    subagents: { parents: sum(rows.map(row => row.subagents), "parents"), children: sum(rows.map(row => row.subagents), "children"),
      maxDepth: Math.max(...rows.map(row => row.subagents.maxDepth)), maxFanout: Math.max(...rows.map(row => row.subagents.maxFanout)) },
    models, providers, vendors, projects, tools: tools("tools"), toolKinds: tools("toolKinds"),
    fleetDetails: { activeDates: dates, groupDates, filtered: rows.some(row => row.fleetDetails?.filtered),
      concurrency: rows.some(row => row.fleetDetails?.filtered) ? "unavailable" : rows.length > 1 ? "host_lower_bound" : "host",
      toolNamesComplete: rows.every(row => row.fleetDetails?.toolNamesComplete !== false) } };
}

export function mergeFleetTokens(slices: FleetSlice<TokenSnapshot>[]): TokenSnapshot {
  const rows = slices.map(slice => slice.data), first = rows[0]!;
  const bins = new Map<number, number>(); for (const row of rows) for (const [bin, count] of row.fleetDetails?.speedBins ?? []) bins.set(bin, (bins.get(bin) ?? 0) + count);
  const percentile = (quantile: number) => { const n = [...bins.values()].reduce((a, b) => a + b, 0); if (!n) return null;
    let count = 0; for (const [bin, value] of [...bins].sort((a, b) => a[0] - b[0])) { count += value; if (count >= Math.ceil(n * quantile)) return Math.pow(1.04, bin); } return null; };
  const dimension = (name: "models" | "providers" | "projects" | "sources") => groups(slices.flatMap(slice => (slice.data[name] ?? []).map(row => ({ ...row,
    ...(name === "projects" ? { key: hostEntityId(slice.hostId, row.key), label: `${row.label} · ${slice.label}` } : {}) }))), row => row.key,
    entries => ({ ...entries[0], ...counts(entries), sessions: sum(entries, "sessions"), lastAt: latest(entries.map(row => row.lastAt)) })).sort((a, b) => tokenTotal(b) - tokenTotal(a));
  const totals = counts(rows.map(row => row.totals)), daily = groups(rows.flatMap(row => row.daily), row => row.day, days => ({ day: days[0].day, ...counts(days) })).sort((a, b) => a.day.localeCompare(b.day));
  return { ...first, generatedAt: latest(rows.map(row => row.generatedAt))!, totals,
    previous: counts(rows.map(row => row.previous)), allTime: counts(rows.map(row => row.allTime)), daily, hours: arraySum(rows.map(row => row.hours)),
    models: dimension("models"), sources: dimension("sources"), projects: dimension("projects"),
    providers: rows.some(row => row.providers) ? dimension("providers") : undefined,
    sessions: slices.flatMap(slice => slice.data.sessions.map(row => ({ ...row, sessionId: hostEntityId(slice.hostId, row.sessionId), project: `${row.project} · ${slice.label}` }))).sort((a, b) => tokenTotal(b) - tokenTotal(a)),
    records: { peakDay: daily.length ? daily.map(row => ({ day: row.day, total: tokenTotal(row) })).sort((a, b) => b.total - a.total)[0] : null,
      fastest: largest(rows.map(row => row.records.fastest), row => row.tps), biggest: largest(rows.map(row => row.records.biggest), row => row.output) },
    speed: { p50: percentile(0.5), p90: percentile(0.9) },
    paseoShare: tokenTotal(totals) ? rows.reduce((n, row) => n + (row.paseoShare ?? 0) * tokenTotal(row.totals), 0) / tokenTotal(totals) : null,
    coverage: { earliestAt: earliest(rows.map(row => row.coverage.earliestAt)), latestAt: latest(rows.map(row => row.coverage.latestAt)),
      backfill: { ...total(rows.map(row => row.coverage.backfill)), done: rows.every(row => row.coverage.backfill.done) } as TokenSnapshot["coverage"]["backfill"],
      roots: slices.flatMap(slice => slice.data.coverage.roots.map(root => ({ ...root, path: `${slice.label}: ${root.path}` }))),
      truncated: Object.fromEntries(["files", "bytes", "index", "scan"].map(key => [key, rows.some(row => (row.coverage.truncated as any)?.[key])])) as NonNullable<TokenSnapshot["coverage"]["truncated"]> },
    fleetDetails: { speedBins: [...bins], filtered: rows.some(row => row.fleetDetails?.filtered), sessionDetailLimited: rows.some(row => row.fleetDetails?.sessionDetailLimited) } };
}

export function mergeFleetLive(rows: TokenLive[], sources: FleetSlice<TokenLive>[] = []): TokenLive {
  if (rows.every(row => row.fleetSamples)) {
    const now = Math.max(...rows.map(row => Date.parse(row.generatedAt))), count = Math.max(...rows.map(row => row.output.length));
    const bucket = 10_000, start = Math.floor(now / bucket) * bucket - (count - 1) * bucket, miniStart = Math.floor(now / bucket) * bucket - 11 * bucket;
    const unique = new Map<string, NonNullable<TokenLive["fleetSamples"]>[number] & { hostId: string; label: string }>();
    for (const [index, row] of rows.entries()) for (const sample of row.fleetSamples!) {
      const previous = unique.get(sample.key);
      if (!previous || sample.at > previous.at || sample.at === previous.at && sample.output > previous.output) unique.set(sample.key, { ...sample, hostId: sources[index]?.hostId ?? "", label: sources[index]?.label ?? "" });
    }
    const output = Array<number>(count).fill(0), input = [...output], calls = [...output], agents = new Map<string, TokenLive["agents"][number]>();
    let nowOutput = 0, nowInput = 0, nowCalls = 0;
    for (const sample of unique.values()) {
      spreadOutput(sample, start, output); const index = Math.floor((sample.at - start) / bucket);
      if (index >= 0 && index < count) { input[index] += sample.input; calls[index] += sample.calls; }
      if (sample.at >= now - 60_000) { nowOutput += outputPortion(sample, now - 60_000, now); nowInput += sample.input; nowCalls += sample.calls; }
      if (sample.at < now - 600_000) continue;
      const id = sample.agentId ?? hostEntityId(sample.hostId || "unknown", `${sample.source}:${sample.sessionId}`);
      const row = agents.get(id) ?? { sessionId: hostEntityId(sample.hostId || "unknown", sample.sessionId), source: sample.source, agentId: sample.agentId,
        title: sample.title ? `${sample.title} · ${sample.label}` : sample.label, model: sample.model, outputPerSec: 0, recent: Array<number>(12).fill(0), output10m: 0, calls10m: 0, lastCallAt: new Date(sample.at).toISOString() };
      row.outputPerSec += outputPortion(sample, now - 120_000, now) / 120; row.output10m += sample.output; row.calls10m += sample.calls;
      spreadOutput(sample, miniStart, row.recent); row.lastCallAt = latest([row.lastCallAt, new Date(sample.at).toISOString()])!; agents.set(id, row);
    }
    const peak = Math.max(0, ...output);
    return { generatedAt: new Date(now).toISOString(), bucketMs: 10000, start: new Date(start).toISOString(), output, input, calls,
      now: { outputPerSec: nowOutput / 60, inputPerSec: nowInput / 60, callsPerMin: nowCalls },
      peak: peak ? { outputPerSec: peak / 10, at: new Date(start + output.indexOf(peak) * bucket).toISOString() } : null,
      agents: [...agents.values()].sort((a, b) => b.outputPerSec - a.outputPerSec), today: total(rows.map(row => row.today)) as TokenLive["today"] };
  }
  const first = rows[0], end = Math.max(...rows.map(row => Date.parse(row.start) + row.output.length * row.bucketMs));
  const count = Math.max(...rows.map(row => row.output.length)), start = end - count * first.bucketMs;
  const series = (name: "output" | "input" | "calls") => Array.from({ length: count }, (_, i) => rows.reduce((sum, row) => {
    const index = Math.round((start + i * first.bucketMs - Date.parse(row.start)) / first.bucketMs); return sum + (row[name][index] ?? 0);
  }, 0));
  const output = series("output"), peak = Math.max(0, ...output);
  return { ...first, generatedAt: latest(rows.map(row => row.generatedAt))!, start: new Date(start).toISOString(), output, input: series("input"), calls: series("calls"),
    now: total(rows.map(row => row.now)) as TokenLive["now"], today: total(rows.map(row => row.today)) as TokenLive["today"],
    agents: rows.flatMap(row => row.agents).sort((a, b) => b.outputPerSec - a.outputPerSec),
    peak: peak ? { outputPerSec: peak / 10, at: new Date(start + output.indexOf(peak) * first.bucketMs).toISOString() } : null };
}

/** Explicit per-contract reducers avoid adding percentages, durations, IDs or timestamps indiscriminately. */
export function mergeFleetRead(method: string, sources: FleetSlice[], coverage: FleetCoverage): any {
  if (!sources.length) throw new Error("No machines supplied this panel's data");
  const slices = sources.map(slice => ({ ...slice, data: qualifyFleetResult(slice.data, slice.hostId) }));
  const rows = slices.map(slice => slice.data), first = rows[0], flatten = (key: string) => rows.flatMap(row => row[key] ?? []);
  const errors = (key: string) => slices.filter(slice => slice.data[key]).map(slice => `${slice.label}: ${slice.data[key]}`).join("; ") || null;
  const incomplete = coverage.hosts.some(host => host.state !== "live");
  let result: any;
  switch (method) {
    case "observatory.stats.get": result = mergeFleetStats(slices); break;
    case "observatory.tokens.get": result = mergeFleetTokens(slices); break;
    case "observatory.tokens.live": result = mergeFleetLive(rows, slices); break;
    case "observatory.telemetry.get": result = { ...first, startedAt: earliest(rows.map(row => row.startedAt)), agents: flatten("agents"), events: flatten("events").sort((a, b) => b.at.localeCompare(a.at)), persistenceError: errors("persistenceError") }; break;
    case "observatory.background.get": result = { ...first, agents: flatten("agents"), available: !incomplete && rows.every(row => row.available) }; break;
    case "observatory.live.get": result = { ...first, agents: flatten("agents") }; break;
    case "observatory.read-state.list": result = { ...first, receipts: flatten("receipts"), archiveOrigins: flatten("archiveOrigins"), error: errors("error") }; break;
    case "observatory.providers.bases": result = { bases: Object.fromEntries(slices.flatMap(slice => Object.entries(slice.data.bases ?? {}).map(([provider, base]) => [hostEntityId(slice.hostId, provider), base]))) }; break;
    case "observatory.quota.get": {
      // Stable account keys are provider + account hash, not per-host labels. Never sum shared account quotas.
      const accounts = groups(flatten("accounts"), row => row.key, entries => entries.sort((a, b) => (b.readingAt ?? "").localeCompare(a.readingAt ?? ""))[0]);
      result = { ...first, accounts, readAt: earliest(rows.map(row => row.readAt)), refreshing: rows.some(row => row.refreshing), error: rows.find(row => row.error)?.error ?? null }; break;
    }
    case "observatory.attention.get": result = { ...first, count: sum(rows, "count"), blocking: sum(rows, "blocking"), loud: sum(rows, "loud"),
      entries: flatten("entries").sort((a, b) => (a.since ?? "").localeCompare(b.since ?? "")), ready: rows.some(row => row.ready), failed: rows.every(row => row.failed),
      truncated: incomplete || rows.some(row => row.truncated), scheduleFailures: rows.every(row => row.scheduleFailures === null) ? null : sum(rows, "scheduleFailures") }; break;
    case "observatory.schedules.heartbeats": result = { ...first, heartbeats: flatten("heartbeats"), targets: flatten("targets"),
      complete: !incomplete && rows.every(row => row.complete), truncated: incomplete || rows.some(row => row.truncated), error: errors("error") }; break;
    case "observatory.schedules.list": result = { ...first, schedules: flatten("schedules"), runs: flatten("runs").sort((a, b) => (b.startedAt ?? b.createdAt ?? "").localeCompare(a.startedAt ?? a.createdAt ?? "")),
      older: sum(rows, "older"), olderHeartbeats: sum(rows, "olderHeartbeats"), reconstructed: sum(rows, "reconstructed"), week: total(rows.map(row => row.week)),
      truncated: incomplete || rows.some(row => row.truncated), searchLimited: rows.some(row => row.searchLimited), error: errors("error"), notice: errors("notice") }; break;
    case "observatory.analytics.get": {
      const bucket = (name: string) => groups(flatten(name), row => row.day ?? row.bucketStart, entries => ({ ...entries[0],
        ...total(entries.map(({ bucketStart, day, approximate, ...counts }) => counts)), approximate: entries.some(row => row.approximate) }));
      result = { ...first, startedAt: earliest(rows.map(row => row.startedAt)), updatedAt: latest(rows.map(row => row.updatedAt)),
        agents: flatten("agents"), usage: flatten("usage"), hours: bucket("hours"), days: bucket("days"),
        coverageIntervals: flatten("coverageIntervals"), agentsTruncated: incomplete || rows.some(row => row.agentsTruncated), persistenceError: errors("persistenceError") }; break;
    }
    default: throw new Error(`No fleet reducer for ${method}`);
  }
  return { ...result, ...(first.mode ? { mode: "full", unchanged: false } : {}), revision: `fleet:${Date.now()}`, fleetCoverage: coverage };
}
