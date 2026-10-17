import assert from "node:assert/strict";
import test from "node:test";
import { createStore, runHostCommand, type CommandDeps, type CommandHost } from "../client/host-commands";
import type { HostJob } from "../shared/hosts";

const source = { reference: "git:https://github.com/myaier/capibara.git:dashbord", ref: null };
function fixture(options: { directory?: string | null; outputs?: string[][]; registered?: boolean; clock?: { now: number; step: number }; gone?: boolean } = {}) {
  const jobs = createStore<ReadonlyMap<string, HostJob>>(new Map());
  const created: Array<{ workspaceId: string; name?: string; command?: string; args?: string[] }> = [], killed: string[] = [], acquired: string[] = [];
  const outputs = [...(options.outputs ?? [["+ paseo plugin add"], ["+ paseo plugin add", "Installed agent-observatory", "__OBSERVATORY_HOST_COMMAND__ ok"]])];
  let last: string[] = [];
  const host: CommandHost = {
    workspaces: { list: async () => ({ entries: options.directory === null ? [] : [{ id: "ws_demo", workspaceDirectory: options.directory ?? "/Users/<name>/project", archivingAt: null }] }) },
    terminals: { create: async created_ => { created.push(created_); return { id: "term_demo",
      capture: async () => ({ lines: (last = outputs.shift() ?? last) }), kill: async () => { killed.push("term_demo"); },
      // Paseo returns no terminal once its process exited.
      refresh: async () => options.gone ? null : { id: "term_demo" } }; } },
  };
  const clock = options.clock ?? { now: 1_000, step: 1_500 };
  const deps: CommandDeps = { acquire: id => { acquired.push(id); return host; }, registered: async () => options.registered ?? true,
    now: () => clock.now, sleep: async ms => { clock.now += Math.max(ms, clock.step); } };
  return { jobs, deps, created, killed, acquired };
}

test("a command runs in a terminal of one of the host's workspaces and clears once the installation registers", async () => {
  const f = fixture();
  const seen: HostJob["state"][] = [];
  f.jobs.subscribe(() => { const job = f.jobs.get().get("srv_demo_build"); if (job && seen.at(-1) !== job.state) seen.push(job.state); });
  assert.equal(await runHostCommand("srv_demo_build", "install", { source }, f.deps, f.jobs), "ok");
  assert.deepEqual(f.acquired, ["srv_demo_build"]);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]!.workspaceId, "ws_demo"); assert.equal(f.created[0]!.command, "/bin/sh");
  assert.match(f.created[0]!.args![1]!, /if "\$P" plugin add git:https:\/\/github\.com\/myaier\/capibara\.git:dashbord; then R=ok; else R=failed; fi/);
  assert.deepEqual(seen, ["running", "waiting"]);
  assert.equal(f.jobs.get().has("srv_demo_build"), false);
  assert.deepEqual(f.killed, ["term_demo"]);
});

test("a Windows workspace runs the command through cmd.exe", async () => {
  const f = fixture({ directory: "C:\\Users\\demo\\project" });
  assert.equal(await runHostCommand("srv_demo_win", "install", { source }, f.deps, f.jobs), "ok");
  assert.equal(f.created[0]!.command, "cmd.exe");
  assert.match(f.created[0]!.args![3]!, /^where paseo >nul 2>nul && \(\(call paseo plugin add git:https:\/\/github\.com\/myaier\/capibara\.git:dashbord\) && echo /);
});

test("a failed command keeps its terminal and the output's last lines; a missing CLI or workspace says so", async () => {
  const failed = fixture({ outputs: [["Cloning…", "fatal: repository not found", "__OBSERVATORY_HOST_COMMAND__ failed"]] });
  assert.equal(await runHostCommand("srv_demo_build", "install", { source }, failed.deps, failed.jobs), "failed");
  const job = failed.jobs.get().get("srv_demo_build")!;
  assert.deepEqual([job.state, job.result, job.output, job.workspaceId, job.terminalId], ["failed", "failed", ["Cloning…", "fatal: repository not found"], "ws_demo", "term_demo"]);
  assert.deepEqual(failed.killed, []);
  const noCli = fixture({ outputs: [["__OBSERVATORY_HOST_COMMAND__ no-cli"]] });
  assert.equal(await runHostCommand("srv_demo_build", "install", { source }, noCli.deps, noCli.jobs), "no-cli");
  const noWorkspace = fixture({ directory: null });
  assert.equal(await runHostCommand("srv_demo_build", "install", { source }, noWorkspace.deps, noWorkspace.jobs), "no-workspace");
  assert.equal(noWorkspace.created.length, 0);
});

test("an unknown or unsafe source never reaches the host", async () => {
  for (const unsafe of [null, { reference: "git:https://example.com/x.git;id", ref: null }]) {
    const f = fixture();
    assert.equal(await runHostCommand("srv_demo_build", "install", { source: unsafe }, f.deps, f.jobs), "error");
    assert.deepEqual(f.acquired, []); assert.equal(f.jobs.get().get("srv_demo_build")?.state, "failed");
  }
});

test("one command per host: a second request while one runs is refused, a failed one can be retried", async () => {
  const f = fixture({ outputs: [[], [], ["__OBSERVATORY_HOST_COMMAND__ failed"]] });
  const first = runHostCommand("srv_demo_build", "install", { source }, f.deps, f.jobs);
  assert.equal(await runHostCommand("srv_demo_build", "enable", { source: null }, f.deps, f.jobs), "busy");
  assert.equal(await first, "failed");
  assert.equal(await runHostCommand("srv_demo_build", "install", { source }, f.deps, f.jobs), "failed");
  assert.equal(f.created.length, 2);
});

test("a command that never reports, or an installation that never starts, ends as a failure", async () => {
  const silent = fixture({ outputs: [["still cloning"]], clock: { now: 0, step: 60_000 } });
  assert.equal(await runHostCommand("srv_demo_build", "install", { source }, silent.deps, silent.jobs), "timeout");
  assert.deepEqual(silent.jobs.get().get("srv_demo_build")?.output, ["still cloning"]);
  const stalled = fixture({ registered: false });
  assert.equal(await runHostCommand("srv_demo_build", "upgrade", { source: null }, stalled.deps, stalled.jobs), "not-running");
  assert.equal(stalled.jobs.get().get("srv_demo_build")?.state, "failed");
});

test("turning plugins on edits the host's config, reloads its daemon, then installs or enables the observatory as its config needs", async () => {
  const on = fixture({ directory: "C:\\Users\\demo\\project" });
  assert.equal(await runHostCommand("srv_demo_win", "plugins-on", { source, config: { pluginsEnabled: false, installed: true, enabled: true } }, on.deps, on.jobs), "ok");
  assert.match(on.created[0]!.args![3]!, /\(\(call paseo daemon config set pluginsEnabled true && call paseo daemon reload\) && echo /);
  const missing = fixture();
  assert.equal(await runHostCommand("srv_demo_build", "plugins-on", { source, config: { pluginsEnabled: false, installed: false, enabled: false } }, missing.deps, missing.jobs), "ok");
  assert.match(missing.created[0]!.args![1]!, /if "\$P" daemon config set pluginsEnabled true && "\$P" daemon reload && "\$P" plugin add git:https:\/\/github\.com\/myaier\/capibara\.git:dashbord; then/);
  // Without a usable source a host that also needs the install is left alone.
  const unknown = fixture();
  assert.equal(await runHostCommand("srv_demo_build", "plugins-on", { source: null, config: { pluginsEnabled: false, installed: false, enabled: false } }, unknown.deps, unknown.jobs), "error");
  assert.deepEqual(unknown.acquired, []);
});

test("a terminal that disappears before reporting ends the command at once instead of waiting out the timeout", async () => {
  const f = fixture({ outputs: [["+ paseo plugin enable agent-observatory"], []], gone: true });
  assert.equal(await runHostCommand("srv_demo_build", "enable", { source: null }, f.deps, f.jobs), "error");
  const job = f.jobs.get().get("srv_demo_build")!;
  assert.deepEqual([job.state, job.result, job.output], ["failed", "error", ["+ paseo plugin enable agent-observatory"]]);
});
