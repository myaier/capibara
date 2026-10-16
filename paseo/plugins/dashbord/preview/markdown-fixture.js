export const markdownImageUrl = "file:///var/folders/tmp/paseo-attachments-preview/office%20(1).png";
export const markdownImageBytes = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAMUlEQVR4nGPQXdUDR455l+CIQXdbDxw5Nl2CIwbdQz1w5DjtEhwx6J7rgSPHVZfgCABCKzFBe9qwEAAAAABJRU5ErkJggg==";
export const markdownReply = [
  "## Markdown 渲染预览",
  `![办公室预览](${markdownImageUrl})`,
  "**粗体结果**、*斜体说明*、~~旧结论~~，以及 `npm test`。",
  "- [x] 本地图片显示\n- [ ] 后续验证",
  "| 项目 | 结果 | 说明 |\n| :--- | :---: | ---: |\n| 图片 | **通过** | 按原始比例显示 |\n| 表格 | 通过 | 支持横向滚动 |",
  "> 引用内容保持可读。",
  "[查看文档](https://example.com/docs)",
  "```md\n![代码里的图片](file:///must-not-be-read.png)\n```",
  "---",
  "<script>window.__markdownExecuted = true</script>",
  "Markdown 预览结束。",
].join("\n\n");
