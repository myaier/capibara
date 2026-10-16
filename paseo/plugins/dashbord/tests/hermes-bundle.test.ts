import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

// The phone app runs plugin bundles on Hermes. Paseo patches esbuild's interop helper (`get: () => from[key]`) so that
// Hermes reads module exports eagerly; a top-level `key` or `from` anywhere in the client code makes esbuild rename that
// helper's own names, and the patch no longer applies. Hermes' default evaluator also runs no `class` syntax.
test("the client bundle keeps Paseo's Hermes interop patchable, and the send code uses no classes", async () => {
  const result = await build({ entryPoints: [join(__dirname, "..", "index.client.tsx")], bundle: true, format: "cjs", jsx: "automatic", platform: "neutral", target: "es2020",
    supported: { "async-await": false }, packages: "external", logLevel: "silent", treeShaking: true, write: false });
  const code = result.outputFiles[0]!.text;
  assert.ok(code.includes("get: () => from[key]"), "the helper Paseo patches is there, unrenamed");
  assert.deepEqual([...new Set(code.match(/get:\s*\(\)\s*=>\s*from\d*\[key\d*\]/g))], ["get: () => from[key]"]);
  // Which module each class comes from (esbuild marks each module with a `// path` line).
  const classes: string[] = [];
  let file = "";
  for (const line of code.split("\n")) {
    const marker = /^\/\/ (\S+)$/.exec(line);
    if (marker) file = marker[1]!;
    if (/\bclass\s+[A-Za-z_$][\w$]*|=\s*class\b/.test(line)) classes.push(file);
  }
  // client/use-attention.ts keeps the one class left; the shared send ledger's client side has none (SendRefused is a plain Error).
  assert.deepEqual(classes.filter(path => !path.endsWith("client/use-attention.ts")), []);
});
