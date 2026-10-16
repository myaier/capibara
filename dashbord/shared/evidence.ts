import { t } from "./text";
/** Keep both setup and terminal output; never blindly keep only a giant prefix. */
export function excerptText(text: string, limit: number): { text: string; truncated: boolean } {
  const cap = Math.max(0, Math.floor(limit));
  if (text.length <= cap) return { text, truncated: false };
  if (cap < 80) return { text: text.slice(0, Math.ceil(cap * 0.6)) + text.slice(-Math.floor(cap * 0.4)), truncated: true };
  const marker = t("sharedEvidence.m001", { value1: text.length });
  const head = Math.ceil((cap - marker.length) * 0.55);
  return { text: text.slice(0, head) + marker + text.slice(-(cap - marker.length - head)), truncated: true };
}
