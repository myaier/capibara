// Development-only 额度 (observatory.quota.get) for the preview: two sources, one window racing ahead of its pace,
// a weekly window forecast to run out, a quiet one. ?scenario=quota-error keeps the values and says the session dropped;
// ?scenario=quota-stale has only older readings (codex-F8: Claude's read failed after a reading forecast to run out
// 15 minutes ago, Codex is unavailable), so the 看板 chip says 「读数 HH:MM」 without the alarm; ?scenario=quota-mixed
// adds a current Codex reading next to that failed Claude one (the chip picks the current one);
// ?scenario=quota-empty has no usage source at all.
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = at => new Date(at).toISOString();
function series(from, to, value) {
  const points = [];
  for (let at = from, index = 0; at <= to; at += 10 * MIN, index++) points.push([at, Math.round(value(at) * 10) / 10, index === 6]);
  return points.slice(-36);
}
function window(id, label, summary, durationMs, resetsAt, now, value, forecast, extra = {}) {
  const start = resetsAt - durationMs, used = Math.round(value(now) * 10) / 10, pace = Math.min(1, Math.max(0, (now - start) / durationMs));
  const tone = used > 90 ? "danger" : used >= 70 ? "warning" : "ok";
  return { id, label, summary, usedPct: used, resetsAt: iso(resetsAt), durationMs, pace: Math.round(pace * 1000) / 1000, ahead: used > pace * 100 + 1, state: "live",
    forecast, tone, alarm: forecast?.kind === "exhaust" || forecast?.kind === "exhausted", history: series(Math.max(start, now - 3 * DAY), now, value), span: [start, resetsAt], ...extra };
}
export function fixtureQuota(now = Date.now(), scenario = null) {
  now = Math.floor(now / MIN) * MIN;
  if (scenario === "quota-empty") return { generatedAt: iso(now), readAt: iso(now), error: null, refreshing: false, accounts: [] };
  const fiveStart = now - 3.5 * HOUR, fiveReset = fiveStart + 5 * HOUR, weekReset = now + 3 * DAY, weekStart = weekReset - 7 * DAY;
  const fast = at => 5 + (at - fiveStart) / HOUR * 12 + Math.max(0, (at - fiveStart) / HOUR - 2.5) * 22, week = at => 42 * (at - weekStart) / (now - weekStart);
  const codexWeekReset = now + 4.2 * DAY, codexWeekStart = codexWeekReset - 7 * DAY, codexWeek = at => 55 * Math.max(0, at - codexWeekStart) / (now - codexWeekStart);
  if (scenario === "quota-stale" || scenario === "quota-mixed") {
    // The codex-F8 case: 40 % at 08:00, 80 % at 08:30 with the reset at 11:00, then the account's read fails at 09:00.
    const readAt = now - 30 * MIN, staleReset = now + 2 * HOUR, staleStart = staleReset - 5 * HOUR, rising = at => Math.min(80, 40 + Math.max(0, at - (readAt - 30 * MIN)) / (30 * MIN) * 40);
    const claude = { key: "claude:fixture-account", provider: "claude", name: "Claude", hint: null, plan: "Max", status: "error", readingAt: iso(readAt), stale: true, windows: [
      window("five_hour", "5 小时", true, 5 * HOUR, staleReset, readAt, rising, { kind: "exhaust", at: iso(readAt + 15 * MIN), method: "rate" }, { span: [staleStart, staleReset] }),
      window("weekly", "每周", true, 7 * DAY, weekReset, readAt, week, { kind: "projected", pct: 73.5, method: "pace" }),
    ] };
    const codex = scenario === "quota-mixed"
      ? { key: "codex:fixture-account", provider: "codex", name: "Codex", hint: null, plan: "plus", status: "available", readingAt: iso(now - 2 * MIN), stale: false, windows: [
        window("five_hour", "5 小时", true, 5 * HOUR, now + 4 * HOUR, now, () => 12, { kind: "idle" }),
        window("weekly", "每周", true, 7 * DAY, codexWeekReset, now, codexWeek, { kind: "projected", pct: 64, method: "pace" }),
      ] }
      : { key: "codex:fixture-account", provider: "codex", name: "Codex", hint: null, plan: "plus", status: "unavailable", readingAt: iso(now - 50 * MIN), stale: true, windows: [
        window("weekly", "每周", true, 7 * DAY, codexWeekReset, now - 50 * MIN, codexWeek, { kind: "projected", pct: 64, method: "pace" }),
      ] };
    return { generatedAt: iso(now), readAt: iso(now), error: null, refreshing: false, accounts: [claude, codex] };
  }
  const accounts = [
    { key: "claude:fixture-account", provider: "claude", name: "Claude", hint: null, plan: "Max", status: "available", readingAt: iso(now - 2 * MIN), stale: scenario === "quota-error", windows: [
      window("five_hour", "5 小时", true, 5 * HOUR, fiveReset, now, fast, { kind: "exhaust", at: iso(now + 54 * MIN), method: "rate" }),
      window("weekly", "每周", true, 7 * DAY, weekReset, now, week, { kind: "projected", pct: 73.5, method: "pace" }),
      window("weekly_model_opus", "每周 · Opus", false, 7 * DAY, weekReset, now, at => week(at) * 2.17, { kind: "exhaust", at: iso(now + 9.5 * HOUR), method: "pace" }),
    ] },
    { key: "codex:fixture-account", provider: "codex", name: "Codex", hint: null, plan: "plus", status: "available", readingAt: iso(now - 2 * MIN), stale: scenario === "quota-error", windows: [
      window("five_hour", "5 小时", true, 5 * HOUR, now + 4 * HOUR, now, () => 12, { kind: "idle" }),
      window("weekly", "每周", true, 7 * DAY, codexWeekReset, now, codexWeek, { kind: "exhaust", at: iso(now + 2.1 * DAY), method: "pace" }),
    ] },
  ];
  return { generatedAt: iso(now), readAt: iso(now - 2 * MIN), error: scenario === "quota-error" ? { kind: "disconnected", at: iso(now) } : null, refreshing: false, accounts };
}
