/**
 * 拒绝并中断: denying a request with "interrupt" makes some providers end the turn as failed. That turn was stopped by the
 * user, so a failure within a short grace period after such a denial counts as canceled — not as an error, a failed turn or
 * a 重复失败 signal.
 */
export const INTERRUPT_GRACE_MS = 10_000;

export function createInterruptGrace(now: () => number = Date.now, graceMs = INTERRUPT_GRACE_MS) {
  const interrupts = new Map<string, { at: number; turnId: string | null }>();
  return {
    /** A permission was denied with `interrupt: true`. */
    note(agentId: string): void {
      interrupts.delete(agentId); interrupts.set(agentId, { at: now(), turnId: null });
      while (interrupts.size > 500) interrupts.delete(interrupts.keys().next().value!);
    },
    /**
     * The outcome to record for a turn that just ended. The first turn to end after a denial is the interrupted one and keeps
     * the mark (for every handler of that same end); any later turn, e.g. a prompt sent right afterwards that fails, does not.
     */
    outcome(agentId: string, kind: "completed" | "failed" | "canceled", turnId: string | null): "completed" | "failed" | "canceled" {
      const mark = interrupts.get(agentId);
      if (!mark) return kind;
      // Without a turn id only the grace period applies.
      if (turnId !== null && mark.turnId === null) mark.turnId = turnId;
      else if (turnId !== null && mark.turnId !== turnId) { interrupts.delete(agentId); return kind; }
      return kind === "failed" && now() - mark.at <= graceMs ? "canceled" : kind;
    },
  };
}
