import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { TOKEN_SOURCES, tokenCountsSchema } from "./tokens";

/**
 * Execution digest (复盘) of one agent. The server folds the agent's canonical timeline (every raw event with its own
 * timestamp, so tool start and end are both known) into turns, an activity chart, where the time went, files, commands,
 * checks and highlights, and attaches token usage from the token ledger. A phone receives a few KB instead of
 * thousands of raw rows, and running agents refresh with a revision (unchanged replies are a few bytes).
 *
 * Times are epoch milliseconds. Turns are numbered from 1 in timeline order. `seq` values are canonical timeline
 * sequence numbers the client can use to jump to the raw row in 时间线.
 */
const count = z.number().int().nonnegative();
const ms = z.number().nonnegative().finite();
const at = z.number().int().nonnegative();
const text = (max: number) => z.string().max(max);

/**
 * Activity lanes. `model` is time inside a turn with no tool running and no approval pending (thinking, writing,
 * preparing the next call). `wait` is a pending permission request.
 */
export const DIGEST_LANES = ["model", "read", "search", "edit", "shell", "web", "agent", "plan", "wait", "other"] as const;
export type DigestLane = typeof DIGEST_LANES[number];
/**
 * When lanes overlap (parallel tool calls), each instant of active time is attributed to the first lane in this
 * order, so `timeShare` adds up to the active time.
 */
export const DIGEST_LANE_PRIORITY: readonly DigestLane[] = ["wait", "shell", "agent", "web", "edit", "search", "read", "plan", "other", "model"];

export const digestSegmentSchema = z.object({
  lane: z.enum(DIGEST_LANES),
  start: at, end: at,
  status: z.enum(["ok", "failed", "running", "canceled"]),
  /** Tool name plus a short target ("Bash · npm test", "Edit · client/kit.tsx"), or "思考" for model time. */
  label: text(80),
  turn: count,
  /** Calls merged into this segment when the chart was thinned (1 = a single call). */
  n: count,
  seq: count.nullable(),
});
export type DigestSegment = z.infer<typeof digestSegmentSchema>;

export const digestTimeShareSchema = z.object(Object.fromEntries(DIGEST_LANES.map(lane => [lane, ms])) as Record<DigestLane, typeof ms>);
export type DigestTimeShare = z.infer<typeof digestTimeShareSchema>;
/** Tool calls per lane (`model` and `wait` are always 0). */
export const digestLaneCountsSchema = z.object(Object.fromEntries(DIGEST_LANES.map(lane => [lane, count])) as Record<DigestLane, typeof count>);
export type DigestLaneCounts = z.infer<typeof digestLaneCountsSchema>;

export const CHECK_KINDS = ["test", "typecheck", "lint", "build", "install"] as const;
export type CheckKind = typeof CHECK_KINDS[number];

export const digestTurnSchema = z.object({
  index: count,
  turnId: text(128).nullable(),
  start: at,
  /** null while the turn is running. */
  end: at.nullable(),
  outcome: z.enum(["completed", "failed", "canceled", "running", "unknown"]),
  /** Excerpts (single line, whitespace collapsed): the user's prompt and the agent's last reply of the turn. */
  prompt: text(200), reply: text(240),
  tools: count, failures: count,
  lanes: digestLaneCountsSchema,
  /** Distinct files edited or written, and lines added / removed. */
  files: count, added: count, removed: count,
  commands: count, checksPassed: count, checksFailed: count,
  /** Time share within the turn (see DIGEST_LANE_PRIORITY). */
  time: digestTimeShareSchema,
  tokens: tokenCountsSchema.nullable(),
});
export type DigestTurn = z.infer<typeof digestTurnSchema>;

export const digestFileSchema = z.object({
  /** Relative to the agent's cwd when inside it. */
  path: text(240),
  reads: count, edits: count, added: count, removed: count,
  lastAt: at,
  /** Turn indexes that touched the file, ascending, at most 20. */
  turns: z.array(count).max(20),
});
export type DigestFile = z.infer<typeof digestFileSchema>;

export const digestCommandSchema = z.object({
  /** First word of the command after env assignments, cd …&&, sudo, timeout, npx and similar wrappers. */
  program: text(40),
  runs: count, failures: count, ms,
  /** One representative command line (most recent). */
  sample: text(120),
});
export type DigestCommand = z.infer<typeof digestCommandSchema>;

export const digestCheckSchema = z.object({
  kind: z.enum(CHECK_KINDS),
  start: at, end: at.nullable(),
  command: text(120),
  /** null while running or when the outcome is unknown. */
  ok: z.boolean().nullable(),
  turn: count,
  seq: count.nullable(),
});
export type DigestCheck = z.infer<typeof digestCheckSchema>;

export const HIGHLIGHT_KINDS = [
  "turn_failed", "interrupted", "check_failed", "check_fixed", "check_passed", "fail_streak", "error",
  "slow_tool", "long_think", "approval_wait", "big_edit", "many_files", "git", "subagent", "compaction", "token_heavy",
] as const;
export type HighlightKind = typeof HIGHLIGHT_KINDS[number];
export const digestHighlightSchema = z.object({
  kind: z.enum(HIGHLIGHT_KINDS),
  severity: z.enum(["good", "info", "warn", "bad"]),
  at, turn: count,
  /** Short Chinese headline ("测试失败 2 次后通过", "最慢的命令", "大改动"). */
  title: text(80),
  /** The subject: a command, file, sub-agent description or error excerpt. */
  detail: text(160),
  /** Kind-specific number (duration ms, lines, failures, tokens …) for the client to format; null when none. */
  value: z.number().finite().nullable(),
  seq: count.nullable(),
});
export type DigestHighlight = z.infer<typeof digestHighlightSchema>;

export const digestSchema = z.object({
  agentId: text(256),
  generatedAt: z.iso.datetime(),
  /** Timeline epoch the `seq` values belong to (the 时间线 jump needs epoch + seq); null without rows. */
  epoch: text(128).nullable(),
  /** First and last folded event; `activeMs` is the summed duration of turns. */
  start: at.nullable(), end: at.nullable(), activeMs: ms,
  running: z.boolean(),
  totals: z.object({
    turns: count, tools: count, failures: count, files: count, added: count, removed: count,
    commands: count, checksPassed: count, checksFailed: count, approvals: count, waitMs: ms,
    errors: count, compactions: count, subagents: count, messages: count,
  }),
  timeShare: digestTimeShareSchema,
  /** Oldest first; the most recent 60 turns when there are more (see coverage). */
  turns: z.array(digestTurnSchema).max(60),
  /** Time-ordered, at most 800 (adjacent same-lane calls are merged when there are more; see `n`). */
  segments: z.array(digestSegmentSchema).max(800),
  /** By edits + reads, at most 40. */
  files: z.array(digestFileSchema).max(40),
  /** By runs, at most 20. */
  commands: z.array(digestCommandSchema).max(20),
  /** In time order, at most 80. */
  checks: z.array(digestCheckSchema).max(80),
  /** Most important first (bad → warn → good → info, then recency), at most 30. */
  highlights: z.array(digestHighlightSchema).max(30),
  /** From the token ledger when the agent's provider session was found in the local logs. */
  tokens: z.object({
    source: z.enum(TOKEN_SOURCES),
    totals: tokenCountsSchema,
    /** Per call, oldest first, thinned evenly to at most 400: end time, output, all input read, speed (tok/s) or null. */
    calls: z.array(z.tuple([at, count, count, z.number().nonnegative().finite().nullable()])).max(400),
  }).nullable(),
  coverage: z.object({
    /** Canonical rows folded, and whether older history was left out (only the newest rows are read). */
    rows: count, truncated: z.boolean(),
  }),
});
export type Digest = z.infer<typeof digestSchema>;

const revision = z.string().min(1).max(80);
export const digestResponseSchema = z.discriminatedUnion("mode", [
  digestSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);
export type DigestResponse = z.infer<typeof digestResponseSchema>;
export const getDigest = defineRpc({
  name: "observatory.digest.get",
  input: z.object({ agentId: z.string().min(1).max(256), revision: revision.optional() }),
  output: digestResponseSchema,
});
export type DigestState = Digest & { revision?: string };
export function mergeDigest(previous: DigestState | undefined, response: DigestResponse): DigestState {
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...digest } = response; return { ...digest, revision: response.revision }; }
  if (!previous) throw new Error(t("sharedDigest.m001"));
  return previous;
}
