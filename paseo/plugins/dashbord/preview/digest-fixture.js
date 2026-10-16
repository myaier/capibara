// Development-only synthetic execution digest (复盘). A scripted session is simulated step by step, so turns, lanes,
// time share, files, commands, checks, highlights and tokens all agree with each other.
import { DIGEST_LANES } from "../shared/digest";
import { addTokenCounts, emptyTokenCounts } from "../shared/tokens";

const scenario = () => new URLSearchParams(globalThis.location?.search ?? "").get("scenario");
function random(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash = text => [...text].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
const round = Math.round, S = 1000;

// Step: [lane, label, seconds, extra]; extra: { fail, file, added, removed, check, think, wait, seq, running, compaction, agent }
const payment = [
  { prompt: "梳理支付服务现有的请求链路，找出重复扣款的风险点", reply: "链路梳理完毕：重复扣款风险集中在回调重试和并发下单两处，建议用幂等键加唯一约束兜底。", steps: [
    ["plan", "TodoWrite · 梳理计划", 1], ["search", "Grep · createPayment", 2], ["search", "Grep · retryCallback", 2],
    ["read", "Read · src/payments/create-payment.ts", 1, { file: "src/payments/create-payment.ts", seq: 4 }], ["read", "Read · src/payments/callback-handler.ts", 1, { file: "src/payments/callback-handler.ts" }],
    ["read", "Read · src/payments/retry-policy.ts", 1, { file: "src/payments/retry-policy.ts" }], ["read", "Read · src/orders/order-service.ts", 1, { file: "src/orders/order-service.ts" }],
    ["shell", "Bash · git log --oneline -20 -- src/payments", 1], ["web", "WebFetch · docs.stripe.com/idempotency", 6], ["read", "Read · db/schema.sql", 1, { file: "db/schema.sql" }],
  ] },
  { prompt: "按方案实现幂等键：数据库唯一约束 + 请求去重中间件", reply: "幂等键已接入：新增唯一约束迁移和去重中间件，支付测试 42 项全部通过。", steps: [
    ["read", "Read · src/payments/idempotency.ts", 1, { file: "src/payments/idempotency.ts" }],
    ["edit", "Edit · src/payments/idempotency.ts", 2, { file: "src/payments/idempotency.ts", added: 186, removed: 42 }],
    ["edit", "Edit · src/payments/create-payment.ts", 1, { file: "src/payments/create-payment.ts", added: 38, removed: 12 }],
    ["edit", "Write · migrations/2026_09_add_idempotency_key.sql", 1, { file: "migrations/2026_09_add_idempotency_key.sql", added: 24 }],
    ["shell", "Bash · npm run db:migrate -- --dry-run", 14, { wait: 212 }],
    ["shell", "Bash · npm run test:payments", 48, { check: "test", fail: true }],
    ["edit", "Edit · src/payments/idempotency.ts", 1, { file: "src/payments/idempotency.ts", added: 12, removed: 6 }],
    ["shell", "Bash · npm run test:payments", 51, { check: "test", fail: true }],
    ["edit", "Edit · src/payments/idempotency.ts", 1, { file: "src/payments/idempotency.ts", added: 4, removed: 2 }],
    ["shell", "Bash · npm run test -- --runInBand", 47, { check: "test", seq: 5 }],
  ] },
  { prompt: "补充并发重试的集成测试，并确认数据库约束在高并发下生效", reply: "并发集成测试已补齐：120 个并发请求只落库一次，子任务确认唯一约束生效。", steps: [
    ["agent", "Task · 验证数据库唯一约束", 362, { seq: 6, agent: "验证数据库唯一约束" }],
    ["edit", "Write · tests/payments/concurrency.spec.ts", 2, { file: "tests/payments/concurrency.spec.ts", added: 142 }],
    ["shell", "Bash · npm run test:integration", 252, { check: "test" }],
  ] },
  { prompt: "跑一遍全量类型检查和 lint，然后提交代码", reply: "类型检查与 lint 通过，已提交并推送 feature/payments-v2。", steps: [
    ["shell", "Bash · npx tsc --noEmit", 22, { check: "typecheck" }], ["shell", "Bash · npm run lint", 18, { check: "lint", fail: true }],
    ["edit", "Edit · src/payments/idempotency.ts", 1, { file: "src/payments/idempotency.ts", added: 2, removed: 2 }], ["shell", "Bash · npm run lint", 17, { check: "lint" }],
    ["shell", "Bash · git add -A && git commit -m \"feat(payments): 幂等请求\"", 2, { git: "提交代码" }], ["shell", "Bash · git push origin feature/payments-v2", 4, { git: "推送分支" }],
  ], after: 7_200 },
  { prompt: "回调重试在网络抖动时会不会重复入账？再确认一下", reply: "不会：回调带同一幂等键，第二次命中唯一约束后直接返回首个结果；已补充说明到 README。", compaction: true, steps: [
    ["read", "Read · src/payments/callback-handler.ts", 1, { file: "src/payments/callback-handler.ts", think: 215 }], ["search", "Grep · idempotencyKey", 2],
    ["read", "Read · src/payments/idempotency.ts", 1, { file: "src/payments/idempotency.ts" }], ["edit", "Edit · README.md", 1, { file: "README.md", added: 18, removed: 1 }],
  ] },
  { prompt: "把幂等中间件接到退款接口上", reply: "退款接口已接入幂等中间件，正在跑并发回归。", steps: [
    ["read", "Read · src/payments/refund.ts", 1, { file: "src/payments/refund.ts" }], ["edit", "Edit · src/payments/refund.ts", 2, { file: "src/payments/refund.ts", added: 56, removed: 8 }],
    ["shell", "Bash · npm run test:concurrency", 140, { check: "test", running: true, seq: 8 }],
  ] },
];
const release = [
  { prompt: "检查本次发布的测试与数据库连接", reply: "集成测试未通过：staging 数据库连接超时，已保留失败上下文。", failed: true, steps: [
    ["shell", "Bash · npm run build", 38, { check: "build" }], ["shell", "Bash · npm run test:integration", 64, { check: "test", fail: true, seq: 2 }],
    ["shell", "Bash · nc -z staging-database 5432", 11, { fail: true }], ["shell", "Bash · npm run test:integration", 66, { check: "test", fail: true }],
    ["shell", "Bash · npm run test:integration", 65, { check: "test", fail: true }],
  ] },
];

function simulate(agentId, now) {
  const rand = random(hash(agentId));
  const running = ["payment-root", "payment-idempotency", "migration-review"].includes(agentId);
  const failedAgent = agentId === "release-check";
  const script = failedAgent ? release : running ? payment : payment.slice(0, 5);
  const segments = [], turns = [], calls = [], files = new Map(), commands = new Map(), checks = [], highlights = [];
  let t = 0, seq = 20, turnIndex = 0;
  const addSegment = (lane, start, end, status, label, extra = {}) => segments.push({ lane, start, end, status, label, turn: turnIndex, n: 1, seq: extra.seq ?? (seq += 3), _extra: extra });
  for (const turn of script) {
    turnIndex++;
    if (turnIndex > 1) t += (turn.after ?? 60 + rand() * 340) * S;
    const start = t, before = segments.length;
    const think = seconds => { if (seconds >= 1) { addSegment("model", t, t + seconds * S, "ok", "思考"); const tps = 40 + rand() * 45, output = round(Math.min(seconds, 60) * tps * (0.4 + rand() * 0.5)), context = 70_000 + turnIndex * 16_000 + round(rand() * 20_000);
      calls.push({ at: t + seconds * S, start: t, output, cacheRead: round(context * 0.95), cacheWrite: round(context * 0.04), input: round(context * 0.01), turn: turnIndex }); } t += seconds * S; };
    for (const [lane, label, seconds, extra = {}] of turn.steps) {
      think(extra.think ?? 4 + rand() * 24);
      if (extra.wait) { addSegment("wait", t, t + extra.wait * S, "ok", "等待审批 · 数据库迁移"); t += extra.wait * S; }
      const status = extra.running ? "running" : extra.fail ? "failed" : "ok";
      const end = extra.running ? t + seconds * S : t + seconds * S;
      addSegment(lane, t, end, status, label, extra);
      if (extra.file) { const file = files.get(extra.file) ?? { path: extra.file, reads: 0, edits: 0, added: 0, removed: 0, lastAt: 0, turns: [] };
        if (lane === "read") file.reads++; else file.edits++; file.added += extra.added ?? 0; file.removed += extra.removed ?? 0; file.lastAt = end; if (!file.turns.includes(turnIndex)) file.turns.push(turnIndex); files.set(extra.file, file); }
      if (lane === "shell") { const words = label.replace(/^Bash · /, "").split(/\s+/), program = words[0] === "npx" ? words[1] : words[0];
        const entry = commands.get(program) ?? { program, runs: 0, failures: 0, ms: 0, sample: "" }; entry.runs++; if (extra.fail) entry.failures++; entry.ms += seconds * S; entry.sample = label.replace(/^Bash · /, ""); commands.set(program, entry); }
      if (extra.check) checks.push({ kind: extra.check, start: t, end: extra.running ? null : end, command: label.replace(/^Bash · /, ""), ok: extra.running ? null : !extra.fail, turn: turnIndex, seq: segments.at(-1).seq });
      t = end;
    }
    if (turnIndex < script.length || !running) think(8 + rand() * 18);
    const own = segments.slice(before), last = turnIndex === script.length && running;
    turns.push({ start, end: last ? null : t, turn, own, last });
  }
  return { segments, turns, calls, files, commands, checks, highlights, script, running, failedAgent, total: t };
}

export function fixtureDigest(agentId, now = Date.now()) {
  if (scenario() === "digest-error") throw new Error("模拟复盘读取失败");
  const sim = simulate(agentId, now);
  // Running agents end now; others ended 25 minutes ago.
  const shift = (sim.running ? now : now - 25 * 60_000) - sim.total;
  const at = value => round(value + shift);
  const empty = scenario() === "digest-empty";
  const lanes = () => Object.fromEntries(DIGEST_LANES.map(lane => [lane, 0]));
  const segments = sim.segments.map(({ _extra, ...segment }) => ({ ...segment, start: at(segment.start), end: at(segment.end) }));
  const share = list => { const time = lanes(); for (const segment of list) time[segment.lane] += segment.end - segment.start; return time; };
  const callsByTurn = new Map();
  for (const call of sim.calls) callsByTurn.set(call.turn, addTokenCounts(callsByTurn.get(call.turn) ?? emptyTokenCounts(), { calls: 1, input: call.input, cacheWrite: call.cacheWrite, cacheRead: call.cacheRead, output: call.output, genMs: call.at - call.start, genOutput: call.output }));
  const turns = sim.turns.map(({ start, end, turn, own, last }, index) => {
    const tools = own.filter(segment => segment.lane !== "model" && segment.lane !== "wait"), counted = lanes();
    for (const segment of tools) counted[segment.lane]++;
    const edited = new Set(own.filter(segment => segment.lane === "edit").map(segment => segment._extra.file));
    const shells = own.filter(segment => segment.lane === "shell"), checks = own.filter(segment => segment._extra.check && segment.status !== "running");
    return { index: index + 1, turnId: `fixture-turn-${index + 1}`, start: at(start), end: end === null ? null : at(end),
      outcome: last ? "running" : turn.failed ? "failed" : "completed", prompt: turn.prompt, reply: turn.reply,
      tools: tools.length, failures: tools.filter(segment => segment.status === "failed").length, lanes: counted,
      files: edited.size, added: own.reduce((sum, segment) => sum + (segment._extra.added ?? 0), 0), removed: own.reduce((sum, segment) => sum + (segment._extra.removed ?? 0), 0),
      commands: shells.length, checksPassed: checks.filter(segment => segment.status === "ok").length, checksFailed: checks.filter(segment => segment.status === "failed").length,
      time: share(own.map(segment => ({ ...segment, end: segment.status === "running" ? segment.end : segment.end }))), tokens: callsByTurn.get(index + 1) ?? null };
  });
  const timeShare = share(segments);
  const checks = sim.checks.map(check => ({ ...check, start: at(check.start), end: check.end === null ? null : at(check.end) }));
  // Highlights, most important first.
  const highlights = [];
  const byKind = new Map();
  for (const check of checks) (byKind.get(check.kind) ?? byKind.set(check.kind, []).get(check.kind)).push(check);
  const kindNames = { test: "测试", typecheck: "类型检查", lint: "代码检查", build: "构建", install: "依赖安装" };
  for (const [kind, list] of byKind) {
    const failures = list.filter(check => check.ok === false), lastRun = list.filter(check => check.ok !== null).at(-1);
    if (failures.length && lastRun?.ok) highlights.push({ kind: "check_fixed", severity: "good", at: lastRun.end ?? lastRun.start, turn: lastRun.turn, title: `${kindNames[kind]}失败 ${failures.length} 次后通过`, detail: lastRun.command, value: failures.length, seq: lastRun.seq });
    else if (failures.length) highlights.push({ kind: "check_failed", severity: "bad", at: failures.at(-1).start, turn: failures.at(-1).turn, title: `${kindNames[kind]}失败 ${failures.length} 次`, detail: failures.at(-1).command, value: failures.length, seq: failures.at(-1).seq });
    else if (lastRun) highlights.push({ kind: "check_passed", severity: "good", at: lastRun.end ?? lastRun.start, turn: lastRun.turn, title: `${kindNames[kind]}通过`, detail: lastRun.command, value: list.length, seq: lastRun.seq });
  }
  if (sim.failedAgent) {
    highlights.push({ kind: "turn_failed", severity: "bad", at: at(sim.total), turn: 1, title: "这一轮以失败结束", detail: "集成测试未通过：数据库连接超时。", value: null, seq: 3 });
    const lastFailure = segments.filter(segment => segment.status === "failed").at(-1);
    highlights.push({ kind: "fail_streak", severity: "bad", at: lastFailure.start, turn: 1, title: "连续 4 次失败", detail: "npm run test:integration", value: 4, seq: lastFailure.seq });
  }
  const tools = segments.filter(segment => !["model", "wait"].includes(segment.lane));
  for (const segment of [...tools].filter(segment => segment.end - segment.start >= 60_000 && segment.status !== "running").sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 2))
    highlights.push({ kind: "slow_tool", severity: "warn", at: segment.start, turn: segment.turn, title: segment.lane === "agent" ? "最久的子任务" : "最慢的命令", detail: segment.label.replace(/^\w+ · /, ""), value: segment.end - segment.start, seq: segment.seq });
  for (const segment of segments.filter(segment => segment.lane === "wait" && segment.end - segment.start >= 60_000))
    highlights.push({ kind: "approval_wait", severity: "warn", at: segment.start, turn: segment.turn, title: "等你审批", detail: "npm run db:migrate -- --dry-run", value: segment.end - segment.start, seq: segment.seq });
  for (const segment of segments.filter(segment => segment.lane === "model" && segment.end - segment.start >= 180_000))
    highlights.push({ kind: "long_think", severity: "info", at: segment.start, turn: segment.turn, title: "长时间思考", detail: "读代码前先推演了回调重试的时序", value: segment.end - segment.start, seq: null });
  const edits = sim.segments.filter(segment => segment.lane === "edit" && (segment._extra.added ?? 0) + (segment._extra.removed ?? 0) >= 80).sort((a, b) => (b._extra.added + (b._extra.removed ?? 0)) - (a._extra.added + (a._extra.removed ?? 0)));
  for (const segment of edits.slice(0, 2)) highlights.push({ kind: "big_edit", severity: "info", at: at(segment.start), turn: segment.turn, title: "大改动", detail: `${segment._extra.file} +${segment._extra.added} −${segment._extra.removed ?? 0}`, value: segment._extra.added + (segment._extra.removed ?? 0), seq: segment.seq });
  for (const segment of sim.segments.filter(segment => segment._extra.git)) highlights.push({ kind: "git", severity: "good", at: at(segment.start), turn: segment.turn, title: segment._extra.git, detail: segment.label.replace(/^Bash · /, ""), value: null, seq: segment.seq });
  for (const segment of sim.segments.filter(segment => segment._extra.agent)) highlights.push({ kind: "subagent", severity: "info", at: at(segment.start), turn: segment.turn, title: "派出子 Agent", detail: segment._extra.agent, value: segment.end - segment.start, seq: segment.seq });
  sim.turns.forEach(({ turn, start }, index) => { if (turn.compaction) highlights.push({ kind: "compaction", severity: "info", at: at(start), turn: index + 1, title: "上下文压缩", detail: "对话过长，已自动压缩早期内容", value: null, seq: null }); });
  const tokenTotals = sim.calls.reduce((sum, call) => addTokenCounts(sum, { calls: 1, input: call.input, cacheWrite: call.cacheWrite, cacheRead: call.cacheRead, output: call.output, genMs: call.at - call.start, genOutput: call.output }), emptyTokenCounts());
  const heavy = turns.filter(turn => turn.tokens).sort((a, b) => (b.tokens.cacheRead + b.tokens.output) - (a.tokens.cacheRead + a.tokens.output))[0];
  const all = tokenTotals.cacheRead + tokenTotals.cacheWrite + tokenTotals.input + tokenTotals.output;
  if (heavy && turns.length >= 3) { const share = (heavy.tokens.cacheRead + heavy.tokens.cacheWrite + heavy.tokens.input + heavy.tokens.output) / all;
    if (share >= 0.35) highlights.push({ kind: "token_heavy", severity: "warn", at: heavy.start, turn: heavy.index, title: `第 ${heavy.index} 轮用掉 ${round(share * 100)}% 的 Token`, detail: heavy.prompt, value: share, seq: null }); }
  const rank = { bad: 0, warn: 1, good: 2, info: 3 };
  highlights.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at - a.at);
  const fileList = [...sim.files.values()].map(file => ({ ...file, lastAt: at(file.lastAt) })).sort((a, b) => (b.edits * 2 + b.reads) - (a.edits * 2 + a.reads));
  const running = sim.running;
  const digest = {
    agentId, generatedAt: new Date(now).toISOString(), epoch: `fixture-${agentId}`,
    start: at(0), end: running ? now : at(sim.total), activeMs: turns.reduce((sum, turn) => sum + ((turn.end ?? now) - turn.start), 0), running,
    totals: { turns: turns.length, tools: tools.length, failures: tools.filter(segment => segment.status === "failed").length, files: new Set(sim.segments.filter(segment => segment.lane === "edit").map(segment => segment._extra.file)).size,
      added: turns.reduce((sum, turn) => sum + turn.added, 0), removed: turns.reduce((sum, turn) => sum + turn.removed, 0), commands: segments.filter(segment => segment.lane === "shell").length,
      checksPassed: checks.filter(check => check.ok === true).length, checksFailed: checks.filter(check => check.ok === false).length,
      approvals: segments.filter(segment => segment.lane === "wait").length, waitMs: timeShare.wait, errors: sim.failedAgent ? 1 : 0,
      compactions: sim.script.filter(turn => turn.compaction).length, subagents: segments.filter(segment => segment.lane === "agent").length, messages: turns.length * 2 },
    timeShare, turns, segments, files: fileList.slice(0, 40), commands: [...sim.commands.values()].sort((a, b) => b.runs - a.runs), checks, highlights: highlights.slice(0, 30),
    tokens: { source: agentId.startsWith("migration") ? "claude" : "codex", totals: tokenTotals,
      calls: sim.calls.map(call => [at(call.at), call.output, call.input + call.cacheWrite + call.cacheRead, call.at - call.start >= 1000 ? round(call.output / ((call.at - call.start) / 1000) * 10) / 10 : null]) },
    coverage: { rows: sim.segments.length * 3 + 40, truncated: false },
  };
  if (empty) return { ...digest, start: null, end: null, activeMs: 0, running: false, epoch: null, totals: Object.fromEntries(Object.keys(digest.totals).map(key => [key, 0])), timeShare: lanes(),
    turns: [], segments: [], files: [], commands: [], checks: [], highlights: [], tokens: null, coverage: { rows: 0, truncated: false } };
  return digest;
}
