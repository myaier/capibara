// Synthetic dashboard statistics for the development preview (deterministic, no real data).
import { addStatsMetrics, emptyStatsMetrics, statsRangeDays, vendorNames, vendorOf } from "../shared/stats";

const DAY = 86_400_000;
function random(seed) { let state = seed >>> 0; return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const localDay = (at, offset) => new Date(at + offset * 60_000).toISOString().slice(0, 10);
const dayAt = (day) => Date.parse(`${day}T00:00:00.000Z`);
const round = Math.round;

/** One synthetic day of activity; recent weeks are busier, as on a busy host. */
function dayMetrics(index, days, rand) {
  const age = days - 1 - index;
  if (age > 72) return emptyStatsMetrics();
  const weekday = (index + 3) % 7, weekend = weekday >= 5;
  if (age > 20 && rand() < 0.28) return emptyStatsMetrics();
  const intensity = (age < 8 ? 1 : age < 21 ? 0.62 : 0.3) * (weekend ? 0.55 : 1) * (0.7 + rand() * 0.6);
  const sessions = Math.max(age < 30 ? 1 : 0, round(46 * intensity));
  const turns = round(sessions * (4 + rand() * 5));
  const failed = round(turns * (0.015 + rand() * 0.04)), canceled = round(turns * (0.01 + rand() * 0.02));
  const completed = Math.max(0, turns - failed - canceled - (age === 0 ? 5 : 0));
  const toolCalls = round(turns * (14 + rand() * 10)), edits = round(toolCalls * (0.12 + rand() * 0.06));
  return {
    ...emptyStatsMetrics(), sessions, childSessions: round(sessions * (0.35 + rand() * 0.2)), turns, completed, failed, canceled,
    runMs: round(turns * (3.5 + rand() * 6) * 60_000), runSamples: completed + failed + canceled,
    busyMs: round(Math.min(20, 3 + intensity * 14) * 3_600_000), peakParallel: Math.max(1, round(3 + intensity * 9 + rand() * 2)),
    approvals: round(turns * (0.02 + rand() * 0.03)), waitMs: round(turns * (0.02 + rand() * 0.03) * 95_000),
    userMessages: turns + round(turns * rand() * 0.1), assistantMessages: round(turns * (2.6 + rand())),
    toolCalls, toolFailures: round(toolCalls * (0.025 + rand() * 0.03)), edits,
    linesAdded: round(edits * (14 + rand() * 18)), linesRemoved: round(edits * (4 + rand() * 7)), filesChanged: round(edits * (0.45 + rand() * 0.2)),
    shellCalls: round(toolCalls * (0.3 + rand() * 0.1)), webCalls: round(toolCalls * (0.02 + rand() * 0.03)), subagentCalls: round(turns * (0.03 + rand() * 0.03)),
    errors: round(failed * 0.6), compactions: round(sessions * rand() * 0.3),
  };
}
const models = [
  ["claude-opus-5-5[1m]", "claude", 0.34, { success: 0.985, speed: 1.15, lines: 1.35 }],
  ["gpt-5-codex", "codex", 0.18, { success: 0.99, speed: 1.4, lines: 1.1 }],
  ["gemini-2.5-pro", "opencode", 0.15, { success: 0.96, speed: 0.55, lines: 0.6 }],
  ["grok-4.6", "opencode", 0.11, { success: 0.95, speed: 0.7, lines: 0.5 }],
  ["claude-fable-5-1[1m]", "claude", 0.08, { success: 0.99, speed: 1.3, lines: 0.9 }],
  ["kimi-k2", "opencode", 0.07, { success: 0.97, speed: 0.9, lines: 0.8 }],
  ["gpt-5", "copilot", 0.04, { success: 0.94, speed: 0.45, lines: 0.7 }],
  ["deepseek-v3", "pi", 0.02, { success: 0.93, speed: 0.8, lines: 0.6 }],
  ["qwen3-coder", "pi", 0.01, { success: 0.9, speed: 1, lines: 0.4 }],
];
const projects = [["acme/web-app", 0.27], ["demo-project", 0.17], ["Commerce Platform", 0.14], ["data-pipeline", 0.12], ["Mobile Experience", 0.1], ["Delivery Systems", 0.08], ["docs-site", 0.07], ["Growth Studio", 0.05]];
const tools = [["Bash", "shell", 0.24], ["Read", "read", 0.2], ["Edit", "edit", 0.13], ["Grep", "search", 0.09], ["TodoWrite", "plan", 0.06], ["Glob", "search", 0.05], ["Write", "edit", 0.04],
  ["apply_patch", "edit", 0.04], ["shell", "shell", 0.04], ["WebFetch", "web", 0.02], ["Task", "agent", 0.02], ["mcp__paseo__create_agent", "other", 0.015], ["WebSearch", "web", 0.012], ["mcp__github__search_issues", "other", 0.008]];

function scale(metrics, share, shape = {}) {
  const row = emptyStatsMetrics();
  for (const key of Object.keys(row)) row[key] = key === "peakParallel" ? Math.max(1, round(metrics[key] * Math.min(1, share * 3))) : round(metrics[key] * share);
  if (shape.success !== undefined) { const finished = row.completed + row.failed + row.canceled; row.failed = round(finished * (1 - shape.success) * 0.8); row.canceled = round(finished * (1 - shape.success) * 0.2); row.completed = Math.max(0, finished - row.failed - row.canceled); }
  if (shape.speed !== undefined) row.runMs = round(row.runMs * shape.speed);
  if (shape.lines !== undefined) { row.linesAdded = round(row.linesAdded * shape.lines); row.linesRemoved = round(row.linesRemoved * shape.lines); }
  return row;
}
function breakdown(rows, totals, now, offset, extra = () => ({})) {
  return rows.map(([key, label, share, shape, vendor], index) => ({ ...scale(totals, share, shape), key, label, vendor: vendor ?? null,
    activeDays: Math.max(1, round(24 * Math.sqrt(share))), lastActiveAt: new Date(now - index * 47 * 60_000).toISOString(), running: index < 3 ? 2 - Math.min(2, index) : 0,
    open: Math.max(0, round(28 * share)), contextUsed: null, contextMax: null, ...extra(index) }));
}

export function fixtureStats(range = "30d", offset = 480, now = Date.now()) {
  const scenario = new URLSearchParams(globalThis.location?.search ?? "").get("scenario");
  const rand = random(20260923), historyDays = 400, today = localDay(now, offset), todayAt = dayAt(today);
  const history = Array.from({ length: historyDays }, (_, index) => ({ day: new Date(todayAt - (historyDays - 1 - index) * DAY).toISOString().slice(0, 10), ...dayMetrics(index, historyDays, rand) }));
  if (scenario === "stats-empty") for (const entry of history) Object.assign(entry, emptyStatsMetrics());
  const length = statsRangeDays[range];
  const daily = history.slice(-length), before = history.slice(-2 * length, -length);
  const sum = rows => rows.reduce((total, row) => addStatsMetrics(total, row), emptyStatsMetrics());
  const totals = sum(daily), previous = sum(before), allTime = sum(history);
  // Calendar: Monday of the week 52 weeks back through today.
  const weekday = (new Date(todayAt).getUTCDay() + 6) % 7, start = todayAt - (weekday + 52 * 7) * DAY;
  const calendarRows = history.filter(entry => dayAt(entry.day) >= start);
  const punchcard = { sessions: Array(168).fill(0), turns: Array(168).fill(0) };
  const curve = [0.5, 0.35, 0.3, 0.15, 0.05, 0.03, 0.05, 0.12, 0.3, 0.55, 0.9, 1, 0.7, 0.6, 0.85, 0.95, 1, 0.9, 0.6, 0.55, 0.7, 0.85, 0.95, 0.8];
  for (const entry of daily) { const day = (new Date(dayAt(entry.day)).getUTCDay() + 6) % 7; const weight = curve.reduce((a, b) => a + b, 0);
    curve.forEach((value, hour) => { punchcard.sessions[day * 24 + hour] += round(entry.sessions * value / weight); punchcard.turns[day * 24 + hour] += round(entry.turns * value / weight); }); }
  let current = 0; for (let index = history.length - 1; index >= 0 && (history[index].sessions || history[index].turns || index === history.length - 1); index--) if (history[index].sessions || history[index].turns) current++;
  let longest = 0, run = 0, longestEnd = null; for (const entry of history) { if (entry.sessions || entry.turns) { run++; if (run > longest) { longest = run; longestEnd = entry.day; } } else run = 0; }
  const busiest = history.reduce((best, entry) => entry.sessions + entry.turns > (best ? best.sessions + best.turns : -1) ? entry : best, null);
  const modelRows = breakdown(models.map(([key, provider, share, shape]) => [key, key, share, shape, vendorOf(key, provider)]), totals, now, offset);
  const providerShares = new Map(); for (const [key, provider, share] of models) providerShares.set(provider, (providerShares.get(provider) ?? 0) + share);
  const providerRows = breakdown([...providerShares].sort((a, b) => b[1] - a[1]).map(([key, share]) => [key, key, share, undefined, vendorOf(null, key)]), totals, now, offset);
  const vendorShares = new Map(); for (const [key, provider, share] of models) { const vendor = vendorOf(key, provider); vendorShares.set(vendor, (vendorShares.get(vendor) ?? 0) + share); }
  const vendorRows = breakdown([...vendorShares].sort((a, b) => b[1] - a[1]).map(([key, share]) => [key, vendorNames[key] ?? key, share, undefined, key]), totals, now, offset);
  const projectRows = breakdown(projects.map(([key, share]) => [key, key, share]), totals, now, offset);
  const toolRows = tools.map(([name, kind, share]) => ({ name, kind, calls: round(totals.toolCalls * share), failures: round(totals.toolCalls * share * (kind === "shell" ? 0.07 : kind === "web" ? 0.1 : 0.015)) })).filter(tool => tool.calls > 0);
  const kinds = new Map(); for (const tool of toolRows) { const entry = kinds.get(tool.kind) ?? { name: tool.kind, kind: tool.kind, calls: 0, failures: 0 }; entry.calls += tool.calls; entry.failures += tool.failures; kinds.set(tool.kind, entry); }
  const empty = scenario === "stats-empty";
  return {
    generatedAt: new Date(now).toISOString(), range, utcOffsetMinutes: offset, from: daily[0].day, to: today,
    observedSince: empty ? null : new Date(now - 7 * DAY).toISOString(), contentSince: empty ? null : new Date(now - 3 * DAY).toISOString(), directoryTruncated: false,
    totals, previous, allTime, daily,
    calendar: { start: new Date(start).toISOString().slice(0, 10), sessions: calendarRows.map(entry => entry.sessions), turns: calendarRows.map(entry => entry.turns) },
    punchcard, streak: { current, longest, longestEnd, activeDays: daily.filter(entry => entry.sessions || entry.turns).length, activeDaysAllTime: history.filter(entry => entry.sessions || entry.turns).length },
    records: empty ? { busiestDay: null, longestTurn: null, peakParallel: null, busiestSession: null } : {
      busiestDay: busiest ? { day: busiest.day, sessions: busiest.sessions, turns: busiest.turns } : null,
      longestTurn: { ms: 83 * 60_000 + 12_000, agentId: "payment-root", title: "重构支付服务", model: "claude-opus-5-5[1m]", at: new Date(now - 2 * DAY).toISOString() },
      peakParallel: { count: 12, at: new Date(now - 1 * DAY - 3 * 3_600_000).toISOString() },
      busiestSession: { agentId: "payment-root", title: "重构支付服务", turns: 64 } },
    live: empty ? { open: 0, running: 0, approvals: 0, unread: 0, idle: 0 } : { open: 28, running: 5, approvals: 1, unread: 3, idle: 2 },
    subagents: empty ? { parents: 0, children: 0, maxFanout: 0, maxDepth: 0 } : { parents: 21, children: totals.childSessions, maxFanout: 7, maxDepth: 3 },
    models: empty ? [] : modelRows, providers: empty ? [] : providerRows, vendors: empty ? [] : vendorRows, projects: empty ? [] : projectRows,
    tools: empty ? [] : toolRows, toolKinds: empty ? [] : [...kinds.values()].sort((a, b) => b.calls - a.calls),
  };
}
