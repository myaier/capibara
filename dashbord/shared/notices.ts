/**
 * Closing a notice (✕) hides it by problem, not for a while: it stays hidden while every problem it names was closed. It
 * comes back when a new problem joins (another machine, another reason), or when a closed problem has been gone for
 * NOTICE_RECOVERY_MS and then returns. A problem that flickers away and back inside that window stays closed.
 */
export const NOTICE_RECOVERY_MS = 5 * 60_000;
export const DISMISSED_NOTICE_LIMIT = 64;

export const hasUndismissed = (keys: readonly string[], dismissed: readonly string[]): boolean => keys.some(key => !dismissed.includes(key));

export function dismissNotices(dismissed: readonly string[], keys: readonly string[]): string[] {
  return [...new Set([...dismissed, ...keys])].slice(-DISMISSED_NOTICE_LIMIT);
}

/**
 * Forgets closed problems that have been gone for NOTICE_RECOVERY_MS. `clearSince` is the caller's memory of when each one
 * went away. Returns the dismissals to keep, or null when nothing changed.
 */
export function expireDismissals(dismissed: readonly string[], active: ReadonlySet<string>, clearSince: Map<string, number>, now: number): string[] | null {
  for (const key of [...clearSince.keys()]) if (!dismissed.includes(key) || active.has(key)) clearSince.delete(key);
  const kept = dismissed.filter(key => {
    if (active.has(key)) return true;
    const since = clearSince.get(key) ?? now; clearSince.set(key, since);
    return now - since < NOTICE_RECOVERY_MS;
  });
  for (const key of dismissed) if (!kept.includes(key)) clearSince.delete(key);
  return kept.length === dismissed.length ? null : kept;
}
