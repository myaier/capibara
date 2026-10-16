import type { PaseoApi } from "./paseo-types";
import { finalReplyAfter, replyAsksUser, replyNudge, type ReplyNudge } from "../shared/reply";
import { normalizeTimelinePage, projectTimelineRows } from "../shared/timeline";
import { quotaNotice, tailStop, type StopReason } from "../shared/stop-reason";
import { findChangeRequest } from "../shared/change-request";
import type { ChangeRequestLink } from "../shared/telemetry";
import type { StatsDirectory } from "./stats-directory";
import type { TelemetryStore } from "./telemetry";

export interface ReplyCheckOptions {
  now?: () => number; perRun?: number; intervalMs?: number; retryMs?: number;
  /**
   * The zone a reset clock time without one is read in (grok-F2): the devices' (DeviceZone.current()). Without it, or when it
   * returns nothing, the plugin process's own zone, which on a daemon is often UTC. Either way such a reset is marked a guess.
   */
  zone?: () => string | null | undefined;
}
/** What a backfilled reply leaves: when, whether it asks the user, its MR / PR link and its 快捷回复 category (never text). */
export interface BackfilledReply { at: string; asks: boolean; link?: ChangeRequestLink | null; nudge?: ReplyNudge | null }
/** The telemetry calls the check makes (a method signature, so the store's own narrower reply type still fits). */
export interface ReplyCheckTelemetry extends Pick<TelemetryStore, "needsReplyCheck"> {
  recordReply(agentId: string, userAt: string, reply: BackfilledReply | null, stop?: StopReason | null): Promise<void>;
}
const processZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };

/**
 * Reads the final reply of stopped Agents whose last turn the hooks never saw end (a queued follow-up, a plugin reload)
 * or that predate 待回复, a few per minute, each turn once. The live path is the turn-end hook; this only fills gaps.
 */
export function createReplyCheck(telemetry: ReplyCheckTelemetry, directory: Pick<StatsDirectory, "agents" | "loaded" | "refresh">, options: ReplyCheckOptions = {}) {
  const now = options.now ?? Date.now, perRun = options.perRun ?? 6, interval = options.intervalMs ?? 60_000, retry = options.retryMs ?? 10 * 60_000;
  // A timeline that cannot be read is retried later instead of holding up the rest of the queue.
  const failedUntil = new Map<string, number>();
  let running = false, closed = false, last = -Infinity;

  async function run(paseo: PaseoApi): Promise<void> {
    await directory.refresh(paseo);
    if (closed || !directory.loaded) return;
    const due: Array<{ id: string; userAt: string; updatedAt: string | null }> = [];
    for (const agent of directory.agents) {
      if (due.length >= perRun) break;
      const userAt = agent.lastUserMessageAt;
      if (!userAt || agent.archivedAt || agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions > 0) continue;
      if ((failedUntil.get(agent.id) ?? -Infinity) > now()) continue;
      if (await telemetry.needsReplyCheck(agent.id, userAt, agent.updatedAt)) due.push({ id: agent.id, userAt, updatedAt: agent.updatedAt ?? null });
    }
    // One zone for the whole pass: the devices' when known.
    const zone = options.zone?.() || processZone();
    for (const agent of due) {
      if (closed) return;
      try {
        const page = normalizeTimelinePage(await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 40, projection: "projected" }));
        const user = Date.parse(agent.userAt), updated = Date.parse(agent.updatedAt ?? "");
        const rows = projectTimelineRows(page.rows), reply = finalReplyAfter(rows, user);
        // Rows of a session loaded from disk carry the load time; the Agent's own last update bounds when its turn really ended.
        const at = reply ? new Date(Math.min(Date.parse(reply.at), Number.isFinite(updated) && updated >= user ? updated : Infinity)).toISOString() : null;
        // Why it stopped, when the hooks missed it: a limit notice as the reply, or no closing reply (after tool calls, or nothing).
        const stamp = at ?? new Date(Math.max(user, Number.isFinite(updated) ? updated : user)).toISOString();
        // "resets 5am" / "try again in 2 hours" count from when the reply was written, not from this (possibly much later) read.
        const written = Date.parse(stamp);
        const quota = reply ? quotaNotice(reply.text, "reply", written, zone) : null;
        const stop: StopReason | null = quota ? { kind: "quota", ...quota, at: stamp } : reply ? null : (() => { const found = tailStop(rows, user, written, zone); return found ? { ...found, at: stamp } : null; })();
        // A limit notice asks nothing and invites no quick reply; anything else gets its 快捷回复 category (opus-B26).
        await telemetry.recordReply(agent.id, agent.userAt, reply && at ? { at, asks: quota ? false : replyAsksUser(reply.text), link: findChangeRequest(reply.text), nudge: quota ? null : replyNudge(reply.text) } : null, stop);
        failedUntil.delete(agent.id);
      } catch {
        failedUntil.set(agent.id, now() + retry);
      }
    }
  }

  return {
    /** Called from polled reads; runs at most once per interval and never overlaps itself. */
    refresh(paseo: PaseoApi): Promise<void> {
      if (closed || running || now() - last < interval) return Promise.resolve();
      last = now(); running = true;
      return run(paseo).catch(() => {}).finally(() => { running = false; });
    },
    close() { closed = true; },
  };
}
