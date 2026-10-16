// Development-only synthetic 定时运行 data. Shapes follow observatory.schedules.list / .run; nothing is read from a host.
import { RUN_WINDOWS, cadenceLabel, previewOf } from "../shared/schedules";

const base = Date.now();
const DAY = 86_400_000;
const minutesAgo = minutes => new Date(base - minutes * 60_000).toISOString();
const daysAgo = (days, minutes = 0) => new Date(base - days * DAY - minutes * 60_000).toISOString();
const later = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const schedules = [
  { id: "5bf7fe3f", name: "每日站会摘要", kind: "new-agent", status: "active", cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Tokyo" }, target: "commerce-platform", provider: "codex", next: 900,
    prompt: "汇总昨天合并的改动、未关闭的合并请求和失败的流水线，写成站会摘要。" },
  { id: "df65264f", name: "依赖升级 · 每日", kind: "new-agent", status: "active", cadence: { type: "cron", expression: "30 9 * * *", timezone: "Asia/Tokyo" }, target: "commerce-platform", provider: "claude", next: 1_380,
    prompt: "检查过期依赖，升级补丁版本并跑测试，通过后开一个合并请求。" },
  { id: "379351a3", name: "夜间回归测试", kind: "new-agent", status: "active", cadence: { type: "cron", expression: "0 2 * * *", timezone: null }, target: "delivery", provider: "codex", next: 640,
    prompt: "在 nightly 工作区跑完整回归测试，失败时附上第一条失败用例。" },
  { id: "9c41d2aa", name: "每周版本报告", kind: "new-agent", status: "active", cadence: { type: "cron", expression: "0 18 * * 5", timezone: "Asia/Tokyo" }, target: "commerce-platform", provider: "codex", next: 4 * 1440,
    prompt: "整理本周发布的版本、合并请求和遗留问题，按模块写成周报。" },
  { id: "7e2b90c4", name: "每日环境诊断", kind: "new-agent", status: "paused", cadence: { type: "cron", expression: "0 7 * * *", timezone: "America/New_York" }, target: "commerce-platform", provider: "codex", next: null,
    prompt: "检查预发布环境的数据库连接、队列积压和证书有效期。" },
  { id: "858d6906", name: "巡检心跳", kind: "heartbeat", status: "active", cadence: { type: "every", everyMs: 30 * 60_000 }, target: "重构支付服务", provider: "codex", next: 12,
    prompt: "看一下当前进度，有阻塞就告诉我。" },
];

const agent = (id, title, status, archivedAt = null, known = true) => ({ id, title, status, archivedAt, known });
const workspace = (id, name, branch, archivedAt = null) => ({ id, name, branch, archivedAt });
const runs = [];
function add(scheduleId, id, startedAt, minutes, extra = {}) {
  const schedule = schedules.find(item => item.id === scheduleId);
  runs.push({ id, scheduleId, scheduleName: schedule?.name ?? extra.scheduleName, kind: schedule?.kind ?? "new-agent", status: "succeeded", source: "schedule", scheduledFor: startedAt, startedAt,
    endedAt: minutes === null ? null : later(startedAt, minutes), output: null, error: null, agent: null, workspace: null, projectName: "Commerce Platform", link: null, ...extra });
}

const standupReply = [
  "## 昨日进展",
  "",
  "1. 支付服务：幂等校验已合并，18 项接口测试全部通过。",
  "2. 移动端：重试逻辑改为指数退避，**仍有 1 个用例偶发失败**。",
  "   - 失败用例：`checkout.retry.spec.ts`",
  "   - 负责人已认领，今天修复",
  "",
  "## 待处理",
  "",
  "- 合并请求 https://code.example.com/commerce/checkout/-/merge_requests/42 等待评审",
  "- 迁移草案需要确认目标环境",
  "",
  "> 流水线：主干 3 次构建全部通过。",
].join("\n");
const upgradeReply = "已升级 12 个依赖的补丁版本，测试全部通过。\n\n- `zod` 4.4.2 → 4.4.3\n- `esbuild` 0.28.1 → 0.28.2\n\n合并请求：[#128](https://github.com/example/commerce/pull/128)";
const weeklyReply = [
  "# 第 41 周版本报告",
  "",
  "本周发布 **3 个版本**，合并 14 个请求。详细记录见 https://code.example.com/commerce/checkout/-/merge_requests/37。",
  "",
  "## 按模块",
  "",
  "- 支付",
  "  - 幂等校验上线，重复订单降为 0",
  "  - 退款回调改为异步，平均耗时 1.2 秒",
  "- 移动端",
  "  - 重试逻辑改为指数退避",
  "",
  "## 遗留问题",
  "",
  "1. 预发布数据库偶发连接超时（已开工单）",
  "2. `checkout.retry.spec.ts` 偶发失败",
  "",
  "```",
  "releases: 3  merged: 14  reverted: 0",
  "```",
].join("\n");

// 每日站会摘要 — workdays at 09:00, MR links, one run stopped on a permission prompt.
add("5bf7fe3f", "c61d0735-0752-41e1-aebd-636508cb6973", minutesAgo(95), 6, { output: standupReply, agent: agent("fixture-standup-1", "站会摘要 · 今天", "closed", minutesAgo(80)),
  workspace: workspace("ws-standup-1", "站会摘要", "paseo/standup-1009"), link: { url: "https://code.example.com/commerce/checkout/-/merge_requests/42", label: "!42", kind: "mr", state: null } });
add("5bf7fe3f", "4e299f69-fc54-40ab-9775-e14d616cb847", daysAgo(1, 95), 7, { output: "昨日合并 5 个请求，流水线全部通过。https://code.example.com/commerce/checkout/-/merge_requests/41",
  agent: agent("fixture-standup-2", "站会摘要 · 昨天", "closed", daysAgo(1, 80)), workspace: workspace("ws-standup-2", "站会摘要", "paseo/standup-1008", daysAgo(1, 80)),
  link: { url: "https://code.example.com/commerce/checkout/-/merge_requests/41", label: "!41", kind: "mr", state: "merged" } });
add("5bf7fe3f", "515c78dc-4ed4-4fdc-be0a-6d1d456b7c30", daysAgo(2, 95), 5, { output: "昨日无合并，2 个请求等待评审。", agent: agent("fixture-standup-3", "站会摘要", "closed", daysAgo(2, 80)) });
add("5bf7fe3f", "25700d7b-7fe9-4411-a967-2861ffc8afb2", daysAgo(3, 95), 31, { status: "failed", agent: agent("fixture-standup-4", "站会摘要", "idle", daysAgo(3, 60)),
  error: "Internal error: Agent fixture-standup-4 is waiting for permission: exec_command | code=-32603 Internal error" });
// 依赖升级 — one run going right now, a PR, a provider timeout.
// It started moments ago: the host directory (walked once a minute) has not listed its Agent yet.
add("df65264f", "bf1f69c0-ce9b-4a11-9563-6c8d81b37269", minutesAgo(4), null, { status: "running", agent: agent("fixture-deps-1", null, null, null, false),
  workspace: workspace("ws-deps-1", "依赖升级", "paseo/deps-1009") });
add("df65264f", "38757527-2181-4346-862a-38eaa6405921", daysAgo(1, 30), 22, { output: upgradeReply, agent: agent("fixture-deps-2", "依赖升级", "closed", daysAgo(1, 5)),
  workspace: workspace("ws-deps-2", "依赖升级", "paseo/deps-1008", daysAgo(1, 5)), link: { url: "https://github.com/example/commerce/pull/128", label: "#128", kind: "pr", state: null } });
add("df65264f", "7a1c2e90-3f4b-4d6a-8e21-5b9c0d7f6a13", daysAgo(2, 30), 1, { status: "failed", error: "Internal error: Timed out refreshing opencode after 60000ms" });
// 夜间回归测试 — a zone-less cron (runs in UTC); its workspace vanished today.
add("379351a3", "258958c2-1e0e-48ed-9714-79f22f999ee3", minutesAgo(410), 0, { status: "failed", projectName: "Delivery Systems",
  error: "Working directory /workspace/delivery-nightly no longer exists. The schedule has been completed." });
for (let day = 1; day <= 6; day++) add("379351a3", `e583db79-9496-4eaa-a75a-64989fcc55${String(day).padStart(2, "0")}`, daysAgo(day, 410), 38 + day, { projectName: "Delivery Systems",
  output: `回归测试通过：${410 + day * 3} 个用例。`, agent: agent(`fixture-nightly-${day}`, "夜间回归测试", "closed", daysAgo(day, 360)) });
// 每周版本报告 — the archived 上周版本报告 session is one of its runs; two runs are older than 30 days.
add("9c41d2aa", "5d0e2c1a-7f43-4b8e-9a61-2f5c8d7e3b10", daysAgo(2), 9, { output: weeklyReply, agent: agent("old-report", "上周版本报告", "closed", daysAgo(1)),
  workspace: workspace("commerce", "Checkout v2", "main"), link: { url: "https://code.example.com/commerce/checkout/-/merge_requests/37", label: "!37", kind: "mr", state: null } });
for (const days of [9, 16, 23, 37, 44]) add("9c41d2aa", `9c41d2aa-run-${days}`, daysAgo(days), 8, { output: `第 ${41 - Math.round(days / 7)} 周版本报告：发布 2 个版本。`, agent: agent(`fixture-weekly-${days}`, "每周版本报告", "closed", daysAgo(days - 1)) });
// 每日环境诊断 (paused, New York time) — today's run left the 归档环境诊断 session open.
add("7e2b90c4", "b3f1a2c4-6d5e-4f70-8a9b-0c1d2e3f4a5b", minutesAgo(200), 14, { output: "预发布环境正常：数据库连接 12 ms，队列无积压，证书还有 64 天到期。", agent: agent("environment-closed", "归档环境诊断", "closed") });
add("7e2b90c4", "c4d5e6f7-0a1b-4c2d-9e3f-4a5b6c7d8e9f", daysAgo(1, 200), 3, { status: "failed", error: "Daemon restarted before the scheduled run completed" });
// 巡检心跳 — every 30 minutes on 重构支付服务; hidden unless 心跳 is on.
for (let index = 0; index < 12; index++) add("858d6906", `cb881ba3-328a-481f-a59b-af23160be2${String(index).padStart(2, "0")}`, minutesAgo(18 + index * 30), 2, {
  ...(index === 3 ? { status: "failed", error: "Internal error: Agent payment-root already has an active run" } : { output: index === 0 ? "幂等校验进行中，没有阻塞。" : "进度正常。" }),
  agent: agent("payment-root", "重构支付服务", "running"), workspace: workspace("commerce-payments-v2", "Checkout v2", "feature/payments-v2") });
// A deleted schedule: two runs the ledger kept, two only Agent labels describe.
add(null, "a8e1f0c2-1d3b-4e5f-8a9b-7c6d5e4f3a21", daysAgo(5, 120), 11, { scheduleId: "37142edd", scheduleName: "旧版发布巡检", source: "ledger", agent: agent("fixture-legacy-1", "旧版发布巡检", "closed", daysAgo(5, 100)) });
add(null, "a8e1f0c2-1d3b-4e5f-8a9b-7c6d5e4f3a22", daysAgo(6, 120), 4, { scheduleId: "37142edd", scheduleName: "旧版发布巡检", source: "ledger", status: "failed",
  error: "Internal error: acp does not support ACP session resume | code=-32603" });
// Its project was removed from Paseo: only the Agent record remains, the host cannot open it.
add(null, "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e61", daysAgo(10, 60), 0, { scheduleId: "1f0a9b3e", scheduleName: "发布前检查", source: "agent", scheduledFor: null, projectName: "Delivery Systems",
  agent: { ...agent("fixture-rebuilt-1", "发布前检查", "closed", daysAgo(9)), listed: false }, workspace: workspace("ws-rebuilt-1", "发布前检查", null, daysAgo(9)) });
add(null, "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e62", daysAgo(11, 60), 0, { scheduleId: "1f0a9b3e", scheduleName: "发布前检查", source: "agent", scheduledFor: null, projectName: "Delivery Systems", status: "unknown",
  agent: agent("fixture-rebuilt-2", "发布前检查", "closed", daysAgo(10)) });
runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

const deleted = [
  { id: "37142edd", name: "旧版发布巡检", cadence: "每天 06:00", timezone: "Asia/Tokyo", target: "commerce-platform", provider: "codex" },
  { id: "1f0a9b3e", name: "发布前检查", cadence: "", timezone: null, target: "Delivery Systems", provider: null },
];
const row = run => ({ id: run.id, scheduleId: run.scheduleId, scheduleName: run.scheduleName, kind: run.kind, status: run.status, source: run.source, scheduledFor: run.scheduledFor, startedAt: run.startedAt,
  endedAt: run.endedAt, preview: previewOf(run.output), hasOutput: !!run.output, error: run.error, agent: run.agent, workspace: run.workspace, projectName: run.projectName, link: run.link });
function summaries() {
  const all = [...schedules.map(item => ({ id: item.id, name: item.name, kind: item.kind, status: item.status, cadence: cadenceLabel(item.cadence),
    timezone: item.cadence.type === "cron" ? item.cadence.timezone ?? "UTC" : null, target: item.target, nextRunAt: item.next === null ? null : new Date(base + item.next * 60_000).toISOString(),
    lastRunAt: runs.find(run => run.scheduleId === item.id)?.startedAt ?? null, provider: item.provider })),
  ...deleted.map(item => ({ ...item, kind: "new-agent", status: "deleted", nextRunAt: null, lastRunAt: null }))];
  return all.map(summary => {
    const own = runs.filter(run => run.scheduleId === summary.id);
    return { ...summary, recent: own.slice(0, 10).reverse().map(run => run.status), total: own.length, failed: own.filter(run => run.status === "failed").length, running: own.filter(run => run.status === "running").length };
  }).sort((a, b) => Number(a.status === "deleted") - Number(b.status === "deleted") || Number(b.running > 0) - Number(a.running > 0) || a.name.localeCompare(b.name, "zh-CN"));
}

/** observatory.schedules.list for a scenario: `schedules-empty`, `schedules-notice`, `schedules-error`, or the full fixture. */
export function fixtureScheduleList(window = "recent", scenario = null) {
  if (scenario === "schedules-error") throw new Error("模拟：定时任务目录暂时读不到");
  const empty = scenario === "schedules-empty";
  const limits = RUN_WINDOWS[window], cutoff = limits.days === null ? null : base - limits.days * DAY;
  let newAgent = 0, heartbeats = 0;
  const kept = empty ? [] : runs.filter(run => {
    if (cutoff !== null && Date.parse(run.startedAt) < cutoff && run.status !== "running") return false;
    return run.kind === "heartbeat" ? heartbeats++ < limits.heartbeats : newAgent++ < limits.runs;
  });
  const all = empty ? [] : runs, allHeartbeats = all.filter(run => run.kind === "heartbeat").length, keptHeartbeats = kept.filter(run => run.kind === "heartbeat").length;
  const week = { runs: 0, failed: 0, heartbeats: 0, heartbeatsFailed: 0 };
  for (const run of all) {
    if (Date.parse(run.startedAt) < base - 7 * DAY) continue;
    if (run.kind === "heartbeat") { week.heartbeats++; if (run.status === "failed") week.heartbeatsFailed++; } else { week.runs++; if (run.status === "failed") week.failed++; }
  }
  return { mode: "full", unchanged: false, revision: `fixture-schedules-${window}`, generatedAt: new Date().toISOString(), window, schedules: empty ? [] : summaries(), runs: kept.map(row),
    older: all.length - allHeartbeats - (kept.length - keptHeartbeats), olderHeartbeats: allHeartbeats - keptHeartbeats, truncated: kept.length < all.length, week,
    reconstructed: empty ? 0 : runs.filter(run => run.source === "agent").length, error: null,
    notice: scenario === "schedules-notice" ? "定时运行账本损坏，已另存为 schedule-ledger.corrupt.json 并重新记录；已删除任务的旧运行会从 Agent 记录还原。" : null };
}

/** observatory.schedules.run: the recorded reply only exists while the schedule file does. */
export function fixtureScheduleRun(runId) {
  const run = runs.find(item => item.id === runId) ?? null;
  const schedule = run ? summaries().find(item => item.id === run.scheduleId) ?? null : null;
  const prompt = schedules.find(item => item.id === run?.scheduleId)?.prompt ?? null;
  if (!run || run.source !== "schedule") return { runId, output: null, outputTruncated: false, prompt: null, row: run ? row(run) : null, schedule,
    note: run?.source === "ledger" ? "这个定时任务已被删除，回复没有保留；可以读取会话记录查看最后回复。" : "定时任务记录已不存在，可以读取会话记录查看最后回复。" };
  return { runId, output: run.output, outputTruncated: false, prompt, row: row(run), schedule,
    note: run.output ? null : run.status === "running" ? "还在运行，结束后会记录最终回复。" : "这次运行没有记录最终回复，可以读取会话记录。" };
}

/**
 * observatory.schedules.heartbeats as the server answers it: the listed heartbeats plus what 归档已读完成 needs (codex-F16), every Agent a
 * live heartbeat wakes and whether the scan read every schedule file. `?scenario=heartbeats-error` shows a schedules directory that
 * cannot be read, `?scenario=heartbeats-partial` a scan cut short by its budget: both keep 归档已读完成 disabled with the reason.
 */
export function fixtureHeartbeatsResponse(heartbeats, scenario = null) {
  const error = scenario === "heartbeats-error" ? "定时任务目录读不出来，无法确认哪些会话还有心跳。" : null;
  const complete = scenario !== "heartbeats-error" && scenario !== "heartbeats-partial";
  const targets = [...new Set(heartbeats.filter(item => item.status !== "completed").map(item => item.agentId))].sort();
  return { mode: "full", unchanged: false, revision: `heartbeats-${heartbeats.length}-${scenario ?? "all"}`, generatedAt: new Date().toISOString(), heartbeats, truncated: false, error, complete, targets };
}
