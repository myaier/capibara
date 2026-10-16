import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";
import { UI_CHUNK } from "../shared/generated/ui-chunk-manifest";

test("the shipped lazy UI is reproducible from current source and retains a valid Hermes factory", async () => {
  const root = join(__dirname, "..");
  await promisify(execFile)(process.execPath, [join(root, "scripts/build-client-chunks.mjs"), "--check"], { cwd: root });
  const code = await readFile(join(root, "server/generated/ui-chunk.txt"), "utf8");
  assert.equal(Buffer.byteLength(code), UI_CHUNK.bytes);
  assert.equal(createHash("sha256").update(code).digest("hex").slice(0, 16), UI_CHUNK.hash);
  assert.equal(typeof new Script(code).runInNewContext(), "function");
  assert.doesNotMatch(code, /get:\s*\(\)\s*=>\s*from\d*\[key\d*\]/, "host module imports must use eager values on Hermes");
});
