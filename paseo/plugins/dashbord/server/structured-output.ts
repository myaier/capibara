import { t } from "../shared/text";

/** Parse plain JSON, a fenced object, or a complete object in surrounding text. Models sometimes repeat the whole answer, so the last object `accept` approves wins; otherwise the largest one. */
export function extractStructuredJson(output: string, accept?: (value: unknown) => boolean): unknown {
  const text = output.trim();
  if (text.length > 4_000_000) throw new Error(t("metadataRunner.outputTooLarge"));
  try { return JSON.parse(text); } catch { /* providers sometimes add a fence or preamble */ }
  const spans: Array<[number, number]> = []; let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) { if (char === "{") { start = index; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { spans.push([start, index + 1]); start = -1; }
  }
  const objects = spans.flatMap(([from, to]) => { try { return [{ value: JSON.parse(text.slice(from, to)) as unknown, size: to - from }]; } catch { return []; } });
  const accepted = accept ? objects.filter(object => accept(object.value)) : [];
  const chosen = accepted.at(-1) ?? objects.sort((a, b) => b.size - a.size)[0];
  if (chosen) return chosen.value;
  throw new Error(t("metadataRunner.invalidJson"));
}
