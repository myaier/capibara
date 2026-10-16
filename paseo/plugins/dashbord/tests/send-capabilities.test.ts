import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { createElement } from "react";
import { getSteerableProviders } from "../shared/steer";

// The client hook that reads the host's send capabilities, called with the host SDK stubbed: `useRpc` answers like the server's
// handler (its reply parsed by the RPC's schema) and `useQuery` hands back its options, so the query function runs as the
// query would. Render the hook through React; the fleet context is a real hook even with a stubbed transport.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const web = require("react-native-web"), reactQuery = require("@tanstack/react-query");
const queries: Array<{ queryKey: unknown; queryFn(): Promise<unknown> }> = [];
let reply: unknown = null;
const stubs: Record<string, unknown> = {
  "react-native": web,
  "@getpaseo/plugin/client/react-native": { Icon: ({ name }: { name: string }) => createElement("i", { "data-icon": name }), useToast: () => ({ show() {}, error() {} }),
    Modal: Object.assign(() => null, { Content: () => null }), ScrollView: web.ScrollView, TextInput: web.TextInput, FlatList: web.FlatList, copyText: async () => {} },
  "@getpaseo/plugin/client": { usePaseo: () => ({}), useRpc: (contract: { name: string; output: { parse(value: unknown): unknown } }) => async () => contract.output.parse(reply) },
  "@tanstack/react-query": { ...reactQuery, useQuery: (options: { queryKey: unknown; queryFn(): Promise<unknown> }) => { queries.push(options); return { data: undefined, isError: false }; } },
};
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };

// codex-obs-send-ui-F3: what reaches checkSend / sendChecked (the sheet's and the quick replies') is all three lists the server sent.
test("useSteerableProviders hands checkSend the bases the server sent, and an older server's reply as no bases", async () => {
  const { useSteerableProviders } = await import("../client/use-send-capabilities");
  reply = { providers: ["claude", "codex", "my-codex", "my-pi"], slashSteerable: ["claude"], bases: { "my-codex": "codex", "my-pi": "pi" } };
  require("react-dom/server").renderToString(createElement(() => { useSteerableProviders(true); return null; }));
  assert.deepEqual(await queries.at(-1)!.queryFn(), { steerable: ["claude", "codex", "my-codex", "my-pi"], slashSteerable: ["claude"], bases: { "my-codex": "codex", "my-pi": "pi" } });
  reply = { providers: ["claude"] };
  require("react-dom/server").renderToString(createElement(() => { useSteerableProviders(true); return null; }));
  assert.deepEqual(await queries.at(-1)!.queryFn(), { steerable: ["claude"], slashSteerable: [], bases: {} });
  assert.equal(getSteerableProviders.name, "observatory.steerable.list");
});
