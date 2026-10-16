import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [slug, ...flags] = process.argv.slice(2);
const marker = "capibara/paseo-package@1";
const metadataFile = "release.json";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function inside(base, path) {
  const rest = relative(base, resolve(base, path));
  if (!rest || rest === ".." || rest.startsWith(`..${sep}`) || resolve(base, rest) !== resolve(base, path)) {
    throw new Error(`Path must be inside ${base}: ${path}`);
  }
  return resolve(base, path);
}

async function filesBelow(base, path = base) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Package files must not be symlinks: ${path}`);
  if (stat.isFile()) return [relative(base, path).split(sep).join("/")];
  if (!stat.isDirectory()) throw new Error(`Unsupported package file: ${path}`);
  const result = [];
  for (const name of (await readdir(path)).sort()) result.push(...await filesBelow(base, join(path, name)));
  return result;
}

function validateRuntime(files) {
  const manifest = JSON.parse(files.get("paseo-plugin.json")?.toString() ?? "null");
  const pkg = JSON.parse(files.get("package.json")?.toString() ?? "null");
  if (!manifest?.id || !pkg?.version) throw new Error("Package needs a plugin ID and version");
  if (!files.has("index.client.tsx") && !files.has("index.client.ts") && !files.has("index.server.ts")) {
    throw new Error("Package has no Paseo entry point");
  }
  for (const asset of [manifest.icon, ...(manifest.media ?? [])].filter(Boolean)) {
    if (!/^https?:\/\//.test(asset) && !files.has(asset)) throw new Error(`Missing manifest asset: ${asset}`);
  }
  // The lazy UI is shipped prebuilt. Verify the code and manifest agree before publishing it.
  const chunkPath = "shared/generated/ui-chunk-manifest.ts";
  if (files.has(chunkPath)) {
    const match = files.get(chunkPath).toString().match(/export const UI_CHUNK = (\{[^\n]+\}) as const;/);
    if (!match) throw new Error("Cannot read the lazy UI manifest");
    const chunk = JSON.parse(match[1]);
    const code = files.get("server/generated/ui-chunk.txt");
    if (!code || code.length !== chunk.bytes || hash(code).slice(0, 16) !== chunk.hash) {
      throw new Error("Lazy UI code does not match its manifest; rebuild the chunk before publishing");
    }
  }
  return { manifest, pkg };
}

async function checkPackage(output) {
  const metadata = JSON.parse(await readFile(join(output, metadataFile), "utf8"));
  if (metadata.generator !== marker || metadata.slug !== slug || !metadata.files) throw new Error("Unknown package metadata");
  const names = (await filesBelow(output)).filter(name => name !== metadataFile).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(metadata.files).sort())) throw new Error("Published file inventory changed");
  const files = new Map();
  for (const name of names) {
    const bytes = await readFile(inside(output, name));
    if (hash(bytes) !== metadata.files[name]) throw new Error(`Published file changed: ${name}`);
    files.set(name, bytes);
  }
  const { manifest, pkg } = validateRuntime(files);
  if (metadata.pluginId !== manifest.id || metadata.version !== pkg.version) throw new Error("Published identity changed");
  console.log(`${slug}: verified ${names.length} published files (${metadata.pluginId} ${metadata.version})`);
}

async function main() {
  if (!slug || !/^[A-Za-z][A-Za-z0-9-]*$/.test(slug) || flags.some(flag => flag !== "--check")) {
    throw new Error("Usage: node paseo/scripts/package-plugin.mjs <slug> [--check]");
  }
  const config = JSON.parse(await readFile(join(root, "paseo/plugins.json"), "utf8"))[slug];
  if (!config || !Array.isArray(config.include)) throw new Error(`Unknown plugin: ${slug}`);
  const output = inside(root, slug);
  if (flags.includes("--check")) return checkPackage(output);

  const source = inside(root, config.source);
  if (config.buildCheck) {
    const [script, ...args] = config.buildCheck;
    execFileSync(process.execPath, [inside(source, script), ...args], { cwd: source, stdio: "inherit" });
  }
  const names = new Set();
  for (const entry of config.include) {
    for (const name of await filesBelow(source, inside(source, entry))) {
      if (!/(^|\/)(node_modules|tests|preview|\.git)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)\.DS_Store$/.test(name)) names.add(name);
    }
  }
  const files = new Map();
  for (const name of [...names].sort()) files.set(name, await readFile(inside(source, name)));
  const { manifest, pkg } = validateRuntime(files);
  // Runtime consumers do not need the source project's development scripts or dependencies.
  files.set("package.json", Buffer.from(`${JSON.stringify({ name: pkg.name, version: pkg.version, private: true,
    description: pkg.description, license: pkg.license, ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}) }, null, 2)}\n`));
  const metadata = { generator: marker, slug, pluginId: manifest.id, version: pkg.version, source: config.source,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])) };

  let exists = false;
  try {
    const stat = await lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to replace ${output}`);
    const previous = JSON.parse(await readFile(join(output, metadataFile), "utf8"));
    if (previous.generator !== marker || previous.slug !== slug) throw new Error(`Refusing to replace unowned directory ${output}`);
    exists = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; if (await lstat(output).catch(() => null)) throw new Error(`Refusing to replace unowned directory ${output}`); }

  const staging = await mkdtemp(join(root, ".paseo-package-"));
  const candidate = join(staging, "candidate"), backup = join(staging, "previous");
  try {
    for (const [name, bytes] of files) {
      const destination = inside(candidate, name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await writeFile(join(candidate, metadataFile), `${JSON.stringify(metadata, null, 2)}\n`);
    await checkPackage(candidate);
    if (exists) await rename(output, backup);
    try { await rename(candidate, output); }
    catch (error) { if (exists) await rename(backup, output); throw error; }
  } finally { await rm(staging, { recursive: true, force: true }); }
  console.log(`Prepared ${slug}/ from ${config.source}; commit this snapshot only when releasing.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
