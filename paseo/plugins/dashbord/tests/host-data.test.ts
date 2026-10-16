import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readHostIdentity, registerHostData } from "../server/host-data";
import { getHostDiagnostics, getHostIdentity, reportHostDiagnostics } from "../shared/host-data";

test("host identity is the daemon server ID, not a project, account, or machine display name", async t => {
  const home = await mkdtemp(join(tmpdir(), "observatory-host-")); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "server-id"), "srv-test\n");
  const info = await readHostIdentity(home, "unique-nonce");
  assert.equal(info.serverId, "srv-test"); assert.equal(info.nonce, "unique-nonce");
  assert.equal(info.protocol, 1); assert.ok(info.capabilities.includes("host-rpc"));
});

test("diagnostics are host-bound, in-memory, and refuse work after disposal", async t => {
  const home = await mkdtemp(join(tmpdir(), "observatory-host-")); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "server-id"), "srv-own");
  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = { handle: (contract: any, handler: any) => { handlers.set(contract.name, handler); } } as unknown as PluginServerContext;
  const release = registerHostData(server, home);
  assert.equal((await handlers.get(getHostIdentity.name)!({ nonce: "n" })).nonce, "n");
  await assert.rejects(handlers.get(reportHostDiagnostics.name)!({ reporterId: "other", peers: [] }), /another host/);
  await handlers.get(reportHostDiagnostics.name)!({ reporterId: "srv-own", peers: [{ serverId: "srv-peer", version: "test", ok: true, error: null }] });
  const result = await handlers.get(getHostDiagnostics.name)!({});
  assert.equal(result.reporterId, "srv-own"); assert.equal(result.peers[0].serverId, "srv-peer"); assert.ok(result.at);
  release(); await assert.rejects(handlers.get(getHostDiagnostics.name)!({}), /disposed/);
});
