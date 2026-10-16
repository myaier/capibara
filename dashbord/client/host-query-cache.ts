export interface HostQueryValue<T> { value: T; generation: number; collectedAt: number }
interface Entry<T> { success: HostQueryValue<T> | null; pending: Promise<T> | null; generation: number; token: object }

export function canonicalQuery(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalQuery).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(name => (value as Record<string, unknown>)[name] !== undefined)
    .map(name => `${JSON.stringify(name)}:${canonicalQuery((value as Record<string, unknown>)[name])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Per-host raw data cache. Connection generations and scope keys prevent late replies from becoming current data. */
export function createHostQueryCache<T>(now = Date.now, limit = 128) {
  const entries = new Map<string, Entry<T>>();
  return {
    peek(key: string): HostQueryValue<T> | null { return entries.get(key)?.success ?? null; },
    read(key: string, generation: number, load: (previous: T | undefined) => Promise<T>): Promise<T> {
      let entry = entries.get(key);
      if (entry?.generation === generation && entry.pending) return entry.pending;
      if (!entry || entry.generation !== generation) {
        entry = { success: entry?.success ?? null, pending: null, generation, token: {} }; entries.set(key, entry);
      }
      const current = entry, previous = current.success?.generation === generation ? current.success.value : undefined;
      const pending = Promise.resolve().then(() => load(previous)).then(value => {
        if (entries.get(key)?.token !== current.token) throw new Error("Host query was replaced while reading");
        current.success = { value, generation, collectedAt: now() }; return value;
      }).finally(() => { if (entries.get(key)?.token === current.token) current.pending = null; });
      current.pending = pending;
      entries.delete(key); entries.set(key, current);
      while (entries.size > limit) {
        const oldest = [...entries].find(([other, candidate]) => other !== key && !candidate.pending)?.[0];
        if (!oldest) break;
        entries.delete(oldest);
      }
      return pending;
    },
    forget(key: string) { entries.delete(key); },
    clear() { entries.clear(); },
  };
}
