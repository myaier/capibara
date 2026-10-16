import type { Server } from "node:http";
/** The development preview's port: `OBSERVATORY_PREVIEW_PORT` when it is a valid port, else 4177. */
export declare function previewPort(env?: Readonly<Record<string, string | undefined>>): number;
/** Serves the built preview files from `output`; other paths are 404, a request target that is not a URL is 400. */
export declare function createPreviewServer(output: string): Server;
