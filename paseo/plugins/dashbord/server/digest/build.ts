import { digestSchema, type Digest } from "../../shared/digest";
import { buildActivity, thinSegments, type ActivityOptions } from "./activity";
import { buildAggregates } from "./aggregates";
import { buildHighlights } from "./highlights";
import { emptyLanes, excerpt, type FoldState } from "./model";
import { attachTokens, sampleEvenly, type TokenHistory } from "./tokens";

// Reserve room for mode/unchanged/revision. UTF-8 bytes (not JS string length) matter on the relay.
export const MAX_DIGEST_BYTES = 59_000;
const bytes = (digest: Digest) => Buffer.byteLength(JSON.stringify(digest), "utf8");

/** Thin only presentation detail; totals and per-turn time/counts remain from the entire folded window. */
export function boundPayload(digest: Digest): Digest {
  if (bytes(digest) <= MAX_DIGEST_BYTES) return digest;
  digest.turns = digest.turns.map(turn => ({ ...turn, prompt: excerpt(turn.prompt, 80), reply: excerpt(turn.reply, 100) }));
  if (Buffer.byteLength(JSON.stringify(digest.turns)) > MAX_DIGEST_BYTES / 2) {
    digest.turns = digest.turns.map(turn => ({ ...turn, prompt: excerpt(turn.prompt, 40), reply: excerpt(turn.reply, 60) }));
  }
  // Reduce whichever optional section currently dominates. Keep files/commands intact within each retained entry.
  while (bytes(digest) > MAX_DIGEST_BYTES) {
    const lists = [digest.segments, digest.tokens?.calls ?? [], digest.checks, digest.files, digest.highlights, digest.commands];
    const candidates = lists.map((list, index) => ({ index, size: list.length ? Buffer.byteLength(JSON.stringify(list)) : 0 }))
      .sort((a, b) => b.size - a.size);
    const largest = candidates[0]!; if (largest.size === 0) break;
    const target = Math.floor(lists[largest.index]!.length / 2);
    switch (largest.index) {
      case 0: digest.segments = thinSegments(digest.segments, target); break;
      case 1: if (digest.tokens) digest.tokens.calls = sampleEvenly(digest.tokens.calls, target); break;
      case 2: digest.checks = target ? digest.checks.slice(-target) : []; break;
      case 3: digest.files = digest.files.slice(0, target); break;
      case 4: digest.highlights = digest.highlights.slice(0, target); break;
      case 5: digest.commands = digest.commands.slice(0, target); break;
    }
  }
  // A pathological all-Unicode history can fill the budget with fixed-schema turn cards alone.
  // Coverage is explicit when the displayed history must be shortened beyond the normal 60-turn window.
  while (bytes(digest) > MAX_DIGEST_BYTES && digest.turns.length > 1) {
    digest.turns.shift(); digest.coverage.truncated = true;
    const first = digest.turns[0]!.index;
    digest.segments = digest.segments.filter(segment => segment.turn >= first);
  }
  return digest;
}

export function buildDigest(state: FoldState, options: ActivityOptions, history: TokenHistory = null): Digest {
  const activity = buildActivity(state, options), { turns } = activity;
  const aggregates = buildAggregates(state, turns, options.now), tokens = attachTokens(turns, history, options.now);
  const highlights = buildHighlights(state, turns, activity.segments, aggregates.checks, tokens);
  const timeShare = emptyLanes();
  for (const turn of turns) for (const lane of Object.keys(timeShare) as (keyof typeof timeShare)[]) timeShare[lane] += turn.time[lane];
  const sum = (key: "tools" | "failures" | "added" | "removed" | "commands" | "checksPassed" | "checksFailed") => turns.reduce((total, turn) => total + turn[key], 0);
  const shown = turns.slice(-60), first = shown[0]?.index ?? 0;
  const digest: Digest = { agentId: state.agentId, generatedAt: new Date(options.now).toISOString(), epoch: state.rows ? state.epoch : null,
    start: turns.length ? Math.min(...turns.map(turn => turn.start)) : null,
    end: turns.length ? Math.max(...turns.map(turn => turn.end ?? Math.max(turn.start, options.now))) : null,
    activeMs: Object.values(timeShare).reduce((a, b) => a + b, 0), running: turns.some(turn => turn.outcome === "running"),
    totals: { turns: turns.length, tools: sum("tools"), failures: sum("failures"), files: aggregates.editedFiles, added: sum("added"), removed: sum("removed"),
      commands: sum("commands"), checksPassed: sum("checksPassed"), checksFailed: sum("checksFailed"), approvals: activity.approvals, waitMs: timeShare.wait,
      errors: state.events.filter(event => event.type === "error").length, compactions: state.events.filter(event => event.type === "compaction").length,
      subagents: [...state.tools.values()].filter(tool => tool.lane === "agent").length, messages: state.turns.reduce((sum, turn) => sum + turn.messages, 0) },
    timeShare, turns: shown, segments: thinSegments(activity.segments.filter(segment => segment.turn >= first)),
    files: aggregates.files.slice(0, 40), commands: aggregates.commands.slice(0, 20), checks: aggregates.checks.slice(-80), highlights, tokens,
    coverage: { rows: state.rows, truncated: state.truncated || turns.length > 60 } };
  return digestSchema.parse(boundPayload(digest));
}
