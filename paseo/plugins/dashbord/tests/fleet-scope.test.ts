import assert from "node:assert/strict";
import test from "node:test";
import { emptyFleetScope, filtersForHost, fleetScopeKey, hostEntityId, matchesFleetFilters, normalizeFleetScope, parseHostEntityId, routeEntityInput } from "../shared/fleet-scope";
import { canonicalQuery, createHostQueryCache } from "../client/host-query-cache";

test("scope identity includes every filter and time zone and has no host selection", () => {
  const a = normalizeFleetScope({ providers: ["claude", "claude"], models: ["model"], from: "2026-10-01T00:00:00Z" });
  const b = normalizeFleetScope({ ...a, providers: ["claude"] });
  assert.equal(fleetScopeKey(a), fleetScopeKey(b));
  for (const changed of [{ ...b, providers: ["codex"] }, { ...b, models: ["other"] }, { ...b, from: "2026-10-02T00:00:00Z" }]) {
    assert.notEqual(fleetScopeKey(a), fleetScopeKey(changed));
  }
  assert.notEqual(fleetScopeKey(a, { timeZone: "UTC" }), fleetScopeKey(a, { timeZone: "Asia/Taipei" }));
  assert.throws(() => normalizeFleetScope({ hostIds: [] } as never));
  assert.equal(filtersForHost(emptyFleetScope(), "mac").included, true);
  assert.equal(filtersForHost(emptyFleetScope(), "win").included, true);
});

test("duplicate IDs and escaped separators round-trip without ambiguity", () => {
  const raw = "id:%/中文", a = hostEntityId("mac:one", raw), b = hostEntityId("win", raw);
  assert.notEqual(a, b); assert.deepEqual(parseHostEntityId(a), { hostId: "mac:one", id: raw });
  assert.equal(parseHostEntityId("native-id"), null);
  assert.throws(() => parseHostEntityId("~h:mac:%oops"), /Invalid/);
});

test("entity operations cannot fan out, guess a host, or rewrite message text", () => {
  const id = hostEntityId("win", "same");
  const input = { agentId: id, text: id, arguments: { agentId: id } };
  assert.deepEqual(routeEntityInput(input, "mac"), { hostId: "win", input: { agentId: "same", text: id, arguments: { agentId: id } } });
  assert.throws(() => routeEntityInput({ agentId: "raw" }), /owning host/);
  assert.throws(() => routeEntityInput({ agentIds: [hostEntityId("mac", "a"), hostEntityId("win", "a")] }), /multiple hosts/);
  assert.throws(() => routeEntityInput({ agentIds: [hostEntityId("mac", "a"), "unknown-owner"] }), /Unqualified/);
  assert.equal(routeEntityInput({ agentId: "raw" }, "mac").hostId, "mac");
});

test("a project selection cannot silently become all projects on a different machine", () => {
  const scope = normalizeFleetScope({ projects: [hostEntityId("mac", "project")] });
  assert.deepEqual(filtersForHost(scope, "mac").filters.projects, ["project"]);
  assert.equal(filtersForHost(scope, "win").included, false);
  const filters = { ...emptyFleetScope(), providers: ["codex"], models: ["model"], from: "2026-10-01T00:00:00Z" };
  assert.equal(matchesFleetFilters({ provider: "codex", model: "model", at: "2026-10-02T00:00:00Z" }, filters), true);
  assert.equal(matchesFleetFilters({ provider: "claude", model: "model", at: "2026-10-02T00:00:00Z" }, filters), false);
  assert.equal(matchesFleetFilters({ provider: "codex", model: "model", at: null }, filters), false);
});

test("cache generations reject late replies while preserving labelled historical data", async () => {
  const cache = createHostQueryCache<string>(() => 100);
  await cache.read("mac/stats/scope-a", 1, async () => "first");
  let finish!: (value: string) => void;
  const pending = cache.read("mac/stats/scope-a", 1, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  await cache.read("mac/stats/scope-a", 2, async previous => { assert.equal(previous, undefined); return "second"; });
  finish("late"); await assert.rejects(pending, /replaced/);
  assert.deepEqual(cache.peek("mac/stats/scope-a"), { value: "second", generation: 2, collectedAt: 100 });
  await assert.rejects(cache.read("mac/stats/scope-a", 2, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(cache.peek("mac/stats/scope-a")!.value, "second");
  assert.equal(cache.peek("win/stats/scope-a"), null);
  assert.equal(cache.peek("mac/stats/scope-b"), null);
});

test("matching queries share one in-flight read and removed keys cannot reappear", async () => {
  const cache = createHostQueryCache<string>();
  let finish!: (value: string) => void, calls = 0;
  const read = () => { calls++; return new Promise<string>(resolve => { finish = resolve; }); };
  const a = cache.read("scope", 1, read), b = cache.read("scope", 1, read);
  assert.equal(a, b); await Promise.resolve(); assert.equal(calls, 1);
  cache.forget("scope"); finish("late"); await assert.rejects(a, /replaced/);
  assert.equal(cache.peek("scope"), null);
  assert.equal(canonicalQuery({ b: 2, a: 1 }), canonicalQuery({ a: 1, b: 2 }));
});
