import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { createElement } from "react";
import type { AttentionResponse, AttentionSummary } from "../shared/attention";

// The badge store reads AppState from react-native (Flow source node cannot load) and RPCs from the host SDK: stub both.
const rpcInputs: unknown[] = [];
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const stubs: Record<string, unknown> = {
  "react-native": { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } },
  "@getpaseo/plugin/client": { useHosts: () => [], useRpc: () => async (input: unknown) => { rpcInputs.push(input); throw new Error("not used"); }, usePaseo: () => { throw new Error("not used"); } },
};
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };

const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };

const summary = (patch: Partial<AttentionSummary> = {}): AttentionSummary => ({ count: 1, truncated: false, blocking: 0, loud: 0, entries: [], scheduleFailures: 0, ready: true, failed: false, ...patch });
const full = (count: number, revision: string): AttentionResponse => ({ ...summary({ count }), mode: "full", unchanged: false, revision });

test("every badge read carries the device's zone, unless the device reports one the RPC cannot take (grok-F2)", async () => {
  const { withDeviceZone, deviceTimeZone } = await import("../client/use-attention");
  const calls: Array<{ revision?: string; timeZone?: string }> = [];
  const read = async (input: { revision?: string; timeZone?: string }) => { calls.push(input); return full(1, "r"); };
  await withDeviceZone(read, () => "US/Pacific")({});
  await withDeviceZone(read, () => "US/Pacific")({ revision: "r" });
  await withDeviceZone(read, () => null)({ revision: "r" });
  assert.deepEqual(calls, [{ timeZone: "US/Pacific" }, { revision: "r", timeZone: "US/Pacific" }, { revision: "r" }]);
  // The process's own zone is reported in the RPC's form (or not at all).
  const zone = deviceTimeZone();
  assert.ok(zone === null || /^[A-Za-z][\w+-]*(\/[\w+-]+){0,2}$/.test(zone), String(zone));
});

test("知道了 here reads the badge again at once, after a read already in flight (opus-F34)", async () => {
  const { createAttentionStore } = await import("../client/use-attention");
  const store = createAttentionStore(60_000);
  let release!: () => void, count = 2;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: number[] = [];
  store.read = async () => { calls.push(count); if (calls.length === 1) await gate; return full(count, `r${calls.length}`); };
  const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
  const first = store.refresh();
  // The acknowledgement lands while that read is out: its answer may predate it.
  count = 1; store.invalidate(); store.invalidate();
  release(); await first; await settle();
  assert.deepEqual(calls, [2, 1], "exactly one more read after the one in flight");
  assert.equal(store.getSnapshot().state?.count, 1);
  // Nothing in flight: it reads now.
  count = 0; store.invalidate(); await settle();
  assert.deepEqual(calls, [2, 1, 0]);
  assert.equal(store.getSnapshot().state?.count, 0);
});

// The resident stub and the UI chunk are separate bundles: the stub makes one set of stores per registration and hands it
// to the chunk's surfaces as a prop, which provide it to the detail. A reconnect evaluates a fresh stub with a fresh set.
test("one store per host and registration; a detail's 知道了 in the chunk re-reads the badge's store through the provider", async () => {
  const { createAttentionStores } = await import("../client/use-attention");
  const { AttentionStoresContext, useInvalidateAttention } = await import("../client/attention-context");
  const stores = createAttentionStores();
  assert.equal(stores.get("host-a"), stores.get("host-a"));
  assert.notEqual(stores.get("host-b"), stores.get("host-a"), "hosts stay apart");
  assert.notEqual(createAttentionStores().get("host-a"), stores.get("host-a"), "a new registration (a reconnect) starts afresh");
  const calls: Array<{ revision?: string; timeZone?: string }> = [];
  stores.get("host-a").read = async input => { calls.push(input); return full(2, "r1"); };
  let invalidate: ((hostId: string) => void) | undefined;
  const Probe = () => { invalidate = useInvalidateAttention(); return null; };
  renderToString(createElement(AttentionStoresContext.Provider, { value: stores }, createElement(Probe)));
  invalidate!("host-a"); invalidate!("host-c");
  for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, "the badge's store for that host read again");
  assert.equal(stores.get("host-a").getSnapshot().state?.count, 2);
  // No provider (a surface the stub did not hand the stores to): nothing to read again, nothing thrown.
  renderToString(createElement(Probe));
  invalidate!("host-a");
  assert.equal(calls.length, 1);
});

test("the badge's own store reports the device's zone with every read it sends (grok-F2)", async () => {
  const { createAttentionStores, useAttentionStore, deviceTimeZone } = await import("../client/use-attention");
  let store!: ReturnType<typeof useAttentionStore>;
  function Probe() { store = useAttentionStore(createAttentionStores(), "host-zone"); return null; }
  renderToString(createElement(Probe));
  const zone = deviceTimeZone();
  await assert.rejects(store.read!({ revision: "r7" }), /not used/);
  assert.deepEqual(rpcInputs.at(-1), zone ? { revision: "r7", timeZone: zone } : { revision: "r7" });
});
