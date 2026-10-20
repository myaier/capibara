import type { ComponentType } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { followText } from "./shared/i18n";
import type { ChunkExtras } from "./client/lazy-chunk";
import { OBSERVATORY_VERSION } from "./shared/plugin-update";
import { AgentsPlaza, type AgentsPlazaProps } from "./client/plaza/scene";

// Paseo freezes exports before running the module body; this declaration must be hoisted.
// The plaza is its own chunk: its art (about 1 MB of inlined WebP) loads only when someone opens the plaza view.
export default function chunk() { return { api: 1, createSurfaces }; }

function createSurfaces(_client: PluginClientContext, extras?: ChunkExtras): Record<string, ComponentType<any>> {
  followText(extras?.text);
  const Plaza = (props: Omit<AgentsPlazaProps, "version">) => <AgentsPlaza {...props} version={OBSERVATORY_VERSION} />;
  return { "agents-plaza": Plaza };
}
