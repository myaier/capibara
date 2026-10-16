import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

/** The development preview's port: `OBSERVATORY_PREVIEW_PORT` when it is a valid port, else 4177. The Playwright config reads it too. */
export function previewPort(env = process.env) {
  const port = Number(env.OBSERVATORY_PREVIEW_PORT ?? 4177);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 4177;
}

const allowed = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/app.js", "app.js"], ["/app.js.map", "app.js.map"]]);
/** Serves the four built preview files from `output`; any other path is 404 and a request target that is not a URL is 400. */
export function createPreviewServer(output) {
  return createServer(async (request, response) => {
    try {
      let pathname;
      try { pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname; }
      catch { response.writeHead(400); response.end("Bad request"); return; }
      const file = allowed.get(pathname);
      if (!file) { response.writeHead(404); response.end("Not found"); return; }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".map") ? "application/json" : "application/javascript; charset=utf-8");
      response.end(await readFile(join(output, file)));
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end("Preview asset unavailable");
    }
  });
}
