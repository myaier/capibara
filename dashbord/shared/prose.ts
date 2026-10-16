/**
 * Light Markdown for agent replies, shared by the result views: headings, paragraphs, block quotes, (nested) bullet and
 * numbered/task lists, tables, fenced code, inline emphasis, images and http(s) links. Never interprets HTML.
 */
export type ProseBlock = { kind: "heading"; level: number; text: string } | { kind: "paragraph"; text: string } | { kind: "quote"; text: string }
  | { kind: "list"; items: Array<{ marker: string; depth: number; text: string; checked?: boolean }> }
  | { kind: "code"; language: string; text: string } | { kind: "rule" }
  | { kind: "table"; headers: string[]; align: Array<"left" | "center" | "right">; rows: string[][] };
export type ProseToken = { kind: "text" | "code" | "bold" | "italic" | "strike"; text: string }
  | { kind: "link" | "image"; text: string; url: string };

// Agent replies are untrusted text: every pattern here is linear in the line or bounded (no nested or overlapping
// quantifiers that can backtrack over a long run of spaces, brackets or hashes).
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+([^\n]*)$/;
const QUOTE = /^\s{0,3}>\s?([^\n]*)$/;
/** `## Title ##` → level 2, "Title". A closing run of `#` needs a space before it (`## C#` keeps its `#`). */
function headingOf(line: string): { level: number; text: string } | null {
  const marks = /^#{1,6}/.exec(line)?.[0].length ?? 0;
  if (!marks || !/\s/.test(line[marks] ?? "")) return null;
  let text = line.slice(marks).trim();
  const closing = /(?:^|\s)#+$/.exec(text);
  if (closing) text = text.slice(0, closing.index).trimEnd();
  return text ? { level: marks, text } : null;
}
/**
 * `code` · [text](https://…) · bare https://… · **bold**. A bare link ends at whitespace, brackets, quotes and any CJK or full-width
 * character (replies often run Chinese text straight after a URL); trailing ASCII punctuation stays outside it. Link text cannot
 * contain `[` and is at most 500 characters, so a run of unclosed brackets is scanned once.
 */
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
const URL_CHAR = "[^\\s<>()（）\\[\\]\"'`\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]";
// Bounded destinations allow escaped/balanced parentheses and <paths with spaces> without scanning an endless link.
const DESTINATION = String.raw`(?:<[^<>\n]{1,2000}>|(?:\\.|[^\s()\\]|\([^()\n]{0,500}\)){1,2000})`;
const INLINE = new RegExp(String.raw`(\\[!\[\]*_\x60~\\])|(\x60[^\x60\n]+\x60)|(!?)\[([^\[\]\n]{0,500})\]\((${DESTINATION})(?:[ \t]+["'][^"'\n]{0,500}["'])?\)|(https?:\/\/${URL_CHAR}*(?:(?![.,;:!?])${URL_CHAR}))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_(?![\w]))|(~~[^~\n]+~~)`, "g");

/** Shared with the image reader; other URI schemes never become image requests. */
export function imageSourceKind(url: string): "remote" | "local" | null {
  if (!url || /[\u0000-\u001f]/.test(url)) return null;
  if (/^https?:\/\//i.test(url)) return "remote";
  if (/^file:\/\//i.test(url) || /^[a-z]:[\\/]/i.test(url)) return "local";
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("\\\\") || url.startsWith("#")) return null;
  return "local";
}

function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "", code = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === "\\" && line[i + 1] === "|") { cell += "|"; i++; }
    else if (char === "`") { code = !code; cell += char; }
    else if (char === "|" && !code) { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  cells.push(cell.trim());
  if (line.trimStart().startsWith("|")) cells.shift();
  if (line.trimEnd().endsWith("|")) cells.pop();
  return cells;
}

export function proseBlocks(chunk: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  let paragraph: string[] = [], quote: string[] = [];
  let list: Extract<ProseBlock, { kind: "list" }> | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    if (quote.length) blocks.push({ kind: "quote", text: quote.join("\n") });
    if (list) blocks.push(list);
    paragraph = []; quote = []; list = null;
  };
  const lines = chunk.replace(/\r\n?/g, "\n").split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    if (!line.trim()) { flush(); continue; }
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (fence) {
      flush();
      const content: string[] = [], marker = fence[1]!;
      while (++lineIndex < lines.length) {
        const closing = lines[lineIndex]!.trim();
        if (closing.length >= marker.length && [...closing].every(char => char === marker[0])) break;
        content.push(lines[lineIndex]!);
      }
      // An empty or whitespace-only fence carries nothing and used to render as a mysterious empty box.
      const text = content.join("\n");
      if (text.trim()) blocks.push({ kind: "code", language: fence[2]!.trim(), text });
      continue;
    }
    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) { flush(); blocks.push({ kind: "rule" }); continue; }
    const delimiter = lines[lineIndex + 1];
    if (line.includes("|") && delimiter && /^[\s|:\-]+$/.test(delimiter)) {
      const headers = tableCells(line), separators = tableCells(delimiter);
      if (headers.length === separators.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
        flush(); lineIndex++;
        const rows: string[][] = [];
        while (lines[lineIndex + 1]?.includes("|")) rows.push(tableCells(lines[++lineIndex]!));
        blocks.push({ kind: "table", headers, align: separators.map(cell => cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : "left"), rows });
        continue;
      }
    }
    const heading = headingOf(line), item = LIST_ITEM.exec(line), quoted = QUOTE.exec(line);
    if (heading) { flush(); blocks.push({ kind: "heading", ...heading }); continue; }
    if (item) {
      if (paragraph.length || quote.length) flush();
      list ??= { kind: "list", items: [] };
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]!);
      list.items.push({ marker: /\d/.test(item[2]!) ? item[2]!.replace(")", ".") : "•", depth: Math.min(3, Math.floor(item[1]!.replace(/\t/g, "  ").length / 2)), text: task ? task[2]! : item[3]!, ...(task ? { checked: task[1]!.toLowerCase() === "x" } : {}) });
      continue;
    }
    if (quoted) { if (paragraph.length || list) flush(); quote.push(quoted[1]!); continue; }
    // A wrapped line continues the last list item.
    if (list) { const items = (list as Extract<ProseBlock, { kind: "list" }>).items; items[items.length - 1]!.text += `\n${line.trim()}`; continue; }
    if (quote.length) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

export function proseTokens(text: string): ProseToken[] {
  const tokens: ProseToken[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ kind: "text", text: text.slice(last, at) });
    const url = match[5]?.replace(/^<|>$/g, "").replace(/\\([\\()])/g, "$1") ?? match[6];
    if (match[1]) tokens.push({ kind: "text", text: match[1].slice(1) });
    else if (match[2]) tokens.push({ kind: "code", text: match[2].slice(1, -1) });
    else if (url) {
      const image = match[3] === "!", allowed = image ? imageSourceKind(url) !== null : /^https?:\/\//i.test(url);
      tokens.push(allowed ? { kind: image ? "image" : "link", text: match[4] ?? url, url } : { kind: "text", text: match[0] });
    }
    else if (match[7]) tokens.push({ kind: "bold", text: match[7].slice(2, -2) });
    else if (match[8]) tokens.push(match[8].startsWith("_") && /\w/.test(text[at - 1] ?? "") ? { kind: "text", text: match[8] } : { kind: "italic", text: match[8].slice(1, -1) });
    else if (match[9]) tokens.push({ kind: "strike", text: match[9].slice(2, -2) });
    last = at + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}

/** Image references in visible prose only; fenced and inline code do not grant file access. */
export function proseImageUrls(text: string): string[] {
  const urls = new Set<string>();
  const collect = (value: string, depth = 0) => {
    for (const token of proseTokens(value)) {
      if (token.kind === "image") urls.add(token.url);
      else if (depth < 8 && ["bold", "italic", "strike"].includes(token.kind)) collect(token.text, depth + 1);
    }
  };
  for (const block of proseBlocks(text)) {
    if (block.kind === "code" || block.kind === "rule") continue;
    if (block.kind === "list") block.items.forEach(item => collect(item.text));
    else if (block.kind === "table") [...block.headers, ...block.rows.flat()].forEach(cell => collect(cell));
    else collect(block.text);
  }
  return [...urls];
}
