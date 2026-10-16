import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewPort } from "./preview-server.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "preview", "dist");
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["preview/index.jsx"], bundle: true, outfile: join(output, "app.js"), platform: "browser",
  format: "iife", target: ["es2020"], sourcemap: true, jsx: "automatic", logLevel: "warning",
  alias: { "react-native": "react-native-web", "@getpaseo/plugin/client": "./preview/sdk-adapter.jsx",
    "@getpaseo/plugin/client/react-native": "./preview/sdk-adapter.jsx", "@getpaseo/plugin/client/ui": "./preview/sdk-adapter.jsx" },
  define: { "process.env.NODE_ENV": '"development"', __DEV__: "true" },
});
await writeFile(join(output, "index.html"), await readFile(join(root, "preview", "index.html")));
console.log("Built development fixture preview in preview/dist (synthetic data only).");

if (process.argv.includes("--serve")) {
  const port = previewPort();
  const server = createPreviewServer(output);
  server.listen(port, "127.0.0.1", () => console.log(`Development fixture preview: http://127.0.0.1:${port}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
