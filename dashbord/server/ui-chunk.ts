import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getClientChunk } from "../shared/ui-chunk";
import { UI_CHUNK } from "../shared/generated/ui-chunk-manifest";
import { createClientChunkHandler } from "./client-chunks";
import code from "./generated/ui-chunk.txt";

export function registerClientChunks(server: PluginServerContext) {
  return server.handle(getClientChunk, createClientChunkHandler([{ ...UI_CHUNK, code }]));
}
