import { onTextChange } from "./i18n";
import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const restoreFields = {
  agentId: z.string(), workspaceId: z.string().nullable(), workspaceRestored: z.boolean(),
  workspaceAction: z.enum(["unarchive", "restore"]).nullable(), message: z.string(),
};
/** How a restore ended. */
export const restoreOutcomeSchema = z.object({ status: z.enum(["restored", "already_active", "needs_native", "failed"]), ...restoreFields });
export type RestoreOutcome = z.infer<typeof restoreOutcomeSchema>;
/**
 * What 恢复会话 answers: an outcome, or `pending` while the restore goes on on the server (rebuilding a worktree and reopening
 * the session can take minutes; the host gives a plugin RPC 30 s). While pending, `message` is the current step and
 * `restoreSessionStatus` reads the restore by `jobId` (absent in an answer that has none, such as the preview's).
 */
export const restoreSessionResultSchema = z.object({ status: z.enum(["pending", "restored", "already_active", "needs_native", "failed"]), ...restoreFields, jobId: z.string().nullable().default(null) });
export type RestoreSessionResult = z.infer<typeof restoreSessionResultSchema>;
/** Starts restoring an archived session, or joins the restore already running for it; answers within a few seconds. */
export const restoreSession = defineRpc({
  name: "observatory.history.restore", input: z.object({ agentId: z.string().min(1).max(512) }),
  output: restoreSessionResultSchema,
});
/** A restore by `jobId`; null once the server no longer knows it (the plugin reloaded, or it ended more than ten minutes ago). */
export const restoreSessionStatus = defineRpc({
  name: "observatory.history.restore.status", input: z.object({ jobId: z.string().min(1).max(100) }),
  output: restoreSessionResultSchema.nullable(),
});

/** After a host timeout or a dropped connection the restore may well go on: say so, never show the host's English. */
export let RESTORE_STILL_RUNNING = t("sharedHistory.m001");
let RESTORE_DISCONNECTED = t("sharedHistory.m002");
let RESTORE_RELOADING = t("sharedHistory.m003");
const errorText = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "").trim();
const timedOut = (message: string) => /timed? ?out|timeout|宿主未响应/i.test(message); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
const disconnected = (message: string) => /not connected|disconnect|client (?:is )?closed|connection (?:closed|lost|reset)|socket|Plugin stopped/i.test(message);
/** The host answering for the plugin while it reloads: it is not loaded, or not yet with its RPCs (plugins/runtime.js invoke). */
const pluginGone = (message: string) => /Plugin is not available|does not contribute RPC/i.test(message);
/** A restore failure for the user, in Chinese; other English host text is quoted behind a Chinese lead. */
export function restoreFailureText(error: unknown): string {
  const message = errorText(error);
  if (timedOut(message)) return RESTORE_STILL_RUNNING;
  if (disconnected(message)) return RESTORE_DISCONNECTED;
  if (pluginGone(message)) return RESTORE_RELOADING;
  if (!message) return t("sharedHistory.m004");
  return /[\u3400-\u9fff]/.test(message) ? message.replaceAll(t("sharedHistory.m005"), t("sharedHistory.m006")) : t("sharedHistory.m007", { value1: message.slice(0, 300) });
}

/** The client's side of a restore (client/use-restore.ts supplies the RPCs and the foreground-aware wait). */
export interface RestoreFlow {
  agentId: string;
  start(): Promise<RestoreSessionResult>;
  status(jobId: string): Promise<RestoreSessionResult | null>;
  /** Waits before the next read; false stops following (the view went away). */
  wait(ms: number): Promise<boolean>;
  /** Read-only: whether the session is still archived (null: unknown); asked only once the server has lost the restore. */
  archived?(): Promise<boolean | null>;
  onProgress?(message: string): void;
  now?(): number;
}
export const RESTORE_POLL_MS = 2500;
/** Following ends after this long; the restore itself goes on and the list shows the session once it is unarchived. */
const RESTORE_FOLLOW_MS = 10 * 60_000;
/**
 * Starts (or joins) a restore and reads it every 2.5 s until it ends. Never rejects: a host timeout or a lost connection
 * comes back as `pending` with RESTORE_STILL_RUNNING (the restore may be running), any other error as a Chinese `failed`. The
 * plugin reloading under a read (`Plugin is not available`, `does not contribute RPC`) is the server losing the restore: the
 * session's own archived state tells how it ended.
 */
export async function followRestore(flow: RestoreFlow): Promise<RestoreSessionResult> {
  const now = flow.now ?? Date.now, started = now();
  const base: RestoreSessionResult = { status: "pending", agentId: flow.agentId, workspaceId: null, workspaceRestored: false, workspaceAction: null, message: RESTORE_STILL_RUNNING, jobId: null };
  const still = (view: RestoreSessionResult = base): RestoreSessionResult => ({ ...view, status: "pending", message: RESTORE_STILL_RUNNING });
  const failed = (error: unknown, view: RestoreSessionResult = base): RestoreSessionResult => {
    const message = errorText(error);
    return timedOut(message) || disconnected(message) ? { ...still(view), message: restoreFailureText(error) } : { ...view, status: "failed", message: restoreFailureText(error) };
  };
  let view: RestoreSessionResult;
  try { view = await flow.start(); } catch (error) { return failed(error); }
  for (let misses = 0; view.status === "pending";) {
    if (!view.jobId) return still(view);
    flow.onProgress?.(view.message);
    if (!(await flow.wait(RESTORE_POLL_MS))) return still(view);
    let next: RestoreSessionResult | null;
    try { next = await flow.status(view.jobId); misses = 0; }
    catch (error) {
      const message = errorText(error);
      // The plugin reloading under the poll: its restore went with the old process, as when the server no longer knows the job.
      if (pluginGone(message)) next = null;
      // A slow host or a reconnect: read again, up to three times in a row.
      else if ((timedOut(message) || disconnected(message)) && ++misses < 3) continue;
      else return failed(error, view);
    }
    if (!next) {
      // The server lost the restore (the plugin reloaded, or the answer expired): the session itself tells how it ended.
      const archived = await flow.archived?.().catch(() => null);
      if (archived === false) return { ...view, status: "already_active", message: t("sharedHistory.m008") };
      if (archived === true) return { ...view, status: "failed", message: t("sharedHistory.m009") };
      return still(view);
    }
    view = next;
    if (view.status === "pending" && now() - started >= RESTORE_FOLLOW_MS) return still(view);
  }
  return view;
}

export const sessionEvidenceSchema = z.object({
  agentId: z.string(), turns: z.number(), tools: z.number(), toolFailures: z.number(), errors: z.number(),
  firstTimelineAt: z.string().nullable(), lastTimelineAt: z.string().nullable(), sampleSize: z.number(),
  complete: z.boolean(), hasOlder: z.boolean(), coverageReason: z.string().nullable(),
  completionEvidence: z.object({ kind: z.enum(["attention_finished", "none"]), at: z.string().nullable() }),
});
export type SessionEvidence = z.infer<typeof sessionEvidenceSchema>;
export const getSessionEvidence = defineRpc({
  name: "observatory.history.evidence", input: z.object({ agentId: z.string().min(1).max(512) }),
  output: sessionEvidenceSchema,
});

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  RESTORE_STILL_RUNNING = t("sharedHistory.m001");
  RESTORE_DISCONNECTED = t("sharedHistory.m002");
  RESTORE_RELOADING = t("sharedHistory.m003");
});
