import assert from "node:assert/strict";
import test from "node:test";
import { canSteer, confirmFingerprint, consentFor, contentKey, coversConsent, isSlashCommand, messageIdKey, newMessageId, permissionIds, sendFailure, sendPlan, turnIdentity, usableTarget, type SendTarget } from "../client/send-plan";
import { readSendCapabilities, slashSteerableFromConfig, steerableFromConfig } from "../server/steerable-providers";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The shared kit/send-plan.ts (every plugin carries the same copy): what Paseo 0.11.1 does to a message sent to an
// existing agent, so the label, the warning and the call agree.
const agent = (provider: string, status: SendTarget["status"], extra: Partial<SendTarget> = {}): SendTarget => ({ provider, status, ...extra });
const custom = { steerable: ["claude-alt", "codex-relay", "claude-team"], slashSteerable: ["claude-alt", "claude-team"] };

test("slash commands steer only into Claude-based providers; pi, omp, codex and opencode would lose their turn", () => {
  assert.equal(isSlashCommand("/review 看一下"), true);
  assert.equal(isSlashCommand("  /compact"), true);
  assert.equal(isSlashCommand("看看 /tmp/a.log"), false);
  assert.equal(isSlashCommand("/"), false);
  assert.equal(isSlashCommand("//comment"), false);
  // The daemon reads the whole first word: a path is text, and steers like any other text (codex-kit-F2).
  for (const text of ["/tmp/a.log 请分析", "/src/main.ts", "/foo/bar baz"]) {
    assert.equal(isSlashCommand(text), false, text);
    assert.equal(sendPlan(agent("pi", "running"), { text }).kind, "steer", text);
  }
  for (const provider of ["claude", "claude-alt", "claude-team"]) {
    assert.equal(sendPlan(agent(provider, "running"), { ...custom, text: "/review" }).kind, "steer", provider);
  }
  for (const provider of ["pi", "omp", "codex", "opencode", "codex-relay"]) {
    const plan = sendPlan(agent(provider, "running"), { ...custom, text: "/review", what: "命令" });
    assert.equal(plan.kind, "confirm", provider);
    assert.equal(plan.label, "中断并发送");
    assert.equal(plan.note, "运行中，这条命令不能插话");
    assert.match(plan.confirm!, /这条命令不能插进当前回合，发送命令会中断它当前的回合/);
    assert.equal(plan.options, undefined, "never sent as a steer");
    // The same provider still takes plain text mid-turn.
    assert.equal(sendPlan(agent(provider, "running"), { ...custom, text: "继续" }).kind, "steer", provider);
  }
  // `slash: true` without the text, and canSteer agrees with the plan.
  assert.equal(sendPlan(agent("pi", "running"), { slash: true }).kind, "confirm");
  assert.equal(canSteer(agent("pi", "running"), [], { slash: true }), false);
  // A command whose name is unknown is read cautiously, even for Claude (it might be /compact).
  assert.equal(canSteer(agent("claude-alt", "running"), ["claude-alt"], { slash: true, slashSteerable: ["claude-alt"] }), false);
  // A provider that never steers is unchanged: its own confirmation, not the slash one.
  assert.equal(sendPlan(agent("grok", "running"), { ...custom, text: "/review" }).note, "运行中，这个 Agent 不支持插话");
  // Idle agents simply receive it.
  assert.equal(sendPlan(agent("pi", "idle"), { ...custom, text: "/review" }).kind, "send");
});

test("Claude's /rewind and root-only commands replace a running turn, so they ask first like any interruption (codex-kit-F1)", () => {
  for (const text of ["/compact", "/clear", "/rewind", "/context", "/usage", "/init 项目", "/loop 5m /check", "/schedule", "/debug", "/heapdump", "/extra-usage"]) {
    for (const provider of ["claude", "claude-alt"]) {
      const plan = sendPlan(agent(provider, "running"), { ...custom, text, what: "命令" });
      assert.equal(plan.kind, "confirm", `${provider} ${text}`);
      assert.equal(plan.label, "中断并发送");
      assert.equal(plan.options, undefined);
    }
  }
  // Their skills and other commands still join the turn; the daemon compares the name as typed.
  assert.equal(sendPlan(agent("claude", "running"), { text: "/review 改动" }).kind, "steer");
  assert.equal(sendPlan(agent("claude", "running"), { text: "/Compact" }).kind, "steer");
  // Through a custom id the server only reported as a base.
  assert.equal(sendPlan(agent("my-claude", "running"), { steerable: ["my-claude"], bases: { "my-claude": "claude" }, text: "/compact" }).kind, "confirm");
  assert.equal(sendPlan(agent("my-claude", "running"), { steerable: ["my-claude"], bases: { "my-claude": "claude" }, text: "/review" }).kind, "steer");
});

test("commands Paseo runs beside the turn go straight out: no interruption, approvals untouched (codex-kit-F3)", () => {
  const running = (provider: string, pending = 0) => agent(provider, "running", { pendingPermissions: pending });
  for (const [provider, text] of [["pi", "/compact"], ["pi", "/autocompact on"], ["omp", "/Compact"], ["omp", "/handoff"], ["omp", "/steer 先看测试"], ["omp", "/follow-up 然后提交"], ["codex", "/compact"]] as const) {
    for (const pending of [0, 1]) {
      const plan = sendPlan(running(provider, pending), { text });
      assert.equal(plan.kind, "send", `${provider} ${text} ${pending}`);
      assert.equal(plan.confirm, null);
      assert.equal(plan.options, undefined);
      assert.equal(plan.note, "这条命令由宿主单独执行，不打断当前回合，也不影响待审批");
    }
  }
  // Not out of band: an empty /steer, codex's /Compact (exact name), claude's /compact.
  assert.equal(sendPlan(running("omp"), { text: "/steer" }).kind, "confirm");
  assert.equal(sendPlan(running("codex"), { text: "/Compact" }).kind, "confirm");
  // A custom id: precise with the server's bases, cautious without them.
  assert.equal(sendPlan(running("codex-relay"), { ...custom, text: "/compact" }).kind, "confirm");
  assert.equal(sendPlan(running("codex-relay"), { ...custom, bases: { "codex-relay": "codex" }, text: "/compact" }).kind, "send");
  // Idle: just sent, nothing to explain.
  assert.equal(sendPlan(agent("pi", "idle"), { text: "/compact" }).note, null);
});

test("a waiting approval is cancelled by any send: the confirmation says so, steered or not", () => {
  const steered = sendPlan(agent("claude-alt", "running", { pendingPermissions: 1 }), { ...custom, what: "回答" });
  assert.equal(steered.kind, "confirm");
  assert.deepEqual(steered.options, { activeTurnBehavior: "steer" });
  assert.match(steered.confirm!, /插进当前回合，同时取消这次审批请求，等待批准的操作不会执行/);
  assert.doesNotMatch(steered.confirm!, /审批请求还在/);
  const interrupted = sendPlan(agent("grok", "running", { pendingPermissions: 2 }), { ...custom, what: "回答" });
  assert.equal(interrupted.options, undefined);
  assert.match(interrupted.confirm!, /中断当前回合，并取消这次审批请求/);
  assert.equal(steered.note, "Agent 正在等你审批，发送会取消这次审批");
});

test("closed only means not loaded: it is sendable; an archived agent is not", () => {
  const closed = sendPlan(agent("claude-alt", "closed"), custom);
  assert.equal(closed.kind, "send");
  assert.equal(closed.note, "会话未载入，发送时会自动载入");
  const archived = sendPlan(agent("claude-alt", "idle", { archivedAt: "2026-10-12T00:00:00Z" }), custom);
  assert.equal(archived.kind, "unavailable");
  assert.equal(archived.note, "这个 Agent 已归档");
  assert.equal(sendPlan(null).note, "这个 Agent 已不可用");
  assert.equal(usableTarget({ archivedAt: null }), true);
  assert.equal(usableTarget({ archivedAt: "x" }), false);
  assert.equal(usableTarget(null), false);
});

test("a confirmation is bound to the exact pending requests, not to how many there are (codex-F4)", () => {
  const target = { id: "a", provider: "grok", status: "running", activeTurn: { id: "t1", startedAt: "s" } };
  const plan = sendPlan(agent("grok", "running", { pendingPermissions: 1 }));
  assert.notEqual(confirmFingerprint(target, plan, ["approval-A"]), confirmFingerprint(target, plan, ["approval-B"]));
  assert.equal(confirmFingerprint(target, plan, ["b", "a"]), confirmFingerprint(target, plan, ["a", "b"]));
  assert.notEqual(confirmFingerprint(target, plan, []), confirmFingerprint({ ...target, activeTurn: { id: "t2", startedAt: "s" } }, plan, []));
});

test("message ids are unique uuids, and the daemon's retry answers read as plain words", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newMessageId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(sendFailure(new Error("agent_request_outcome_unknown")).kind, "maybe-delivered");
  assert.match(sendFailure(new Error("agent_request_outcome_unknown")).message, /可能已经送达/);
  assert.equal(sendFailure(new Error("agent_request_key_conflict")).kind, "changed");
  assert.deepEqual(sendFailure(new Error("boom")), { kind: "failed", message: "boom" });
});

test("the server reads both lists from the daemon config: steering ids, and the Claude-based ones that also steer slash commands", async () => {
  const config = { agents: { providers: { "claude-alt": { extends: "claude" }, "claude-team": { extends: "claude" }, "codex-relay": { extends: "codex" }, grok: { extends: "acp" }, "bad id!": { extends: "claude" } } } };
  assert.deepEqual(steerableFromConfig(config), ["claude-alt", "claude-team", "codex-relay"]);
  assert.deepEqual(slashSteerableFromConfig(config), ["claude-alt", "claude-team"]);
  const home = await mkdtemp(join(tmpdir(), "kit-send-"));
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  const read = await readSendCapabilities({ PASEO_HOME: home });
  assert.deepEqual(read.slashSteerable, ["claude", "claude-alt", "claude-team"]);
  assert.deepEqual(read.bases, { "claude-alt": "claude", "claude-team": "claude", "codex-relay": "codex" });
  assert.ok(read.steerable.includes("codex-relay") && read.steerable.includes("pi") && !read.steerable.includes("grok"));
  // No config: the built-ins only.
  assert.deepEqual(await readSendCapabilities({ PASEO_HOME: join(home, "missing") }), { steerable: ["claude", "codex", "pi", "opencode", "omp"], slashSteerable: ["claude"], bases: {} });
});

test("only a plain-text command runs beside the turn; codex /goal names both outcomes (codex-kit recheck)", () => {
  const running = (provider: string, pending = 0) => agent(provider, "running", { pendingPermissions: pending });
  // With images or attachments the daemon builds a structured prompt that no command parser sees.
  assert.equal(sendPlan(running("pi"), { text: "/compact", structured: true }).kind, "confirm");
  assert.equal(sendPlan(running("omp"), { text: "/compact", structured: true }).kind, "confirm");
  assert.equal(sendPlan(running("claude"), { text: "/compact", structured: true }).kind, "steer");
  assert.equal(sendPlan(running("codex"), { text: "/compact", structured: true }).kind, "steer");
  assert.equal(sendPlan(running("opencode"), { text: "/review", structured: true }).kind, "steer");
  assert.equal(sendPlan(running("codex-relay"), { ...custom, bases: { "codex-relay": "codex" }, text: "/compact", structured: true }).kind, "steer");
  assert.equal(sendPlan(running("pi"), { text: "/compact" }).kind, "send");
  const goal = sendPlan(running("codex", 1), { text: "/goal pause" });
  assert.equal(goal.kind, "confirm");
  assert.equal(goal.label, "仍然发送");
  assert.match(goal.confirm!, /开启了目标功能的 Codex 会在当前回合旁边单独执行 \/goal/);
  assert.match(goal.confirm!, /没开启时，发送这条消息会中断它当前的回合，并取消这次审批请求/);
  assert.equal(sendPlan(running("codex"), { text: "/Goal pause" }).label, "中断并发送");
  assert.equal(sendPlan(agent("codex", "idle"), { text: "/goal pause" }).kind, "send");
});

test("a confirmation's consent covers the turn it would interrupt and the approvals it would cancel, nothing more", () => {
  const grok = agent("grok", "running");
  const interrupt = consentFor(sendPlan(grok));
  assert.deepEqual(interrupt, { interrupt: true, approvals: [], turn: null });
  assert.equal(consentFor(sendPlan(agent("claude", "running"))), null, "steering needs no OK");
  assert.equal(consentFor(sendPlan(agent("grok", "idle"))), null);
  const approval = consentFor(sendPlan(agent("claude", "running", { pendingPermissions: 2 })), ["p2", "p1", "p1"]);
  assert.deepEqual(approval, { interrupt: false, approvals: ["p1", "p2"], turn: null }, "a steer cancels the approvals but keeps the turn");
  assert.equal(coversConsent(approval, { interrupt: false, approvals: ["p1"], turn: null }), true);
  assert.equal(coversConsent(approval, { interrupt: false, approvals: ["p1", "p3"], turn: null }), false, "a new approval needs a new OK");
  assert.equal(coversConsent(approval, interrupt), false, "agreeing to cancel an approval is not agreeing to interrupt");
  assert.equal(coversConsent(null, null), true);
  assert.equal(coversConsent(null, interrupt), false);
  assert.deepEqual(permissionIds([{ id: "a" }, { requestId: "b" }, null, { id: 3 }]), ["a"]);
  // An OK given while one turn ran does not carry over to the next turn.
  const t1 = { turnId: "t1", startedAt: "2026-10-12T10:00:00.000Z" }, t2 = { turnId: "t2", startedAt: "2026-10-12T10:05:00.000Z" };
  assert.equal(turnIdentity(t1), "t1@2026-10-12T10:00:00.000Z");
  assert.equal(turnIdentity(null), null);
  const forT1 = consentFor(sendPlan(grok), [], t1);
  assert.equal(coversConsent(forT1, consentFor(sendPlan(grok), [], t1)), true);
  assert.equal(coversConsent(forT1, consentFor(sendPlan(grok), [], t2)), false);
  assert.equal(coversConsent(interrupt, consentFor(sendPlan(grok), [], t1)), false, "an OK without a turn does not cover a running one");
});

test("content keys are stable across clients and short; a key carried in an id is read back", () => {
  assert.equal(contentKey(["skills", "/review"]), contentKey(["skills", "/review"]));
  assert.notEqual(contentKey(["skills", "/review"]), contentKey(["skills", "/review "]));
  assert.notEqual(contentKey(["a", "bc"]), contentKey(["ab", "c"]), "parts never run together");
  assert.match(contentKey(["x"]), /^[0-9a-z]{1,11}$/);
  assert.equal(messageIdKey("3f1c-uuid~k1x"), "k1x");
  assert.equal(messageIdKey("plain-uuid"), null);
});
