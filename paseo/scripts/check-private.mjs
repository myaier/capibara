#!/usr/bin/env node
// Blocks private data from entering this public repository: credentials, and the machine identities, addresses and
// personal paths that acceptance work tends to copy into notes and fixtures.
//
//   node paseo/scripts/check-private.mjs --staged   added lines of the staged change (pre-commit hook)
//   node paseo/scripts/check-private.mjs --all      every tracked file (CI)
//
// A line that must keep a match (for example a documentation address) can carry `privacy-check: allow`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF = "paseo/scripts/check-private.mjs";
const SKIP = [/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|lock)$/i, /(^|\/)package-lock\.json$/];
// Reserved names (RFC 2606/6761) and no-reply senders.
const ALLOWED_EMAIL = /@((.+\.)?example(\.(com|org|net))?|(.+\.)?(test|invalid|localhost)|users\.noreply\.github\.com|noreply\.github\.com|anthropic\.com)$/i;
const ALLOWED_IP = /^(127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;

export const RULES = [
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "api-token", pattern: /\b(sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,})\b/ },
  { id: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
  { id: "ip-address", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, keep: match => !ALLOWED_IP.test(match) },
  { id: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, keep: match => !ALLOWED_EMAIL.test(match) },
  { id: "paseo-server-id", pattern: /\bsrv_[A-Za-z0-9_-]{10,}/g, keep: match => !match.startsWith("srv_demo") },
  { id: "windows-hostname", pattern: /\b(DESKTOP|LAPTOP)-[A-Z0-9]{7}\b/ },
  { id: "home-path", pattern: /(\/Users\/|\/home\/)(?!(you|me|user|username|runner|<[^>]+>)\/)[a-z][a-z0-9._-]+\//gi },
];

export function findings(file, lines) {
  if (file === SELF || SKIP.some(pattern => pattern.test(file))) return [];
  const found = [];
  for (const { line, text } of lines) {
    if (text.includes("privacy-check: allow")) continue;
    for (const rule of RULES) {
      const matches = rule.pattern.global ? [...text.matchAll(rule.pattern)].map(match => match[0]) : (text.match(rule.pattern) ?? []).slice(0, 1);
      for (const match of matches) if (!rule.keep || rule.keep(match)) found.push({ file, line, rule: rule.id, match });
    }
  }
  return found;
}

const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function stagedLines() {
  const files = new Map();
  let file = null, line = 0;
  for (const text of git(["diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR"]).split("\n")) {
    if (text.startsWith("+++ ")) { file = text.startsWith("+++ b/") ? text.slice(6) : null; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (file && text.startsWith("+")) { if (!files.has(file)) files.set(file, []); files.get(file).push({ line, text: text.slice(1) }); line++; }
  }
  return files;
}

function trackedLines() {
  const files = new Map();
  for (const file of git(["ls-files", "-z"]).split("\0").filter(Boolean)) {
    if (SKIP.some(pattern => pattern.test(file))) continue;
    let content; try { content = readFileSync(file, "utf8"); } catch { continue; }
    if (content.includes("\0")) continue;
    files.set(file, content.split("\n").map((text, index) => ({ line: index + 1, text })));
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode !== "--staged" && mode !== "--all") { console.error("usage: check-private.mjs --staged | --all"); process.exit(2); }
  const files = mode === "--staged" ? stagedLines() : trackedLines();
  const found = [...files].flatMap(([file, lines]) => findings(file, lines));
  if (!found.length) process.exit(0);
  console.error("Private data check failed. This repository is public; remove these before committing:\n");
  for (const item of found) console.error(`  ${item.file}:${item.line}  [${item.rule}]  ${item.match}`);
  console.error("\nUse fictional values (example.com, 192.0.2.x, srv_demo…, WIN-DEMO-PC). If a match is genuinely public,");
  console.error("add `privacy-check: allow` to that line. See CONTRIBUTING.md.");
  process.exit(1);
}
