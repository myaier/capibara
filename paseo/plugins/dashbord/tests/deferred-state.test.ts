import assert from "node:assert/strict";
import test from "node:test";
import { DEFERRED_POLL_MS, confirmOffer, deferredPollInterval, ledgerNotice, messageKey, messageRecord, onItsWayLabel, quickReplyGroup, quickReplyGuard, quickReplyKey, rememberUnanswered, requestId, settleRequest, unansweredId, visibleDeferred } from "../client/deferred-state";
import { contentKey } from "../client/send-plan";
import type { DeferredView } from "../shared/deferred-rpc";

const view = (messageId: string, state: DeferredView["state"], patch: Partial<DeferredView> = {}): DeferredView =>
  ({ messageId, agentId: "a", key: "k", source: "快捷回复「继续做完」", preview: "继续做完。", createdAt: 1, at: 1, state, note: "", ...patch });

test("a message's key is the plugin, its source and its words, as the four plugins name theirs", () => {
  assert.equal(messageKey("分析建议", "请复查"), contentKey(["observatory", "分析建议", "请复查"]));
  assert.notEqual(messageKey("分析建议", "请复查"), messageKey("快捷回复", "请复查"));
  assert.match(quickReplyKey("继续做完。", null, null), /^[0-9a-z]+$/);
});

// The four plugins' r3-F5: a request whose answer never came back may have reached the server, so the next try asks for its id.
test("a lost request is asked about again under its id until it is answered or listed; then a new id", () => {
  const key = messageKey("分析建议", "请复查这里");
  const first = requestId("a", key);
  assert.notEqual(requestId("a", key), first, "nothing lost: every request is new");
  rememberUnanswered("a", key, first);
  assert.equal(unansweredId("a", key), first);
  assert.equal(requestId("a", key), first, "the next try asks for the same id");
  assert.equal(requestId("a", key, [view("other", "queued")]), first, "another message listed does not settle it");
  assert.notEqual(requestId("b", key), first, "per Agent");
  assert.notEqual(requestId("a", key, [view(first, "sent")]), first, "listed: the list is its record, a new request gets a new id");
  assert.equal(unansweredId("a", key), null);
  rememberUnanswered("a", key, first);
  settleRequest("a", key);
  assert.equal(unansweredId("a", key), null, "answered");
});

test("the request registry keeps the newest 200", () => {
  for (let index = 0; index < 205; index++) rememberUnanswered("a", `key-${index}`, `id-${index}`);
  assert.equal(unansweredId("a", "key-0"), null);
  assert.equal(unansweredId("a", "key-4"), null);
  assert.equal(unansweredId("a", "key-5"), "id-5");
  assert.equal(unansweredId("a", "key-204"), "id-204");
});

test("a message's record: one on its way first, else the newest outcome; the list is read again only while one is on its way", () => {
  const list = [view("old", "sent", { at: 5 }), view("newer", "canceled", { at: 9 }), view("other", "queued", { key: "other" })];
  assert.equal(messageRecord(list, "a", "k")?.messageId, "newer");
  assert.equal(messageRecord([...list, view("way", "held", { at: 1 })], "a", "k")?.messageId, "way");
  assert.equal(messageRecord(list, "b", "k"), null);
  assert.equal(deferredPollInterval([view("x", "queued")], true), DEFERRED_POLL_MS);
  assert.equal(deferredPollInterval([view("x", "queued")], false), false, "in the background: never");
  assert.equal(deferredPollInterval([view("x", "sent")], true), false);
  // Outcomes show for a while after this app first saw them; on their way always.
  const seen = new Map<string, number>();
  assert.deepEqual(visibleDeferred([view("s", "sent"), view("q", "queued")], 1_000, seen).views.map(item => item.messageId), ["s", "q"]);
  assert.deepEqual(visibleDeferred([view("s", "sent"), view("q", "queued")], 1_000 + 12_000, seen).views.map(item => item.messageId), ["q"]);
});

test("the words for a confirmation's third choice and for a message already on its way", () => {
  assert.deepEqual(confirmOffer({ approvals: [] }), { label: "等这一轮结束再发", note: "不打断当前回合，等它这一轮结束后自动发送" });
  assert.equal(confirmOffer({ approvals: ["p"] })?.label, "等审批处理完再发");
  assert.deepEqual(["held", "sending", "queued", "maybe-sent", "sent"].map(state => onItsWayLabel({ state: state as DeferredView["state"] })), ["在等你确认", "正在发送", "已在排队", "刚刚可能已经发出", "刚刚已经发出"]);
});

// codex-obs-send-ui-R2: queueing can answer with a message held for the user, one that may already have gone out, or one that
// ended; only a queued one is promised to go out when the turn ends.
test("what an entry says about the ledger's answer: only 排队中 promises to send when the turn ends", () => {
  const notice = (state: DeferredView["state"], note = "") => ledgerNotice({ state, note }, "重构支付服务");
  assert.deepEqual(notice("queued"), { tone: "success", kind: "waiting", text: "已排队：等「重构支付服务」这一轮结束后自动发送" });
  assert.deepEqual(ledgerNotice({ state: "queued", note: "" }, "重构支付服务", "继续做完"), { tone: "success", kind: "waiting", text: "已排队：继续做完，等「重构支付服务」这一轮结束后自动发送" });
  assert.deepEqual(notice("sending"), { tone: "success", kind: "waiting", text: "正在发给「重构支付服务」，见下方。" });
  assert.deepEqual(notice("sent"), { tone: "success", kind: "sent", text: "已发给「重构支付服务」" });
  // Held: it waits for the user, whose row below has the reason, 仍然发送 and 取消.
  assert.deepEqual(notice("held", "没收到发送结果，可能已经送达。"), { tone: "warning", kind: "attention", text: "这条消息在等你确认，见下方。" });
  assert.equal(ledgerNotice({ state: "held", note: "x" }, "重构支付服务", "继续做完").text, "「继续做完」在等你确认，见下方。");
  assert.deepEqual(notice("maybe-sent", "发送结果不确定，可能已经送达，请打开会话看一下"), { tone: "warning", kind: "uncertain", text: "发送结果不确定，可能已经送达，请打开会话看一下" });
  assert.equal(notice("maybe-sent").text, "发送结果不确定，可能已经送达，请先打开会话看一下，不要直接重发。");
  assert.deepEqual(notice("canceled", "已取消，没有发送"), { tone: "info", kind: "ended", text: "已取消，没有发送" });
  assert.deepEqual(notice("expired", "排队超过一天，已放弃发送"), { tone: "danger", kind: "ended", text: "排队超过一天，已放弃发送" });
  assert.deepEqual(notice("discarded", "「重构支付服务」之后又跑了一轮，这条快捷回复答的是之前那一轮，不再适用，没有发送。"),
    { tone: "danger", kind: "ended", text: "「重构支付服务」之后又跑了一轮，这条快捷回复答的是之前那一轮，不再适用，没有发送。" });
  for (const state of ["held", "maybe-sent", "canceled", "expired", "discarded"] as const) assert.doesNotMatch(notice(state, "x").text, /排队|自动发送/, state);
});

// codex-obs-attn-R3: one question per turn, whichever button; the turn as the server checks it.
test("a quick reply's group is its turn, the same for every button; its guard names that turn", () => {
  assert.equal(quickReplyGroup("2026-10-12T00:58:00.000Z", "2026-10-12T02:00:00.000Z"), quickReplyGroup("2026-10-12T08:58:00+08:00", "2026-10-12T10:00:00+08:00"));
  assert.notEqual(quickReplyGroup("2026-10-12T00:58:00.000Z", "2026-10-12T02:00:00.000Z"), quickReplyGroup("2026-10-12T00:58:00.000Z", "2026-10-12T03:00:00.000Z"), "another round");
  assert.notEqual(quickReplyGroup("2026-10-12T00:58:00.000Z", null), quickReplyKey("继续做完。", "2026-10-12T00:58:00.000Z", null), "a group is not any button's key");
  assert.match(quickReplyGroup(null, null), /^[0-9a-z]{1,120}$/);
  assert.deepEqual(quickReplyGuard("2026-10-12T00:58:00.000Z", undefined), { prompt: "2026-10-12T00:58:00.000Z", round: null });
});
