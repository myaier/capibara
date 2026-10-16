import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory, resolvePaseoHome } from "../server/paseo-home";

const HOME = "/home/user";
const home = (value: string | undefined, log: string[] = []) => resolvePaseoHome({ env: value === undefined ? {} : { PASEO_HOME: value }, home: HOME, log: message => log.push(message) });

test("PASEO_HOME: absolute paths and ~/ are used; unset means ~/.paseo", () => {
  assert.equal(home(undefined), "/home/user/.paseo");
  assert.equal(home("  "), "/home/user/.paseo");
  assert.equal(home("/srv/paseo/"), "/srv/paseo");
  assert.equal(home("/srv/a/../paseo"), "/srv/paseo");
  assert.equal(home("~/work/paseo"), "/home/user/work/paseo");
  assert.equal(home("~"), "/home/user");
});

test("PASEO_HOME: a relative value falls back to ~/.paseo and is logged once", () => {
  const log: string[] = [];
  for (const value of ["relative/dir", "./paseo", "~other/paseo", "../paseo"]) assert.equal(home(value, log), "/home/user/.paseo", value);
  assert.equal(home("relative/dir", log), "/home/user/.paseo");
  assert.equal(log.length, 4, "each invalid value is logged once");
  assert.match(log[0]!, /PASEO_HOME/); assert.match(log[0]!, /~\/\.paseo|\.paseo/);
});

test("the plugin's data directory is created 0700, an existing wider one is tightened, a symlink is left alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-private-"));
  try {
    const fresh = join(root, "a", "plugin-data");
    await ensurePrivateDirectory(fresh); assert.equal((await stat(fresh)).mode & 0o777, 0o700);
    const wide = join(root, "wide"); await mkdir(wide); await chmod(wide, 0o755);
    await ensurePrivateDirectory(wide); assert.equal((await stat(wide)).mode & 0o777, 0o700);
    const target = join(root, "target"); await mkdir(target); await chmod(target, 0o755);
    const link = join(root, "link"); await symlink(target, link);
    await ensurePrivateDirectory(link); assert.equal((await stat(target)).mode & 0o777, 0o755, "a symlinked directory is the user's choice");
  } finally { await rm(root, { recursive: true, force: true }); }
});
