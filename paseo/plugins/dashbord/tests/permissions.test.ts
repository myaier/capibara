import assert from "node:assert/strict";
import test from "node:test";
import { DENY_MESSAGE, PERMISSION_TEXT_LIMIT, answerPermission, isLastingAction, permissionChoices, permissionView, requestState, type PermissionHandle, type PermissionResponse } from "../shared/permissions";

// Request shapes as Paseo 0.11.1 providers build them (daemon agent/providers/*), with made-up commands and paths.
const claudeBash = { id: "permission-1", provider: "claude", name: "Bash", kind: "tool", input: { command: "npm test -- --runInBand", description: "Run the unit tests" },
  detail: { type: "shell", command: "npm test -- --runInBand" }, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }] };
const codexCommand = { id: "permission-item-7", provider: "codex", name: "CodexBash", kind: "tool", title: "Run command: git push origin feature", description: "Push the branch",
  input: { command: "git push origin feature", cwd: "/home/me/app" }, detail: { type: "shell", command: "git push origin feature", cwd: "/home/me/app" } };
const acpOptions = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "allow_always", name: "Always Allow", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
const acpEdit = { id: "perm-acp-1", provider: "my-acp", name: "edit", kind: "tool", title: "Edit src/app.ts", detail: { type: "edit", filePath: "/home/me/app/src/app.ts", oldString: "a", newString: "b" },
  actions: acpOptions.map(option => ({ id: option.optionId, label: option.name, behavior: option.kind.startsWith("allow") ? "allow" : "deny" })), metadata: { toolCallId: "t1", options: acpOptions } };
const responses = (request: unknown) => permissionChoices(request).map(choice => [choice.label, choice.response]);

test("a tool request without provider actions gets 批准 / 拒绝 / 拒绝并中断, answered exactly so", () => {
  const view = permissionView(claudeBash, "/home/me/app")!;
  assert.equal(view.inline, true);
  assert.equal(view.title, "Bash");
  assert.equal(view.tool, null, "the name is the title already");
  assert.equal(view.command, "npm test -- --runInBand");
  assert.equal(view.args, "description: Run the unit tests", "the command has its own line; the rest is listed");
  assert.deepEqual([view.cwd, view.cwdIsAgent], ["/home/me/app", true], "Claude names no directory: the Agent's is shown, marked as such");
  assert.deepEqual(responses(claudeBash), [
    ["批准", { behavior: "allow" }],
    ["拒绝", { behavior: "deny", message: DENY_MESSAGE }],
    ["拒绝并中断", { behavior: "deny", interrupt: true, message: DENY_MESSAGE }],
  ]);
  // Claude's own rule suggestions (always allow Bash) are never offered or sent.
  assert.ok(permissionChoices(claudeBash).every(choice => !choice.lasting && !("updatedPermissions" in choice.response)));
  const codex = permissionView(codexCommand, "/home/me/other")!;
  assert.deepEqual([codex.title, codex.tool, codex.description, codex.command, codex.cwd, codex.cwdIsAgent], ["Run command: git push origin feature", "CodexBash", "Push the branch", "git push origin feature", "/home/me/app", false]);
  assert.equal(codex.args, null, "command and cwd are shown on their own lines");
});

test("provider actions keep their labels and are answered by id; lasting ones are marked (ACP kinds first)", () => {
  const choices = permissionChoices(acpEdit);
  assert.deepEqual(choices.map(choice => [choice.label, choice.lasting, choice.fromProvider]), [["Allow", false, true], ["Reject", false, true], ["Always Allow", true, true], ["拒绝并中断", false, false]]);
  assert.deepEqual(choices.map(choice => choice.response), [
    { behavior: "allow", selectedActionId: "allow" },
    { behavior: "deny", selectedActionId: "reject" },
    { behavior: "allow", selectedActionId: "allow_always" },
    // An unnamed ACP denial could pick a lasting reject_always: 拒绝并中断 names the one-time reject.
    { behavior: "deny", interrupt: true, message: DENY_MESSAGE, selectedActionId: "reject" },
  ]);
  const view = permissionView(acpEdit, "/home/me/app")!;
  assert.deepEqual([view.target, view.args], ["/home/me/app/src/app.ts", "oldString: a\nnewString: b"]);
  // An ACP kind outranks a label that sounds harmless.
  const sneaky = { ...acpEdit, actions: [{ id: "yes", label: "Yes", behavior: "allow" }], metadata: { options: [{ optionId: "yes", name: "Yes", kind: "allow_always" }] } };
  assert.equal(permissionChoices(sneaky)[0]!.lasting, true);
  // Only lasting denials: 拒绝并中断 would pick one of them, so it is not offered.
  const lastingDeny = { ...acpEdit, actions: [{ id: "ok", label: "Allow", behavior: "allow" }, { id: "never", label: "Reject Always", behavior: "deny" }], metadata: { options: [{ optionId: "ok", kind: "allow_once" }, { optionId: "never", kind: "reject_always" }] } };
  assert.deepEqual(permissionChoices(lastingDeny).map(choice => choice.key), ["action:ok", "action:never"]);
  // An ACP chooser (choices, no denial): 拒绝并中断 cancels without naming an option.
  const chooser = { ...acpEdit, detail: { type: "plain_text", text: "Pick a branch" }, actions: [{ id: "a", label: "main", behavior: "allow" }, { id: "b", label: "develop", behavior: "allow" }], metadata: {} };
  assert.deepEqual(permissionChoices(chooser).at(-1)!.response, { behavior: "deny", interrupt: true, message: DENY_MESSAGE });
  assert.equal(permissionView(chooser)!.args, "Pick a branch");
});

test("OpenCode and omp: their own actions, lasting by id or label, and no 拒绝并中断 (they ignore interrupt)", () => {
  const v1 = { id: "per_1", provider: "opencode", name: "bash", kind: "tool", title: "Bash", actions: [{ id: "deny", label: "Deny", behavior: "deny" }, { id: "allow_always", label: "Allow always", behavior: "allow" }, { id: "allow_once", label: "Allow once", behavior: "allow" }] };
  assert.deepEqual(permissionChoices(v1).map(choice => [choice.label, choice.lasting, choice.response]), [
    ["Allow once", false, { behavior: "allow", selectedActionId: "allow_once" }],
    ["Deny", false, { behavior: "deny", selectedActionId: "deny" }],
    ["Allow always", true, { behavior: "allow", selectedActionId: "allow_always" }],
  ]);
  const v2 = { ...v1, actions: [{ id: "once", label: "Allow once", behavior: "allow" }, { id: "always", label: "Always allow", behavior: "allow" }, { id: "reject", label: "Deny", behavior: "deny" }] };
  assert.deepEqual(permissionChoices(v2).map(choice => [choice.key, choice.lasting]), [["action:once", false], ["action:reject", false], ["action:always", true]]);
  const omp = { id: "ui-3", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash", actions: [{ id: "deny", label: "Deny", behavior: "deny" }, { id: "approve", label: "Approve", behavior: "allow" }] };
  assert.deepEqual(permissionChoices(omp).map(choice => [choice.label, choice.lasting]), [["Approve", false], ["Deny", false]]);
});

test("lasting choices are recognised by id and by label, in English and Chinese", () => {
  for (const action of [{ id: "allow_always", label: "Allow" }, { id: "always", label: "OK" }, { id: "x", label: "Allow for this session" }, { id: "x", label: "Yes, and don't ask again" },
    { id: "x", label: "本会话内允许" }, { id: "x", label: "总是允许" }, { id: "x", label: "以后都允许" }, { id: "acceptForSession", label: "Accept" }, { id: "approve-session", label: "Approve" }]) {
    assert.equal(isLastingAction(action), true, JSON.stringify(action));
  }
  for (const action of [{ id: "allow", label: "Allow" }, { id: "allow_once", label: "Allow once" }, { id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }, { id: "reject", label: "拒绝" }, { id: "y", label: "允许这一次" }]) {
    assert.equal(isLastingAction(action), false, JSON.stringify(action));
  }
  assert.equal(isLastingAction({ id: "z", label: "Fine" }, "reject_always"), true);
  assert.equal(isLastingAction({ id: "z", label: "Fine" }, "allow_once"), false);
});

test("questions, plans and choice-less mode switches open the conversation; a request without an id is not shown", () => {
  assert.equal(permissionView({ id: "q", kind: "question", name: "AskUserQuestion", input: { questions: [{ question: "Which one?" }] } })!.inline, false);
  assert.equal(permissionView({ id: "p", kind: "plan", name: "ExitPlanMode", actions: [{ id: "implement", label: "Implement", behavior: "allow" }] })!.inline, false);
  assert.equal(permissionView({ id: "m", kind: "mode", title: "Switch to code mode", actions: [{ id: "ok", label: "Allow", behavior: "allow" }] })!.inline, true);
  assert.equal(permissionView({ id: "m", kind: "mode", title: "Switch to code mode" })!.inline, false);
  const odd = permissionView({ id: "o", kind: "surprise", name: "Thing" })!;
  assert.deepEqual([odd.kind, odd.inline], ["other", false], "an unknown kind is never approved in place");
  assert.equal(permissionView({ kind: "tool", name: "Bash" }), null);
  // Malformed actions are dropped rather than sent.
  assert.deepEqual(permissionChoices({ id: "t", kind: "tool", actions: [{ id: "", label: "x", behavior: "allow" }, { id: "a", label: "A", behavior: "maybe" }] }).map(choice => choice.key), ["allow", "deny", "deny-interrupt"]);
  // A diff the provider prepared is shown as is.
  assert.equal(permissionView({ id: "e", kind: "tool", name: "Edit", input: { file_path: "/home/me/app/a.ts", old_string: "x", new_string: "y" }, detail: { type: "edit", filePath: "/home/me/app/a.ts", unifiedDiff: "@@ -1 +1 @@\n-x\n+y" } })!.args, "@@ -1 +1 @@\n-x\n+y");
});

// codex-obs-send-ui-F1 (send-ui/repro.ts): 展开完整内容 must show everything the request would do, so nothing is cut in the view.
test("whole parameters are counted by where each one ends, never by lines: a value's own line breaks are not parameters (codex-obs-send-ui-R1)", () => {
  // codex-obs-send-ui-R1: a long multi-line value cut halfway was counted as some 32,000 whole parameters out of 2, and the
  // panel showed a negative number of parameters not shown whole.
  const script = permissionView({ id: "s", kind: "tool", name: "Tool", input: { script: "x\n".repeat(40_000), hidden: "last value" } })!;
  assert.deepEqual(script.cut.args, { kept: PERMISSION_TEXT_LIMIT, total: 80_027, items: { total: 2, whole: 0 } });
  // A multi-line value that fits is whole; the one cut after it, and the one after that, are not.
  const mixed = permissionView({ id: "m", kind: "tool", name: "Tool", input: { note: "line\n".repeat(100), body: "y\n".repeat(40_000), tail: "z" } })!;
  assert.deepEqual(mixed.cut.args!.items, { total: 3, whole: 1 });
  assert.ok(mixed.args!.startsWith(`note: ${"line\n".repeat(100)}\nbody: y\n`));
  // Beside a diff, the other parameters are counted the same way.
  const edit = permissionView({ id: "e", kind: "tool", name: "Edit", input: { file_path: "/a.ts", old_string: "a", new_string: "b", first: "1", script: "q\n".repeat(40_000), last: "2" },
    detail: { type: "edit", filePath: "/a.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" } })!;
  assert.deepEqual(edit.cut.params!.items, { total: 3, whole: 1 });
  for (const view of [script, mixed]) {
    const items = view.cut.args!.items!;
    assert.ok(items.whole >= 0 && items.whole <= items.total, JSON.stringify(items));
  }
});

test("a long command, a long parameter and a request with only query / pattern are kept whole (codex-obs-send-ui-F1)", () => {
  const longCommand = `printf ${"x".repeat(4100)} ; echo ACTUAL_END_OF_COMMAND`;
  const command = permissionView({ id: "long-command", kind: "tool", provider: "claude", name: "Bash", input: { command: longCommand } })!;
  assert.equal(command.command, longCommand, "the 4136-character command keeps its tail");
  assert.deepEqual(command.cut, {});
  const content = `${"x".repeat(1300)}ACTUAL_INPUT_END`;
  const write = permissionView({ id: "long-input", kind: "tool", provider: "claude", name: "Write", input: { content } })!;
  assert.equal(write.args, `content: ${content}`, "a parameter past 1200 characters keeps its end marker");
  const search = permissionView({ id: "search", kind: "tool", provider: "claude", name: "WebSearch", input: { query: "the exact user search", pattern: "private*" } })!;
  assert.deepEqual([search.command, search.target, search.args], [null, "the exact user search", "pattern: private*"], "the query is the target, the pattern a parameter");
  const glob = permissionView({ id: "glob", kind: "tool", provider: "claude", name: "Glob", input: { pattern: "src/**/*.ts" } })!;
  assert.deepEqual([glob.target, glob.args], ["src/**/*.ts", null], "a pattern alone is the target");
  // Many parameters and long values: all of them, in order, not the first 16 cut to 1200 characters each.
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`option${index}`, `${"v".repeat(1500)}#${index}`]));
  const listed = permissionView({ id: "many", kind: "tool", name: "Tool", input: many })!.args!.split("\n");
  assert.equal(listed.length, 30); assert.equal(listed.at(-1), `option29: ${"v".repeat(1500)}#29`);
});

test("a parameter is left out only where the panel shows that very value: Grep's path, an edit's replace_all, a different cwd stay (codex-obs-send-ui-F1)", () => {
  // Claude's Grep: the host maps the pattern into a search detail; the path and the mode are parameters of their own.
  const grep = permissionView({ id: "g", kind: "tool", provider: "claude", name: "Grep", input: { pattern: "TODO", path: "/home/me/app/src", output_mode: "content" }, detail: { type: "search", query: "TODO" } })!;
  assert.deepEqual([grep.target, grep.args], ["TODO", "path: /home/me/app/src\noutput_mode: content"]);
  // An edit with its diff: the old and new text are in the diff, replace_all is not.
  const edit = permissionView({ id: "e", kind: "tool", name: "Edit", input: { file_path: "/home/me/app/a.ts", old_string: "x", new_string: "y", replace_all: true },
    detail: { type: "edit", filePath: "/home/me/app/a.ts", unifiedDiff: "@@ -1 +1 @@\n-x\n+y" } })!;
  assert.deepEqual([edit.target, edit.args, edit.params, edit.hostCut], ["/home/me/app/a.ts", "@@ -1 +1 @@\n-x\n+y", "replace_all: true", null]);
  // A working directory or command in the input that differs from the one shown is listed too.
  const shell = permissionView({ id: "s", kind: "tool", provider: "codex", name: "CodexBash", input: { command: ["bash", "-lc", "make"], cwd: "/home/me/other" }, detail: { type: "shell", command: "make", cwd: "/home/me/app" } })!;
  assert.deepEqual([shell.command, shell.cwd, shell.args], ["make", "/home/me/app", "command: [\"bash\",\"-lc\",\"make\"]\ncwd: /home/me/other"]);
  // A WebFetch's prompt is not its URL: listed.
  const fetch = permissionView({ id: "f", kind: "tool", name: "WebFetch", input: { url: "https://example.com/doc", prompt: "Summarise the API" }, detail: { type: "fetch", url: "https://example.com/doc" } })!;
  assert.deepEqual([fetch.target, fetch.args], ["https://example.com/doc", "prompt: Summarise the API"]);
});

test("past 64 KB a part is cut and says where; a diff the host cut is named, and its full text comes from the input (codex-obs-send-ui-F1)", () => {
  const huge = permissionView({ id: "h", kind: "tool", name: "Bash", input: { command: "y".repeat(70_000) } })!;
  assert.equal(huge.command!.length, PERMISSION_TEXT_LIMIT);
  assert.deepEqual(huge.cut, { command: { kept: PERMISSION_TEXT_LIMIT, total: 70_000 } });
  // Parameters are bounded altogether.
  const params = permissionView({ id: "p", kind: "tool", name: "Tool", input: { a: "a".repeat(40_000), b: "b".repeat(40_000) } })!;
  assert.equal(params.args!.length, PERMISSION_TEXT_LIMIT); assert.deepEqual(params.cut, { args: { kept: PERMISSION_TEXT_LIMIT, total: 80_007, items: { total: 2, whole: 1 } } });
  // Never cut inside a surrogate pair: the emoji goes whole or not at all.
  const emoji = permissionView({ id: "u", kind: "tool", name: "Bash", input: { command: `${"z".repeat(PERMISSION_TEXT_LIMIT - 1)}😀 tail` } })!;
  assert.equal(emoji.command!.length, PERMISSION_TEXT_LIMIT - 1); assert.equal(emoji.cut.command!.kept, PERMISSION_TEXT_LIMIT - 1);
  // daemon 0.11.1 truncateDiffText: the first 12000 characters and `...[truncated N chars]`. The input's old and new text are then listed.
  const cutDiff = `${"@@ -1 +1 @@\n-a\n+b\n".repeat(10)}\n...[truncated 345 chars]`;
  const edit = permissionView({ id: "d", kind: "tool", name: "Edit", input: { file_path: "/home/me/app/a.ts", old_string: "a", new_string: "b" }, detail: { type: "edit", filePath: "/home/me/app/a.ts", unifiedDiff: cutDiff } })!;
  assert.deepEqual([edit.hostCut, edit.args, edit.params], [345, cutDiff, "old_string: a\nnew_string: b"]);
});

test("no parameter is left out unsaid: the 201st short one is listed, and a list cut at 64 KB says how many are not whole (codex-obs-send-ui-F1)", () => {
  // codex-obs-send-ui-F1-remaining: 200 parameters were listed at most, so a 201st (the one that changes what the tool does) went
  // missing with nothing cut on record.
  const input: Record<string, unknown> = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`option${index}`, index]));
  input.CRITICAL_PARAMETER_AFTER_200 = 123;
  const many = permissionView({ id: "many", kind: "tool", name: "ConfiguredTool", input })!;
  assert.equal(many.args!.split("\n").length, 201);
  assert.ok(many.args!.endsWith("\nCRITICAL_PARAMETER_AFTER_200: 123"), "the last one, listed");
  assert.deepEqual(many.cut, {}, "all there: nothing to say");
  // Past the limit the list is cut where its characters run out, and says how many parameters it has and how many are not whole.
  const crowd: Record<string, unknown> = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`flag${index}`, "v".repeat(10)]));
  crowd.CRITICAL_LAST = "rm -rf /";
  const cut = permissionView({ id: "crowd", kind: "tool", name: "ConfiguredTool", input: crowd })!;
  const whole = cut.args!.split("\n").length - 1;
  assert.deepEqual(cut.cut.args, { kept: PERMISSION_TEXT_LIMIT, total: cut.cut.args!.total, items: { total: 10_001, whole } });
  assert.ok(cut.cut.args!.total > PERMISSION_TEXT_LIMIT && whole > 3000 && whole < 10_001);
  assert.ok(!cut.args!.includes("CRITICAL_LAST"));
  // Counted by where each parameter ends, a cut that lands exactly at one's end keeps it whole.
  const exact = permissionView({ id: "x", kind: "tool", name: "Tool", input: { a: "a".repeat(PERMISSION_TEXT_LIMIT - 3), b: "b" } })!;
  assert.deepEqual(exact.cut.args, { kept: PERMISSION_TEXT_LIMIT, total: PERMISSION_TEXT_LIMIT + 5, items: { total: 2, whole: 1 } });
  // The parameters an edit leaves beside its diff are a list too; a provider's own text (the diff) is not.
  const edit = permissionView({ id: "e", kind: "tool", name: "Edit", input: { file_path: "/a.ts", old_string: "a", new_string: "b", ...Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`extra${index}`, index])) },
    detail: { type: "edit", filePath: "/a.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" } })!;
  assert.equal(edit.params!.split("\n").length, 300);
});

test("a request is pending only while the Agent still lists it", () => {
  const snapshot = (agent: unknown) => ({ agent, project: null });
  assert.equal(requestState(snapshot({ status: "running", pendingPermissions: [{ id: "a" }, { id: "b" }] }), "b"), "pending");
  assert.equal(requestState(snapshot({ status: "running", pendingPermissions: [{ id: "a" }] }), "b"), "gone");
  assert.equal(requestState(snapshot({ status: "idle", pendingPermissions: [{ id: "b" }], archivedAt: "2026-10-12T00:00:00.000Z" }), "b"), "gone", "archived");
  assert.equal(requestState(null, "b"), "gone", "the host no longer knows the Agent");
  assert.equal(requestState(snapshot(null), "b"), "gone");
  assert.equal(requestState(undefined, "b"), "unknown", "a failed read");
  assert.equal(requestState({}, "b"), "unknown");
  assert.equal(requestState(snapshot({ status: "running" }), "b"), "unknown", "no list to look in");
});

/** A fake Agent handle: `states` are what successive refreshes return; answers are recorded. */
function fakeHandle(states: unknown[]) {
  const answers: Array<{ requestId: string; response: PermissionResponse }> = [];
  let reads = 0;
  const handle: PermissionHandle = {
    refresh: async () => { const state = states[Math.min(reads, states.length - 1)]; reads++; if (state instanceof Error) throw state; return state; },
    respondToPermission: async input => { answers.push(input); },
  };
  return { handle, answers, reads: () => reads };
}
const agentWith = (ids: string[], status = "running") => ({ agent: { status, pendingPermissions: ids.map(id => ({ id })) }, project: null });
const now = { sleep: async () => {} };

test("answering reads first, sends exactly the chosen response, and waits for the host to drop the request", async () => {
  for (const choice of [...permissionChoices(claudeBash), ...permissionChoices(acpEdit)]) {
    const fake = fakeHandle([agentWith(["r"]), agentWith(["r"]), agentWith([], "idle")]);
    const outcome = await answerPermission(fake.handle, "r", choice, now);
    assert.deepEqual(outcome, { kind: "answered", stillRunning: false }, choice.key);
    assert.deepEqual(fake.answers, [{ requestId: "r", response: choice.response }], choice.key);
  }
});

test("answered elsewhere, never confirmed, or unreadable: said so, and nothing sent unless it still waited", async () => {
  const [allow] = permissionChoices(claudeBash);
  const elsewhere = fakeHandle([agentWith(["other"])]);
  assert.deepEqual(await answerPermission(elsewhere.handle, "r", allow!, now), { kind: "elsewhere" });
  assert.equal(elsewhere.answers.length, 0);
  const unknown = fakeHandle([{}]);
  assert.deepEqual(await answerPermission(unknown.handle, "r", allow!, now), { kind: "unknown" });
  assert.equal(unknown.answers.length, 0);
  const failing = fakeHandle([new Error("socket closed")]);
  await assert.rejects(answerPermission(failing.handle, "r", allow!, now), /socket closed/);
  assert.equal(failing.answers.length, 0);
  // Sent, but the host still lists it after every check (respondToPermission has no receipt).
  const stuck = fakeHandle([agentWith(["r"])]);
  assert.deepEqual(await answerPermission(stuck.handle, "r", allow!, now), { kind: "unconfirmed" });
  assert.equal(stuck.answers.length, 1);
  assert.equal(stuck.reads(), 7, "one read before, one per confirmation delay");
  // A failed read while confirming is just another try.
  const flaky = fakeHandle([agentWith(["r"]), new Error("blip"), agentWith([], "idle")]);
  assert.deepEqual(await answerPermission(flaky.handle, "r", allow!, now), { kind: "answered", stillRunning: false });
});

test("拒绝并中断 also waits for the turn to stop, and says so when it did not", async () => {
  const interrupt = permissionChoices(claudeBash).find(choice => choice.interrupt)!;
  const stops = fakeHandle([agentWith(["r"]), agentWith([], "running"), agentWith([], "idle")]);
  assert.deepEqual(await answerPermission(stops.handle, "r", interrupt, now), { kind: "answered", stillRunning: false });
  const goesOn = fakeHandle([agentWith(["r"]), agentWith([], "running")]);
  assert.deepEqual(await answerPermission(goesOn.handle, "r", interrupt, now), { kind: "answered", stillRunning: true });
  // A plain answer does not wait for the turn: an approved command keeps it running.
  const allowed = fakeHandle([agentWith(["r"]), agentWith([], "running")]);
  assert.deepEqual(await answerPermission(allowed.handle, "r", permissionChoices(claudeBash)[0]!, now), { kind: "answered", stillRunning: false });
  assert.equal(allowed.reads(), 2);
});
