import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandResult, displayCommand, hostCommand, hostPlatform, hostRow, hostSummary, outputTail, pickWorkspace, planSync, syncTarget, terminalInvocation,
  type HostFacts, type HostJob } from "../shared/hosts";
import { formatPluginSource, type UpdateState } from "../shared/plugin-update";

const current = "75c0c6a4aaf70362226fe31664d800c89be0df3b", next = "8e1f2c3d4b5a69788796a5b4c3d2e1f00a1b2c3d", other = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d";
const source = { reference: "git:https://github.com/myaier/capibara.git:dashbord", ref: null };
function update(overrides: Partial<UpdateState> = {}): UpdateState {
  return { version: "2.20.0-dev.1", revision: current, available: null, dismissed: false, checking: false, checkedAt: null, error: null,
    updating: null, justUpdated: null, source, ...overrides };
}
const offered = (commit = next) => ({ commit, version: "2.20.0-dev.2", entries: [{ version: "2.20.0-dev.2", heading: "2.20.0-dev.2 · Capibara · 2026-10-17", body: "- New." }], truncated: false });
function fact(overrides: Partial<HostFacts> & { serverId?: string; status?: HostFacts["host"]["status"] } = {}): HostFacts {
  const { serverId = "srv_demo_win", status = "online", ...rest } = overrides;
  return { host: { serverId, label: serverId === "srv_demo_mac" ? "MAC-DEMO" : "WIN-DEMO-PC", status }, registered: { version: "2.20.0-dev.1" },
    update: { state: update(), error: null }, job: null, pending: null, ignored: false, page: false, settled: true, ...rest };
}
function job(overrides: Partial<HostJob> = {}): HostJob {
  return { serverId: "srv_demo_build", kind: "install", command: "paseo plugin add", state: "running", startedAt: 1, result: null, output: [], error: null,
    workspaceId: "ws_demo", terminalId: "term_demo", ...overrides };
}
const unregistered = (overrides: Partial<HostFacts> = {}) =>
  fact({ serverId: "srv_demo_build", registered: null, update: { state: null, error: null }, ...overrides });
const named = (serverId: string, overrides: Partial<HostFacts> = {}) => unregistered({ host: { serverId, label: serverId.toUpperCase(), status: "online" }, ...overrides });

test("the page's installation sets the target: its newer revision, or its own revision with notes from a host behind it", () => {
  const page = fact({ serverId: "srv_demo_mac", page: true, update: { state: update({ available: offered() }), error: null } });
  assert.deepEqual(syncTarget([page, fact()]), { commit: next, version: "2.20.0-dev.2", entries: offered().entries, truncated: false });
  const currentPage = fact({ serverId: "srv_demo_mac", page: true });
  const behind = fact({ update: { state: update({ revision: other, available: offered(current) }), error: null } });
  assert.deepEqual(syncTarget([currentPage, behind]), { commit: current, version: "2.20.0-dev.1", entries: offered().entries, truncated: false });
  assert.equal(syncTarget([fact({ page: true, update: { state: null, error: "offline" } })]), null);
});

test("an installed host is current, outdated or diverged relative to the target, and updating or failed while it updates", () => {
  const target = { commit: next, version: "2.20.0-dev.2", entries: [], truncated: false };
  assert.equal(hostRow(fact({ update: { state: update({ revision: next }), error: null } }), target).state, "current");
  assert.equal(hostRow(fact({ update: { state: update({ available: offered() }), error: null } }), target).state, "outdated");
  assert.equal(hostRow(fact({ update: { state: update({ available: offered(other) }), error: null } }), target).state, "diverged");
  assert.equal(hostRow(fact({ update: { state: null, error: null } }), target).state, "checking");
  // Its own source check failed: shown, nothing to run. Its update service does not answer: a repair is offered.
  assert.deepEqual(pick(hostRow(fact({ update: { state: update({ error: "network" }), error: null } }), target)), ["check-failed", null]);
  assert.deepEqual(pick(hostRow(fact({ update: { state: null, error: "Unknown RPC observatory.update.get" } }), target)), ["check-failed", "repair"]);
  const started = new Date(5000).toISOString();
  const running = hostRow(fact({ update: { state: update({ available: offered(), updating: { commit: next, startedAt: started, error: null } }), error: null } }), target);
  assert.equal(running.state, "updating"); assert.equal(running.updatingSince, 5000); assert.equal(running.phase, "building");
  // Started by this client but not yet recorded by the host, or the old process answering before its restart.
  assert.equal(hostRow(fact({ pending: { commit: next, startedAt: 9 }, update: { state: update({ available: offered() }), error: null } }), target).state, "updating");
  // The installation restarting: it stops answering, then leaves the registry until the new revision registers.
  assert.equal(hostRow(fact({ pending: { commit: next, startedAt: 9 }, update: { state: update({ available: offered() }), error: "unavailable" } }), target).phase, "restarting");
  const gone = hostRow(fact({ registered: null, pending: { commit: next, startedAt: 9 } }), target);
  assert.deepEqual([gone.state, gone.phase, gone.updatingSince], ["updating", "restarting", 9]);
  const failed = hostRow(fact({ update: { state: update({ available: offered(), updating: { commit: next, startedAt: started, error: "build failed" } }), error: null } }), target);
  assert.deepEqual([failed.state, failed.action, failed.error], ["update-failed", "retry-update", "build failed"]);
});

test("a host without a running installation is offered an install once it had time to start one", () => {
  assert.deepEqual(pick(hostRow(unregistered({ settled: false }), null)), ["checking", null]);
  assert.deepEqual(pick(hostRow(unregistered(), null)), ["missing", "install"]);
  assert.equal(hostRow(fact({ status: "offline" }), null).state, "offline");
  assert.equal(hostRow(fact({ status: "error" }), null).state, "offline");
  assert.equal(hostRow(fact({ status: "idle" }), null).state, "offline");
  assert.equal(hostRow(fact({ status: "connecting" }), null).state, "connecting");
});

test("a terminal command shows while it runs and after it fails; a registered installation replaces a finished command", () => {
  assert.equal(hostRow(unregistered({ job: job() }), null).state, "job-running");
  assert.equal(hostRow(unregistered({ job: job({ state: "waiting", result: "ok" }) }), null).state, "job-waiting");
  const failed = hostRow(unregistered({ job: job({ state: "failed", result: "no-cli", error: "paseo not found" }) }), null);
  assert.deepEqual([failed.state, failed.action, failed.error], ["job-failed", "retry-job", "paseo not found"]);
  assert.equal(hostRow(fact({ job: job({ state: "failed", result: "failed" }) }), null).state, "current");
  assert.equal(hostRow(fact({ job: job({ state: "waiting" }) }), null).state, "current");
  assert.equal(hostRow(fact({ job: job() }), null).state, "job-running");
});

test("the summary counts what needs a decision, leaving ignored hosts and dismissed updates quiet", () => {
  const target = { commit: next, version: null, entries: [], truncated: false };
  const rows = [
    hostRow(fact({ update: { state: update({ available: offered() }), error: null } }), target),
    hostRow(fact({ update: { state: update({ available: offered(), dismissed: true }), error: null } }), target),
    hostRow(unregistered(), target),
    hostRow(unregistered({ ignored: true }), target),
    hostRow(unregistered({ job: job({ state: "failed" }) }), target),
    hostRow(unregistered({ job: job() }), target),
    hostRow(fact({ status: "offline" }), target),
    hostRow(fact({ update: { state: null, error: "Unknown RPC" } }), target),
  ];
  assert.deepEqual(hostSummary(rows), { total: 8, attention: 3, busy: 1, failed: 1 });
});

test("全部同步 updates every outdated or failed installation with the page last, and installs where none runs", () => {
  const target = { commit: next, version: null, entries: [], truncated: false };
  const outdated = (serverId: string, page = false, ignored = false) => hostRow(fact({ serverId, page, ignored, update: { state: update({ available: offered() }), error: null } }), target);
  const rows = [
    outdated("srv_demo_mac", true), outdated("srv_demo_win"), outdated("srv_demo_skip", false, true),
    hostRow(fact({ serverId: "srv_demo_failed", update: { state: update({ available: offered(), updating: { commit: next, startedAt: new Date(1).toISOString(), error: "x" } }), error: null } }), target),
    hostRow(fact({ serverId: "srv_demo_same", update: { state: update({ revision: next }), error: null } }), target),
    hostRow(fact({ serverId: "srv_demo_old", update: { state: null, error: "Unknown RPC" } }), target),
    hostRow(named("srv_demo_new"), target),
    hostRow(named("srv_demo_retry", { job: job({ serverId: "srv_demo_retry", kind: "repair", state: "failed" }) }), target),
    hostRow(named("srv_demo_hidden", { ignored: true }), target),
  ];
  // A host whose update service does not answer is repaired only when asked; it may be a passing failure.
  assert.deepEqual(planSync(rows), {
    updates: ["srv_demo_win", "srv_demo_failed", "srv_demo_mac"],
    commands: [{ serverId: "srv_demo_new", kind: "install" }, { serverId: "srv_demo_retry", kind: "repair" }],
  });
});

test("the command installs the page's own source and otherwise enables and updates in place; anything a shell could reinterpret is refused", () => {
  assert.deepEqual(hostCommand(source), { add: ["plugin", "add", "git:https://github.com/myaier/capibara.git:dashbord"],
    fallback: [["plugin", "enable", "agent-observatory"], ["plugin", "update", "agent-observatory", "--yes"]] });
  assert.deepEqual(hostCommand({ ...source, ref: "main" })!.add, ["plugin", "add", source.reference, "--ref", "main"]);
  assert.equal(displayCommand(hostCommand({ ...source, ref: "release/2.20" })!.add), "paseo plugin add git:https://github.com/myaier/capibara.git:dashbord --ref release/2.20");
  assert.equal(hostCommand(null), null);
  for (const reference of ["git:https://example.com/a b.git", "git:https://example.com/$(id).git", "git:x;rm", "git:x&calc", "git:x|y", "git:%PATH%", "git:x^y", "git:'x'", "-x", "~/plugins", "git:x>y", "git:x`id`"]) {
    assert.equal(hostCommand({ reference, ref: null }), null, reference);
  }
  for (const ref of ["-main", "main;id", "a b", "$(x)", "..x"]) assert.equal(hostCommand({ ...source, ref }), null, ref);
});

test("the installation source is formatted the way Paseo prints and parses it", () => {
  assert.equal(formatPluginSource({ kind: "git", remote: "https://github.com/myaier/capibara.git", pluginPath: "dashbord" }), "git:https://github.com/myaier/capibara.git:dashbord");
  assert.equal(formatPluginSource({ kind: "git", remote: "https://example.com/plugin.git", pluginPath: "." }), "git:https://example.com/plugin.git");
  assert.equal(formatPluginSource({ kind: "npm", packageName: "@example/observatory", pluginPath: "." }), "npm:@example/observatory");
  assert.equal(formatPluginSource({ kind: "git", remote: "https://example.com/x.git", pluginPath: "p", registry: { url: "https://registry.example.com/api", id: "demo/observatory" } }), "registry.example.com/demo/observatory");
  assert.equal(formatPluginSource({ kind: "directory", path: "/Users/<name>/plugin" }), null);
  assert.equal(formatPluginSource(undefined), null);
});

test("the terminal invocation picks the shell from the workspace path and reports one outcome line", () => {
  assert.equal(hostPlatform("C:\\Users\\demo\\project"), "windows");
  assert.equal(hostPlatform("D:/work/project"), "windows");
  assert.equal(hostPlatform("\\\\server\\share"), "windows");
  assert.equal(hostPlatform("/Users/<name>/project"), "posix");
  const command = hostCommand(source)!;
  const windows = terminalInvocation("windows", command);
  assert.equal(windows.command, "cmd.exe");
  assert.deepEqual(windows.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(windows.args[3], "where paseo >nul 2>nul && ((call paseo plugin add git:https://github.com/myaier/capibara.git:dashbord || (call paseo plugin enable agent-observatory && call paseo plugin update agent-observatory --yes)) && echo __OBSERVATORY_HOST_COMMAND__ ok || echo __OBSERVATORY_HOST_COMMAND__ failed) || echo __OBSERVATORY_HOST_COMMAND__ no-cli");
  const posix = terminalInvocation("posix", command);
  assert.equal(posix.command, "/bin/sh"); assert.equal(posix.args[0], "-c");
  assert.match(posix.args[1]!, /if "\$P" plugin add git:https:\/\/github\.com\/myaier\/capibara\.git:dashbord; then R=ok; elif "\$P" plugin enable agent-observatory && "\$P" plugin update agent-observatory --yes; then R=ok; else R=failed; fi; echo "__OBSERVATORY_HOST_COMMAND__ \$R"$/);
  assert.equal(commandResult(["+ paseo plugin add", "Installed", "__OBSERVATORY_HOST_COMMAND__ ok", ""]), "ok");
  assert.equal(commandResult(["  __OBSERVATORY_HOST_COMMAND__ no-cli  "]), "no-cli");
  assert.equal(commandResult(["Cloning", "__OBSERVATORY_HOST_COMMAND__ okay"]), null);
  assert.deepEqual(outputTail(["a", "", "b  ", "__OBSERVATORY_HOST_COMMAND__ failed", "c"], 2), ["b", "c"]);
  assert.deepEqual(pickWorkspace([{ id: "", workspaceDirectory: "/a" }, { id: "w1", archivingAt: "2026-10-16T00:00:00Z", workspaceDirectory: "/b" }, { id: "w2", projectRootPath: "/c" }]), { id: "w2", directory: "/c" });
  assert.equal(pickWorkspace([]), null);
});

test("the POSIX invocation installs with the CLI on PATH, and enables and updates in place when the plugin is already configured", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-host-command-"));
  try {
    const run = async (codes: { add: number; enable: number; update: number }) => {
      // A stand-in CLI that logs each call and exits with the code given for its subcommand.
      await writeFile(join(directory, "calls"), "");
      await writeFile(join(directory, "paseo"), `#!/bin/sh\necho "$*" >> "${directory}/calls"\ncase "$2" in add) exit ${codes.add};; enable) exit ${codes.enable};; update) exit ${codes.update};; esac\n`);
      await chmod(join(directory, "paseo"), 0o755);
      const invocation = terminalInvocation("posix", hostCommand(source)!);
      const output = await new Promise<string[]>((resolve, reject) => execFile(invocation.command, invocation.args, { env: { PATH: `${directory}:/usr/bin:/bin`, HOME: directory } },
        (error, stdout) => error && !stdout ? reject(error) : resolve(stdout.split("\n"))));
      return { result: commandResult(output), calls: (await readFile(join(directory, "calls"), "utf8")).trim().split("\n") };
    };
    assert.deepEqual(await run({ add: 0, enable: 0, update: 0 }), { result: "ok", calls: ["plugin add git:https://github.com/myaier/capibara.git:dashbord"] });
    assert.deepEqual(await run({ add: 1, enable: 0, update: 0 }), { result: "ok",
      calls: ["plugin add git:https://github.com/myaier/capibara.git:dashbord", "plugin enable agent-observatory", "plugin update agent-observatory --yes"] });
    assert.equal((await run({ add: 1, enable: 1, update: 0 })).result, "failed");
    assert.equal((await run({ add: 1, enable: 0, update: 1 })).result, "failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function pick(row: ReturnType<typeof hostRow>) { return [row.state, row.action]; }
