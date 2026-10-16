/**
 * 「查看全部运行」 / 「在定时运行中查看」 hand-off: an Agent's 定时任务 or 心跳 card asks the 定时运行 page to show one schedule
 * (and select one run).
 *
 * Paseo 0.11 carries it in the screen's params (they travel in the URL): `openScreen({ screenId: "schedule-runs",
 * params: scheduleScreenParams(focus) })`, read back by `focusFromParams`. The module-level request below is only for older
 * hosts, whose `openSurface` takes no parameters: the request waits here until the page reads it.
 */
export interface ScheduleFocus { scheduleId: string; runId?: string }

/** The 定时运行 screen's params: `schedule` (a schedule id) and, optionally, `run` (one of its run ids). */
export function scheduleScreenParams(focus: ScheduleFocus): Record<string, string> {
  return focus.runId ? { schedule: focus.scheduleId, run: focus.runId } : { schedule: focus.scheduleId };
}
/** The focus a screen was opened with; null for `{}` (opened from the sidebar or the Command Center). */
export function focusFromParams(params: Readonly<Record<string, string>> | null | undefined): ScheduleFocus | null {
  const scheduleId = params?.schedule?.trim().slice(0, params.schedule.startsWith("~h:") ? 4096 : 80);
  if (!scheduleId) return null;
  const runId = params?.run?.trim().slice(0, params.run.startsWith("~h:") ? 4096 : 120);
  return runId ? { scheduleId, runId } : { scheduleId };
}

let pending: ScheduleFocus | null = null;
const listeners = new Set<(focus: ScheduleFocus) => void>();

/** Older hosts only (no `addScreen` / screen params): remember the request for the page `openSurface` is about to show. */
export function focusScheduleRuns(focus: ScheduleFocus): void {
  pending = focus;
  for (const listener of listeners) listener(focus);
}
/** The request a page opened right now should apply; it stays until `clearScheduleFocus` so a re-render cannot lose it. */
export const peekScheduleFocus = (): ScheduleFocus | null => pending;
export function clearScheduleFocus(focus: ScheduleFocus | null): void { if (focus && pending === focus) pending = null; }
export function onScheduleFocus(listener: (focus: ScheduleFocus) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
