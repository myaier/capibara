import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { screenForHost, screenLocationForHost } from "../shared/screen-routing";
import { hostEntityId } from "../shared/fleet-scope";

const require = createRequire(__filename);
const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };
const hosts = [{ serverId: "mac", status: "online" }, { serverId: "win", status: "online" }];
let pressRow: (() => void) | undefined;
const native = require("react-native-web");
const modules: Record<string, unknown> = {
  "react-native": native,
  "@getpaseo/plugin/client": { useHosts: () => hosts, useRpc: () => async () => { throw new Error("offline"); }, usePaseo: () => ({}) },
  "@getpaseo/plugin/client/ui": { SidebarRow: (props: { onPress(): void; label: string }) => {
    pressRow = props.onPress;
    return createElement("button", null, props.label);
  } },
  "@getpaseo/plugin/client/react-native": { ScrollView: native.ScrollView, FlatList: native.FlatList, TextInput: native.TextInput,
    Icon: () => null, Modal: Object.assign(() => null, { Content: () => null }), useToast: () => ({}) },
};

// Execute the real entry points. Only the host SDK/React Native are supplied by the harness;
// sidebar callbacks, host registration, screen ownership and the lazy popover wrapper are production code.
async function load(entry: string) {
  const result = await build({ entryPoints: [join(__dirname, "..", entry)], bundle: true, format: "cjs", jsx: "automatic",
    platform: "neutral", target: "es2020", packages: "external", write: false, logLevel: "silent" });
  const module = { exports: {} as { default: (...args: any[]) => any } };
  new Function("require", "module", "exports", result.outputFiles[0]!.text)(
    (name: string) => name in modules ? modules[name] : require(name), module, module.exports);
  return module.exports.default;
}

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("sidebar presses use the host navigation callback so the mobile drawer closes", async t => {
  const contribute = await load("index.client.tsx");
  const sidebar = new Map<string, ComponentType<PluginSidebarItemProps>>();
  const registered = new Set<string>();
  const events: string[] = [];
  const client = {
    paseo: {},
    rpc: async (contract: { name: string }, input: { nonce?: string }) => {
      if (contract.name === "observatory.host.identity") return { serverId: "mac", hostname: "Mac", protocol: 1, version: "test", nonce: input.nonce };
      // A pending language fetch leaves the bundled boot catalog active.
      return new Promise(() => {});
    },
    openScreen: () => events.push("global-navigation"),
    addScreen: ({ id }: { id: string }) => { registered.add(id); return () => { registered.delete(id); }; },
    addSidebarHeaderItem: ({ id, Component }: { id: string; Component: ComponentType<PluginSidebarItemProps> }) => {
      sidebar.set(id, Component); return () => { sidebar.delete(id); };
    },
    addCommandCenterItem: () => () => {}, addWorkspacePanel: () => () => {}, addSettingsScreen: () => () => {}, addSlashCommand: () => () => {},
  } as unknown as PluginClientContext;
  const dispose = contribute(client); t.after(dispose);
  await settle();
  assert.equal(sidebar.size, 3, "all production sidebar rows registered");
  for (const id of ["observatory", "archives", "schedule-runs"]) {
    events.length = 0;
    let drawerOpen = true;
    const props = { theme: { colors: { surface0: "#fff" } }, host: { id: "mac", label: "Mac" },
      layout: { compact: true, platform: "ios" }, currentScreen: null, openPopover() {},
      openScreen(location: { screenId: string }) {
        assert.ok(registered.has(location.screenId), "the selected installation owns the destination");
        drawerOpen = false; events.push(location.screenId);
      },
    } as unknown as PluginSidebarItemProps;
    pressRow = undefined;
    renderToString(createElement(sidebar.get(id)!, props));
    const onPress = pressRow as (() => void) | undefined;
    assert.ok(onPress, "the actual sidebar row exposes a press handler");
    onPress();
    assert.equal(drawerOpen, false, `${id}: navigation must dismiss the mobile drawer`);
    assert.deepEqual(events, [screenForHost(id, "mac")], "navigate once through the sidebar's callback");
  }
});

test("attention popover navigation dismisses the host sheet and drawer and retains entity ownership", async () => {
  const chunk = await load("ui-chunk.client.tsx");
  const events: unknown[] = [];
  const surfaces = chunk().createSurfaces({ addScreen() {}, openScreen() { events.push("global-navigation"); } });
  const location = { screenId: "observatory", params: { agent: hostEntityId("win", "same"), focus: "attention" } };
  let drawerOpen = true, popoverOpen = true;
  const tree = surfaces["attention-popover"]({ host: { id: "mac", label: "Mac" }, openScreen(input: unknown) {
    drawerOpen = false; popoverOpen = false; events.push(input);
  } });
  tree.props.children.props.openScreen(location);
  assert.equal(drawerOpen, false);
  assert.equal(popoverOpen, false);
  assert.deepEqual(events, [screenLocationForHost(location, "mac")]);
  assert.equal((events[0] as typeof location).params.agent, hostEntityId("win", "same"));
});
