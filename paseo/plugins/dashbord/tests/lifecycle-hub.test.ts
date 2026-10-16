import assert from "node:assert/strict";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { lifecycleHub } from "../server/lifecycle-hub";

/** The host side of `server.on`, as plugin-process.js / PluginHookHandlers.invoke run it: a structuredClone per handler. */
function fakeHost() {
  const handlers = new Map<string, Set<(input: unknown, context: unknown) => unknown>>();
  let clones = 0;
  const server = {
    on: (name: string, handler: (input: unknown, context: unknown) => unknown) => {
      let set = handlers.get(name); if (!set) { set = new Set(); handlers.set(name, set); }
      set.add(handler);
      return () => { set!.delete(handler); if (!set!.size) handlers.delete(name); };
    },
    handle: function (this: unknown) { return this; },
    before: () => () => {},
  } as unknown as PluginServerContext;
  const invoke = async (name: string, input: unknown) => {
    for (const handler of handlers.get(name) ?? []) { clones++; try { await handler(structuredClone(input), { paseo: {} }); } catch { /* the host logs and goes on */ } }
  };
  return { server, handlers, invoke, clones: () => clones };
}

test("every module's turn_ended handler runs on one host clone, in registration order (opus-F15)", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server), seen: string[] = [];
  const timeline = Array.from({ length: 50 }, (_, index) => ({ type: "assistant_message", text: `part ${index}` }));
  const inputs = new Set<unknown>();
  for (const name of ["telemetry", "stats", "results", "read-state", "quota"]) {
    hub.server.on("agent.turn_ended", async (input: unknown) => { inputs.add(input); seen.push(name); await Promise.resolve(); });
  }
  assert.equal(host.handlers.get("agent.turn_ended")?.size, 1, "a single host registration");
  await host.invoke("agent.turn_ended", { agent: { id: "a" }, turnId: "t", outcome: { kind: "completed" }, timeline });
  assert.equal(host.clones(), 1, "the host cloned the whole timeline once, not six times");
  assert.deepEqual(seen, ["telemetry", "stats", "results", "read-state", "quota"]);
  assert.equal(inputs.size, 1, "all handlers read the same copy");
  assert.deepEqual(hub.registered(), ["agent.turn_ended"]);
});

test("a failing handler does not stop the others; removal drops the host registration with the last handler", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server), seen: string[] = [];
  const removeA = hub.server.on("agent.turn_started", () => { seen.push("a"); throw new Error("boom"); });
  const removeB = hub.server.on("agent.turn_started", () => { seen.push("b"); });
  const originalError = console.error; console.error = () => {};
  try { await host.invoke("agent.turn_started", { agent: { id: "x" }, turnId: null }); } finally { console.error = originalError; }
  assert.deepEqual(seen, ["a", "b"]);
  removeA();
  assert.equal(host.handlers.get("agent.turn_started")?.size, 1, "still registered while a handler is left");
  removeB(); removeB();
  assert.equal(host.handlers.has("agent.turn_started"), false);
  assert.deepEqual(hub.registered(), []);
  // A handler registered after everything was removed registers again.
  hub.server.on("agent.turn_started", () => { seen.push("c"); });
  await host.invoke("agent.turn_started", { agent: { id: "x" }, turnId: null });
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("close removes every host registration; other context methods are the host's, called on the host", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server);
  hub.server.on("agent.created", () => {}); hub.server.on("agent.closed", () => {});
  assert.equal(host.handlers.size, 2);
  assert.equal((hub.server.handle as unknown as () => unknown)(), host.server, "bound to the host context");
  hub.close();
  assert.equal(host.handlers.size, 0);
});
