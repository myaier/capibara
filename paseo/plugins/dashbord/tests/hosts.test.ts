import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandResult, compareVersions, displayCommand, hostCommand, hostPlatform, hostRow, hostSummary, mergeHostMemory, outputTail, pickWorkspace, planSync,
  pluginConfigState, syncTarget, terminalInvocation, type HostFacts, type HostJob, type HostMemory } from "../shared/hosts";
import { formatPluginSource, type UpdateState } from "../shared/plugin-update";

const current = "75c0c6a4aaf70362226fe31664d800c89be0df3b", next = "8e1f2c3d4b5a69788796a5b4c3d2e1f00a1b2c3d", other = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d";
const source = { reference: "git:https://github.com/myaier/capibara.git:dashbord", ref: null };
const installed = { pluginsEnabled: true, installed: true, enabled: true };
function update(overrides: Partial<UpdateState> = {}): UpdateState {
  return { version: "2.20.0-dev.1", revision: current, available: null, dismissed: false, checking: false, checkedAt: null, error: null,
    updating: null, justUpdated: null, source, ...overrides };
}
const offered = (commit = next) => ({ commit, version: "2.20.0-dev.2", entries: [{ version: "2.20.0-dev.2", heading: "2.20.0-dev.2 · Capibara · 2026-10-17", body: "- New." }], truncated: false });
function fact(overrides: Partial<HostFacts> & { serverId?: string; status?: HostFacts["host"]["status"] } = {}): HostFacts {
  const { serverId = "srv_demo_win", status = "online", ...rest } = overrides;
  return { host: { serverId, label: serverId === "srv_demo_mac" ? "MAC-DEMO" : "WIN-DEMO-PC", status }, registered: { version: "2.20.0-dev.1" },
    update: { state: update(), error: null }, config: { value: null, error: null }, memory: null, job: null, pending: null, ignored: false, page: false, settled: true, ...rest };
}
function job(overrides: Partial<HostJob> = {}): HostJob {
  return { serverId: "srv_demo_build", kind: "install", command: "paseo plugin add", state: "running", startedAt: 1, result: null, output: [], error: null,
    workspaceId: "ws_demo", terminalId: "term_demo", ...overrides };
}
const unregistered = (config: HostFacts["config"]["value"], overrides: Partial<HostFacts> = {}) =>
  fact({ serverId: "srv_demo_build", registered: null, update: { state: null, error: null }, config: { value: config, error: null }, ...overrides });
const named = (serverId: string, config: HostFacts["config"]["value"], overrides: Partial<HostFacts> = {}) =>
  unregistered(config, { host: { serverId, label: serverId.toUpperCase(), status: "online" }, ...overrides });
const remembered = (overrides: Partial<HostMemory> = {}): HostMemory => ({ serverId: "srv_demo_win", label: "WIN-DEMO-PC", version: "2.19.0-dev.8", revision: current, seenAt: "2026-10-14T08:00:00.000Z", ...overrides });
const pick = (row: ReturnType<typeof hostRow>) => [row.state, row.action];

test("only the plugin's own facts are kept from a daemon config, whatever else it carries", () => {
  const config = { pluginsEnabled: true, providers: { claude: { env: { ANTHROPIC_API_KEY: "demo-key" } } },
    plugins: { "agent-observatory": { source: "directory", path: "/Users/<name>/.paseo/plugins/x", enabled: false }, other: { source: "directory", path: "/x" } } };
  assert.deepEqual(pluginConfigState(config), { pluginsEnabled: true, installed: true, enabled: false });
  assert.deepEqual(pluginConfigState({ pluginsEnabled: true, plugins: { "agent-observatory": { source: "directory", path: "/x" } } }), installed);
  assert.deepEqual(pluginConfigState({ plugins: {} }), { pluginsEnabled: false, installed: false, enabled: false });
  assert.deepEqual(pluginConfigState(null), { pluginsEnabled: false, installed: false, enabled: false });
});

test("the page's installation sets the target: its newer revision, or its own revision with notes from a host behind it", () => {
  const page = fact({ serverId: "srv_demo_mac", page: true, update: { state: update({ available: offered() }), error: null } });
  assert.deepEqual(syncTarget([page, fact()]), { commit: next, version: "2.20.0-dev.2", entries: offered().entries, truncated: false });
  const currentPage = fact({ serverId: "srv_demo_mac", page: true });
  const behind = fact({ update: { state: update({ revision: other, available: offered(current) }), error: null } });
  assert.deepEqual(syncTarget([currentPage, behind]), { commit: current, version: "2.20.0-dev.1", entries: offered().entries, truncated: false });
  assert.equal(syncTarget([fact({ page: true, update: { state: null, error: "offline" } })]), null);
});

test("an installed host is current, outdated with its own update, or diverged; updating or failed while it updates", () => {
  const target = { commit: next, version: "2.20.0-dev.2", entries: [], truncated: false };
  assert.equal(hostRow(fact({ update: { state: update({ revision: next }), error: null } }), target).state, "current");
  assert.deepEqual(pick(hostRow(fact({ update: { state: update({ available: offered() }), error: null } }), target)), ["outdated", "update"]);
  assert.equal(hostRow(fact({ update: { state: update({ available: offered(other) }), error: null } }), target).state, "diverged");
  // An answer from before the target was set, or a check still running, is not called diverged.
  assert.equal(hostRow(fact({ stale: true, update: { state: update({ available: offered(other) }), error: null } }), target).state, "checking");
  assert.equal(hostRow(fact({ update: { state: update({ available: offered(other), checking: true }), error: null } }), target).state, "checking");
  assert.equal(hostRow(fact({ stale: true, update: { state: update({ available: offered() }), error: null } }), target).state, "outdated");
  assert.equal(hostRow(fact({ update: { state: null, error: null } }), target).state, "checking");
  assert.deepEqual(pick(hostRow(fact({ update: { state: update({ error: "network" }), error: null } }), target)), ["check-failed", null]);
  assert.deepEqual(pick(hostRow(fact({ update: { state: null, error: "timeout" } }), target)), ["check-failed", null]);
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
  // The page's own update waiting for commands on other hosts.
  const queued = hostRow(fact({ page: true, pending: { commit: next, startedAt: 9, queued: true }, update: { state: update({ available: offered() }), error: null } }), target);
  assert.deepEqual([queued.state, queued.action], ["queued", null]);
  assert.equal(hostSummary([queued]).busy, 1);
});

test("a host without a running installation is not installed, disabled, too old, or has plugins turned off, as its config says", () => {
  assert.deepEqual(pick(hostRow(unregistered(null), null)), ["checking", null]);
  assert.deepEqual(pick(hostRow(unregistered({ pluginsEnabled: true, installed: false, enabled: false }), null)), ["missing", "install"]);
  assert.deepEqual(pick(hostRow(unregistered({ pluginsEnabled: true, installed: true, enabled: false }), null)), ["disabled", "enable"]);
  assert.deepEqual(pick(hostRow(unregistered(installed), null)), ["too-old", "upgrade"]);
  assert.deepEqual(pick(hostRow(unregistered({ pluginsEnabled: false, installed: true, enabled: true }), null)), ["plugins-off", "plugins-on"]);
  // Absent or disabled is final at once; installed and enabled waits for the host to have started it.
  assert.equal(hostRow(unregistered({ pluginsEnabled: true, installed: false, enabled: false }, { settled: false }), null).state, "missing");
  assert.equal(hostRow(unregistered(installed, { settled: false }), null).state, "checking");
  const unreadable = hostRow(fact({ serverId: "srv_demo_build", registered: null, update: { state: null, error: null }, config: { value: null, error: "denied" } }), null);
  assert.deepEqual([unreadable.state, unreadable.action, unreadable.error], ["check-failed", "install", "denied"]);
  // A running installation from before the update RPC is upgraded from its command line.
  assert.deepEqual(pick(hostRow(fact({ registered: { version: "2.18.0-dev.4" }, update: { state: null, error: "Unknown RPC" } }), null)), ["too-old", "upgrade"]);
  assert.equal(hostRow(fact({ registered: { version: "2.18.0-dev.9" } }), null).state, "current");
  assert.equal(hostRow(fact({ status: "connecting" }), null).state, "connecting");
});

test("an offline host shows when it was last seen and needs a sync if it then ran another revision", () => {
  const target = { commit: next, version: "2.20.0-dev.2", entries: [], truncated: false };
  const offline = hostRow(fact({ status: "offline", update: { state: null, error: null }, memory: remembered() }), target);
  assert.deepEqual([offline.state, offline.version, offline.lastSeen, offline.pendingSync], ["offline", "2.19.0-dev.8", "2026-10-14T08:00:00.000Z", true]);
  assert.equal(hostRow(fact({ status: "offline", memory: remembered({ revision: next }) }), target).pendingSync, false);
  const unknown = hostRow(fact({ status: "error", memory: null }), target);
  assert.deepEqual([unknown.state, unknown.lastSeen, unknown.pendingSync], ["offline", null, false]);
  assert.equal(hostRow(fact({ status: "idle", memory: remembered() }), null).pendingSync, false);
});

test("a terminal command shows while it runs and after it fails; a registered installation replaces a finished command", () => {
  const missing = { pluginsEnabled: true, installed: false, enabled: false };
  assert.equal(hostRow(unregistered(missing, { job: job() }), null).state, "job-running");
  assert.equal(hostRow(unregistered(missing, { job: job({ state: "waiting", result: "ok" }) }), null).state, "job-waiting");
  const failed = hostRow(unregistered(missing, { job: job({ state: "failed", result: "no-cli", error: "paseo not found" }) }), null);
  assert.deepEqual([failed.state, failed.action, failed.error], ["job-failed", "retry-job", "paseo not found"]);
  assert.equal(hostRow(fact({ job: job({ state: "failed", result: "failed" }) }), null).state, "current");
  assert.equal(hostRow(fact({ job: job({ state: "waiting" }) }), null).state, "current");
});

test("the summary counts what needs a decision, leaving ignored hosts and dismissed updates quiet", () => {
  const target = { commit: next, version: null, entries: [], truncated: false };
  const missing = { pluginsEnabled: true, installed: false, enabled: false };
  const rows = [
    hostRow(fact({ update: { state: update({ available: offered() }), error: null } }), target),
    hostRow(fact({ update: { state: update({ available: offered(), dismissed: true }), error: null } }), target),
    hostRow(unregistered(missing), target),
    hostRow(unregistered({ pluginsEnabled: true, installed: true, enabled: false }), target),
    hostRow(unregistered(installed), target),
    hostRow(unregistered(missing, { ignored: true }), target),
    hostRow(unregistered(missing, { job: job({ state: "failed" }) }), target),
    hostRow(unregistered(missing, { job: job() }), target),
    hostRow(unregistered({ pluginsEnabled: false, installed: false, enabled: false }), target),
    hostRow(fact({ status: "offline", memory: remembered() }), target),
  ];
  assert.deepEqual(hostSummary(rows), { total: 10, attention: 6, busy: 1, failed: 1 });
});

test("全部同步 updates every outdated or failed installation with the page last, and installs, enables, upgrades or turns plugins on for the others", () => {
  const target = { commit: next, version: null, entries: [], truncated: false };
  const outdated = (serverId: string, page = false, ignored = false) => hostRow(fact({ serverId, page, ignored, update: { state: update({ available: offered() }), error: null } }), target);
  const rows = [
    outdated("srv_demo_mac", true), outdated("srv_demo_win"), outdated("srv_demo_skip", false, true),
    hostRow(fact({ serverId: "srv_demo_failed", update: { state: update({ available: offered(), updating: { commit: next, startedAt: new Date(1).toISOString(), error: "x" } }), error: null } }), target),
    hostRow(fact({ serverId: "srv_demo_same", update: { state: update({ revision: next }), error: null } }), target),
    hostRow(named("srv_demo_new", { pluginsEnabled: true, installed: false, enabled: false }), target),
    hostRow(named("srv_demo_off", { pluginsEnabled: true, installed: true, enabled: false }), target),
    hostRow(named("srv_demo_old", installed), target),
    hostRow(named("srv_demo_retry", { pluginsEnabled: true, installed: false, enabled: false }, { job: job({ serverId: "srv_demo_retry", kind: "enable", state: "failed" }) }), target),
    hostRow(named("srv_demo_hidden", { pluginsEnabled: true, installed: false, enabled: false }, { ignored: true }), target),
    hostRow(named("srv_demo_plugins_off", { pluginsEnabled: false, installed: true, enabled: true }), target),
  ];
  assert.deepEqual(planSync(rows), {
    updates: ["srv_demo_win", "srv_demo_failed", "srv_demo_mac"],
    commands: [{ serverId: "srv_demo_new", kind: "install" }, { serverId: "srv_demo_off", kind: "enable" }, { serverId: "srv_demo_old", kind: "upgrade" }, { serverId: "srv_demo_retry", kind: "enable" },
      { serverId: "srv_demo_plugins_off", kind: "plugins-on" }],
  });
});

test("install adds the page's own source; enable and upgrade name this plugin; turning plugins on reloads the daemon before what the host still needs; anything a shell could reinterpret is refused", () => {
  assert.deepEqual(hostCommand("install", source), [["plugin", "add", "git:https://github.com/myaier/capibara.git:dashbord"]]);
  assert.deepEqual(hostCommand("install", { ...source, ref: "main" }), [["plugin", "add", source.reference, "--ref", "main"]]);
  assert.equal(displayCommand(hostCommand("install", { ...source, ref: "release/2.20" })![0]!), "paseo plugin add git:https://github.com/myaier/capibara.git:dashbord --ref release/2.20");
  assert.deepEqual(hostCommand("enable", null), [["plugin", "enable", "agent-observatory"]]);
  assert.deepEqual(hostCommand("upgrade", null), [["plugin", "update", "agent-observatory", "--yes"], ["plugin", "reload", "agent-observatory"]]);
  assert.equal(hostCommand("install", null), null);
  const on = [["daemon", "config", "set", "pluginsEnabled", "true"], ["daemon", "reload"]], off = { pluginsEnabled: false, installed: true, enabled: true };
  assert.deepEqual(hostCommand("plugins-on", null, off), on);
  assert.deepEqual(hostCommand("plugins-on", null, { ...off, enabled: false }), [...on, ["plugin", "enable", "agent-observatory"]]);
  assert.deepEqual(hostCommand("plugins-on", source, { ...off, installed: false, enabled: false }), [...on, ["plugin", "add", source.reference]]);
  assert.equal(hostCommand("plugins-on", null, { ...off, installed: false, enabled: false }), null);
  for (const reference of ["git:https://example.com/a b.git", "git:https://example.com/$(id).git", "git:x;rm", "git:x&calc", "git:x|y", "git:%PATH%", "git:x^y", "git:'x'", "-x", "~/plugins", "git:x>y", "git:x`id`"]) {
    assert.equal(hostCommand("install", { reference, ref: null }), null, reference);
  }
  for (const ref of ["-main", "main;id", "a b", "$(x)", "..x"]) assert.equal(hostCommand("install", { ...source, ref }), null, ref);
});

test("versions compare by number with a release after its dev builds; memory keeps the latest sighting per host", () => {
  assert.equal(compareVersions("2.18.0-dev.4", "2.18.0-dev.9"), -1);
  assert.equal(compareVersions("2.18.0-dev.10", "2.18.0-dev.9"), 1);
  assert.equal(compareVersions("2.18.0", "2.18.0-dev.9"), 1);
  assert.equal(compareVersions("2.17.3", "2.18.0-dev.9"), -1);
  assert.equal(compareVersions("2.20.0-dev.1", "2.20.0-dev.1"), 0);
  assert.ok(Number.isNaN(compareVersions("dev", "2.18.0")));
  const older = remembered({ seenAt: "2026-10-14T08:00:00.000Z" }), newer = remembered({ version: "2.20.0-dev.1", seenAt: "2026-10-16T08:00:00.000Z" });
  assert.deepEqual(mergeHostMemory([newer], [older]), [newer]);
  assert.deepEqual(mergeHostMemory([older], [newer, remembered({ serverId: "srv_demo_mac", label: "MAC-DEMO", seenAt: "2026-10-15T08:00:00.000Z" })]).map(entry => entry.serverId), ["srv_demo_win", "srv_demo_mac"]);
  assert.equal(mergeHostMemory([], Array.from({ length: 70 }, (_, index) => remembered({ serverId: `srv_demo_${index}`, seenAt: new Date(index * 1000).toISOString() }))).length, 64);
});

test("the installation source is formatted the way Paseo prints and parses it", () => {
  assert.equal(formatPluginSource({ kind: "git", remote: "https://github.com/myaier/capibara.git", pluginPath: "dashbord" }), "git:https://github.com/myaier/capibara.git:dashbord");
  assert.equal(formatPluginSource({ kind: "git", remote: "https://example.com/plugin.git", pluginPath: "." }), "git:https://example.com/plugin.git");
  assert.equal(formatPluginSource({ kind: "npm", packageName: "@example/observatory", pluginPath: "." }), "npm:@example/observatory");
  assert.equal(formatPluginSource({ kind: "git", remote: "https://example.com/x.git", pluginPath: "p", registry: { url: "https://registry.example.com/api", id: "demo/observatory" } }), "registry.example.com/demo/observatory");
  assert.equal(formatPluginSource({ kind: "directory", path: "/Users/<name>/plugin" }), null);
  assert.equal(formatPluginSource(undefined), null);
});

test("the terminal invocation picks the shell from the workspace path, runs the steps in order and reports one outcome line", () => {
  assert.equal(hostPlatform("C:\\Users\\demo\\project"), "windows");
  assert.equal(hostPlatform("D:/work/project"), "windows");
  assert.equal(hostPlatform("\\\\server\\share"), "windows");
  assert.equal(hostPlatform("/Users/<name>/project"), "posix");
  const windows = terminalInvocation("windows", hostCommand("install", source)!);
  assert.equal(windows.command, "cmd.exe");
  assert.deepEqual(windows.args.slice(0, 3), ["/d", "/s", "/k"]);
  assert.equal(windows.args[3], "where paseo >nul 2>nul && ((call paseo plugin add git:https://github.com/myaier/capibara.git:dashbord) && echo __OBSERVATORY_HOST_COMMAND__ ok || echo __OBSERVATORY_HOST_COMMAND__ failed) || echo __OBSERVATORY_HOST_COMMAND__ no-cli");
  assert.match(terminalInvocation("windows", hostCommand("upgrade", null)!).args[3]!, /\(\(call paseo plugin update agent-observatory --yes && call paseo plugin reload agent-observatory\) && echo/);
  const posix = terminalInvocation("posix", hostCommand("upgrade", null)!);
  assert.equal(posix.command, "/bin/sh"); assert.equal(posix.args[0], "-c");
  assert.match(posix.args[1]!, /if "\$P" plugin update agent-observatory --yes && "\$P" plugin reload agent-observatory; then R=ok; else R=failed; fi; fi; echo "__OBSERVATORY_HOST_COMMAND__ \$R"; exec "\$\{SHELL:-\/bin\/sh\}" -il$/);
  assert.equal(commandResult(["+ paseo plugin add", "Installed", "__OBSERVATORY_HOST_COMMAND__ ok", ""]), "ok");
  assert.equal(commandResult(["  __OBSERVATORY_HOST_COMMAND__ no-cli  "]), "no-cli");
  assert.equal(commandResult(["Cloning", "__OBSERVATORY_HOST_COMMAND__ okay"]), null);
  assert.deepEqual(outputTail(["a", "", "b  ", "__OBSERVATORY_HOST_COMMAND__ failed", "c"], 2), ["b", "c"]);
  assert.deepEqual(pickWorkspace([{ id: "", workspaceDirectory: "/a" }, { id: "w1", archivingAt: "2026-10-16T00:00:00Z", workspaceDirectory: "/b" }, { id: "w2", projectRootPath: "/c" }]), { id: "w2", directory: "/c" });
  assert.equal(pickWorkspace([]), null);
});

test("the POSIX invocation runs each step with the CLI on PATH and fails as soon as one fails", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-host-command-"));
  try {
    const run = async (steps: string[][], codes: Record<string, number>) => {
      // A stand-in CLI that logs each call and exits with the code given for its subcommand.
      await writeFile(join(directory, "calls"), "");
      await writeFile(join(directory, "paseo"), `#!/bin/sh\necho "$*" >> "${directory}/calls"\ncase "$2" in ${Object.entries(codes).map(([name, code]) => `${name}) exit ${code};;`).join(" ")} esac\n`);
      await chmod(join(directory, "paseo"), 0o755);
      const invocation = terminalInvocation("posix", steps);
      // The shell stays open after the outcome line; stdin at end of file lets it exit here.
      const output = await new Promise<string[]>((resolve, reject) => execFile(invocation.command, invocation.args, { env: { PATH: `${directory}:/usr/bin:/bin`, HOME: directory, SHELL: "/bin/sh" } },
        (error, stdout) => error && !stdout ? reject(error) : resolve(stdout.split("\n"))).stdin?.end());
      return { result: commandResult(output), calls: (await readFile(join(directory, "calls"), "utf8")).trim().split("\n") };
    };
    assert.deepEqual(await run(hostCommand("install", source)!, { add: 0 }), { result: "ok", calls: ["plugin add git:https://github.com/myaier/capibara.git:dashbord"] });
    assert.deepEqual(await run(hostCommand("install", source)!, { add: 1 }), { result: "failed", calls: ["plugin add git:https://github.com/myaier/capibara.git:dashbord"] });
    assert.deepEqual(await run(hostCommand("upgrade", null)!, { update: 0, reload: 0 }), { result: "ok", calls: ["plugin update agent-observatory --yes", "plugin reload agent-observatory"] });
    assert.deepEqual(await run(hostCommand("upgrade", null)!, { update: 2, reload: 0 }), { result: "failed", calls: ["plugin update agent-observatory --yes"] });
    const off = { pluginsEnabled: false, installed: true, enabled: false };
    assert.deepEqual(await run(hostCommand("plugins-on", null, off)!, { config: 0, reload: 0, enable: 0 }),
      { result: "ok", calls: ["daemon config set pluginsEnabled true", "daemon reload", "plugin enable agent-observatory"] });
    assert.deepEqual(await run(hostCommand("plugins-on", null, off)!, { config: 0, reload: 1 }), { result: "failed", calls: ["daemon config set pluginsEnabled true", "daemon reload"] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
