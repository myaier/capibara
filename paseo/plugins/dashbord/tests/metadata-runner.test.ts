import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { PaseoApi, PaseoAgentCreateOptions, PaseoAgentHandle, PaseoAgentRunResult } from "../server/paseo-types";
import { metadataMode, runMetadataTask, type MetadataPlan, type MetadataTaskOptions } from "../server/metadata-runner";
import { extractStructuredJson } from "../server/structured-output";
import { isInternalAgent } from "../shared/internal-agents";

const schema = z.object({ title: z.string().min(1) });
const plan: MetadataPlan = { info: { provider: "codex", model: "small", thinkingOptionId: "low", modeId: "auto" },
  model: "small", effort: "low", access: "read", featureValues: { fast_mode: true, yolo: true },
  providerOptions: { sandbox_mode: "read-only", approval_policy: "never" } };
const result = (status = "idle", extra: Record<string, unknown> = {}) => ({ status, final: { pendingPermissions: [] },
  error: null, lastMessage: '{"title":"会话名称"}', ...extra }) as unknown as PaseoAgentRunResult;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(results = [result()]) {
  const created: PaseoAgentCreateOptions[] = [], denied: unknown[] = [];
  let archived = 0;
  const handle = { id: "title-helper", current: () => null, refresh: async () => null,
    archive: async () => { archived++; return { archivedAt: "2026-10-15T00:00:00Z" }; },
    waitForFinish: async () => results.shift() ?? result(), respondToPermission: async (request: unknown) => { denied.push(request); },
  } as unknown as PaseoAgentHandle;
  const paseo = { agents: { create: async (input: PaseoAgentCreateOptions) => { created.push(input); return handle; } } } as unknown as PaseoApi;
  const options: MetadataTaskOptions<z.infer<typeof schema>> = { paseo, plan, parent: { id: "parent", cwd: "/repo" }, jobId: "title-1",
    title: "Session title", prompt: "Name this task", systemPrompt: "Return only a title", schema,
    parse: text => schema.parse(extractStructuredJson(text)), signal: new AbortController().signal };
  return { handle, paseo, options, created, denied, archived: () => archived };
}

test("title generation creates a restricted metadata helper and archives it", async () => {
  const f = fixture();
  assert.equal((await runMetadataTask(f.options)).value.title, "会话名称");
  assert.equal(f.created.length, 1);
  const created = f.created[0];
  assert.equal(created.parent, "parent"); assert.equal(created.cwd, "/repo");
  assert.deepEqual(created.labels, { "observatory.role": "title", "observatory.job": "title-1" });
  assert.equal(created.autoArchive, true); assert.equal(created.config.provider, "codex/small");
  assert.deepEqual(created.config.options, { sandbox_mode: "read-only", approval_policy: "never" });
  assert.deepEqual(created.config.toolPolicy, { preapproved: [] }); assert.deepEqual(created.config.mcpServers, {});
  assert.deepEqual(created.config.featureValues, { fast_mode: true }); assert.equal(f.archived(), 1);
  assert.equal(isInternalAgent(created), true);
  assert.equal(isInternalAgent({ labels: { "observatory.role": "insight" } }), true, "legacy helpers remain excluded");
  assert.equal(isInternalAgent({ labels: {} }), false);
});

test("metadata mode selection never inherits an unrestricted parent mode", async () => {
  assert.equal(metadataMode([{ id: "agent", label: "Agent" }]).unsafe, true);
  assert.deepEqual(metadataMode([{ id: "auto", label: "Auto" }], { codex: true }).providerOptions, plan.providerOptions);
  const f = fixture();
  await assert.rejects(runMetadataTask({ ...f.options, plan: { ...plan, info: { ...plan.info, modeId: null } } }), /受限模式/);
  assert.equal(f.created.length, 0);
});

test("title helpers deny requested permissions and still archive after completion", async () => {
  const f = fixture([result("permission", { final: { pendingPermissions: [{ id: "write-file" }] } }), result()]);
  await runMetadataTask(f.options);
  assert.equal(f.denied.length, 1);
  const denied = f.denied[0] as { requestId: string; response: { behavior: string; message: string } };
  assert.equal(denied.requestId, "write-file"); assert.equal(denied.response.behavior, "deny"); assert.ok(denied.response.message.length > 0);
  assert.equal(f.archived(), 1);
});

test("invalid title output and provider errors archive the helper without a second prompt", async () => {
  for (const answer of [result("idle", { lastMessage: "not JSON" }), result("error", { error: "provider failed" }), result("timeout")]) {
    const f = fixture([answer]); await assert.rejects(runMetadataTask(f.options));
    assert.equal(f.created.length, 1); assert.equal(f.archived(), 1);
  }
});

test("canceling a pending title wait archives its helper immediately", async () => {
  const f = fixture(), waiting = deferred<void>(), done = deferred<PaseoAgentRunResult>(), controller = new AbortController();
  f.handle.waitForFinish = async () => { waiting.resolve(); return done.promise; };
  const pending = runMetadataTask({ ...f.options, signal: controller.signal });
  await waiting.promise; controller.abort(); await assert.rejects(pending, /已取消/);
  assert.equal(f.archived(), 1); done.resolve(result());
});

test("a helper created after cancellation is still archived", async () => {
  const f = fixture(), creating = deferred<PaseoAgentHandle>(), archived = deferred<void>(), controller = new AbortController();
  f.paseo.agents.create = async () => creating.promise;
  const original = f.handle.archive;
  f.handle.archive = async () => { const output = await original(); archived.resolve(); return output; };
  const pending = runMetadataTask({ ...f.options, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /已取消/);
  creating.resolve(f.handle); await archived.promise; assert.equal(f.archived(), 1);
});
