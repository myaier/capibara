import assert from "node:assert/strict";
import test from "node:test";
import { imageSourceKind, proseBlocks, proseImageUrls, proseTokens } from "../shared/prose";

test("replies split into headings, paragraphs, nested lists and quotes", () => {
  const blocks = proseBlocks("## 巡检结论\n\n- 服务健康\n  - P99 182 ms\n  继续观察\n1. 跑测试\n2) 提 MR\n\n> 来自定时任务\n\n普通段落\n第二行");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 2, text: "巡检结论" },
    { kind: "list", items: [{ marker: "•", depth: 0, text: "服务健康" }, { marker: "•", depth: 1, text: "P99 182 ms\n继续观察" }, { marker: "1.", depth: 0, text: "跑测试" }, { marker: "2.", depth: 0, text: "提 MR" }] },
    { kind: "quote", text: "来自定时任务" },
    { kind: "paragraph", text: "普通段落\n第二行" },
  ]);
});

test("Markdown images keep local paths, encoded names, balanced parentheses and optional titles", () => {
  const local = "file:///var/folders/tmp/paseo-attachments-5DcHaj/office%20(1).png";
  assert.deepEqual(proseTokens(`![Office](${local} "Preview")`), [{ kind: "image", text: "Office", url: local }]);
  assert.deepEqual(proseTokens("![](<./office draft.png>)"), [{ kind: "image", text: "", url: "./office draft.png" }]);
  assert.deepEqual(proseTokens("![web](https://example.com/office.png)"), [{ kind: "image", text: "web", url: "https://example.com/office.png" }]);
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "//example.com/a.png", "ftp://example.com/a.png"]) {
    assert.equal(imageSourceKind(url), null);
    assert.ok(proseTokens(`![unsafe](${url})`).every(token => token.kind === "text"));
  }
  assert.deepEqual(proseImageUrls(`![yes](${local})\n\n\`![inline](file:///secret.png)\`\n\n~~~md\n![code](file:///secret.png)\n~~~`), [local]);
});

test("tables, task lists, rules and unfinished fences render as structured blocks", () => {
  assert.deepEqual(proseBlocks("| Name | Result |\n| :--- | ---: |\n| A\\|B | **passed** |\n\n- [x] Done\n- [ ] Next\n\n---\n\n```ts\nconst x = `![literal](file:///a.png)`;"), [
    { kind: "table", headers: ["Name", "Result"], align: ["left", "right"], rows: [["A|B", "**passed**"]] },
    { kind: "list", items: [{ marker: "•", depth: 0, text: "Done", checked: true }, { marker: "•", depth: 0, text: "Next", checked: false }] },
    { kind: "rule" }, { kind: "code", language: "ts", text: "const x = `![literal](file:///a.png)`;" },
  ]);
  assert.deepEqual(proseTokens("*italic* __bold__ ~~removed~~ `literal`"), [
    { kind: "italic", text: "italic" }, { kind: "text", text: " " }, { kind: "bold", text: "bold" }, { kind: "text", text: " " },
    { kind: "strike", text: "removed" }, { kind: "text", text: " " }, { kind: "code", text: "literal" },
  ]);
  assert.deepEqual(proseTokens("file_name_with_underscores"), [{ kind: "text", text: "file_name_with_underscores" }]);
});

test("inline code, bold and links; Chinese punctuation stays outside a bare link; only http(s) becomes a link", () => {
  assert.deepEqual(proseTokens("修复 MR：https://gitlab.example.com/a/b/-/merge_requests/12。另见 [PR](https://github.com/o/r/pull/34)，`npm test` **通过**，javascript:alert(1)"), [
    { kind: "text", text: "修复 MR：" }, { kind: "link", text: "https://gitlab.example.com/a/b/-/merge_requests/12", url: "https://gitlab.example.com/a/b/-/merge_requests/12" },
    { kind: "text", text: "。另见 " }, { kind: "link", text: "PR", url: "https://github.com/o/r/pull/34" }, { kind: "text", text: "，" },
    { kind: "code", text: "npm test" }, { kind: "text", text: " " }, { kind: "bold", text: "通过" }, { kind: "text", text: "，javascript:alert(1)" },
  ]);
  assert.deepEqual(proseTokens("plain"), [{ kind: "text", text: "plain" }]);
});

test("empty and whitespace-only code fences are dropped instead of rendering an empty box", () => {
  assert.deepEqual(proseBlocks("前文\n```\n```\n后文"), [{ kind: "paragraph", text: "前文" }, { kind: "paragraph", text: "后文" }]);
  assert.deepEqual(proseBlocks("前文\n```\n  \n```\n后文"), [{ kind: "paragraph", text: "前文" }, { kind: "paragraph", text: "后文" }]);
  // An unclosed fence whose body is only whitespace is dropped too.
  assert.deepEqual(proseBlocks("前文\n```\n  "), [{ kind: "paragraph", text: "前文" }]);
});
