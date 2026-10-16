import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { SessionActions } from "../server/session-actions";
import { MetadataRunnerRegistry } from "../server/metadata-runner";
import { isProvisionalTitle, provisionalTitle, sessionTitle, TITLE_SOURCE, TITLE_VALUE } from "../shared/session-actions";

const prompt = "帮我设计一个展示各个项目工作进度的卡通办公室，并支持跨机器查看";
function fixture(text = prompt, title = provisionalTitle(text)) {
  const agent = { id: "same-id", title, provider: "codex", cwd: "/project", archivedAt: null as string | null,
    labels: { existing: "keep" } as Record<string, string> };
  let head = { rows: [{ seq: 0, item: { type: "user_message", text } }], hasOlder: false };
  const writes: Record<string, unknown>[] = [];
  let apply = true, generations = 0;
  const api = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(agent) }), timeline: { refetch: async () => head } }) } } as unknown as PaseoApi;
  const bridge = { request: async (message: Record<string, unknown>) => {
    writes.push(message); if (apply) { agent.title = message.name as string; agent.labels = message.labels as Record<string, string>; } return {};
  } };
  const service = new SessionActions(bridge, async () => "mac", async () => { generations++; return "设计跨机器卡通办公室"; });
  return { agent, api, writes, bridge, service, generations: () => generations, ignoreWrites() { apply = false; },
    loseHead() { head = { ...head, hasOlder: true }; } };
}
test("rename persists the name and manual priority, preserving other labels", async () => {
  const f = fixture();
  await f.service.rename(f.api, { serverId: "mac", agentId: f.agent.id, title: "  我的办公室  ", expectedTitle: f.agent.title });
  assert.equal(f.agent.title, "我的办公室"); assert.equal(f.agent.labels[TITLE_SOURCE], "manual"); assert.equal(f.agent.labels.existing, "keep");
  await f.service.autoName(f.api, f.agent.id, new AbortController().signal);
  assert.equal(f.generations(), 0); assert.equal(f.writes.length, 1);
});
test("a remote host with the same ID never writes to this host; stale dialogs and unconfirmed saves fail", async () => {
  const f = fixture(), input = { serverId: "windows", agentId: f.agent.id, title: "New", expectedTitle: f.agent.title };
  await assert.rejects(f.service.rename(f.api, input), /跨主机/); assert.equal(f.writes.length, 0);
  await assert.rejects(f.service.rename(f.api, { ...input, serverId: "mac", expectedTitle: "stale" }), /其他地方/); assert.equal(f.writes.length, 0);
  f.ignoreWrites(); await assert.rejects(f.service.rename(f.api, { ...input, serverId: "mac" }), /尚未确认/);
});
test("automatic naming only changes a proven provisional title and is idempotent", async () => {
  const f = fixture();
  await f.service.autoName(f.api, f.agent.id, new AbortController().signal);
  assert.equal(f.agent.title, "设计跨机器卡通办公室"); assert.equal(f.agent.labels[TITLE_SOURCE], "generated");
  assert.equal(f.agent.labels[TITLE_VALUE], f.agent.title);
  await f.service.autoName(f.api, f.agent.id, new AbortController().signal);
  assert.equal(f.generations(), 1);
  for (const update of [(x: ReturnType<typeof fixture>) => { x.agent.title = "已有原生名称"; },
    (x: ReturnType<typeof fixture>) => { x.agent.archivedAt = new Date().toISOString(); }, (x: ReturnType<typeof fixture>) => x.loseHead()]) {
    const another = fixture(); update(another); await another.service.autoName(another.api, another.agent.id, new AbortController().signal);
    assert.equal(another.generations(), 0); assert.equal(another.writes.length, 0);
  }
});
test("a Codex skill recorded as $name still matches the slash-command title the host derived", async () => {
  for (const [title, text] of [["/find-projects", "$find-projects"], ["/find-projects 宁夏 本周", "$find-projects 宁夏 本周"], ["/review", "$review 检查\n最近改动"]]) {
    assert.ok(isProvisionalTitle(title, text), title);
    const f = fixture(text, title); await f.service.autoName(f.api, f.agent.id, new AbortController().signal);
    assert.equal(f.generations(), 1); assert.equal(f.agent.labels[TITLE_SOURCE], "generated");
  }
  for (const [title, text] of [["/find-projects", "$find-projects-old"], ["/find-projects", "find-projects"], ["查找项目", "$find-projects"], ["/a/b", "$a/b"]]) {
    assert.ok(!isProvisionalTitle(title, text), title);
    const f = fixture(text, title); await f.service.autoName(f.api, f.agent.id, new AbortController().signal);
    assert.equal(f.generations(), 0); assert.equal(f.writes.length, 0);
  }
});
test("a late model answer cannot replace a manual rename or resurrect an archived session", async () => {
  for (const archive of [false, true]) {
    const f = fixture(); let finish!: (title: string) => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const service = new SessionActions(f.bridge, async () => "mac", () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = service.autoName(f.api, f.agent.id, new AbortController().signal);
    await waiting;
    if (archive) f.agent.archivedAt = new Date().toISOString();
    else await service.rename(f.api, { serverId: "mac", agentId: f.agent.id, title: "手动命名", expectedTitle: f.agent.title });
    finish("迟到的自动名称"); await pending;
    assert.equal(f.writes.length, archive ? 0 : 1);
    assert.notEqual(f.agent.title, "迟到的自动名称");
  }
});
test("model failure retains the original title; empty and multiline manual names are rejected", async () => {
  const f = fixture(), service = new SessionActions(f.bridge, async () => "mac", async () => { throw new Error("No quota"); });
  await assert.rejects(service.autoName(f.api, f.agent.id, new AbortController().signal));
  assert.equal(f.agent.title, provisionalTitle(prompt)); assert.equal(f.writes.length, 0);
  for (const name of [" ", "line\nbreak", "a".repeat(161)]) assert.equal(sessionTitle.safeParse(name).success, false);
});
test("manual input wins if an automatic name was saved while the rename dialog was open", async () => {
  const f = fixture(), expectedTitle = f.agent.title;
  await f.service.autoName(f.api, f.agent.id, new AbortController().signal);
  await f.service.rename(f.api, { serverId: "mac", agentId: f.agent.id, title: "用户最终名称", expectedTitle });
  assert.equal(f.agent.title, "用户最终名称"); assert.equal(f.agent.labels[TITLE_SOURCE], "manual");
});
test("queue capacity leaves overflow eligible for a later request and deduplicates accepted work", async t => {
  const f = fixture();
  const service = new SessionActions(f.bridge, async () => "mac", async (_api, _id, _prompt, signal) => {
    if (signal.aborted) return null;
    return new Promise(resolve => signal.addEventListener("abort", () => resolve(null), { once: true }));
  });
  t.after(() => service.close());
  const ids = Array.from({ length: 60 }, (_, index) => `session-${index}`);
  assert.equal((await service.enqueue(f.api, "mac", ids.slice(0, 20))).queued, 20);
  assert.equal((await service.enqueue(f.api, "mac", ids.slice(0, 20))).queued, 0);
  await service.enqueue(f.api, "mac", ids.slice(20, 40));
  const overflow = await service.enqueue(f.api, "mac", ids.slice(40));
  assert.equal(overflow.handledIds.length, 1);
  assert.equal(overflow.queued, 1);
});
test("title selection uses listed ready light models and the lowest supported effort, never the large default", async () => {
  const model = (id: string, efforts = ["high", "low", "minimal"]) => ({ id, label: id, isDefault: id.includes("astra"), defaultThinkingOptionId: "high",
    thinkingOptions: efforts.map(id => ({ id, label: id })) });
  const entries = [
    { provider: "codex", enabled: true, status: "ready", modes: [{ id: "auto", label: "Auto" }], models: [model("gpt-6-astra"), model("gpt-6-luna"), model("gpt-5.4-mini")] },
    { provider: "claude", enabled: true, status: "ready", modes: [{ id: "default", label: "Ask", colorTier: "safe" }], models: [model("claude-haiku")] },
    { provider: "broken", enabled: true, status: "error", modes: [{ id: "ask", label: "Ask" }], models: [model("fast-nano")] },
  ];
  const api = { config: { get: async () => ({ config: {} }) }, providers: { snapshot: async () => ({ entries }) } } as unknown as PaseoApi;
  const registry = new MetadataRunnerRegistry(api);
  const plans = await registry.titlePlans("codex");
  assert.equal(plans.length, 2); assert.ok(plans.every(plan => plan.info.provider === "codex" && plan.effort === "minimal" && !plan.model.includes("astra")));
  const claude = await registry.titlePlans("claude"); assert.equal(claude[0].model, "claude-haiku");
});
