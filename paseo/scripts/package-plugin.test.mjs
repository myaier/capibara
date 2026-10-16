import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "package-plugin.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "capibara-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "paseo/plugins/dashbord");
  await mkdir(join(root, "paseo/scripts"), { recursive: true });
  await mkdir(join(source, "client"), { recursive: true });
  await copyFile(script, join(root, "paseo/scripts/package-plugin.mjs"));
  await writeFile(join(root, "paseo/plugins.json"), JSON.stringify({ dashbord: { source: "paseo/plugins/dashbord",
    include: ["paseo-plugin.json", "package.json", "index.client.tsx", "client"] } }));
  await writeFile(join(source, "paseo-plugin.json"), JSON.stringify({ id: "agent-observatory" }));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "agent-observatory", version: "2.16.0", devDependencies: { example: "1.0.0" } }));
  await writeFile(join(source, "index.client.tsx"), 'export { default } from "./client/view";\n');
  await writeFile(join(source, "client/view.tsx"), "export default function view() {}\n");
  return { root, source, output: join(root, "dashbord"), package: (...args) => run(process.execPath, [join(root, "paseo/scripts/package-plugin.mjs"), "dashbord", ...args]) };
}

test("development changes leave the published snapshot intact until an explicit release", async t => {
  const f = await fixture(t);
  await f.package();
  const before = await readFile(join(f.output, "release.json"), "utf8");
  await writeFile(join(f.source, "client/view.tsx"), "export default function nextVersion() {}\n");
  await f.package("--check");
  assert.equal(await readFile(join(f.output, "release.json"), "utf8"), before);
  assert.match(await readFile(join(f.output, "client/view.tsx"), "utf8"), /function view/);
  await f.package();
  assert.match(await readFile(join(f.output, "client/view.tsx"), "utf8"), /nextVersion/);
  const after = await readFile(join(f.output, "release.json"), "utf8");
  await f.package();
  assert.equal(await readFile(join(f.output, "release.json"), "utf8"), after, "identical inputs produce identical release metadata");
});

test("integrity checks reject corrupted or unexpected published files", async t => {
  const f = await fixture(t);
  await f.package();
  await writeFile(join(f.output, "client/view.tsx"), "changed\n");
  await assert.rejects(f.package("--check"), /Published file changed/);
  await f.package();
  await writeFile(join(f.output, "unexpected.txt"), "extra");
  await assert.rejects(f.package("--check"), /inventory changed/);
});

test("publishing removes retired runtime files and excludes development dependencies", async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, "client/retired.ts"), "export {};\n");
  await writeFile(join(f.source, "client/view.test.ts"), "test only\n");
  await f.package();
  await rm(join(f.source, "client/retired.ts"));
  await f.package();
  await assert.rejects(readFile(join(f.output, "client/retired.ts")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.output, "client/view.test.ts")), { code: "ENOENT" });
  const pkg = JSON.parse(await readFile(join(f.output, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.version, "2.16.0");
});

test("source symlinks cannot pull unrelated files into the distributable", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "private.txt"), "must not ship");
  await symlink(join(f.root, "private.txt"), join(f.source, "client/linked.txt"));
  await assert.rejects(f.package(), /must not be symlinks/);
  await assert.rejects(readFile(join(f.output, "client/linked.txt")), { code: "ENOENT" });
});

test("publishing refuses to replace an unrelated existing root directory", async t => {
  const f = await fixture(t);
  await mkdir(f.output);
  await writeFile(join(f.output, "keep.txt"), "existing user work");
  await assert.rejects(f.package(), /Refusing to replace unowned directory/);
  assert.equal(await readFile(join(f.output, "keep.txt"), "utf8"), "existing user work");
});

test("failed build verification leaves the previous published snapshot intact", async t => {
  const f = await fixture(t);
  await f.package();
  const before = await readFile(join(f.output, "release.json"), "utf8");
  await mkdir(join(f.source, "scripts"));
  await writeFile(join(f.source, "scripts/check.mjs"), 'console.error("stale UI"); process.exitCode = 1;');
  const path = join(f.root, "paseo/plugins.json"), config = JSON.parse(await readFile(path, "utf8"));
  config.dashbord.buildCheck = ["scripts/check.mjs"];
  await writeFile(path, JSON.stringify(config));
  await assert.rejects(f.package(), /stale UI/);
  assert.equal(await readFile(join(f.output, "release.json"), "utf8"), before);
  await f.package("--check");
});
