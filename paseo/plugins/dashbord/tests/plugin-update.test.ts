import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginUpdates } from "../server/plugin-update";
import { changelogSince, estimateUpdateProgress, OBSERVATORY_VERSION } from "../shared/plugin-update";

const installed = "75c0c6a4aaf70362226fe31664d800c89be0df3b", next = "8e1f2c3d4b5a69788796a5b4c3d2e1f00a1b2c3d";
const changelog = `# Changelog

## 9.0.0 · Capibara · 2026-10-17

- Nine.

## 8.0.0 · Capibara · 2026-10-16

- Eight.
- More.

## ${OBSERVATORY_VERSION} · Capibara · 2026-10-15

- Installed.
`;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** Waits for the background check, however many filesystem turns it takes. */
async function idle(service: PluginUpdates) { for (let i = 0; i < 400 && (await service.get()).checking; i++) await new Promise(resolve => setTimeout(resolve, 5)); }
async function fixture(options: { target?: string; outcome?: string; apply?: (proposals: unknown[]) => Promise<Record<string, unknown>> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-update-"));
  const requests: Record<string, unknown>[] = [], gitCalls: string[][] = [];
  let target = options.target ?? next, time = 1_000_000;
  const bridge = { request: async (message: Record<string, unknown>) => {
    requests.push(message);
    if (message.type === "plugin.source.update.apply.request") return options.apply ? options.apply(message.proposals as unknown[]) : new Promise<Record<string, unknown>>(() => {});
    const update = target !== installed;
    return { plugins: [{ id: "agent-observatory", outcome: options.outcome ?? (update ? "update" : "current"),
      current: { identity: { kind: "git", remote: "https://github.com/myaier/capibara.git", pluginPath: "dashbord" }, currentRevision: installed },
      target: { kind: "git", commit: target }, links: [], ...(update ? { proposal: { id: "agent-observatory", target: { kind: "git", commit: target } } } : {}) }] };
  } };
  const git = async (args: string[]) => { gitCalls.push(args); return args.includes("show") ? changelog : ""; };
  const service = new PluginUpdates(bridge as never, directory, git, () => time);
  return { directory, service, requests, gitCalls, retarget(commit: string) { target = commit; }, advance(ms: number) { time += ms; },
    async cleanup() { await rm(directory, { recursive: true, force: true }); } };
}

test("the package version and the version the panel reports stay equal", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(OBSERVATORY_VERSION, pkg.version);
});

test("release notes cover only versions after the installed one, newest first", () => {
  const notes = changelogSince(changelog, OBSERVATORY_VERSION);
  assert.equal(notes.version, "9.0.0");
  assert.deepEqual(notes.entries.map(entry => entry.version), ["9.0.0", "8.0.0"]);
  assert.equal(notes.entries[1].body, "- Eight.\n- More."); assert.equal(notes.truncated, false);
  const unknown = changelogSince(changelog, "1.0.0");
  assert.equal(unknown.entries.length, 3); assert.equal(unknown.truncated, true);
  assert.deepEqual(changelogSince("# Changelog\n", OBSERVATORY_VERSION).entries, []);
});

test("a check previews the installation's source, reads the target's notes once and reports the update", async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const first = await f.service.get();
  assert.equal(first.checking, true); assert.equal(first.version, OBSERVATORY_VERSION);
  await idle(f.service);
  const state = await f.service.get();
  assert.equal(state.checking, false); assert.equal(state.revision, installed); assert.equal(state.error, null);
  assert.equal(state.available?.commit, next); assert.equal(state.available?.version, "9.0.0");
  assert.deepEqual(state.available?.entries.map(entry => entry.version), ["9.0.0", "8.0.0"]);
  assert.deepEqual(f.gitCalls.find(args => args.includes("fetch"))?.slice(-3), ["--", "https://github.com/myaier/capibara.git", next]);
  assert.deepEqual(f.gitCalls.find(args => args.includes("show"))?.at(-1), `${next}:dashbord/CHANGELOG.md`);
  // Within 30 minutes nothing is previewed again; a refresh previews, but the same target's notes are not refetched.
  await f.service.get(); assert.equal(f.requests.length, 1);
  await f.service.get(true); await idle(f.service);
  assert.equal(f.requests.length, 2); assert.equal(f.gitCalls.filter(args => args.includes("show")).length, 1);
  f.advance(30 * 60_000); await f.service.get(); await idle(f.service); assert.equal(f.requests.length, 3);
});

test("dismissing hides only that revision, survives a restart, and a newer revision prompts again", async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  await f.service.get(); await idle(f.service);
  assert.equal((await f.service.dismiss(next)).dismissed, true);
  const restarted = new PluginUpdates(f.service["bridge"], f.directory, async args => args.includes("show") ? changelog : "", () => 1);
  await restarted.get(); await idle(restarted);
  assert.equal((await restarted.get()).dismissed, true);
  f.retarget("ffffffffffffffffffffffffffffffffffffffff");
  await f.service.get(true); await idle(f.service);
  const state = await f.service.get();
  assert.equal(state.available?.commit, "ffffffffffffffffffffffffffffffffffffffff"); assert.equal(state.dismissed, false);
});

test("the current revision reports no update, and a failed preview is an error rather than 'latest'", async t => {
  const current = await fixture({ target: installed }); t.after(() => current.cleanup());
  await current.service.get(); await idle(current.service);
  assert.equal((await current.service.get()).available, null);
  const failed = await fixture({ outcome: "error" }); t.after(() => failed.cleanup());
  await failed.service.get(); await idle(failed.service);
  const state = await failed.service.get();
  assert.equal(state.available, null); assert.ok(state.error);
});

test("apply sends exactly the reviewed proposal, refuses a moved source, and reports a failed build", async t => {
  const moved = await fixture(); t.after(() => moved.cleanup());
  await assert.rejects(moved.service.apply("ffffffffffffffffffffffffffffffffffffffff"), /新提交/);
  assert.equal(moved.requests.filter(message => message.type === "plugin.source.update.apply.request").length, 0);

  const pending = await fixture(); t.after(() => pending.cleanup());
  const started = await pending.service.apply(next);
  assert.equal(started.updating?.commit, next); assert.equal(started.updating?.error, null);
  const sent = pending.requests.find(message => message.type === "plugin.source.update.apply.request");
  assert.deepEqual(sent?.proposals, [{ id: "agent-observatory", target: { kind: "git", commit: next } }]);
  // A second press while the first is in flight does not apply twice.
  await pending.service.apply(next);
  assert.equal(pending.requests.filter(message => message.type === "plugin.source.update.apply.request").length, 1);

  const broken = await fixture({ apply: async () => ({ plugins: [{ id: "agent-observatory", outcome: "error", error: "build failed" }] }) }); t.after(() => broken.cleanup());
  await broken.service.apply(next);
  for (let i = 0; i < 400 && !(await broken.service.get()).updating?.error; i++) await settle();
  assert.equal((await broken.service.get()).updating?.error, "build failed");
});

test("progress is an estimate that never claims completion before the new revision answers", () => {
  assert.ok(estimateUpdateProgress(0, "building") > 0);
  assert.ok(estimateUpdateProgress(10_000, "building") < estimateUpdateProgress(40_000, "building"));
  assert.ok(estimateUpdateProgress(10 * 60_000, "building") <= 0.85);
  assert.equal(estimateUpdateProgress(1000, "restarting"), 0.9);
  assert.ok(estimateUpdateProgress(10 * 60_000, "restarting") < 1);
  assert.equal(estimateUpdateProgress(1000, "done"), 1);
});

test("the process an update restarts into reports that update once its revision is the target, for 30 minutes", async t => {
  const f = await fixture({ apply: () => new Promise(() => {}) }); t.after(() => f.cleanup());
  await f.service.apply(next);
  assert.equal((await f.service.get()).justUpdated, null);
  const restarted = (clock: number) => new PluginUpdates({ request: async () => ({ plugins: [{ id: "agent-observatory", outcome: "current",
    current: { identity: { kind: "git", remote: "https://github.com/myaier/capibara.git", pluginPath: "dashbord" }, currentRevision: next }, target: { kind: "git", commit: next }, links: [] }] }) } as never,
    f.directory, async () => "", () => clock);
  const fresh = restarted(1_000_000 + 60_000);
  await fresh.get(); await idle(fresh);
  assert.deepEqual({ ...(await fresh.get()).justUpdated, startedAt: undefined }, { from: OBSERVATORY_VERSION, to: OBSERVATORY_VERSION, commit: next, startedAt: undefined });
  const late = restarted(1_000_000 + 31 * 60_000);
  await late.get(); await idle(late);
  assert.equal((await late.get()).justUpdated, null);
});
