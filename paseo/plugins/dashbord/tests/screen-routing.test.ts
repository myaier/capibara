import assert from "node:assert/strict";
import test from "node:test";
import { PluginIdSchema } from "@getpaseo/protocol/plugin-config";
import { logicalScreenId, screenForHost, screenLocationForHost, screenOwner } from "../shared/screen-routing";
import { hostEntityId } from "../shared/fleet-scope";

test("real screen IDs have one installation match and remain stable across peer reconnects", () => {
  const hosts = ["srv_demo-62xVrz", "srv_demo_HPowul", "host_A", "host_a", "host-0041", "hostA"];
  const ids = hosts.map(host => screenForHost("observatory", host));
  assert.equal(new Set(ids).size, hosts.length);
  for (const [index, id] of ids.entries()) {
    assert.equal(PluginIdSchema.parse(id), id, "Paseo must accept the contribution ID");
    assert.equal(screenOwner(id), hosts[index]);
    assert.equal(logicalScreenId(id), "observatory");
    assert.equal(hosts.filter(host => screenForHost("observatory", host) === id).length, 1);
    assert.equal(screenForHost("observatory", hosts[index]), id);
  }
});

test("legacy links acquire ownership and moving a view preserves the entity's original machine", () => {
  const legacy = screenLocationForHost({ screenId: "observatory", params: { agent: "same", focus: "attention" } }, "win");
  assert.equal(legacy.params?.agent, hostEntityId("win", "same"));
  const moved = screenLocationForHost(legacy, "mac");
  assert.equal(moved.screenId, screenForHost("observatory", "mac"));
  assert.deepEqual(moved.params, legacy.params);
  assert.equal(screenLocationForHost({ screenId: screenForHost("schedule-runs", "win"), params: { schedule: "job" } }, "mac").params?.schedule, hostEntityId("win", "job"));
  assert.throws(() => screenLocationForHost({ screenId: "observatory--bad_escape" }, "mac"), /Invalid/);
});
