import assert from "node:assert/strict";
import test from "node:test";
import { previewOf } from "../shared/schedules";
import { proseBlocks, proseTokens } from "../shared/prose";

/** Replies and schedule outputs are agent-written text, so the Markdown helpers must stay linear on hostile input. */
function fast(label: string, run: () => unknown, budgetMs = 250) {
  const started = performance.now();
  run();
  const took = performance.now() - started;
  assert.ok(took < budgetMs, `${label} took ${took.toFixed(0)} ms`);
}

test("reply previews stay fast on hostile Markdown: unclosed brackets, bold markers, blank lines, an endless link", () => {
  const n = 60_000;
  fast("brackets", () => previewOf("[".repeat(n)));
  fast("image brackets", () => previewOf("![".repeat(n / 2)));
  fast("bold markers", () => previewOf("**a ".repeat(n / 4)));
  fast("blank lines", () => previewOf(`${"\n".repeat(n)}x`));
  fast("open link", () => previewOf(`[a](${"x".repeat(n)}`));
  fast("32 MB-style reply", () => previewOf(`## 结论\n\n${"[链接](https://example.com/a) **重点** `代码` ".repeat(20_000)}`));
});

test("a preview of a long reply still comes from its start, Markdown stripped", () => {
  assert.equal(previewOf(`## 结论\n\n- 第一条 **重点**\n- [文档](https://example.com/doc)\n\n${"正文 ".repeat(50_000)}`)?.startsWith("结论 第一条 重点 文档 正文"), true);
  assert.equal(previewOf("[".repeat(10))?.length, 10);
});

test("reply rendering stays fast on hostile Markdown", () => {
  const n = 60_000;
  fast("brackets", () => proseTokens("[".repeat(n)));
  fast("link text without a URL", () => proseTokens(`[${"a".repeat(n)}`));
  fast("heading padded with spaces", () => proseBlocks(`# a${" ".repeat(n)}b`));
  fast("heading of hashes", () => proseBlocks(`## ${"#".repeat(n)}x`));
  fast("list item padded with spaces", () => proseBlocks(`-${" ".repeat(n)}a\r`));
  fast("quote padded with spaces", () => proseBlocks(`>${" ".repeat(n)}a\r`));
});

test("headings keep their text: closing hashes need a space before them, CRLF line ends are dropped", () => {
  assert.deepEqual(proseBlocks("## 巡检结论 ##"), [{ kind: "heading", level: 2, text: "巡检结论" }]);
  assert.deepEqual(proseBlocks("### 迁移到 C#"), [{ kind: "heading", level: 3, text: "迁移到 C#" }]);
  assert.deepEqual(proseBlocks("# 标题\r\n- 第一项\r\n> 引用\r"), [
    { kind: "heading", level: 1, text: "标题" }, { kind: "list", items: [{ marker: "•", depth: 0, text: "第一项" }] }, { kind: "quote", text: "引用" }]);
  assert.deepEqual(proseBlocks("####### 七个井号"), [{ kind: "paragraph", text: "####### 七个井号" }]);
});

test("links stay links; brackets inside link text no longer swallow the text before them", () => {
  assert.deepEqual(proseTokens("见 [PR](https://example.com/pull/1) 和 [a [b](https://example.com/b)"), [
    { kind: "text", text: "见 " }, { kind: "link", text: "PR", url: "https://example.com/pull/1" }, { kind: "text", text: " 和 [a " },
    { kind: "link", text: "b", url: "https://example.com/b" }]);
});
