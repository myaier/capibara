import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { createElement } from "react";
import { bindTranslator, createTranslator, type Catalog } from "../shared/i18n";
import en from "../shared/locales/en.json";
import zh from "../shared/locales/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import type { AgentRecord } from "../shared/model";
import { normalizeTimelinePage, projectTimelineRows } from "../shared/timeline";
import { answering, outgoingMessage } from "../client/send-check";

// Render the same native components the web host uses, with only host-owned APIs stubbed.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const web = require("react-native-web");
const stubs: Record<string, unknown> = {
  "react-native": web,
  "@getpaseo/plugin/client/react-native": { Icon: ({ name }: { name: string }) => createElement("i", { "data-icon": name }), Modal: Object.assign(() => null, { Content: () => null }),
    ScrollView: web.ScrollView, TextInput: web.TextInput, FlatList: web.FlatList, copyText: async () => {}, useToast: () => ({ show() {}, error() {} }) },
  "@getpaseo/plugin/client": { usePaseo: () => ({}), useRpc: () => async () => ({}) },
  "@getpaseo/plugin/client/ui": { SidebarRow: ({ label }: { label: string }) => createElement("div", { "aria-label": label }, label) },
};
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0secondary-i18n:${name}`] = { id: `\0secondary-i18n:${name}`, filename: `\0secondary-i18n:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0secondary-i18n:${request}` : resolveFilename.call(this, request, ...rest); };
const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };
const useChinese = () => bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
const useEnglish = () => bindTranslator(createTranslator("en", [en, kitEn]));
const theme = { colors: { surface0: "#ffffff", surface1: "#f4f4f5", surface2: "#e4e4e7", foreground: "#18181b", foregroundMuted: "#71717a", border: "#d4d4d8", accent: "#2563eb", accentForeground: "#ffffff", statusDanger: "#dc2626", statusSuccess: "#16a34a" } };

test("session and schedule labels follow the active translator without reimporting modules", async () => {
  useChinese();
  const { phases } = await import("../client/status");
  const { runLooks } = await import("../client/schedule-looks");
  const { statusNames } = await import("../client/ui");
  const { groupTitles } = await import("../client/session-list");
  const { rangeOptions } = await import("../client/stats-common");
  assert.deepEqual([phases.running.label, runLooks.succeeded.label, statusNames.completed, groupTitles.attention, rangeOptions[0].label], ["执行中", "成功", "已完成", "需要处理", "7 天"]);
  try {
    useEnglish();
    assert.deepEqual([phases.running.label, runLooks.succeeded.label, statusNames.completed, groupTitles.attention, rangeOptions[0].label], ["Running", "Succeeded", "Completed", "Needs you", "7 days"]);
    assert.match(phases.approval.hint, /permission requests need your approval/);
  } finally { useChinese(); }
});

test("durations preserve Chinese and allow a user language to reorder hours and minutes", async () => {
  const { shortDuration } = await import("../client/ui");
  useChinese();
  assert.equal(shortDuration(125 * 60_000), "2 小时 5 分");
  try {
    useEnglish();
    assert.equal(shortDuration(125 * 60_000), "2 hr 5 min");
    const custom: Catalog = { secondaryUi: { hoursMinutes: "분 {minutes}, 시 {hours}" } };
    bindTranslator(createTranslator("ko", [custom, en, kitEn]));
    assert.equal(shortDuration(125 * 60_000), "분 5, 시 2");
    assert.equal(shortDuration(8_000), "8 sec");
  } finally { useChinese(); }
});

test("read labels use state identifiers even if a custom language gives states identical names", async () => {
  const { readLabel } = await import("../client/ui");
  const custom: Catalog = { secondaryUi: { question: "Same", waitingForApproval: "Same", questionWaitingForYourAnswer: "Answer this question" } };
  const agent = { status: "waiting", pending: [{ kind: "question", title: "Choose a branch", options: [] }], pendingPermissionCount: 1 } as unknown as AgentRecord;
  try {
    bindTranslator(createTranslator("en", [custom, en, kitEn]));
    assert.equal(readLabel(agent), "Answer this question");
  } finally { useChinese(); }
});

test("the archive sidebar renders the selected language and user catalog fallback", async () => {
  const { ArchivesSidebarItem } = await import("../client/sidebar");
  const render = () => renderToString(createElement(ArchivesSidebarItem, { theme, currentScreen: null, openScreen() {} } as never));
  try {
    useEnglish();
    assert.match(render(), /aria-label="Archived sessions"/);
    bindTranslator(createTranslator("ko", [{ boot: { archivesTitle: "보관된 세션" } }, en, kitEn]));
    assert.match(render(), /aria-label="보관된 세션"/);
  } finally { useChinese(); }
});

test("timeline controls render English while agent-authored Chinese remains unchanged", async () => {
  const { TimelineEntry } = await import("../client/timeline-view");
  try {
    useEnglish();
    const rows = projectTimelineRows(normalizeTimelinePage({ epoch: "e1", entries: [{ seqStart: 1, seqEnd: 1, timestamp: "2026-10-15T08:00:00Z", item: { type: "assistant_message", text: "用户保留的中文结果", messageId: "reply" } }] }).rows);
    const html = renderToString(createElement(TimelineEntry, { theme, row: rows[0] } as never));
    assert.match(html, /Agent reply/);
    assert.match(html, /用户保留的中文结果/);
    assert.doesNotMatch(html, /Agent 回复/);
  } finally { useChinese(); }
});

test("send text follows language while the default persisted deduplication key stays stable", () => {
  useChinese();
  const chinese = outgoingMessage("agent", "User content");
  try {
    useEnglish();
    const english = outgoingMessage("agent", "User content");
    assert.equal(english.source, "Observatory");
    assert.equal(english.what, "message");
    assert.equal(english.key, chinese.key);
    assert.equal(answering("2026-10-15T08:00:00Z", "Review")({ provider: "codex", status: "running" }, false), '"Review" has started a new turn. This quick reply no longer applies.');
  } finally { useChinese(); }
});

test("schedule countdowns choose English singular and plural while Chinese stays unchanged", async () => {
  const { untilLabel } = await import("../client/schedule-looks");
  const now = Date.parse("2026-10-15T08:00:00Z");
  try {
    useChinese();
    assert.equal(untilLabel(new Date(now + 60_000).toISOString(), now), "1 分钟后");
    useEnglish();
    assert.equal(untilLabel(new Date(now + 60_000).toISOString(), now), "In 1 minute");
    assert.equal(untilLabel(new Date(now + 120_000).toISOString(), now), "In 2 minutes");
    assert.equal(untilLabel(new Date(now + 3_600_000).toISOString(), now), "In 1 hour");
  } finally { useChinese(); }
});
