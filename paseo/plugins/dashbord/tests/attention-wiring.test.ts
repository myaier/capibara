import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// These surfaces are React Native (no renderer in node tests): how they use the shared rules is checked in their source. The
// rules themselves are tested in model, attention, quick-replies and dashboard-model tests.
const source = (file: string) => readFileSync(join(__dirname, "..", "client", file), "utf8");

test("the 未读 chip and the list it opens hold snoozed results back by one rule (P3-1)", () => {
  const dashboard = source("dashboard.tsx");
  assert.match(dashboard, /if \(isUnreadCompletion\(agent\)\) \{ if \(heldBySnooze\(agent, snoozedAt\(agent\)\)\) snoozed\+\+; else unread\+\+; \}/, "the chip");
  assert.match(dashboard, /readFilter !== "unread" \|\| showSnoozed \|\| !heldBySnooze\(agent, snoozedAt\(agent\)\)/, "the list");
  assert.doesNotMatch(dashboard, /showSnoozed \|\| !snoozedAt\(agent\)/);
});

test("观测设置 says a subagent's limit, empty or unfinished turn counts whatever the setting (P3-2)", () => {
  assert.match(source("dashboard.tsx"), /子 Agent 出错、撞额度、空轮或没收尾、等审批或提问时照常计入/);
});

test("a thread's parent row shows how many descendants need you, in the most urgent one's colour, apart from 未读 (P3-3)", () => {
  const dashboard = source("dashboard.tsx"), list = source("session-list.tsx");
  assert.match(dashboard, /threadAttention\(row\.node, attentionOf\)/, "counted by the rule 需要处理 groups the thread by");
  assert.match(dashboard, /childUnread: thread\?\.unread \?\? 0, childAttention: thread\?\.count \?\? 0, childPhase: thread\?\.phase \?\? null/);
  assert.match(list, /childAttention > 0 && childPhase \? <ChildAttention theme=\{theme\} count=\{childAttention\} phase=\{childPhase\} \/>/);
  assert.match(list, /\{count\} 个需要处理/);
  assert.match(list, /color=\{hueColor\(theme, look\.hue\)\}/, "the phase's own colour and mark");
  // The toggle keeps its name (the UI tests and screen readers find it by it).
  assert.match(list, /accessibilityLabel=\{`\$\{expanded \? "收起" : "展开"\} \$\{agent\.title\} 的子 agent`\}/);
});

test("quick replies answer one turn: the popover only beside the sentence they answer, the detail under the reply (P1-1, P2-1)", () => {
  const popover = source("attention-popover.tsx"), result = source("result-view.tsx"), replies = source("quick-replies.tsx");
  assert.match(popover, /const nudge = popoverReplies\(entry\)/);
  assert.match(popover, /expectPrompt=\{entry\.promptAt\} expectRound=\{entry\.roundAt\} ask=\{entry\.ask\}/);
  assert.match(result, /expectPrompt=\{agent\.lastUserMessageAt\} expectRound=\{agent\.observedTurnStartedAt \?\? null\}/);
  // A heartbeat's next round shares the prompt: each round mounts its own replies (codex-obs-attn-F1).
  assert.match(popover, /<QuickReplies key=\{`\$\{entry\.agentId\}:\$\{entry\.promptAt \?\? ""\}:\$\{entry\.roundAt \?\? ""\}:/);
  assert.match(result, /<QuickReplies key=\{`\$\{agent\.id\}:\$\{agent\.lastUserMessageAt \?\? ""\}:\$\{agent\.observedTurnStartedAt \?\? ""\}:/);
  assert.doesNotMatch(result, /ask=\{/, "the detail shows the whole reply above them");
  assert.match(replies, /const expect = answering\(expectPrompt, agentTitle\)/);
  assert.match(replies, /const precheck = sameRound\(async \(\) => \{ const answer = await telemetry\(\{ agentId \}\); return "agents" in answer \? answer\.agents\.find\(item => item\.agentId === agentId\)\?\.turnStartedAt : null; \}, expectRound, agentTitle\)/);
  // Through the plugin server's ledger (`observatory.deferred.send`), with the consent of the confirmation the user said yes to.
  assert.match(replies, /sendChecked\(paseo, message, caps, deferred\.send, consent, \{ expect, precheck, \.\.\.\(reply\.rearm \? \{ beforeSend: clearAttention \} : \{\}\) \}\)/);
  // 「等这一轮结束再发」 passes the same turn checks before it is queued.
  assert.match(replies, /await checkFits\(paseo, message, \{ expect, precheck \}\);/);
  // Both the send and the queueing; a tagged Error, never `instanceof` (no classes in the default Hermes).
  assert.equal(replies.match(/if \(isSendRefused\(error\)\) \{ setProblem\(null\); setRefused\(error\.message\); return; \}/g)?.length, 2, "no retry");
  assert.match(replies, /nudge === "go-ahead" \? "它问：" : "它说接下来："/);
  // The turn goes to the server with every reply (codex-obs-attn-R3): one reply of it goes out, and only while it still fits.
  assert.match(replies, /const group = quickReplyGroup\(expectPrompt, expectRound\), guard = quickReplyGuard\(expectPrompt, expectRound\);/);
  assert.match(replies, /messageId: requestId\(agentId, key, listed\.current\), group, guard \}\);/);
  assert.match(replies, /const view = await deferred\.enqueue\(ledgerInput\(message\)\);/, "queued with them too");
  // The attention is cleared only while the turn they answer is still the latest (codex-obs-attn-R4).
  assert.match(replies, /const clearAttention = clearingAttention\(input => markRead\(input\)\.then\(\(\) => queryClient\.invalidateQueries\(\{ queryKey: readReceiptQueryKey \}\)\), agentId, expectRound\);/);
});

// The resident stub and the UI chunk are separate bundles: 知道了 / 标记已读 in the chunk's detail must reach the store the
// badge shows. The stub makes one set per registration and hands it over as a prop; nothing is kept on globalThis, where it
// would outlive a reconnect with the old connection's RPC binding (client/lazy-chunk.tsx keeps only chunk text there).
test("the stub hands one set of 需要处理 stores to the badge, the schedule count and every chunk surface; the detail reads it", () => {
  const root = (file: string) => readFileSync(join(__dirname, "..", file), "utf8");
  const stub = root("index.client.tsx"), chunk = root("ui-chunk.client.tsx");
  assert.match(stub, /const attentionStores = createAttentionStores\(\);/);
  assert.match(stub, /<Surface \{\.\.\.props\} attentionStores=\{attentionStores\} \/>/);
  assert.match(stub, /<ObservatorySidebarItem \{\.\.\.props\} stores=\{attentionStores\}/);
  assert.match(stub, /<ScheduleSidebarItem \{\.\.\.props\} stores=\{attentionStores\} \/>/);
  assert.match(stub, /client\.addScreen\(\{ id: screenForHost\(id, ownHost!\), title, Component: surface\(id\) \}\)/);
  assert.match(stub, /client\.addWorkspacePanel\(\{ id, title, icon, context, Component: surface\(id\) \}\)/);
  assert.doesNotMatch(stub, /Component: lazy\(/, "every screen and panel gets the stores");
  assert.match(chunk, /<AttentionStoresContext\.Provider value=\{props\.attentionStores \?\? null\}>/);
  for (const surface of ["observatory: provide(Overview)", "archives: provide(Archives)", "\"workspace-observatory\": provide(Workspace)", "\"agent-inspector\": provide(Inspector)"])
    assert.ok(chunk.includes(surface), surface);
  assert.match(source("agent-detail.tsx"), /invalidateAttention = useInvalidateAttention\(\)/);
  assert.doesNotMatch(source("use-attention.ts"), /globalThis/);
});

test("the detail marks an unloaded session whose result cannot be read: the server checks the token (P2-4)", () => {
  const detail = source("agent-detail.tsx");
  assert.match(detail, /const unreadable = !!result\.error && agent\.rawStatus === "closed";/);
  assert.match(detail, /if \(ackKind !== "problem" && !unreadable && \(!result\.data/);
  assert.match(detail, /ackKind === "result" \|\| ackKind === "problem" && readState === "unread" \? knownCompletionAt\(agent\) : null/, "知道了 on an unread result's stop names that result");
});
