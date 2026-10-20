import type { ComponentType } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { lazySurfaces, type ChunkExtras } from "./lazy-chunk";
import { getClientChunk } from "../shared/ui-chunk";
import { PLAZA_CHUNK } from "../shared/generated/plaza-chunk-manifest";
import { t } from "../shared/text";

// The ui chunk registers the loader for the plaza chunk once; the session page asks for the view only when it shows it.
let Plaza: ComponentType<any> | null = null;
export function registerPlaza(client: PluginClientContext, extras?: ChunkExtras): void {
  Plaza = lazySurfaces(client, { rpc: getClientChunk, manifest: PLAZA_CHUNK, label: () => t("plaza.name"), text: extras?.text })("agents-plaza");
}
export function plazaView(): ComponentType<any> | null { return Plaza; }
/** The web preview bundles the plaza directly instead of fetching its chunk. */
export function providePlaza(Component: ComponentType<any>): void { Plaza = Component; }
