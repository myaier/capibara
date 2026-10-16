import { onTextChange } from "./i18n";
import { t } from "./text";
/**
 * 就地审批 (opus-B12): a permission request as the host gives it (`agent.pendingPermissions[]`, Paseo 0.11.1), reduced to what
 * the approval panel shows, and the exact `respondToPermission` answer for each choice. Pure apart from `answerPermission`,
 * which drives an Agent handle the caller passes in.
 *
 * What the providers send (daemon 0.11.1, `agent/providers/*`):
 * - Claude (`claude/agent.js` handlePermissionRequest): tool requests carry no `actions`, only the tool's `input`, a mapped
 *   `detail` and Claude's own rule `suggestions`. Allow passes the input through; deny honours `interrupt`. ExitPlanMode is a
 *   `plan` with Reject / Implement actions, AskUserQuestion a `question`.
 * - Codex (`codex-app-server-agent.js`): commands, file changes and MCP approvals are `tool` requests without actions; allow is
 *   "accept", deny "decline", deny with `interrupt` "cancel". Plans and request_user_input questions are their own kinds.
 * - ACP providers (`acp-agent.js` mapPermissionRequest): every option the agent offers becomes an action with its own label,
 *   and `metadata.options` keeps each option's ACP `kind` (allow_once, allow_always, reject_once, reject_always). A plain
 *   allow / deny without `selectedActionId` makes the daemon pick the first allow_once, else allow_always: a lasting choice,
 *   so actions are always answered by id here. Deny with `interrupt` also cancels the turn. `switch_mode` is a `mode` request.
 * - OpenCode (`opencode-agent.js`, `opencode/v2/permissions.js`): Allow once / Allow always / Deny, ids allow_once /
 *   allow_always / deny (v2: once / always / reject). `interrupt` is ignored.
 * - omp (`omp/rpc-ui-permission-mapper.js`): Approve / Deny; `interrupt` is ignored. Pi's dialogs are all questions.
 * So only tool requests, and mode switches that come with their choices, are answered here; the rest open the conversation.
 */

export type PermissionKind = "tool" | "plan" | "question" | "mode" | "other";
/** What `respondToPermission({ requestId, response })` takes (a subset of the protocol's AgentPermissionResponse). */
export type PermissionResponse =
  | { behavior: "allow"; selectedActionId?: string }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };

export interface PermissionChoice {
  /** `action:<id>` for the provider's actions; `allow`, `deny` and `deny-interrupt` for ours. */
  key: string;
  /** The provider's own label, unchanged; ours (批准 / 拒绝 / 拒绝并中断) only where it gave none. */
  label: string;
  behavior: "allow" | "deny";
  /** It changes what the Agent may do beyond this one request (always allow, allow for the session, always reject). */
  lasting: boolean;
  interrupt: boolean;
  fromProvider: boolean;
  response: PermissionResponse;
}

/** The parts of a request the panel shows whole once expanded (codex-obs-send-ui-F1). */
export type PermissionPart = "command" | "target" | "args" | "params" | "cwd" | "description";
export interface PermissionView {
  id: string;
  kind: PermissionKind;
  /** Answered in place: a tool call, or a mode switch whose provider lists its choices. */
  inline: boolean;
  provider: string | null;
  title: string;
  /** The tool's own name when the title says something else (Bash, CodexFileChange). */
  tool: string | null;
  description: string | null;
  /** The shell command, in full. */
  command: string | null;
  /** The file, URL, search or pattern the tool works on. */
  target: string | null;
  /** Everything else it was given, as `name: value` lines (or the diff, content or text the provider showed). */
  args: string | null;
  /** With the provider's own text in `args`: the parameters it leaves out (an edit's `replace_all`), as `name: value` lines. */
  params: string | null;
  cwd: string | null;
  /** The request named no directory: `cwd` is the Agent's own. */
  cwdIsAgent: boolean;
  /**
   * Parts longer than PERMISSION_TEXT_LIMIT: only the first `kept` of their `total` characters are here. For a list of parameters,
   * `items` says how many it has and how many of them are here whole (codex-obs-send-ui-F1).
   */
  cut: Partial<Record<PermissionPart, { kept: number; total: number; items?: { total: number; whole: number } }>>;
  /** Characters the host itself dropped from the diff it sent (its `...[truncated N chars]` mark), or null. */
  hostCut: number | null;
  choices: PermissionChoice[];
}

/** Sent with a denial so the Agent (and the conversation) can tell who said no. */
export let DENY_MESSAGE = t("sharedPermissions.m001");
/** Providers whose answer ignores `interrupt` (OpenCode, omp): 拒绝并中断 is not offered for them. */
const NO_INTERRUPT: ReadonlySet<string> = new Set(["opencode", "omp"]);
/**
 * Characters kept of each part of a request (the command, the target, the working directory, the description, and the
 * parameters altogether, however many): the panel shows them whole once expanded, and says where a longer one was cut. The
 * panel only shortens them on screen while collapsed (codex-obs-send-ui-F1): approving a request means approving all of it,
 * so no parameter is ever left out without saying so.
 */
export const PERMISSION_TEXT_LIMIT = 64 * 1024;

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const line = (value: unknown, max = 240): string | null => { const found = text(value, max * 2); return found ? found.replace(/\s+/g, " ").slice(0, max) : null; };
/** A string part as given (trimmed), whole: the limit is applied where the view is built, which records the cut. */
const whole = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
/** `value` cut to `max` characters, never inside a surrogate pair. */
const cutAt = (value: string, max: number) => value.length <= max ? value : value.slice(0, /[\ud800-\udbff]/.test(value[max - 1] ?? "") ? max - 1 : max);

/** Ids and labels that make a choice outlast this request. ACP's own option kind decides first when the request carries it. */
const LASTING_ID = /always|forever|permanent|session|remember|(allow|accept|approve|reject|deny)[_-]?all/i;
const LASTING_LABEL = /\b(always|forever|permanently|remember|for (this|the) (session|project|workspace|repo|repository|directory|folder|conversation|chat)|this session|all sessions|don'?t ask( again)?|do not ask|never ask|from now on|every time|auto[- ]?approve)\b|总是|始终|永远|一直|以后|每次|不再(询问|提示|问)|记住|本会话|会话内|此会话|这个会话|整个会话|自动(批准|允许)/i; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
export function isLastingAction(action: { id: string; label?: string | null }, acpKind?: string | null): boolean {
  return /_always$/i.test(acpKind ?? "") || LASTING_ID.test(action.id) || LASTING_LABEL.test(action.label ?? "");
}

/** The provider's actions, in its order: an id, a label and allow or deny each; anything else is dropped. */
function providerActions(request: Record<string, unknown>) {
  const kinds = new Map((Array.isArray(object(request.metadata).options) ? object(request.metadata).options as unknown[] : []).map(object)
    .filter(option => typeof option.optionId === "string").map(option => [option.optionId as string, typeof option.kind === "string" ? option.kind : null]));
  return (Array.isArray(request.actions) ? request.actions : []).map(object)
    .filter(action => typeof action.id === "string" && action.id.length > 0 && action.id.length <= 200 && (action.behavior === "allow" || action.behavior === "deny"))
    .map(action => ({ id: action.id as string, label: line(action.label, 60) ?? (action.id as string).slice(0, 60), behavior: action.behavior as "allow" | "deny", acpKind: kinds.get(action.id as string) ?? null }));
}

/**
 * The choices for one request, ready to show: the provider's own actions answered by id, else 批准 / 拒绝; plus 拒绝并中断
 * where the provider honours it. Plain allows come first (the usual answer, nearest the thumb), then denials, then lasting
 * choices, then 拒绝并中断.
 */
export function permissionChoices(value: unknown): PermissionChoice[] {
  const request = object(value), provider = text(request.provider, 64);
  const actions = providerActions(request);
  const interruptible = !provider || !NO_INTERRUPT.has(provider);
  const choices: PermissionChoice[] = actions.length
    ? actions.map(action => ({ key: `action:${action.id}`, label: action.label, behavior: action.behavior, lasting: isLastingAction(action, action.acpKind), interrupt: false, fromProvider: true,
      response: action.behavior === "allow" ? { behavior: "allow" as const, selectedActionId: action.id } : { behavior: "deny" as const, selectedActionId: action.id } }))
    : [{ key: "allow", label: t("sharedPermissions.m002"), behavior: "allow", lasting: false, interrupt: false, fromProvider: false, response: { behavior: "allow" } },
      { key: "deny", label: t("sharedPermissions.m003"), behavior: "deny", lasting: false, interrupt: false, fromProvider: false, response: { behavior: "deny", message: DENY_MESSAGE } }];
  // With actions, the denial is named by id: unnamed, an ACP daemon could pick a lasting reject_always.
  const onceDeny = actions.find(action => action.behavior === "deny" && !isLastingAction(action, action.acpKind));
  if (interruptible && (onceDeny || !actions.some(action => action.behavior === "deny"))) {
    choices.push({ key: "deny-interrupt", label: t("sharedPermissions.m004"), behavior: "deny", lasting: false, interrupt: true, fromProvider: false,
      response: { behavior: "deny", interrupt: true, message: DENY_MESSAGE, ...(onceDeny ? { selectedActionId: onceDeny.id } : {}) } });
  }
  const rank = (choice: PermissionChoice) => choice.interrupt ? 3 : choice.lasting ? 2 : choice.behavior === "allow" ? 0 : 1;
  return choices.map((choice, index) => ({ choice, index })).sort((a, b) => rank(a.choice) - rank(b.choice) || a.index - b.index).map(({ choice }) => choice);
}

/** Input keys naming what the panel shows on a line of its own: left out of the parameters only when they hold that very value. */
const SHOWN_AS: Readonly<Record<string, "command" | "target" | "cwd" | "description">> = {
  command: "command", cmd: "command", file_path: "target", filePath: "target", path: "target", url: "target", query: "target", pattern: "target",
  cwd: "cwd", workdir: "cwd", working_directory: "cwd", description: "description" };
/** Input keys whose content an edit's diff or a write's content (the provider's own text) already shows in full. */
const BODY_KEYS: Readonly<Record<string, readonly string[]>> = {
  edit: ["old_string", "new_string", "oldString", "newString", "patch", "diff", "unified_diff", "unifiedDiff"],
  write: ["content", "file_text", "newContent", "new_content"] };
/** The mark the host puts at the end of a diff it cut (`truncateDiffText`, daemon 0.11.1). */
const HOST_DIFF_CUT = /\n\.\.\.\[truncated (\d+) chars\]$/;
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}
/**
 * `name: value` lines, each value whole, all of them in the order given (the view bounds the total and says where it cut).
 * `ends`: where each parameter's text ends, so a cut counts the parameters it keeps whole by offset: a value may hold line
 * breaks of its own, so lines are not parameters (codex-obs-send-ui-R1).
 */
function paramLines(entries: ReadonlyArray<readonly [string, unknown]>): { text: string; ends: number[] } | null {
  const lines = entries.filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `${key}: ${valueText(value)}`);
  if (!lines.length) return null;
  const ends: number[] = [];
  let at = -1;
  for (const line of lines) { at += 1 + line.length; ends.push(at); }
  return { text: lines.join("\n"), ends };
}
const inputLines = (entries: ReadonlyArray<readonly [string, unknown]>): string | null => paramLines(entries)?.text ?? null;

/**
 * One pending request as the panel shows it; null without an id (it could not be answered). Every part is kept whole up to
 * PERMISSION_TEXT_LIMIT (`cut` says where a longer one stops), so 展开完整内容 shows what is being approved (codex-obs-send-ui-F1).
 * A parameter is left out of `args` / `params` only when the panel shows its very value elsewhere: a Grep's `path` beside its
 * pattern, a WebSearch's `query` as its target, an edit's `replace_all` beside its diff all stay visible.
 */
export function permissionView(value: unknown, agentCwd?: string | null): PermissionView | null {
  const request = object(value), id = text(request.id, 256);
  if (!id) return null;
  const kind: PermissionKind = ["tool", "plan", "question", "mode", "other"].includes(String(request.kind)) ? request.kind as PermissionKind : "other";
  const input = object(request.input), detail = object(request.detail), type = String(detail.type ?? "");
  const actions = providerActions(request);
  const name = line(request.name, 80), title = line(request.title, 200) ?? name ?? (kind === "mode" ? t("sharedPermissions.m005") : t("sharedPermissions.m006"));
  // What the panel shows on lines of its own; a search, glob or grep without a mapped detail is known by its query or pattern.
  const own = {
    command: type === "shell" ? whole(detail.command) : whole(input.command) ?? whole(input.cmd),
    target: whole(detail.filePath) ?? whole(detail.url) ?? whole(detail.query) ?? whole(input.file_path) ?? whole(input.filePath) ?? whole(input.path) ?? whole(input.url) ?? whole(input.query) ?? whole(input.pattern),
    cwd: whole(detail.cwd) ?? whole(input.cwd) ?? whole(input.workdir) ?? whole(input.working_directory),
    description: whole(request.description),
  };
  // The provider's own text: a diff (maybe cut by the host itself), a file's content, a chooser's text.
  const diff = type === "edit" ? whole(detail.unifiedDiff) : null, hostCut = diff ? Number(HOST_DIFF_CUT.exec(diff)?.[1] ?? NaN) : NaN;
  const body = type === "edit" ? diff ?? inputLines([["oldString", detail.oldString], ["newString", detail.newString]])
    : type === "write" ? whole(detail.content) : type === "plain_text" ? whole(detail.text) : null;
  // Everything else it was given. Where the host cut the diff, the input's own old and new text are what is left to read.
  const covered = new Set(body && !Number.isFinite(hostCut) ? BODY_KEYS[type] ?? [] : []);
  const rest = paramLines(Object.entries(input).filter(([key, item]) => !covered.has(key) && !(SHOWN_AS[key] && typeof item === "string" && item.trim() === own[SHOWN_AS[key]!])));
  const list = body ? null : rest ?? (type === "unknown" ? paramLines(Object.entries(object(detail.input))) : null);
  const cut: PermissionView["cut"] = {};
  /** A part whole up to the limit; a longer one is cut there and says so, a list of parameters (`ends`) how many are whole. */
  const fit = (part: PermissionPart, full: string | null, ends?: readonly number[]): string | null => {
    if (!full || full.length <= PERMISSION_TEXT_LIMIT) return full;
    const kept = cutAt(full, PERMISSION_TEXT_LIMIT);
    cut[part] = { kept: kept.length, total: full.length, ...(ends?.length ? { items: { total: ends.length, whole: ends.filter(end => end <= kept.length).length } } : {}) };
    return kept;
  };
  const agentDirectory = whole(agentCwd);
  return {
    id, kind, inline: kind === "tool" || kind === "mode" && actions.length > 0, provider: text(request.provider, 64), title,
    tool: name && name !== title ? name : null, description: fit("description", own.description),
    command: fit("command", own.command), target: fit("target", own.target),
    args: fit("args", body ?? list?.text ?? null, list?.ends), params: fit("params", body ? rest?.text ?? null : null, rest?.ends),
    cwd: fit("cwd", own.cwd ?? agentDirectory), cwdIsAgent: !own.cwd && !!agentDirectory,
    cut, hostCut: Number.isFinite(hostCut) ? hostCut : null,
    choices: permissionChoices(request),
  };
}

/** Where a request stands in an Agent snapshot (`refresh()`'s result): waiting, answered (or the Agent archived or gone), or unreadable. */
export function requestState(snapshot: unknown, requestId: string): "pending" | "gone" | "unknown" {
  // `refresh()` resolves null for an Agent the host no longer knows; a failed read is passed on as undefined.
  if (snapshot === null || object(snapshot).agent === null) return "gone";
  const agent = object(object(snapshot).agent);
  if (!Object.keys(agent).length) return "unknown";
  if (agent.archivedAt) return "gone";
  if (!Array.isArray(agent.pendingPermissions)) return "unknown";
  return agent.pendingPermissions.some(request => object(request).id === requestId) ? "pending" : "gone";
}
const running = (snapshot: unknown) => ["running", "initializing"].includes(String(object(object(snapshot).agent).status));

export interface PermissionHandle {
  refresh(): Promise<unknown>;
  respondToPermission(options: { requestId: string; response: PermissionResponse }): Promise<void>;
}
export type AnswerOutcome =
  /** The host dropped the request after our answer; `stillRunning` after 拒绝并中断 means the turn went on regardless. */
  | { kind: "answered"; stillRunning: boolean }
  /** It was no longer waiting when we looked: answered on another device, or the Agent moved on. */
  | { kind: "elsewhere" }
  /** Sent, but the request still waits: the host has not confirmed it (respondToPermission has no receipt). */
  | { kind: "unconfirmed" }
  /** The Agent's state could not be read, so nothing was sent. */
  | { kind: "unknown" };
/** How long the host gets to drop an answered request: about 6 seconds in all. */
export const CONFIRM_DELAYS: readonly number[] = [250, 500, 750, 1000, 1500, 2000];

/**
 * Answers one request exactly as chosen, reading the Agent before and after: `refresh()` only reads, it never loads the
 * Agent. Nothing is sent unless the request is still waiting right now.
 */
export async function answerPermission(handle: PermissionHandle, requestId: string, choice: Pick<PermissionChoice, "response" | "interrupt">,
  options: { delays?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {}): Promise<AnswerOutcome> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const before = requestState(await handle.refresh(), requestId);
  if (before === "gone") return { kind: "elsewhere" };
  if (before === "unknown") return { kind: "unknown" };
  await handle.respondToPermission({ requestId, response: choice.response });
  let answered = false;
  for (const delay of options.delays ?? CONFIRM_DELAYS) {
    await sleep(delay);
    const after = await handle.refresh().catch(() => undefined);
    if (requestState(after, requestId) !== "gone") continue;
    answered = true;
    // 拒绝并中断: wait out the turn's cancellation too, so a provider that ignored it is reported honestly.
    if (!choice.interrupt || !running(after)) return { kind: "answered", stillRunning: false };
  }
  return answered ? { kind: "answered", stillRunning: true } : { kind: "unconfirmed" };
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  DENY_MESSAGE = t("sharedPermissions.m001");
});
