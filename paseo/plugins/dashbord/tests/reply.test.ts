import assert from "node:assert/strict";
import test from "node:test";
import { REPLY_NUDGES, finalReplyAfter, finalReplyText, nudgeSentence, replyAsksUser, replyNudge } from "../shared/reply";
import type { TimelineRow } from "../shared/timeline";

test("replies that hand the next step to the user are 待回复", () => {
  for (const text of [
    "issue 已经提了，状态 todo。\n\n代码还没改。要不要接着在文档仓库提修复 MR？上次悬着的规则也可以一起改，再跟 !56 一起发布。",
    "**Two ways to find which process it is; either works:**\n\n1. Quickest: stop the local server, then reload the page.\n2. Right after the error appears, run this in a terminal. Send me the output:\n   ```\n   ps -axo pid=,command=\n   ```",
    "**这件事到此结束了。**\n\n- 1.0.54 在两个环境都跑着。\n\n等预发布环境的两个凭据下来告诉我，我合 !59 再发 1.0.55。",
    "Migration done and verified.\n\nShould I also drop the old tables?",
    "改好了，两个环境都验过。\n\n先发预发布环境吧？",
    "测试都过了。发版前需要你确认一下窗口，我再继续。",
    "方案 A 更稳，方案 B 更快。你来决定用哪个。",
  ]) assert.equal(replyAsksUser(text), true, text);
});

test("finished reports, monitoring notes and rhetorical questions are not 待回复", () => {
  for (const text of [
    "两个环境都已经在跑 1.0.39。\n\n**需要知道的**\n- 新指标只对发布后的运行有。\n- 本地预览服务已经关掉。\n\nMR：[!52](https://code.example/mr/52) · [!53](https://code.example/mr/53)",
    "两个看板都部署好了。\n\n- **如果你打不开**：多半是网络问题，不是部署有问题。\n\n链接和更新方法已经写进 README 了。",
    "12:12 检查，两台都正常。\n\n下次大约 13:05 看。那时调度程序会自动接上，我到时确认一下。",
    "为什么会超时？因为上游接口限流，重试后已经恢复。",
    "修好了：\n```\nconst ok = ready ? \"是否继续？\" : null;\n```",
    "用户问「为什么要重启？」，原因是配置变了，已经处理。",
    "My recommendation: release on 10.9. It's your call.\n\nI only read the chat, the screenshot and the policy, and saved these findings to memory.",
    "服务已经重启。不需要回填的话可以在 .env 里加 BACKFILL=false 后再重启。",
    "",
  ]) assert.equal(replyAsksUser(text), false, text);
});

test("a courtesy close is not a question; an offer of a specific next step still is", () => {
  for (const text of [
    "全部改完了，测试 48/48 通过，已推送到 main。\n\n如果还有需要调整的地方，请告诉我。",
    "Done. All 48 tests pass and the branch is pushed.\n\nLet me know if you'd like any changes.",
    "已完成迁移，类型检查通过。有问题随时告诉我。",
    "已完成。\n\n要点：\n- A\n- B\n\n还有什么需要我做的吗？",
    "Done — see PR #12. Anything else?",
    "部署完成，两个环境都验过了。需要的话随时找我。",
    "The report is in /tmp/x.md.\n\nFeel free to reach out if you have any other questions — happy to help!",
    "迁移脚本已合入，回滚步骤写进了 README。希望对你有帮助！",
  ]) assert.equal(replyAsksUser(text), false, text);
  for (const text of [
    "Fixed and pushed.\n\nWant me to also update the README?",
    "都改好了。要不要我也更新 README？\n\n有问题随时告诉我。",
    "The schema change is ready.\n\nLet me know if you want me to run the migration on staging.",
    "Should I deploy it now?\n\nIf you'd like any other changes or have further questions, just let me know — happy to help with anything else.",
  ]) assert.equal(replyAsksUser(text), true, text);
});

test("the final reply is the closing assistant message of the turn, after the latest user message", () => {
  assert.equal(finalReplyText([{ type: "user_message", text: "修一下" }, { type: "tool_call", name: "Edit" }, { type: "assistant_message", text: "改好了，" },
    { type: "assistant_message", text: "要不要发版？" }, { type: "reasoning", text: "done" }]), "改好了，要不要发版？");
  assert.equal(finalReplyText([{ type: "assistant_message", text: "先看看" }, { type: "tool_call", name: "Bash" }]), null);
  assert.equal(finalReplyText([]), null);
  const row = (seq: number, item: TimelineRow["item"], timestamp: string): TimelineRow => ({ key: String(seq), epoch: "e", seqStart: seq, seqEnd: seq, timestamp, item });
  const rows = [row(1, { type: "user_message", text: "继续" }, "2026-09-23T10:00:00Z"), row(2, { type: "tool_call", name: "Bash" }, "2026-09-23T10:01:00Z"),
    row(3, { type: "assistant_message", text: "发完了。" }, "2026-09-23T10:05:00Z"), row(4, { type: "notification", message: "x" }, "2026-09-23T10:05:01Z")];
  assert.deepEqual(finalReplyAfter(rows, Date.parse("2026-09-23T10:00:00Z")), { at: "2026-09-23T10:05:00.000Z", text: "发完了。" });
  assert.equal(finalReplyAfter(rows, Date.parse("2026-09-23T10:06:00Z")), null, "a reply older than the latest message answers an earlier turn");
  assert.equal(finalReplyAfter(rows.slice(0, 2), 0), null, "a turn that ended on a tool call has no final reply");
});

// 快捷回复 (opus-B26): only a category leaves replyNudge, and only for replies that say so in so many words.
test("a reply that asks whether to go on with something specific invites 「继续，按你说的做」 (go-ahead)", () => {
  for (const text of [
    "改好了，测试都过了。\n\n要我继续吗？",
    "README 也有旧链接。要不要我顺手把 README 也改了？",
    "迁移脚本写好了。需要我接着把回滚脚本也补上吗？",
    "方案已经整理在上面了。是否按这个方案执行？",
    "我先把旧接口标成 deprecated，下一版再删，好吗？",
    "测试全部通过，可以合并了吗？",
    "改动都在分支上了。现在提交吗？",
    "改好了，两个环境都验过。\n\n先发预发布环境吧？",
    "都改好了。要不要我也更新 README？\n\n有问题随时告诉我。",
    "要不要我也更新 README？改动很小。",
    "我可以帮你写一个脚本来自动化这个过程，需要吗？",
    "如果需要，我可以顺手把 CHANGELOG 也补上。",
    "你确认后我就合并到 main。",
    "Fixed and pushed.\n\nWant me to also update the README?",
    "The schema change is ready.\n\nShall I run the migration on staging?",
    "Migration done and verified.\n\nShould I also drop the old tables?",
    "Build is green. Do you want me to open the PR?",
    "Would you like me to apply the same fix to the other two services?",
    "The schema change is ready.\n\nLet me know if you want me to run the migration on staging.",
    "I can also add an integration test for the retry path if you'd like.",
    // A courtesy close after the question does not hide it.
    "Should I deploy it now?\n\nIf you'd like any other changes or have further questions, just let me know — happy to help with anything else.",
    "Done.\n\nShould I deploy it now?\n\nLet me know if you'd like me to make any adjustments!",
  ]) assert.equal(replyNudge(text), "go-ahead", text);
});

test("a turn that ends on what it will do next invites 「继续做完」 (keep-going)", () => {
  for (const text of [
    "数据库迁移写好了。接下来我会更新接口测试。",
    "数据库迁移写好了，接下来我会更新接口测试。",
    "第一批 12 个文件已经改完。下一步我将处理剩下的 8 个。",
    "原因找到了：缓存键没带租户 ID。我现在去改。",
    "日志太长了，我先把关键部分整理出来。",
    "我会继续实现剩下的两个接口。",
    "让我来修复这个问题。",
    "让我再试一次。",
    "我来修复。",
    "Found the root cause: the cache key ignores the tenant. Next, I'll patch the key builder.",
    "The first batch is done. Now I'll migrate the remaining 8 files.",
    "Let me run the full test suite to confirm.",
    "Now let me check the logs.",
    "I'm going to refactor the retry helper next.",
    "I'll now update the documentation to match.",
    "Moving on to the API layer.",
  ]) assert.equal(replyNudge(text), "keep-going", text);
});

test("choices, requests for information, opinions and courtesy closes get no quick reply", () => {
  for (const text of [
    "方案 A 更稳，方案 B 更快。你来决定用哪个。",
    "要用 Redis 还是 Memcached？",
    "Should I use Redis or Memcached?",
    "Should I deploy now or wait until Monday?",
    "Should we add a retry here, or is failing fast better?",
    "Which branch should I base this on?",
    "What's the staging URL?",
    "Can you confirm the database name?",
    "Could you run `npm test` locally and tell me the result?",
    "你能把报错截图发给我吗？",
    "你觉得这个命名怎么样？",
    "这样理解对吗？",
    "我写的测试你能看懂吗？",
    "我发现了一个问题，你看怎么样？",
    "这样可以吗？",
    "能跑通吗？",
    "测试都过了。发版前需要你确认一下窗口，我再继续。",
    "**这件事到此结束了。**\n\n- 1.0.54 在两个环境都跑着。\n\n等预发布环境的两个凭据下来告诉我，我合 !59 再发 1.0.55。",
    "**Two ways to find which process it is; either works:**\n\n1. Quickest: stop the local server, then reload the page.\n2. Right after the error appears, run this in a terminal. Send me the output:\n   ```\n   ps -axo pid=,command=\n   ```",
    "My recommendation: release on 10.9. It's your call.\n\nI only read the chat, the screenshot and the policy, and saved these findings to memory.",
    // Help in general is not this next step.
    "全部改完了，测试 48/48 通过，已推送到 main。\n\n如果还有需要调整的地方，请告诉我。",
    "Done. All 48 tests pass and the branch is pushed.\n\nLet me know if you'd like any changes.",
    "已完成。\n\n要点：\n- A\n- B\n\n还有什么需要我做的吗？",
    "需要我再做点什么吗？",
    "Is there anything else you'd like me to do?",
    "Want me to do anything else?",
    "Let me know if you want me to make any other changes.",
    "Let me know if you'd like me to make any adjustments!",
    // Questions quoted or in code, and rhetorical ones answered in place.
    "为什么会超时？因为上游接口限流，重试后已经恢复。",
    "用户问「为什么要重启？」，原因是配置变了，已经处理。",
    "修好了：\n```\nconst ok = ready ? \"是否继续？\" : null;\n```",
    "",
  ]) assert.equal(replyNudge(text), null, text);
});

test("waiting for you, checking back later, monitoring, stopping, work already done or someone else's step is not keep-going", () => {
  for (const text of [
    "12:12 检查，两台都正常。\n\n下次大约 13:05 看。那时调度程序会自动接上，我到时确认一下。",
    "I'll check again at 13:05.",
    "I'll wait for your confirmation before merging.",
    "我等你确认后再继续。",
    "我先不动它，等你决定。",
    "I'll keep an eye on the deploy and report back.",
    "我会继续关注线上指标。",
    "I'll take care of the rest after lunch.",
    "Let me know if anything breaks.",
    "Let me know your thoughts.",
    "让我知道你的想法。",
    "Let me explain what happened.",
    "Let me think about this more.",
    "I'll leave it as is for now.",
    "All done. I'll stop here.",
    "I'll be around if you need anything.",
    "I'll be happy to help with anything else.",
    "I'll be back with results.",
    "I'll get back to you.",
    "日志太长了，我先把关键部分整理出来了。",
    "我先看了日志，发现是缓存的问题，已经修好了。",
    "然后我们就可以上线了。",
    "然后我们就可以上线",
    "下一步就是部署了。",
    "我已经更新了测试，接下来会由 CI 自动部署。",
    "Next, the CI will deploy it automatically.",
    "Next step: you'll need to restart the server.",
    "Then you can run `npm test`.",
    "接下来需要你来决定是否上线。",
    "服务已经重启。不需要回填的话可以在 .env 里加 BACKFILL=false 后再重启。",
    "两个看板都部署好了。\n\n- **如果你打不开**：多半是网络问题，不是部署有问题。\n\n链接和更新方法已经写进 README 了。",
  ]) assert.equal(replyNudge(text), null, text);
});

test("a reply that asks something else as well, or announces work and asks too, is judged by its questions", () => {
  // Asking to go on and announcing more work: 「继续，按你说的做」 answers both.
  assert.equal(replyNudge("要不要我顺手改 README？另外，接下来我会补测试。"), "go-ahead");
  // A go-ahead question next to one that needs a real answer: nothing.
  assert.equal(replyNudge("要不要我顺手改 README？另外，测试环境的地址是多少？"), null);
  // Announcing the next step but asking something first: the question wins, and it is not a go-ahead.
  assert.equal(replyNudge("你觉得命名合适吗？接下来我会补测试。"), null);
  for (const text of ["要我继续吗？", "Next, I'll patch it.", "你来决定。"]) assert.ok(replyNudge(text) === null || REPLY_NUDGES.includes(replyNudge(text)!));
});

// P2-2 (r1's table): a next step that waits for something first. 「继续做完」 would read as "do it now" and skip the condition
// (CI, an approval, a canary), the very thing a wrong 「继续」 must never do.
test("a next step announced with a condition first is not keep-going (P2-2)", () => {
  for (const text of [
    // Read as keep-going before.
    "已经提交了 PR。接下来我会在 CI 通过后合并。",
    "接下来我会等审批通过再部署。",
    "接下来我会等待 CI 结果。",
    "Next, I'll merge once CI is green.",
    "PR is open. I'll merge it as soon as CI is green.",
    "Next, I'll deploy to production once the canary looks healthy.",
    "Next, I'll merge when CI is green.",
    "When CI is green, I'll merge.",
    "接下来我会在测试跑完后提交。",
    "接下来我会在构建成功后发布。",
    "接下来我会在审批以后上线。",
    "Now I'll deploy once the build is ready.",
    "Next, I'll publish as soon as the tag lands.",
    // Excluded already, and still.
    "下一步我会在你确认之后部署。",
    "I'll merge after CI passes.",
    "我会等 CI 变绿之后再合并。",
  ]) assert.equal(replyNudge(text), null, text);
  // "once" as an adverb sets no condition: these still announce the next step.
  for (const text of ["Let me run it once more.", "I'll fix it at once.", "Let me try once again."]) assert.equal(replyNudge(text), "keep-going", text);
});

test("the sentence quick replies answer is the one the rule decided on, as written, on one line (P2-1)", () => {
  // The closing question, not the summary before it (the host's note, which the popover shows, is the reply's start).
  assert.equal(nudgeSentence("改完了，下面是修改总结。\n\n- 拆了存储层\n- 补了测试\n\n要我顺手把旧表删掉、推到 main 吗？"), "要我顺手把旧表删掉、推到 main 吗？");
  assert.equal(nudgeSentence("数据库迁移写好了。接下来我会更新接口测试。"), "接下来我会更新接口测试。");
  assert.equal(nudgeSentence("如果需要，我可以顺手把 CHANGELOG 也补上。"), "如果需要，我可以顺手把 CHANGELOG 也补上。");
  // A short remark after the question, or a courtesy close: the question is quoted.
  assert.equal(nudgeSentence("要不要我也更新 README？改动很小。"), "要不要我也更新 README？");
  assert.equal(nudgeSentence("Done.\n\nShould I deploy it now?\n\nLet me know if you'd like me to make any adjustments!"), "Should I deploy it now?");
  // Code, links and quotes are read masked but quoted as written; emphasis and a list marker go.
  assert.equal(nudgeSentence("改好了。要我把 `feature/x` 推到 [main](https://example.com/main) 吗？"), "要我把 `feature/x` 推到 [main] 吗？");
  assert.equal(nudgeSentence("我看了「为什么失败」那段日志。要不要我顺手把 https://ci.example.com/job/1 的配置也改了？"), "要不要我顺手把 https://ci.example.com/job/1 的配置也改了？");
  assert.equal(nudgeSentence("**改动**：\n- 修了 A\n\n- **要我继续吗？**"), "要我继续吗？");
  // At most 120 characters on one line.
  const long = `接下来我会把这些模块${"逐一重构".repeat(36)}。`;
  assert.equal(replyNudge(long), "keep-going");
  const quoted = nudgeSentence(long)!;
  assert.equal(Array.from(quoted).length, 120); assert.ok(quoted.endsWith("…")); assert.ok(quoted.startsWith("接下来我会把这些模块"));
  // Nothing invited, nothing quoted; and every reply that invites something has its sentence.
  for (const text of ["要用 Redis 还是 Memcached？", "Next, I'll merge once CI is green.", "", null]) assert.equal(nudgeSentence(text), null, String(text));
  for (const text of ["改好了，测试都过了。\n\n要我继续吗？", "I can also add an integration test for the retry path if you'd like.", "Moving on to the API layer.", "Let me run the full test suite to confirm."]) {
    assert.ok(replyNudge(text) && nudgeSentence(text), text);
  }
});
