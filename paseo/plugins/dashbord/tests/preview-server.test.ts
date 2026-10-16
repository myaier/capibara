import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewServer, previewPort } from "../scripts/preview-server.mjs";

function raw(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let data = ""; socket.setEncoding("utf8"); socket.on("data", chunk => { data += chunk; }); socket.on("end", () => resolve(data)); socket.on("error", reject);
  });
}

test("the development preview answers a malformed request target with 400 and keeps serving", async () => {
  const output = await mkdtemp(join(tmpdir(), "observatory-preview-test-"));
  await writeFile(join(output, "index.html"), "<!doctype html><title>preview</title>"); await writeFile(join(output, "app.js"), "void 0;");
  const server = createPreviewServer(output);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.match(await raw(port, "//["), /^HTTP\/1\.1 400/);
    assert.match(await raw(port, "/"), /^HTTP\/1\.1 200/);
    assert.match(await raw(port, "/app.js"), /^HTTP\/1\.1 200/);
    assert.match(await raw(port, "/package.json"), /^HTTP\/1\.1 404/);
    assert.match(await raw(port, "/../../etc/passwd"), /^HTTP\/1\.1 404/);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
});

test("the preview and its UI tests read the same port setting", () => {
  assert.equal(previewPort({}), 4177);
  assert.equal(previewPort({ OBSERVATORY_PREVIEW_PORT: "5180" }), 5180);
  for (const value of ["abc", "0", "70000", "41.5"]) assert.equal(previewPort({ OBSERVATORY_PREVIEW_PORT: value }), 4177, value);
});
