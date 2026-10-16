import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { createElement } from "react";
import { PERMISSION_TEXT_LIMIT, permissionView } from "../shared/permissions";

// The approval panel's body rendered to HTML through react-native-web, as the web host renders it (no browser, no preview build).
// The host SDK's native parts are stubbed: icons as <i data-icon>, no modal or toasts.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const web = require("react-native-web");
const stubs: Record<string, unknown> = {
  "react-native": web,
  "@getpaseo/plugin/client/react-native": { Icon: ({ name }: { name: string }) => createElement("i", { "data-icon": name }), useToast: () => ({ show() {}, error() {} }),
    Modal: Object.assign(() => null, { Content: () => null }), ScrollView: web.ScrollView, TextInput: web.TextInput, FlatList: web.FlatList, copyText: async () => {} },
  "@getpaseo/plugin/client": { usePaseo: () => ({}), useRpc: () => async () => ({}) },
};
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };

const theme = { colors: { surface0: "#ffffff", surface1: "#f4f4f5", surface2: "#e4e4e7", foreground: "#18181b", foregroundMuted: "#71717a", border: "#d4d4d8", accent: "#2563eb",
  accentForeground: "#ffffff", statusDanger: "#dc2626", statusSuccess: "#16a34a" } };
// react-dom ships no type declarations here (no @types/react-dom), so its server renderer is typed by hand.
const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };
async function body(request: unknown, expanded: boolean): Promise<string> {
  const { RequestBody } = await import("../client/permission-panel");
  return renderToString(createElement(RequestBody as never, { theme, view: permissionView(request, "/home/me/app")!, expanded, onToggle() {} } as never));
}

// codex-obs-send-ui-F1: what is approved is what 展开完整内容 shows, to the last character; collapsed, only the screen shortens it.
test("collapsed, a long command shows its first lines; 展开完整内容 shows it to the end", async () => {
  const command = `printf ${"x".repeat(4100)} ; echo ACTUAL_END_OF_COMMAND`;
  const request = { id: "long-command", kind: "tool", provider: "claude", name: "Bash", input: { command } };
  const collapsed = await body(request, false);
  assert.match(collapsed, /\$ printf xxx/); assert.doesNotMatch(collapsed, /ACTUAL_END_OF_COMMAND/, "only the start is drawn while collapsed");
  assert.match(collapsed, /aria-label="展开完整请求内容"/);
  const expanded = await body(request, true);
  assert.ok(expanded.includes(`$ ${command}`), "the whole command, its tail included"); assert.match(expanded, /aria-label="收起请求内容"/);
  assert.doesNotMatch(expanded, /已截断/, "nothing was cut");
});

test("a long parameter keeps its end, and a request with only a query and a pattern shows both", async () => {
  const write = await body({ id: "w", kind: "tool", provider: "claude", name: "Write", input: { content: `${"x".repeat(1300)}ACTUAL_INPUT_END` } }, true);
  assert.match(write, /content: x+ACTUAL_INPUT_END/);
  const search = await body({ id: "s", kind: "tool", provider: "claude", name: "WebSearch", input: { query: "the exact user search", pattern: "private*" } }, false);
  assert.match(search, /the exact user search/); assert.match(search, /pattern: private\*/);
});

test("a part cut at 64 KB and a diff the host cut say so in words", async () => {
  const huge = await body({ id: "h", kind: "tool", name: "Bash", input: { command: "y".repeat(70_000) } }, false);
  assert.match(huge, new RegExp(`命令太长，已截断：只保留了前 ${PERMISSION_TEXT_LIMIT.toLocaleString()} 字（原文 70,000 字）`));
  assert.match(huge, /data-icon="Scissors"/);
  const edit = await body({ id: "d", kind: "tool", name: "Edit", input: { file_path: "/home/me/app/a.ts", old_string: "OLD_TEXT", new_string: "NEW_TEXT" },
    detail: { type: "edit", filePath: "/home/me/app/a.ts", unifiedDiff: "@@ -1 +1 @@\n-OLD\n+NEW\n...[truncated 345 chars]" } }, true);
  assert.match(edit, /宿主只传来这段差异的开头，另有 345 字没有传过来；下面的参数里是完整的修改内容/);
  assert.match(edit, /old_string: OLD_TEXT\nnew_string: NEW_TEXT/);
});

test("201 short parameters: collapsed shows the first, 展开完整内容 shows the last; a list cut at 64 KB says how many are not whole (codex-obs-send-ui-F1)", async () => {
  const input: Record<string, unknown> = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`option${index}`, index]));
  input.CRITICAL_PARAMETER_AFTER_200 = 123;
  const request = { id: "many", kind: "tool", provider: "claude", name: "ConfiguredTool", input };
  const collapsed = await body(request, false);
  assert.match(collapsed, /option0: 0/); assert.doesNotMatch(collapsed, /CRITICAL_PARAMETER_AFTER_200/); assert.match(collapsed, /aria-label="展开完整请求内容"/);
  const expanded = await body(request, true);
  assert.match(expanded, /option199: 199\nCRITICAL_PARAMETER_AFTER_200: 123/); assert.doesNotMatch(expanded, /已截断/);
  const crowd: Record<string, unknown> = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`flag${index}`, "v".repeat(10)]));
  const view = permissionView({ id: "crowd", kind: "tool", name: "ConfiguredTool", input: crowd }, "/home/me/app")!;
  const note = await body({ id: "crowd", kind: "tool", name: "ConfiguredTool", input: crowd }, true);
  assert.ok(note.includes(`内容太长，已截断：只保留了前 ${PERMISSION_TEXT_LIMIT.toLocaleString()} 字（原文 ${view.cut.args!.total.toLocaleString()} 字）；共 10,000 项参数，后 ${(10_000 - view.cut.args!.items!.whole).toLocaleString()} 项没有完整显示`));
});

test("a multi-line parameter cut at 64 KB: the note counts the parameters not shown whole, never a negative number (codex-obs-send-ui-R1)", async () => {
  const note = await body({ id: "script", kind: "tool", name: "Tool", input: { script: "x\n".repeat(40_000), hidden: "last value" } }, true);
  assert.ok(note.includes(`内容太长，已截断：只保留了前 ${PERMISSION_TEXT_LIMIT.toLocaleString()} 字（原文 80,027 字）；共 2 项参数，后 2 项没有完整显示`));
  assert.doesNotMatch(note, /后 -/);
});
