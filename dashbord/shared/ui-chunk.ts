import { createClientChunkRpc } from "./client-chunk";
export const getClientChunk = createClientChunkRpc("observatory.client-chunk.get", ["ui"]);
