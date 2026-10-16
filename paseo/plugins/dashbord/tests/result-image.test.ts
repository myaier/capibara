import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "../server/paseo-types";
import { registerResults } from "../server/results";
import { readResultImagePart } from "../server/result-image";
import { getResultImage, loadResultImage, resultImageFailure, RESULT_IMAGE_MAX_BYTES, RESULT_IMAGE_PART_BYTES } from "../shared/result-image";
import { getAgentResult } from "../shared/results";

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
test("the registered image RPC uses the requested agent's reply and working directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-image-rpc-"));
  const handlers = new Map<string, (input: any, context: { paseo: PaseoApi }) => Promise<any>>();
  const close = registerResults({ handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler), on: () => () => {} } as unknown as PluginServerContext);
  const paseo = { agents: { ref: (id: string) => {
    const agent = { id, status: "idle", cwd: directory };
    return { current: () => agent, refresh: async () => ({ agent }), timeline: { refetch: async () => ({ epoch: "images", window: { minSeq: 1 }, hasOlder: false, hasNewer: false, rows: [
      { seqStart: 1, seqEnd: 1, item: { type: "user_message", text: "show the image" } },
      { seqStart: 2, seqEnd: 2, item: { type: "assistant_message", text: id === "owner" ? "![image](./image.png)" : "no image in this reply" } },
    ] }) } };
  } } } as unknown as PaseoApi;
  try {
    await writeFile(join(directory, "image.png"), pngHeader);
    const read = handlers.get(getResultImage.name)!;
    const response = getResultImage.output.parse(await read({ agentId: "owner", url: "./image.png", part: 0 }, { paseo }));
    assert.equal(response.data, pngHeader.toString("base64"));
    await assert.rejects(read({ agentId: "other", url: "./image.png", part: 0 }, { paseo }), /not referenced/);
  } finally { close(); await rm(directory, { recursive: true, force: true }); }
});

test("local image reads preserve bytes across bounded RPC parts and resolve relative paths on the host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-image-"));
  try {
    const file = join(directory, "image (draft).png"), bytes = Buffer.concat([pngHeader, Buffer.alloc(RESULT_IMAGE_PART_BYTES * 2 + 19, 42)]);
    await writeFile(file, bytes);
    const url = pathToFileURL(file).href, reply = `![draft](${url})`;
    const requests: number[] = [];
    const result = await loadResultImage(async input => {
      requests.push(input.part);
      const response = await readResultImagePart(input, reply, null);
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < 120 * 1024);
      return getResultImage.output.parse(response);
    }, "agent", url);
    assert.deepEqual(Buffer.from(result.split(",")[1]!, "base64"), bytes);
    assert.deepEqual(requests.sort(), [0, 1, 2]);
    const relative = await readResultImagePart({ agentId: "agent", url: "./image%20(draft).png", part: 0 }, "![draft](./image%20(draft).png)", directory);
    assert.equal(relative.mime, "image/png");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("image reads reject unreferenced files, code-only references, non-images, oversized and changed files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-image-"));
  try {
    const path = join(directory, "image.png"), url = pathToFileURL(path).href, image = `![draft](${url})`, input = { agentId: "agent", url, part: 0 };
    await writeFile(path, Buffer.concat([pngHeader, Buffer.alloc(RESULT_IMAGE_PART_BYTES)]));
    for (const reply of ["no image", `\`${image}\``, `\`\`\`md\n${image}\n\`\`\``]) await assert.rejects(readResultImagePart(input, reply, directory), /not referenced/);
    const first = await readResultImagePart(input, image, null);
    await writeFile(path, Buffer.concat([pngHeader, Buffer.alloc(RESULT_IMAGE_PART_BYTES + 1)]));
    await assert.rejects(readResultImagePart({ ...input, part: 1, version: first.version }, image, null), /changed/);
    await assert.rejects(readResultImagePart({ ...input, part: 1 }, image, null), /changed/);
    await truncate(path, RESULT_IMAGE_MAX_BYTES + 1);
    await assert.rejects(readResultImagePart(input, image, null), /too large/);
    await writeFile(path, "<svg onload='alert(1)'></svg>");
    await assert.rejects(readResultImagePart(input, image, null), /Unsupported/);
    await assert.rejects(readResultImagePart({ ...input, url: "file://remote/share/image.png" }, "![x](file://remote/share/image.png)", null));
    await rm(path);
    await assert.rejects(readResultImagePart(input, image, null), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("client refuses mixed versions and stops requesting parts after unmount", async () => {
  const first = { mime: "image/png" as const, data: "YWJj", part: 0, parts: 2, version: "first" };
  await assert.rejects(loadResultImage(async input => input.part === 0 ? first : { ...first, part: 1, version: "changed" }, "a", "/image.png"), /changed/);
  let calls = 0;
  await assert.rejects(loadResultImage(async () => { calls++; return first; }, "a", "/image.png", () => true), /cancelled/);
  assert.equal(calls, 1);
});

test("a displayed reply keeps its image authorization when newer output arrives, scoped to its agent and bounded lifetime", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-image-reply-"));
  const handlers = new Map<string, (input: any, context: { paseo: PaseoApi }) => Promise<any>>();
  const events = new Map<string, (event: any) => void>();
  let now = Date.now(), latest = 2;
  t.mock.method(Date, "now", () => now);
  const close = registerResults({ handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler),
    on: (name: string, handler: any) => { events.set(name, handler); return () => {}; } } as unknown as PluginServerContext);
  const paseo = { agents: { ref: (id: string) => {
    const agent = { id, status: "idle", cwd: directory };
    return { current: () => agent, refresh: async () => ({ agent }), timeline: { refetch: async () => ({ epoch: "images", window: { minSeq: 1 }, hasOlder: false, hasNewer: false, rows: [
      { seqStart: 1, seqEnd: 1, item: { type: "user_message", text: "show the image" } },
      { seqStart: latest, seqEnd: latest, item: { type: "assistant_message", text: id === "owner" && latest === 2 ? "![image](./image.png)" : "newer reply without an image" } },
    ] }) } };
  } } } as unknown as PaseoApi;
  try {
    const bytes = Buffer.concat([pngHeader, Buffer.alloc(RESULT_IMAGE_PART_BYTES * 2 + 19, 42)]);
    await writeFile(join(directory, "image.png"), bytes);
    const get = handlers.get(getAgentResult.name)!, read = handlers.get(getResultImage.name)!;
    const displayed = await get({ agentId: "owner" }, { paseo });
    const replyRef = displayed.latestReply.ref;
    const loaded = await loadResultImage(async input => {
      assert.equal(input.replyRef, replyRef);
      if (input.part === 1) {
        latest = 3; events.get("agent.turn_started")!({ agent: { id: "owner" } });
        await get({ agentId: "owner" }, { paseo });
      }
      return read(input, { paseo });
    }, "owner", "./image.png", () => false, replyRef);
    assert.deepEqual(Buffer.from(loaded.split(",")[1], "base64"), bytes);
    await assert.rejects(read({ agentId: "other", url: "./image.png", part: 0, replyRef }, { paseo }), /expired/);
    await assert.rejects(read({ agentId: "owner", url: "./unreferenced.png", part: 0, replyRef }, { paseo }), /not referenced/);
    now += 5 * 60_000 + 1;
    await assert.rejects(read({ agentId: "owner", url: "./image.png", part: 0, replyRef }, { paseo }), /expired/);
  } finally { close(); await rm(directory, { recursive: true, force: true }); }
});

test("a missing local image reports the cause and loads after the file is restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-image-restored-"));
  try {
    const file = join(directory, "image.png"), url = pathToFileURL(file).href;
    const read = (input: Parameters<typeof readResultImagePart>[0]) => readResultImagePart(input, `![image](${url})`, directory);
    await assert.rejects(loadResultImage(read, "owner", url), error => {
      assert.match(resultImageFailure(error) ?? "", /已被移动或删除/); return true;
    });
    await writeFile(file, pngHeader);
    assert.equal(await loadResultImage(read, "owner", url), `data:image/png;base64,${pngHeader.toString("base64")}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
