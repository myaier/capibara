import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionActions, TitleAttempts, type TitleGenerator } from "../server/session-actions";
import { MetadataRunnerRegistry, MetadataTimeoutError } from "../server/metadata-runner";
import { isProvisionalTitle, provisionalTitle, sessionTitle, TITLE_SOURCE, TITLE_VALUE } from "../shared/session-actions";

const prompt = "帮我设计一个展示各个项目工作进度的卡通办公室，并支持跨机器查看";
const titled = (title: string): TitleGenerator => async (_paseo, sources) => new Map(sources.map(source => [source.id, title]));
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
  const service = new SessionActions(bridge, async () => "mac", async (paseo, sources, signal) => { generations++; return titled("设计跨机器卡通办公室")(paseo, sources, signal); });
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
    const f = fixture(); let finish!: (titles: ReadonlyMap<string, string>) => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const service = new SessionActions(f.bridge, async () => "mac", () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = service.autoName(f.api, f.agent.id, new AbortController().signal);
    await waiting;
    if (archive) f.agent.archivedAt = new Date().toISOString();
    else await service.rename(f.api, { serverId: "mac", agentId: f.agent.id, title: "手动命名", expectedTitle: f.agent.title });
    finish(new Map([[f.agent.id, "迟到的自动名称"]])); await pending;
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
  const service = new SessionActions(f.bridge, async () => "mac", async (_api, _sources, signal) => {
    if (signal.aborted) return null;
    return new Promise(resolve => signal.addEventListener("abort", () => resolve(null), { once: true }));
  });
  t.after(() => service.close());
  const ids = Array.from({ length: 61 }, (_, index) => `session-${index}`);
  // The first 20 become the running batch; 40 more fit in the queue behind it.
  assert.equal((await service.enqueue(f.api, "mac", ids.slice(0, 20))).queued, 20);
  assert.equal((await service.enqueue(f.api, "mac", ids.slice(0, 20))).queued, 0);
  await service.enqueue(f.api, "mac", ids.slice(20, 40));
  const overflow = await service.enqueue(f.api, "mac", ids.slice(40));
  assert.equal(overflow.handledIds.length, 20);
  assert.equal(overflow.queued, 20);
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

/** Several sessions on one host, and a light-model helper whose answers the test scripts. */
function host(texts: string[], answers: Array<(prompt: string) => Record<string, unknown>>) {
  const agents = new Map(texts.map((text, index) => [`session-${index}`, { id: `session-${index}`, title: provisionalTitle(text), provider: "claude", cwd: "/project",
    archivedAt: null as string | null, labels: {} as Record<string, string>, text }]));
  const created: Array<{ parent: unknown; prompt: string; timeout: unknown }> = [];
  const model = (id: string) => ({ id, label: id, isDefault: false, thinkingOptions: [] });
  const entries = [{ provider: "claude", enabled: true, status: "ready", modes: [{ id: "default", label: "Ask", colorTier: "safe" }], models: [model("claude-haiku-a"), model("claude-haiku-b")] }];
  const api = {
    config: { get: async () => ({ config: {} }) }, providers: { snapshot: async () => ({ entries }) },
    agents: {
      ref: (id: string) => ({ refresh: async () => { const agent = agents.get(id); return agent ? { agent: structuredClone(agent) } : null; },
        timeline: { refetch: async () => ({ rows: [{ seq: 0, item: { type: "user_message", text: agents.get(id)?.text } }], hasOlder: false }) } }),
      create: async (input: { parent: unknown; prompt: string }) => {
        const answer = answers.shift() ?? (() => ({ status: "error", error: "unscripted" }));
        created.push({ parent: input.parent, prompt: input.prompt, timeout: undefined });
        return { id: `helper-${created.length}`, current: () => null, refresh: async () => null, respondToPermission: async () => {},
          archive: async () => ({ archivedAt: "2026-10-19T00:00:00Z" }),
          waitForFinish: async () => ({ final: { pendingPermissions: [] }, lastMessage: null, ...answer(input.prompt) }) };
      },
    },
  } as unknown as PaseoApi;
  const bridge = { request: async (message: Record<string, unknown>) => {
    const agent = agents.get(message.agentId as string)!; agent.title = message.name as string; agent.labels = message.labels as Record<string, string>; return {};
  } };
  return { agents, api, bridge, created };
}
/** Answers every source the helper was given, except the ones listed. */
const answerAll = (skip: string[] = []) => (prompt: string) => {
  const sources = JSON.parse(prompt.slice(prompt.indexOf("["))) as Array<{ id: string; text: string }>;
  return { status: "idle", lastMessage: JSON.stringify({ titles: sources.filter(source => !skip.includes(source.id)).map(source => ({ id: source.id, title: `标题 ${source.id}` })) }) };
};

test("one light-model helper names a whole batch; a session the answer leaves out is recorded as failed", async () => {
  const h = host(["修复渲染器", "对齐项目颜色", "排查插件安装"], [answerAll(["s2"])]);
  const attempts = new TitleAttempts();
  const service = new SessionActions(h.bridge, async () => "mac", undefined, attempts);
  await service.autoNameBatch(h.api, [...h.agents.keys()], new AbortController().signal);
  assert.equal(h.created.length, 1, "one helper for three sessions");
  assert.equal(h.created[0].parent, "session-0");
  const sources = JSON.parse(h.created[0].prompt.slice(h.created[0].prompt.indexOf("["))) as Array<{ id: string; text: string }>;
  assert.deepEqual(sources.map(source => source.text), ["修复渲染器", "对齐项目颜色", "排查插件安装"]);
  assert.equal(h.agents.get("session-0")!.title, "标题 s1"); assert.equal(h.agents.get("session-0")!.labels[TITLE_SOURCE], "generated");
  assert.equal(h.agents.get("session-2")!.title, "标题 s3");
  assert.equal(h.agents.get("session-1")!.title, provisionalTitle("对齐项目颜色"));
  assert.equal(await attempts.due("session-1"), false); assert.equal(await attempts.due("session-0"), true);
});

test("an unreadable session is skipped and the rest of its batch is still named", async () => {
  const h = host(["修复渲染器", "对齐项目颜色"], [answerAll()]);
  const ref = h.api.agents.ref.bind(h.api.agents);
  (h.api.agents as { ref: unknown }).ref = (id: string) => id === "session-0" ? { refresh: async () => { throw new Error("socket closed"); } } : ref(id);
  await new SessionActions(h.bridge, async () => "mac").autoNameBatch(h.api, [...h.agents.keys()], new AbortController().signal);
  assert.equal(h.created.length, 1); assert.equal(h.agents.get("session-1")!.title, "标题 s1");
});

test("a timed-out helper ends the attempt; only a provider error tries the alternative light model", async () => {
  const timedOut = host(["修复渲染器", "对齐项目颜色"], [() => ({ status: "timeout" }), answerAll()]);
  const attempts = new TitleAttempts();
  const service = new SessionActions(timedOut.bridge, async () => "mac", undefined, attempts);
  await assert.rejects(service.autoNameBatch(timedOut.api, [...timedOut.agents.keys()], new AbortController().signal), MetadataTimeoutError);
  assert.equal(timedOut.created.length, 1);
  assert.equal(await attempts.due("session-0"), false); assert.equal(await attempts.due("session-1"), false);
  const failed = host(["修复渲染器"], [() => ({ status: "error", error: "provider failed" }), answerAll()]);
  await new SessionActions(failed.bridge, async () => "mac").autoNameBatch(failed.api, ["session-0"], new AbortController().signal);
  assert.equal(failed.created.length, 2); assert.equal(failed.agents.get("session-0")!.title, "标题 s1");
});

test("failed naming backs off 1 h, then 6 h, then stops, and survives a restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "title-attempts-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "title-attempts.json"), hour = 60 * 60_000;
  let now = Date.parse("2026-10-19T00:00:00Z");
  const attempts = new TitleAttempts(file, () => now);
  await attempts.failed(["a"]);
  assert.equal(await attempts.due("a"), false); now += hour; assert.equal(await attempts.due("a"), true);
  await attempts.failed(["a"]);
  now += 5 * hour; assert.equal(await attempts.due("a"), false); now += hour; assert.equal(await attempts.due("a"), true);
  await attempts.failed(["a", "b"]);
  const restarted = new TitleAttempts(file, () => now + 1000 * hour);
  assert.equal(await restarted.due("a"), false, "three failures end automatic naming");
  assert.equal(await restarted.due("b"), true);
  await restarted.succeeded(["b"]); assert.equal(await new TitleAttempts(file, () => now).due("b"), true);
  const f = fixture(), service = new SessionActions(f.bridge, async () => "mac", titled("不会调用"), new TitleAttempts(file, () => now));
  t.after(() => service.close());
  const result = await service.enqueue(f.api, "mac", ["a"]);
  assert.equal(result.queued, 0); assert.deepEqual(result.handledIds, ["a"]);
});
