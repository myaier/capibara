import assert from "node:assert/strict";
import test from "node:test";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { createHostRegistry, registerClientHost } from "../client/host-registry";
import { getHostIdentity, HOST_DATA_PROTOCOL, HOST_DATA_VERSION, type HostIdentity } from "../shared/host-data";

const identity = (serverId: string): HostIdentity => ({ serverId, hostname: serverId, protocol: HOST_DATA_PROTOCOL,
  version: HOST_DATA_VERSION, capabilities: ["identity", "host-rpc"], now: new Date().toISOString(), nonce: "" });
const echo = defineRpc({ name: "test.echo", input: z.object({ id: z.string() }), output: z.object({ host: z.string(), id: z.string() }) });
const fakeRpc = (host: string): PluginClientContext["rpc"] => async (contract, input) => contract.output.parse({ host, ...contract.input.parse(input) as object });

test("the registry routes identical entity IDs through their owning installation", async () => {
  const registry = createHostRegistry();
  const a = registry.register(identity("mac"), fakeRpc("mac")), b = registry.register(identity("win"), fakeRpc("win"));
  assert.deepEqual(await registry.invoke("mac", echo, { id: "same" }), { host: "mac", id: "same" });
  assert.deepEqual(await registry.invoke("win", echo, { id: "same" }), { host: "win", id: "same" });
  b();
  await assert.rejects(registry.invoke("win", echo, { id: "same" }), /unavailable/);
  assert.deepEqual(await registry.invoke("mac", echo, { id: "same" }), { host: "mac", id: "same" }); a();
});

test("old cleanup and late responses cannot remove or overwrite a replacement connection", async () => {
  const registry = createHostRegistry();
  let finish!: (value: unknown) => void;
  const slow: PluginClientContext["rpc"] = (contract) => new Promise(resolve => { finish = value => resolve(contract.output.parse(value)); });
  const old = registry.register(identity("mac"), slow);
  const pending = registry.invoke("mac", echo, { id: "old" });
  const current = registry.register(identity("mac"), fakeRpc("new-mac"));
  old();
  assert.equal(registry.getSnapshot().length, 1);
  finish({ host: "old-mac", id: "old" });
  await assert.rejects(pending, /connection changed/);
  assert.deepEqual(await registry.invoke("mac", echo, { id: "new" }), { host: "new-mac", id: "new" }); current();
});

test("two installations can perform nonce-bound peer probes and report independent host identities", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = createHostRegistry();
  const reports = new Map<string, any>();
  const calls: Array<{ target: string; method: string }> = [];
  const client = (id: string) => ({ rpc: async (contract: any, input: any) => {
    calls.push({ target: id, method: contract.name });
    if (contract.name === getHostIdentity.name) return contract.output.parse({ ...identity(id), nonce: input.nonce });
    if (contract.name === "observatory.host.diagnostics.report") { reports.set(id, input); return { accepted: true }; }
    throw new Error("Unexpected RPC");
  } }) as PluginClientContext;
  const a = registerClientHost(client("mac"), registry), b = registerClientHost(client("win"), registry);
  t.after(() => { a(); b(); });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(101);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  for (const id of ["mac", "win"]) {
    assert.equal(reports.get(id).reporterId, id);
    assert.deepEqual(reports.get(id).peers.map((peer: any) => [peer.serverId, peer.ok]), [["mac", true], ["win", true]]);
  }
  assert.ok(calls.filter(call => call.method === getHostIdentity.name).length >= 6);
});

test("unloading an installation during its handshake cannot register it later", async () => {
  const registry = createHostRegistry();
  let finish!: (value: unknown) => void;
  const client = { rpc: () => new Promise(resolve => { finish = resolve; }) } as unknown as PluginClientContext;
  const release = registerClientHost(client, registry); release();
  finish({ ...identity("late"), nonce: "registration" });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.deepEqual(registry.getSnapshot(), []);
});

test("unsupported protocols are rejected before a peer becomes routable", () => {
  const registry = createHostRegistry();
  assert.throws(() => registry.register({ ...identity("future"), protocol: 99 as 1 }, fakeRpc("future")), /Incompatible/);
  assert.deepEqual(registry.getSnapshot(), []);
});
