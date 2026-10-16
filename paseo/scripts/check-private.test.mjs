import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findings } from "./check-private.mjs";

const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "check-private.mjs");
// Assembled at runtime so this file passes its own check.
const join2 = (...parts) => parts.join("");
const rules = text => findings("notes.md", [{ line: 1, text }]).map(item => item.rule);

test("private identities and credentials are reported", () => {
  assert.deepEqual(rules(join2("ssh admin@", "34.87.", "122.2")), ["ip-address"]);
  assert.deepEqual(rules(join2("mike", "@", "company.ai")), ["email"]);
  assert.deepEqual(rules(join2("host ", "DESKTOP-", "G5IHD4U")), ["windows-hostname"]);
  assert.deepEqual(rules(join2("serverId ", "srv_", "awHPowulq_mu")), ["paseo-server-id"]);
  assert.deepEqual(rules(join2("log at /", "Users/", "alice/tmp")), ["home-path"]);
  assert.deepEqual(rules(join2("token ", "ghp_", "a".repeat(36))), ["api-token"]);
  assert.deepEqual(rules(join2("-----BEGIN OPENSSH ", "PRIVATE KEY-----")), ["private-key"]);
});

test("documentation values, placeholders and explicit allowances pass", () => {
  for (const text of ["http://127.0.0.1:4177", "ssh demo@192.0.2.10", "someone@example.com", "user@git.example.test",
    "srv_demo-62xVrz", "WIN-DEMO-PC", "/Users/<name>/.paseo", "/home/runner/work", "version 2.19.0-dev.8",
    join2("10.0.", "0.8 privacy-check: allow")]) assert.deepEqual(rules(text), [], text);
});

test("--staged reports only lines added to the index", async t => {
  const root = await mkdtemp(join(tmpdir(), "capibara-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run("git", ["-C", root, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.com"); await git("config", "user.name", "Test");
  await writeFile(join(root, "a.md"), "clean\n"); await git("add", "a.md"); await git("commit", "-qm", "init");
  const check = () => run(process.execPath, [script, "--staged"], { cwd: root });
  await writeFile(join(root, "a.md"), "clean\nstill clean\n"); await git("add", "a.md");
  await check();
  await writeFile(join(root, "a.md"), join2("clean\nhost ", "DESKTOP-", "AB12CD3", "\n")); await git("add", "a.md");
  await assert.rejects(check(), error => /a\.md:2 {2}\[windows-hostname\]/.test(error.stderr));
});
