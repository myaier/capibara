import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { createElement } from "react";
import { normalizeTimelinePage, projectTimelineRows, type TimelineRow } from "../shared/timeline";
import { createTimelineFind, findInRows } from "../shared/timeline-find";

// The timeline view rendered to HTML through react-native-web, the way the web host renders it: no browser, no preview build.
// The host SDK's native parts are stubbed (icons as <i data-icon>, no modal); `react-native` is react-native-web itself.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const web = require("react-native-web");
const stubs: Record<string, unknown> = {
  "react-native": web,
  "@getpaseo/plugin/client/react-native": { Icon: ({ name }: { name: string }) => createElement("i", { "data-icon": name }), Modal: Object.assign(() => null, { Content: () => null }),
    ScrollView: web.ScrollView, TextInput: web.TextInput, FlatList: web.FlatList, copyText: async () => {} },
  "@getpaseo/plugin/client": { usePaseo: () => host, useRpc: () => async () => ({}) },
};
const host = {};
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };

const theme = { colors: { surface0: "#ffffff", surface1: "#f4f4f5", surface2: "#e4e4e7", foreground: "#18181b", foregroundMuted: "#71717a", border: "#d4d4d8", accent: "#2563eb",
  accentForeground: "#ffffff", statusDanger: "#dc2626", statusSuccess: "#16a34a" } };
let messages = 0;
const say = (text: string) => ({ type: "assistant_message", text, messageId: `m${++messages}` });
const shell = (command: string, output: string) => ({ type: "tool_call", callId: `c${++messages}`, name: "exec_command", status: "completed", detail: { type: "shell", command, output } });
function rows(entries: Array<Record<string, unknown>>, epoch = "e1"): TimelineRow[] {
  return projectTimelineRows(normalizeTimelinePage({ epoch, entries: entries.map((item, index) => ({ seqStart: index + 1, seqEnd: index + 1, timestamp: "2026-10-12T16:00:00Z", item })) }).rows);
}
// react-dom ships no type declarations here (no @types/react-dom), so its server renderer is typed by hand.
const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };
async function render(type: unknown, props: Record<string, unknown>): Promise<string> {
  return renderToString(createElement(type as never, { theme, ...props } as never));
}
/** Text of the spans the find marked, by kind: amber ground (a hit) or solid amber (the current one). */
function marks(html: string) {
  const found = [...html.matchAll(/<span[^>]*style="background-color:rgba\(217,119,6,([\d.]+)\)[^"]*"[^>]*>([^<]*)<\/span>/g)];
  return { hits: found.filter(match => match[1] !== "1.00").map(match => match[2]), current: found.filter(match => match[1] === "1.00").map(match => match[2]) };
}

test("a row marks every hit in amber and the current one solid, with a blue frame; without a search it renders plain text", async () => {
  const { TimelineEntry } = await import("../client/timeline-view");
  const [row] = rows([say("部署 deploy 失败，DEPLOY 重试")]);
  const result = findInRows([row!], "deploy", "e1");
  const html = await render(TimelineEntry, { row, hits: result.byRow.get(row!.key), current: result.hits[1], flash: 1 });
  assert.deepEqual(marks(html), { hits: ["deploy"], current: ["DEPLOY"] });
  assert.match(html, /aria-current="true"/); assert.match(html, /border-top-color:rgba\(59,130,246,1\.00\)/, "the current hit's row is framed in blue");
  assert.match(html, /text-decoration-color:rgba\(59,130,246,1\.00\)/);
  const plain = await render(TimelineEntry, { row });
  assert.deepEqual(marks(plain), { hits: [], current: [] }); assert.doesNotMatch(plain, /aria-current/);
  assert.match(plain, /部署 deploy 失败，DEPLOY 重试/);
});

test("a collapsed tool row counts the hits it hides; expanded, its blocks mark them", async () => {
  const { TimelineEntry } = await import("../client/timeline-view");
  const [row] = rows([shell("npm test", "FAIL api.test.ts\nTimeout 超时\n重试后仍超时")]);
  const result = findInRows([row!], "超时", "e1");
  assert.equal(result.hits.length, 2);
  const collapsed = await render(TimelineEntry, { row, hits: result.byRow.get(row!.key), current: null });
  assert.match(collapsed, /2 处命中/); assert.deepEqual(marks(collapsed).hits, [], "the output is behind 展开");
  const memory = { scroll: 0, expanded: new Set([row!.key]), filter: "all" };
  const expanded = await render(TimelineEntry, { row, memory, hits: result.byRow.get(row!.key), current: result.hits[0] });
  assert.doesNotMatch(expanded, /处命中/);
  assert.deepEqual(marks(expanded), { hits: ["超时"], current: ["超时"] });
  assert.match(expanded, /aria-label="收起exec_command"/, "the row keeps its 展开 / 收起 label");
});

test("a long block cut to its first lines says how many hits follow", async () => {
  const { CodeBlock } = await import("../client/timeline-view");
  const text = `${"ok line\n".repeat(30)}timeout here\nand timeout again`;
  const [row] = rows([shell("make check", text)]);
  const hits = findInRows([row!], "timeout", "e1").hits.filter(hit => hit.field === "detail:执行输出");
  const html = await render(CodeBlock, { label: "执行输出", value: text, hits });
  assert.match(html, /后面还有 2 处命中/); assert.match(html, /展开全部 · /);
});

test("the find bar says what it searched: 已加载 N 条, the filter, older records it did not read, and N / M", async () => {
  const { FindBar } = await import("../client/timeline-view");
  const timeline = rows([say("deploy started"), say("waiting"), say("deploy failed")]);
  const clock = { setTimeout: () => 0, clearTimeout: () => {} };
  const finder = createTimelineFind({ clock });
  finder.setRows(timeline, "e1"); finder.open(); finder.setInput("deploy"); finder.next(); finder.next();
  const bar = (find: unknown, extra: Record<string, unknown> = {}) => render(FindBar, { find, finder, inset: 16, loaded: 3, searched: 3, filterLabel: null, hasOlder: false, truncated: false, loadingOlder: false, onLoadOlder() {}, ...extra });
  const found = await bar(finder.getSnapshot(), { hasOlder: true });
  assert.match(found, />2 \/ 2</); assert.match(found, /aria-label="第 2 处，共 2 处"/); assert.match(found, /aria-live="polite"/);
  assert.match(found, /已加载 3 条 · 更早的记录还没读取，不在查找范围内/); assert.match(found, /aria-label="读取更早的记录后继续查找"/);
  for (const label of ["在时间线里查找", "上一处", "下一处", "关闭查找"]) assert.match(found, new RegExp(`aria-label="${label}"`));
  finder.setInput("rollback"); finder.next();
  const none = await bar(finder.getSnapshot(), { loaded: 3, searched: 1, filterLabel: "工具" });
  assert.match(none, />0 处</); assert.match(none, /已加载的 3 条里没有找到，只查「工具」1 条/);
  assert.doesNotMatch(none, /更早的记录/, "nothing older to read");
});

test("the timeline keeps its filter bar and gains a 查找 toggle; the list is unchanged while find is closed", async () => {
  const { TimelineContent } = await import("../client/timeline-view");
  const page = normalizeTimelinePage({ epoch: "e1", entries: [{ seqStart: 1, seqEnd: 1, timestamp: "2026-10-12T16:00:00Z", item: say("全部通过") }], hasOlder: true });
  const timeline = { page, error: null, loading: false, refreshing: false, loadingOlder: false, lastSyncedAt: null, live: true, snapshot: null, viewState: { scrollOffset: 0, filter: "all", followTail: true },
    refresh: async () => {}, loadOlder: async () => {}, setViewState() {} };
  const html = await render(TimelineContent, { timeline, cacheKey: "render-test" });
  assert.match(html, /aria-label="时间线筛选"/); assert.match(html, /aria-label="查找"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*aria-label="查找"/);
  assert.match(html, /aria-label="读取更早的记录"/); assert.match(html, /全部通过/);
  assert.doesNotMatch(html, /在时间线里查找/, "the find bar opens on demand");
});

// codex-obs-send-ui-F2: the view can only scroll to a hit inside a long row if that hit's line is a block it can measure.
test("the current hit's line in an expanded output starts a block of its own; the text and marks are unchanged; nothing splits without a listener", async () => {
  const { TimelineEntry } = await import("../client/timeline-view");
  const output = ["NEEDLE first", ...Array.from({ length: 10 }, (_, index) => `line ${index}`), "then NEEDLE again", "tail"].join("\n");
  const [row] = rows([shell("show-log", output)]);
  const result = findInRows([row!], "NEEDLE", "e1");
  const memory = { scroll: 0, expanded: new Set([row!.key]), filter: "all" };
  const props = { row, memory, hits: result.byRow.get(row!.key), current: result.hits[1] };
  const split = await render(TimelineEntry, { ...props, onHitLine() {} });
  assert.match(split, /line 9<\/div><div[^>]*>then <span[^>]*data-testid="find-current"[^>]*>NEEDLE<\/span> again\ntail<\/div>/, "the part before ends at the line before; the hit's line opens the next block");
  assert.deepEqual(marks(split), { hits: ["NEEDLE"], current: ["NEEDLE"] });
  const whole = await render(TimelineEntry, props);
  assert.doesNotMatch(whole, /line 9<\/div>/); assert.match(whole, /line 9\nthen <span/);
  assert.deepEqual(marks(whole), marks(split));
});

test("a long reply shown in full splits at the current hit's line too; collapsed, it does not", async () => {
  const { TimelineEntry } = await import("../client/timeline-view");
  const reply = ["开头提到 NEEDLE", ...Array.from({ length: 40 }, (_, index) => `第 ${index} 段：这一段是普通的验证记录，没有要找的词。`), "结尾又是 NEEDLE"].join("\n");
  const [row] = rows([say(reply)]);
  const result = findInRows([row!], "NEEDLE", "e1");
  assert.equal(result.hits[1]!.hidden, true, "past the first lines of a collapsed reply");
  const shown = await render(TimelineEntry, { row, memory: { scroll: 0, expanded: new Set([row!.key]), filter: "all" }, hits: result.byRow.get(row!.key), current: result.hits[1], onHitLine() {} });
  assert.match(shown, /第 39 段：这一段是普通的验证记录，没有要找的词。<\/div><div[^>]*>结尾又是 <span[^>]*data-testid="find-current"/);
  const collapsed = await render(TimelineEntry, { row, hits: result.byRow.get(row!.key), current: result.hits[0], onHitLine() {} });
  assert.doesNotMatch(collapsed, /<\/div><div[^>]*>结尾又是/, "a collapsed reply keeps its line limit");
});
