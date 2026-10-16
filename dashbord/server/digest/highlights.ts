import { onTextChange } from "../../shared/i18n";
import { t } from "../../shared/text";
import { CHECK_KINDS, type CheckKind, type Digest, type DigestCheck, type DigestHighlight, type DigestSegment, type DigestTurn } from "../../shared/digest";
import { tokenTotal } from "../../shared/tokens";
import { analyzeCommand } from "./commands";
import { excerpt, type FoldState, type ToolFact } from "./model";

let checkNames: Record<CheckKind, string> = { test: t("serverDigestHighlights.m001"), typecheck: t("serverDigestHighlights.m002"), lint: t("serverDigestHighlights.m003"), build: t("serverDigestHighlights.m004"), install: t("serverDigestHighlights.m005") };
const severityRank: Record<DigestHighlight["severity"], number> = { bad: 0, warn: 1, good: 2, info: 3 };
const reference = (seq: number | null | undefined) => seq !== null && seq !== undefined && seq >= 0 ? seq : null;

/** Build from the complete compact facts, before chart / turn / check payload thinning. */
export function buildHighlights(state: FoldState, turns: readonly DigestTurn[], segments: readonly DigestSegment[],
  checks: readonly DigestCheck[], tokens: Digest["tokens"]): DigestHighlight[] {
  const result: DigestHighlight[] = [];
  const add = (highlight: DigestHighlight) => result.push({ ...highlight, title: excerpt(highlight.title, 80),
    detail: excerpt(highlight.detail, 160), seq: reference(highlight.seq) });
  const tools = [...state.tools.values()].sort((a, b) => a.seq - b.seq || a.start - b.start);
  const toolsBySeq = new Map(tools.map(tool => [tool.seq, tool]));
  const factsByTurn = new Map(state.turns.map(turn => [turn.index, turn]));
  const segmentsBySeq = new Map(segments.filter(segment => segment.seq !== null && segment.lane !== "model" && segment.lane !== "wait")
    .map(segment => [segment.seq, segment]));
  const duration = (tool: ToolFact) => Math.max(0, (segmentsBySeq.get(tool.seq)?.end ?? tool.end) - tool.start);
  const toolAt = (tool: ToolFact) => Math.max(tool.start, segmentsBySeq.get(tool.seq)?.end ?? tool.end);
  const toolDetail = (tool: ToolFact) => tool.command || tool.path || tool.target || tool.name;

  for (const turn of turns) {
    const fact = factsByTurn.get(turn.index), at = turn.end ?? fact?.end ?? turn.start;
    if (turn.outcome === "failed") add({ kind: "turn_failed", severity: "bad", at, turn: turn.index,
      title: t("serverDigestHighlights.m006", { value1: turn.index }), detail: turn.reply || turn.prompt, value: null, seq: reference(fact?.lastRef ?? fact?.lastSeq) });
    if (turn.outcome === "canceled") add({ kind: "interrupted", severity: "warn", at, turn: turn.index,
      title: t("serverDigestHighlights.m007", { value1: turn.index }), detail: turn.prompt, value: null, seq: reference(fact?.lastRef ?? fact?.lastSeq) });
    if (turn.files >= 8) add({ kind: "many_files", severity: "info", at, turn: turn.index,
      title: t("serverDigestHighlights.m008", { value1: turn.index, value2: turn.files }), detail: turn.prompt, value: turn.files, seq: reference(fact?.seq) });
  }

  // A repaired run replaces its old failure episode, so an eventual pass does not remain a bad signal.
  const orderedChecks = [...checks].sort((a, b) => a.start - b.start || (a.seq ?? 0) - (b.seq ?? 0));
  const failedGroups = new Map<string, DigestCheck[]>();
  const checksByKind = new Map<CheckKind, DigestCheck[]>();
  const checkHighlight = (kind: "check_failed" | "check_fixed", failures: readonly DigestCheck[], last: DigestCheck) => {
    add({ kind, severity: kind === "check_fixed" ? "good" : "bad", at: last.end ?? last.start, turn: last.turn,
      title: t("serverDigestHighlights.m009", { value1: checkNames[last.kind], value2: failures.length, value3: kind === "check_fixed" ? t("serverDigestHighlights.m010") : "" }),
      detail: last.command, value: failures.length, seq: last.seq });
  };
  for (const check of orderedChecks) {
    const kindChecks = checksByKind.get(check.kind) ?? []; kindChecks.push(check); checksByKind.set(check.kind, kindChecks);
    const tool = check.seq === null ? undefined : toolsBySeq.get(check.seq);
    const key = `${check.kind}\0${tool?.program || analyzeCommand(check.command).program}`;
    const failures = failedGroups.get(key) ?? [];
    if (check.ok === false) { failures.push(check); failedGroups.set(key, failures); }
    else if (check.ok === true && failures.length) { checkHighlight("check_fixed", failures, check); failedGroups.delete(key); }
  }
  for (const failures of failedGroups.values()) checkHighlight("check_failed", failures, failures[failures.length - 1]!);
  for (const kind of CHECK_KINDS) {
    const runs = checksByKind.get(kind), last = runs?.at(-1);
    if (last?.ok && !runs!.some(check => check.ok === false)) add({ kind: "check_passed", severity: "good",
      at: last.end ?? last.start, turn: last.turn, title: t("serverDigestHighlights.m011", { value1: checkNames[kind] }), detail: last.command,
      value: runs!.filter(check => check.ok === true).length, seq: last.seq });
  }

  const streakOf = new Map<ToolFact, number>(), repeats = new Map<string, ToolFact[]>();
  let consecutive: ToolFact[] = [], streakIndex = 0;
  const flushStreak = () => {
    if (consecutive.length >= 3) {
      const last = consecutive[consecutive.length - 1]!;
      add({ kind: "fail_streak", severity: "bad", at: toolAt(last), turn: last.turn,
        title: t("serverDigestHighlights.m012", { value1: consecutive.length }), detail: toolDetail(last), value: consecutive.length, seq: last.seq });
      for (const tool of consecutive) streakOf.set(tool, streakIndex);
      streakIndex++;
    }
    consecutive = [];
  };
  for (const tool of tools) {
    if (tool.status === "failed") {
      consecutive.push(tool);
      if (tool.commandKey) { const list = repeats.get(tool.commandKey) ?? []; list.push(tool); repeats.set(tool.commandKey, list); }
    } else flushStreak();
  }
  flushStreak();
  for (const repeated of repeats.values()) if (repeated.length >= 3) {
    // An uninterrupted failed streak already conveys this retry episode.
    const firstStreak = streakOf.get(repeated[0]!);
    if (firstStreak !== undefined && repeated.every(tool => streakOf.get(tool) === firstStreak)) continue;
    const last = repeated[repeated.length - 1]!;
    add({ kind: "fail_streak", severity: "bad", at: toolAt(last), turn: last.turn,
      title: t("serverDigestHighlights.m013", { value1: repeated.length }), detail: toolDetail(last), value: repeated.length, seq: last.seq });
  }

  for (const event of state.events) add({ kind: event.type, severity: event.type === "error" ? "bad" : "info",
    at: event.at, turn: event.turn, title: event.type === "error" ? t("serverDigestHighlights.m014") : t("serverDigestHighlights.m015"),
    detail: event.detail, value: null, seq: event.seq });

  for (const tool of tools.filter(tool => duration(tool) >= 60_000).sort((a, b) => duration(b) - duration(a) || b.seq - a.seq).slice(0, 3)) {
    add({ kind: "slow_tool", severity: "warn", at: toolAt(tool), turn: tool.turn,
      title: tool.lane === "shell" ? t("serverDigestHighlights.m016") : tool.lane === "agent" ? t("serverDigestHighlights.m017") : t("serverDigestHighlights.m018"),
      detail: toolDetail(tool), value: duration(tool), seq: tool.seq });
  }
  for (const segment of segments) {
    const ms = segment.end - segment.start;
    if (segment.lane === "model" && ms >= 180_000) add({ kind: "long_think", severity: "info", at: segment.end,
      turn: segment.turn, title: t("serverDigestHighlights.m019"), detail: t("serverDigestHighlights.m020"), value: ms, seq: segment.seq });
    if (segment.lane === "wait" && ms >= 60_000) add({ kind: "approval_wait", severity: "warn", at: segment.end,
      turn: segment.turn, title: segment.status === "running" ? t("serverDigestHighlights.m021") : t("serverDigestHighlights.m022"), detail: segment.label, value: ms, seq: segment.seq });
  }
  for (const tool of tools.filter(tool => tool.lane === "edit" && tool.added + tool.removed >= 80)
    .sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || b.seq - a.seq).slice(0, 2)) {
    add({ kind: "big_edit", severity: "info", at: toolAt(tool), turn: tool.turn, title: t("serverDigestHighlights.m023"),
      detail: `${tool.path || tool.target || tool.name} +${tool.added} −${tool.removed}`, value: tool.added + tool.removed, seq: tool.seq });
  }
  for (const tool of tools) {
    if (tool.git && tool.status === "ok") add({ kind: "git", severity: "good", at: toolAt(tool), turn: tool.turn,
      title: tool.git, detail: tool.command, value: null, seq: tool.seq });
    if (tool.lane === "agent") add({ kind: "subagent", severity: "info", at: toolAt(tool), turn: tool.turn,
      title: tool.status === "failed" ? t("serverDigestHighlights.m024") : tool.status === "canceled" ? t("serverDigestHighlights.m025") : tool.status === "running" ? t("serverDigestHighlights.m026") : t("serverDigestHighlights.m027"),
      detail: tool.target || tool.name, value: duration(tool), seq: tool.seq });
  }

  if (tokens && turns.length >= 3 && tokenTotal(tokens.totals) > 0) {
    const heavy = [...turns].filter(turn => turn.tokens).sort((a, b) => tokenTotal(b.tokens!) - tokenTotal(a.tokens!) || b.start - a.start)[0];
    if (heavy) {
      const share = Math.min(1, tokenTotal(heavy.tokens!) / tokenTotal(tokens.totals));
      if (share >= 0.35) add({ kind: "token_heavy", severity: "warn", at: heavy.end ?? factsByTurn.get(heavy.index)?.end ?? heavy.start,
        turn: heavy.index, title: t("serverDigestHighlights.m028", { value1: heavy.index, value2: Math.round(share * 100) }), detail: heavy.prompt,
        value: share, seq: reference(factsByTurn.get(heavy.index)?.seq) });
    }
  }
  return result.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.at - a.at || (b.seq ?? -1) - (a.seq ?? -1)).slice(0, 30);
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  checkNames = { test: t("serverDigestHighlights.m001"), typecheck: t("serverDigestHighlights.m002"), lint: t("serverDigestHighlights.m003"), build: t("serverDigestHighlights.m004"), install: t("serverDigestHighlights.m005") };
});
