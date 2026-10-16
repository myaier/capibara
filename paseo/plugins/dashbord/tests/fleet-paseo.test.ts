import assert from "node:assert/strict";
import test from "node:test";
import { createFleetPaseo } from "../client/fleet-paseo";
import { hostEntityId } from "../shared/fleet-scope";

test("a foreign connection disappearing during render cannot crash the fleet or fall through to the local host", async () => {
  const calls: string[] = [];
  const hosts = [{ serverId: "mac", label: "Mac", status: "online" as const }, { serverId: "win", label: "Windows", status: "online" as const }];
  const acquire = (id: string): any => {
    if (id === "win") throw new Error("Paseo host is disconnected: win");
    return { agents: { ref: (id: string) => ({ id, refresh: async () => { calls.push(id); return { agent: { id } }; } }), subscribe: () => () => { calls.push("unsubscribe"); } } };
  };
  const api = createFleetPaseo("mac", hosts, acquire);
  const remote = api.agents.ref(hostEntityId("win", "same"));
  assert.equal(remote.id, "same");
  await assert.rejects(remote.refresh(), /disconnected/);
  assert.doesNotThrow(() => remote.timeline.subscribe(() => {}));
  const unsubscribe = api.agents.subscribe(() => {}); unsubscribe();
  assert.deepEqual(calls, ["unsubscribe"]);
  assert.equal((await api.agents.ref(hostEntityId("mac", "same")).refresh())?.agent.id, "same");
  const detail = createFleetPaseo("win", hosts, acquire);
  await assert.rejects(detail.providers.snapshot(), /disconnected/);
  assert.deepEqual(calls, ["unsubscribe", "same"]);
});

test("workspace creation remains on its source, including a frozen native handle", async () => {
  const calls: any[] = [];
  const hosts = ["mac", "win"].map(serverId => ({ serverId, label: serverId, status: "online" as const }));
  const api = createFleetPaseo("mac", hosts, (hostId: string): any => ({ workspaces: { ref: (workspaceId: string) => ({ agents: {
    create: async (input: unknown) => { calls.push({ hostId, workspaceId, input }); return Object.freeze({ id: "created" }); },
  } }) } }));
  const created = await api.workspaces.ref(hostEntityId("win", "workspace")).agents.create({ provider: "codex" } as any);
  assert.equal(created.id, hostEntityId("win", "created"));
  assert.deepEqual(calls, [{ hostId: "win", workspaceId: "workspace", input: { provider: "codex" } }]);
});
