import { t } from "../shared/text";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { DAY_MS, getQuota, HOUR_MS, QUOTA_FRESH_MS, QUOTA_LIMITS, quotaTone, quotaWindowDuration, quotaWindowLabel, type QUOTA_ERRORS, type QuotaAccount, type QuotaForecast,
  type QuotaResponse, type QuotaSnapshot, type QuotaWindow } from "../shared/quota";
import { ensurePrivateDirectory, resolvePaseoHome } from "./paseo-home";
import type { PaseoApi } from "./paseo-types";
import { contentRevision } from "./revision";

/**
 * 额度 (2.13): samples `paseo.providers.listUsage()` into `quota-history.json` and projects windows, pace and forecasts.
 *
 * The daemon does the provider calls (with each account's login) and caches every account for 5 minutes; this module
 * never reads a credential or calls a provider. Every daemon read is a real request to each vendor for each account, so
 * the 10-minute sampler runs only while someone is looking (opus-F41): from a page's read until WATCH_MS after the last
 * one. Agent hooks never start it, and a page that comes back after a pause reads at once (the history chart shows the
 * pause as a gap, as it does any gap over 15 minutes). The daemon then fetches no more than its own Usage panel would.
 *
 * Samples follow tomgrin10/paseo-smart-session's rules: a reading is stored when a value, a reset time or the set of
 * windows changes, plus a 10-minute heartbeat; a reading older than the newest held is refused, and so is a lower value
 * within one window instance (until it has held for 30 minutes: then it is the provider's correction); reset times
 * within ±2 minutes are one window, and only a later reset starts a new one; over 15 minutes without a stored reading
 * is a gap. Account display names may be e-mail addresses: they are hashed into the key and never stored.
 */
export const SAMPLE_MS = 10 * 60_000;
/**
 * The sampler keeps going this long after the last page read (`observatory.quota.get`), then stops until the next one: a
 * page polls every 5 minutes while shown, so this only bridges a tab switch or a short trip to the background.
 */
export const WATCH_MS = 30 * 60_000;
/** A page asks for a fresh read when the last one is at least this old: the daemon's cache answers anything newer anyway. */
export const PAGE_READ_MS = 5 * 60_000;
/** How long a page request waits for that read before answering with what is held (marked `refreshing`). */
const PAGE_WAIT_MS = 4000;
/** Plugin RPCs give up after 30 s; the daemon's own per-account deadline is 20 s. */
export const READ_TIMEOUT_MS = 25_000;
export const HEARTBEAT_MS = 10 * 60_000;
export const GAP_MS = 15 * 60_000;
export const SAME_WINDOW_MS = 120_000;
export const RATE_SPAN_MS = 30 * 60_000;
export const CONFIRM_DROP_MS = 30 * 60_000;
export const RETAIN_MS = 40 * DAY_MS;
/** History file budgets: accounts, readings per account (40 days at one per 5 minutes is 11,520), windows per account, bytes. */
export const QUOTA_STORE_LIMITS = { accounts: 16, samples: 12_000, windows: 16, bytes: 16 * 1024 * 1024 } as const;
/** Throttle for history writes; close() writes at once. A crash loses at most this much history. */
const WRITE_MS = 10 * 60_000;
/** Accounts the host listed within an hour of its latest answer stay on screen (agent-discovered logins come and go). */
const SHOWN_MS = HOUR_MS;
const FILE_NAME = "quota-history.json";

export type QuotaErrorKind = typeof QUOTA_ERRORS[number];
/** One window's reading: used % and reset time (epoch ms, whole seconds). */
export interface QuotaValue { pct: number | null; resetsAt: number | null }
/** A stored reading of one account: its effective time (the provider's fetch time) and every window it listed. */
export interface QuotaSample { at: number; values: Map<string, QuotaValue> }
type Value = QuotaValue; type Sample = QuotaSample;
interface WindowInfo { label: string; summary: boolean }
interface Account {
  key: string; provider: string; source: string; plan: string | null; ordinal: number; firstSeenAt: number; lastSeenAt: number;
  /** Every window id seen (at most 16) with the provider's label; `order` is the latest reading's windows, in its order. */
  windows: Map<string, WindowInfo>; order: string[]; samples: Sample[];
  // In memory only.
  status: "available" | "unavailable" | "error"; hint: string | null;
  /** Windows whose readings went down within one instance, and since when (effective time). */
  drops: Map<string, number>;
  /** Effective time of the newest accepted reading that was not stored (nothing changed). */
  unrecorded: number | null;
}

// The host's reply is checked row by row: a malformed row (or window) drops only itself.
const usageList = z.object({ fetchedAt: z.string().max(80).nullish(), providers: z.array(z.unknown()).max(64) });
const usageRow = z.object({ providerId: z.string().regex(/^[\w.:-]{1,80}$/), displayName: z.string().max(400), status: z.enum(["available", "unavailable", "error"]),
  planLabel: z.string().max(200).nullish(), fetchedAt: z.string().max(80).nullish(), windows: z.array(z.unknown()).max(64).nullish() });
const usageWindow = z.object({ id: z.string().min(1).max(160), label: z.string().max(400).optional(), summary: z.boolean().optional(),
  usedPct: z.number().finite().nullish(), remainingPct: z.number().finite().nullish(), resetsAt: z.string().max(80).nullish() });

const time = z.number().finite().nonnegative(), windowId = z.string().min(1).max(160);
const savedSample = z.tuple([time, z.array(z.tuple([z.number().int().min(0).max(QUOTA_STORE_LIMITS.windows - 1), z.number().finite().min(0).max(1000).nullable(),
  z.number().int().nonnegative().nullable()])).max(QUOTA_STORE_LIMITS.windows)]);
const savedAccount = z.object({ key: z.string().min(1).max(120), provider: z.string().regex(/^[\w.:-]{1,80}$/), source: z.string().max(40), plan: z.string().max(40).nullable(),
  ordinal: z.number().int().min(1).max(999), firstSeenAt: time, lastSeenAt: time,
  windows: z.array(z.object({ id: windowId, label: z.string().max(120), summary: z.boolean() })).max(QUOTA_STORE_LIMITS.windows),
  order: z.array(windowId).max(QUOTA_STORE_LIMITS.windows), samples: z.array(z.unknown()).max(QUOTA_STORE_LIMITS.samples) });
const savedFile = z.object({ version: z.literal(1), accounts: z.array(z.unknown()).max(64) });

const timeOf = (value: unknown): number | null => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) && at > 0 ? at : null; };
const iso = (at: number): string => new Date(at).toISOString();
const round1 = (value: number): number => Math.round(value * 10) / 10;
const clampPct = (value: number): number => Math.min(1000, Math.max(0, round1(value)));

/** `providerId:` + a SHA-256 of the account's display name ("Claude (someone@example.com)"); the name itself is never kept. */
export function quotaAccountKey(providerId: string, displayName: string): string {
  return `${providerId}:${createHash("sha256").update(`agent-observatory/quota\n${displayName}`).digest("hex").slice(0, 32)}`;
}
/** A short label that cannot carry an address or a path: letters, digits, spaces and a little punctuation. */
function plain(value: string | null | undefined, max = 40): string | null {
  const text = value?.trim() ?? "";
  return text && text.length <= max && /^[\p{L}\p{N}][\p{L}\p{N} ._+·&()-]*$/u.test(text) ? text : null;
}
const knownSources: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", kimi: "Kimi", cursor: "Cursor", copilot: "Copilot", zai: "Z.ai", minimax: "MiniMax", "opencode-go": "OpenCode Go" };
/** The usage source's name: the display name without its "(account)" part, when that is a plain label. */
export function quotaSourceName(displayName: string, providerId: string): string {
  return plain(displayName.replace(/\s*\([^()]*\)\s*$/, "")) ?? knownSources[providerId] ?? providerId.slice(0, 40);
}
/** a***@e*** (or a***): tells several accounts of one source apart without showing them; never stored. */
export function maskAccount(displayName: string): string | null {
  const label = /\(([^()]+)\)\s*$/.exec(displayName)?.[1]?.trim();
  if (!label) return null;
  const first = (value: string) => Array.from(value)[0] ?? "", at = label.indexOf("@");
  return (at > 0 ? `${first(label)}***@${first(label.slice(at + 1))}***` : `${first(label)}***`).slice(0, 40);
}
/** "disconnected": the plugin's host session is gone. The SDK then says "Update the host to list provider usage" (it lost the host's feature list), so that text never means an old host here. */
export function quotaErrorKind(error: unknown): QuotaErrorKind {
  if (error instanceof QuotaUnsupported) return "unsupported";
  if (error instanceof QuotaTimeout) return "timeout";
  const message = error instanceof Error ? error.message : String(error);
  if (/update the host|connection (?:lost|closed)|disposed|not connected|socket (?:closed|hang up)|ECONNRESET|EPIPE/i.test(message)) return "disconnected";
  return /timed? ?out/i.test(message) ? "timeout" : "failed";
}
class QuotaTimeout extends Error {}
class QuotaUnsupported extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new QuotaTimeout("timed out")), ms); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}
const delay = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** Whether `next` starts a later window than `current` (an earlier reset is the provider revising the same window). */
function isRollover(current: number | null, next: number | null): boolean {
  return next !== null && (current === null || next - current > SAME_WINDOW_MS);
}
function differs(a: ReadonlyMap<string, Value>, b: ReadonlyMap<string, Value>): boolean {
  if (a.size !== b.size) return true;
  for (const [id, value] of b) { const other = a.get(id); if (!other || other.pct !== value.pct || other.resetsAt !== value.resetsAt) return true; }
  return false;
}

export interface QuotaPoint { at: number; pct: number; resetsAt: number | null }
type Point = QuotaPoint;
/** One window's stored readings split into instances (resets), newest last; only the latest instance is shown. */
export function windowInstances(samples: readonly Sample[], id: string): Array<{ resetsAt: number | null; points: Point[] }> {
  const result: Array<{ resetsAt: number | null; points: Point[] }> = [];
  for (const sample of samples) {
    const value = sample.values.get(id);
    if (!value || value.pct === null) continue;
    const current = result.at(-1), point = { at: sample.at, pct: value.pct, resetsAt: value.resetsAt };
    // A reading after the held reset time belongs to the next window even when it does not report a reset of its own yet;
    // one still carrying the same reset instant is a late copy of the window that ended.
    const ended = current?.resetsAt != null && sample.at >= current.resetsAt && !(value.resetsAt !== null && Math.abs(value.resetsAt - current.resetsAt) <= SAME_WINDOW_MS);
    if (!current || isRollover(current.resetsAt, value.resetsAt) || ended) { result.push({ resetsAt: value.resetsAt, points: [point] }); continue; }
    if (value.resetsAt !== null) current.resetsAt = value.resetsAt;
    current.points.push(point);
  }
  return result;
}
/**
 * Forecast for one window instance. Windows up to a day use the rate over the last 30 minutes or more (anchored at the
 * last reading at or before that cutoff: readings are stored only when they change, so a quiet stretch still has a
 * span); longer ones use this window's average pace so far (used ÷ elapsed share), not before a tenth of it has passed.
 * A window of unknown length gets a rate forecast only when its reset is at most 6 hours away.
 */
export function quotaForecast(points: readonly Point[], resetsAt: number | null, durationMs: number | null, now: number): QuotaForecast | null {
  const last = points.at(-1);
  if (!last) return null;
  if (last.pct >= 100) return { kind: "exhausted" };
  const rateWindow = durationMs !== null ? durationMs <= DAY_MS : resetsAt !== null && resetsAt - now <= 6 * HOUR_MS;
  // "Runs out at" is only said when it is known to come before the reset.
  if (resetsAt === null) return null;
  if (rateWindow) {
    let anchor: Point | null = null;
    for (const point of points) { if (point.at <= last.at - RATE_SPAN_MS) anchor = point; else break; }
    if (!anchor) return null;
    const rate = (last.pct - anchor.pct) / ((last.at - anchor.at) / HOUR_MS);
    if (!(rate > 0)) return { kind: "idle" };
    const at = last.at + (100 - last.pct) / rate * HOUR_MS;
    if (at < resetsAt) return { kind: "exhaust", at: iso(Math.round(at)), method: "rate" };
    return { kind: "projected", pct: clampPct(last.pct + rate * (resetsAt - last.at) / HOUR_MS), method: "rate" };
  }
  if (durationMs === null) return null;
  const start = resetsAt - durationMs, elapsed = (last.at - start) / durationMs;
  if (elapsed < 0.1 || elapsed > 1) return null;
  const projected = last.pct / elapsed;
  if (projected >= 100) return { kind: "exhaust", at: iso(Math.round(start + (last.at - start) * 100 / last.pct)), method: "pace" };
  return { kind: "projected", pct: clampPct(projected), method: "pace" };
}
/** At most `max` readings for the mini chart: the last one of each equal time slice; a slice keeps any gap mark in it. */
export function historyPoints(points: readonly Point[], span: readonly [number, number], max: number = QUOTA_LIMITS.points): Array<[number, number, boolean]> {
  const flagged = points.map((point, index): [number, number, boolean] => [point.at, Math.min(1000, point.pct), index > 0 && point.at - points[index - 1]!.at > GAP_MS]);
  if (flagged.length <= max) return flagged;
  const width = Math.max(1, span[1] - span[0]) / max, result: Array<[number, number, boolean]> = [];
  let slice = Number.NaN;
  for (const point of flagged) {
    const index = Math.min(max - 1, Math.max(0, Math.floor((point[0] - span[0]) / width))), previous = result.at(-1);
    if (previous && index === slice) result[result.length - 1] = [point[0], point[1], previous[2] || point[2]];
    else { result.push(point); slice = index; }
  }
  return result.slice(-max);
}

export interface QuotaRecorderOptions {
  /** Plugin data directory (default `$PASEO_HOME/plugin-data/agent-observatory`). */
  directory?: string;
  now?: () => number;
  /** The 10-minute sampler and throttled writes; tests call sample() and flush() themselves. */
  timers?: boolean;
  log?: (message: string) => void;
  /** Shorter waits for tests (defaults READ_TIMEOUT_MS and 4 s). */
  readTimeoutMs?: number; pageWaitMs?: number;
}

export class QuotaRecorder {
  readonly file: string;
  readonly accounts = new Map<string, Account>();
  readonly loaded: Promise<void>;
  lastAttemptAt = -Infinity;
  lastSuccessAt: number | null = null;
  /** The last page read: the sampler runs until WATCH_MS after it. */
  watchedAt = -Infinity;
  error: { kind: QuotaErrorKind; at: number } | null = null;
  private paseo: PaseoApi | null = null;
  private reading: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;
  private writable = true;
  private written: string | null = null;
  private reported: QuotaErrorKind | null = null;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly timers: boolean;
  private readonly log: (message: string) => void;
  private readonly readTimeoutMs: number;
  private readonly pageWaitMs: number;

  constructor(options: QuotaRecorderOptions = {}) {
    this.readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS; this.pageWaitMs = options.pageWaitMs ?? PAGE_WAIT_MS;
    this.directory = options.directory ?? join(resolvePaseoHome(), "plugin-data", "agent-observatory");
    this.file = join(this.directory, FILE_NAME);
    this.now = options.now ?? Date.now; this.timers = options.timers !== false;
    this.log = options.log ?? (message => console.warn(message));
    this.loaded = this.load();
  }

  /** Remembers the newest daemon handle for the sampler; it does not start sampling (only a page read does). */
  attach(paseo: PaseoApi): void {
    if (this.closed) return;
    this.paseo = paseo;
  }
  /** A page read: the sampler runs (or keeps running) until WATCH_MS after it. */
  watch(paseo: PaseoApi): void {
    if (this.closed) return;
    this.attach(paseo);
    this.watchedAt = this.now();
    if (this.timers && !this.timer) this.schedule();
  }
  /** Whether a page read within WATCH_MS keeps the sampler going. */
  watched(now = this.now()): boolean { return now - this.watchedAt < WATCH_MS; }
  private schedule(): void {
    const wait = this.lastAttemptAt + SAMPLE_MS - this.now();
    this.timer = setTimeout(() => this.tick(), Number.isFinite(wait) ? Math.max(0, wait) : 0);
    this.timer.unref?.();
  }
  private tick(): void {
    this.timer = null;
    // Nobody has read for WATCH_MS: stop asking the daemon (and through it every vendor) until a page reads again.
    if (this.closed || !this.watched()) return;
    // A page read in between moved the schedule.
    const due = this.now() - this.lastAttemptAt >= SAMPLE_MS - 1000;
    void (due ? this.sample() : Promise.resolve()).finally(() => { if (!this.closed && this.timers && !this.timer && this.watched()) this.schedule(); });
  }

  /** One read at a time; later callers share it. */
  sample(paseo: PaseoApi | null = this.paseo): Promise<void> {
    if (this.reading) return this.reading;
    if (!paseo || this.closed) return Promise.resolve();
    this.lastAttemptAt = this.now();
    const reading = this.loaded.then(() => this.read(paseo)).finally(() => { if (this.reading === reading) this.reading = null; });
    this.reading = reading;
    return reading;
  }
  private async read(paseo: PaseoApi): Promise<void> {
    let payload: unknown;
    try {
      const providers = (paseo as Partial<PaseoApi>).providers;
      if (typeof providers?.listUsage !== "function") throw new QuotaUnsupported("no usage API");
      payload = await withTimeout(providers.listUsage(), this.readTimeoutMs);
    } catch (error) { this.fail(quotaErrorKind(error), this.now()); return; }
    this.ingest(payload, this.now());
  }
  /** Keeps every value held; only the error kind is logged (a provider message can name the account). */
  fail(kind: QuotaErrorKind, at: number): void {
    this.error = { kind, at };
    if (this.reported !== kind) { this.reported = kind; this.log(t("serverQuota.m001", { kind: kind })); }
  }

  /** Applies one `listUsage()` reply read at `observedAt`. */
  ingest(payload: unknown, observedAt: number): void {
    const list = usageList.safeParse(payload);
    if (!list.success) { this.fail("failed", observedAt); return; }
    this.error = null; this.reported = null; this.lastSuccessAt = observedAt;
    // The legacy list carries the oldest account fetch time; rows of newer hosts carry their own.
    const listedAt = timeOf(list.data.fetchedAt) ?? observedAt;
    let changed = false;
    for (const raw of list.data.providers) {
      const parsed = usageRow.safeParse(raw);
      if (!parsed.success) continue;
      const row = parsed.data, key = quotaAccountKey(row.providerId, row.displayName);
      let account = this.accounts.get(key);
      if (!account) { account = this.create(key, row.providerId, observedAt); changed = true; }
      const source = quotaSourceName(row.displayName, row.providerId), plan = row.status === "available" ? plain(row.planLabel) : account.plan;
      if (account.source !== source || account.plan !== plan) { account.source = source; account.plan = plan; changed = true; }
      account.lastSeenAt = observedAt; account.hint = maskAccount(row.displayName); account.status = row.status;
      // Unavailable / failed accounts keep their last values, shown with the time they were read.
      if (row.status !== "available") continue;
      const values = new Map<string, Value>(), order: string[] = [];
      for (const item of row.windows ?? []) {
        const window = usageWindow.safeParse(item);
        if (!window.success || values.has(window.data.id) || order.length >= QUOTA_LIMITS.windows) continue;
        const { id, usedPct, remainingPct, resetsAt } = window.data, used = typeof usedPct === "number" ? usedPct : typeof remainingPct === "number" ? 100 - remainingPct : null;
        const reset = timeOf(resetsAt);
        values.set(id, { pct: used === null ? null : clampPct(used), resetsAt: reset === null ? null : Math.round(reset / 1000) * 1000 });
        order.push(id);
        const info = { label: (window.data.label ?? "").trim().slice(0, 120), summary: window.data.summary === true }, known = account.windows.get(id);
        if (!known || known.label !== info.label || known.summary !== info.summary) { this.noteWindow(account, id, info); changed = true; }
      }
      if (!values.size) continue;
      if (order.join("\n") !== account.order.join("\n")) { account.order = order; changed = true; }
      if (this.record(account, Math.min(observedAt, timeOf(row.fetchedAt) ?? listedAt), values)) changed = true;
    }
    if (changed) this.markDirty();
  }
  private create(key: string, provider: string, at: number): Account {
    let ordinal = 1;
    for (const other of this.accounts.values()) if (other.provider === provider) ordinal = Math.max(ordinal, other.ordinal + 1);
    const account: Account = { key, provider, source: provider, plan: null, ordinal, firstSeenAt: at, lastSeenAt: at, windows: new Map(), order: [], samples: [],
      status: "available", hint: null, drops: new Map(), unrecorded: null };
    this.accounts.set(key, account);
    return account;
  }
  /** At most 16 windows per account: a new one replaces the one seen longest ago that the latest reading does not list. */
  private noteWindow(account: Account, id: string, info: WindowInfo): void {
    if (!account.windows.has(id) && account.windows.size >= QUOTA_STORE_LIMITS.windows) {
      const lastSeen = (window: string) => { for (let index = account.samples.length - 1; index >= 0; index--) if (account.samples[index]!.values.has(window)) return account.samples[index]!.at; return -Infinity; };
      const evict = [...account.windows.keys()].filter(window => !account.order.includes(window)).sort((a, b) => lastSeen(a) - lastSeen(b))[0];
      if (!evict) return;
      account.windows.delete(evict);
      for (const sample of account.samples) sample.values.delete(evict);
    }
    account.windows.set(id, info);
  }

  /** Stores a reading when it changes something or the heartbeat is due; true when the history changed. */
  private record(account: Account, at: number, incoming: ReadonlyMap<string, Value>): boolean {
    const last = account.samples.at(-1);
    if (last && at < last.at) return false;
    const next = new Map<string, Value>();
    for (const [id, value] of incoming) {
      const held = last?.values.get(id);
      const sameInstance = !!held && !(held.resetsAt !== null && held.resetsAt <= at) && !isRollover(held.resetsAt, value.resetsAt);
      if (held && sameInstance && held.pct !== null && value.pct !== null && value.pct < held.pct) {
        const since = account.drops.get(id) ?? at;
        account.drops.set(id, since);
        if (at - since < CONFIRM_DROP_MS) { next.set(id, held); continue; }
      }
      account.drops.delete(id);
      // Keep the held reset instant while the provider's recomputed one stays within ±2 minutes of it.
      next.set(id, held && sameInstance && value.resetsAt !== null && held.resetsAt !== null && Math.abs(value.resetsAt - held.resetsAt) <= SAME_WINDOW_MS ? { pct: value.pct, resetsAt: held.resetsAt } : value);
    }
    const same = !!last && !differs(last.values, next);
    if (same && at - last!.at < HEARTBEAT_MS) { account.unrecorded = at; return false; }
    if (last && at === last.at) { last.values = next; account.unrecorded = null; return true; }
    // A read that changed nothing was not stored; stored now, it keeps a chart from showing a gap that was never there.
    if (last && account.unrecorded !== null && account.unrecorded > last.at && account.unrecorded < at && at - last.at > GAP_MS) account.samples.push({ at: account.unrecorded, values: last.values });
    // Heartbeats (most samples) share the previous reading's values: stored samples are never changed in place.
    account.samples.push({ at, values: same ? last!.values : next });
    account.unrecorded = null;
    if (account.samples.length > QUOTA_STORE_LIMITS.samples) account.samples.splice(0, account.samples.length - QUOTA_STORE_LIMITS.samples);
    return true;
  }

  /** The page's view at `now`. */
  snapshot(now: number): QuotaSnapshot {
    const failed = this.error !== null, latest = this.lastSuccessAt;
    const shown = [...this.accounts.values()].filter(account => latest !== null ? account.lastSeenAt >= latest - SHOWN_MS : account.lastSeenAt >= now - DAY_MS)
      .filter(account => account.samples.length || account.status !== "available")
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.ordinal - b.ordinal).slice(0, QUOTA_LIMITS.accounts);
    const perSource = new Map<string, number>();
    for (const account of shown) perSource.set(account.provider, (perSource.get(account.provider) ?? 0) + 1);
    const accounts = shown.map((account): QuotaAccount => {
      // An unchanged reading is not stored, but it is just as current.
      const several = (perSource.get(account.provider) ?? 0) > 1, last = account.samples.at(-1), readingAt = last ? Math.max(last.at, account.unrecorded ?? 0) : null;
      return { key: account.key, provider: account.provider, name: several ? t("serverQuota.m002", { value1: account.source, value2: account.ordinal }) : account.source, hint: several ? account.hint : null,
        plan: account.plan, status: account.status, readingAt: readingAt === null ? null : iso(readingAt),
        stale: failed || account.status !== "available" || (latest !== null && account.lastSeenAt < latest) || readingAt === null || now - readingAt > QUOTA_FRESH_MS,
        windows: account.order.flatMap(id => { const window = this.windowView(account, id, now); return window ? [window] : []; }).slice(0, QUOTA_LIMITS.windows) };
    });
    let snapshot: QuotaSnapshot = { generatedAt: iso(now), readAt: latest === null ? null : iso(latest), error: this.error ? { kind: this.error.kind, at: iso(this.error.at) } : null,
      refreshing: this.reading !== null, accounts };
    // A relay-friendly reply: thin the charts first, then fold the windows the provider leaves out of its summary.
    for (const points of [18, 8]) {
      if (Buffer.byteLength(JSON.stringify(snapshot)) < 48_000) break;
      snapshot = { ...snapshot, accounts: snapshot.accounts.map(account => ({ ...account, windows: account.windows.map(window => ({ ...window, history: window.history.filter((_, index) => index % Math.ceil(window.history.length / points) === 0 || index === window.history.length - 1) })) })) };
    }
    if (Buffer.byteLength(JSON.stringify(snapshot)) >= 48_000) snapshot = { ...snapshot, accounts: snapshot.accounts.map(account => ({ ...account, windows: account.windows.filter(window => window.summary).slice(0, 2) })) };
    return snapshot;
  }
  private windowView(account: Account, id: string, now: number): QuotaWindow | null {
    const instance = windowInstances(account.samples, id).at(-1), info = account.windows.get(id);
    if (!instance) return null;
    const last = instance.points.at(-1)!, resetsAt = instance.resetsAt, durationMs = quotaWindowDuration(id);
    const reset = resetsAt !== null && resetsAt <= now, start = resetsAt !== null && durationMs !== null ? resetsAt - durationMs : null;
    const pace = !reset && start !== null ? Math.min(1, Math.max(0, (now - start) / durationMs!)) : null;
    const forecast = reset ? null : quotaForecast(instance.points, resetsAt, durationMs, now);
    const span: [number, number] = start !== null ? [Math.max(0, Math.round(start)), Math.round(resetsAt!)] : [Math.round(instance.points[0]!.at), Math.round(Math.max(now, last.at))];
    return { id, label: quotaWindowLabel(id, info?.label ?? ""), summary: info?.summary ?? false, usedPct: last.pct, resetsAt: resetsAt === null ? null : iso(resetsAt), durationMs,
      pace: pace === null ? null : Math.round(pace * 1000) / 1000, ahead: pace !== null && last.pct > pace * 100 + 1, state: reset ? "reset" : "live", forecast,
      tone: reset ? "neutral" : quotaTone(last.pct), alarm: forecast?.kind === "exhaust" || forecast?.kind === "exhausted",
      // A reading from before a known window's start cannot be part of it (a provider repeating a reset instant it had not moved yet).
      history: historyPoints(start === null ? instance.points : instance.points.filter(point => point.at >= start - SAME_WINDOW_MS), span), span };
  }

  /**
   * The RPC: a fresh read when the last one is 5 minutes old (waiting up to 4 s for it), then the view, revisioned. It
   * also keeps the sampler going for WATCH_MS; a page back after a pause gets its fresh read here, at once.
   */
  async request(paseo: PaseoApi, revision?: string): Promise<QuotaResponse> {
    this.watch(paseo);
    await this.loaded;
    if (!this.reading && this.now() - this.lastAttemptAt >= PAGE_READ_MS) void this.sample(paseo);
    const reading = this.reading;
    if (reading) await Promise.race([reading, delay(this.pageWaitMs)]);
    const snapshot = this.snapshot(this.now()), current = contentRevision({ ...snapshot, generatedAt: null });
    return revision === current ? { mode: "unchanged", unchanged: true, revision: current } : { ...snapshot, mode: "full", unchanged: false, revision: current };
  }

  // Persistence: `$PASEO_HOME/plugin-data/agent-observatory/quota-history.json`, 0600, atomic replace, 40 days.
  private async load(): Promise<void> {
    let content: string;
    try {
      const details = await stat(this.file);
      if (details.size > QUOTA_STORE_LIMITS.bytes) { await this.quarantine(); return; }
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.writable = false; this.log(t("serverQuota.m003")); }
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(content); } catch { await this.quarantine(); return; }
    const saved = savedFile.safeParse(raw);
    if (!saved.success) { await this.quarantine(); return; }
    for (const item of saved.data.accounts) {
      const parsed = savedAccount.safeParse(item);
      if (!parsed.success || this.accounts.has(parsed.data.key)) continue;
      const data = parsed.data, ids = data.windows.map(window => window.id), samples: Sample[] = [];
      for (const rawSample of data.samples) {
        const sample = savedSample.safeParse(rawSample);
        if (!sample.success) continue;
        const values = new Map<string, Value>(), previous = samples.at(-1)?.values;
        for (const [index, pct, reset] of sample.data[1]) if (ids[index] !== undefined) values.set(ids[index]!, { pct, resetsAt: reset === null ? null : reset * 1000 });
        samples.push({ at: sample.data[0], values: previous && !differs(previous, values) ? previous : values });
      }
      samples.sort((a, b) => a.at - b.at);
      this.accounts.set(data.key, { key: data.key, provider: data.provider, source: plain(data.source) ?? knownSources[data.provider] ?? data.provider, plan: plain(data.plan),
        ordinal: data.ordinal, firstSeenAt: data.firstSeenAt, lastSeenAt: data.lastSeenAt,
        windows: new Map(data.windows.map(window => [window.id, { label: window.label, summary: window.summary }])), order: data.order.filter(id => ids.includes(id)), samples,
        status: "available", hint: null, drops: new Map(), unrecorded: null });
    }
    this.prune(this.now());
    this.written = content;
  }
  private async quarantine(): Promise<void> {
    // One backup, replaced by the next, so repeated damage never piles up copies.
    const aside = join(this.directory, "quota-history.corrupt.json");
    try { await rename(this.file, aside); this.log(t("serverQuota.m004")); }
    catch { this.writable = false; }
  }
  /** 40 days of readings; accounts unseen that long go; at most 16 accounts (the most recently seen). */
  prune(now: number): void {
    const cutoff = now - RETAIN_MS;
    for (const [key, account] of this.accounts) {
      const first = account.samples.findIndex(sample => sample.at >= cutoff);
      if (first !== 0) account.samples.splice(0, first < 0 ? account.samples.length : first);
      if (!account.samples.length && account.lastSeenAt < cutoff) this.accounts.delete(key);
    }
    const ranked = [...this.accounts.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const account of ranked.slice(QUOTA_STORE_LIMITS.accounts)) this.accounts.delete(account.key);
  }
  serialize(): string {
    return JSON.stringify({ version: 1, accounts: [...this.accounts.values()].map(account => {
      const ids = [...account.windows.keys()], index = new Map(ids.map((id, position) => [id, position]));
      return { key: account.key, provider: account.provider, source: account.source, plan: account.plan, ordinal: account.ordinal, firstSeenAt: account.firstSeenAt,
        lastSeenAt: account.lastSeenAt, windows: ids.map(id => ({ id, ...account.windows.get(id)! })), order: account.order,
        samples: account.samples.map(sample => [sample.at, [...sample.values].flatMap(([id, value]) => index.has(id) ? [[index.get(id)!, value.pct, value.resetsAt === null ? null : Math.round(value.resetsAt / 1000)]] : [])]) };
    }) });
  }
  private markDirty(): void {
    this.dirty = true;
    if (!this.timers || this.writeTimer || this.closed) return;
    this.writeTimer = setTimeout(() => { this.writeTimer = null; void this.flush(); }, WRITE_MS);
    this.writeTimer.unref?.();
  }
  /** Serialized, atomic (random temporary name, 0600, rename); identical content is not rewritten. */
  flush(durable = false): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    this.writes = this.writes.then(async () => {
      await this.loaded;
      if (!this.dirty || !this.writable) return;
      this.dirty = false;
      this.prune(this.now());
      let payload = this.serialize();
      while (Buffer.byteLength(payload) > QUOTA_STORE_LIMITS.bytes) {
        const largest = [...this.accounts.values()].sort((a, b) => b.samples.length - a.samples.length)[0];
        if (!largest?.samples.length) break;
        largest.samples.splice(0, Math.max(1, Math.floor(largest.samples.length / 10)));
        payload = this.serialize();
      }
      if (payload === this.written) return;
      const temporary = join(this.directory, `${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await ensurePrivateDirectory(this.directory);
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(payload, "utf8"); if (durable) await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.file);
        this.written = payload;
      } catch { this.dirty = true; this.log(t("serverQuota.m005")); }
      finally { await unlink(temporary).catch(() => {}); }
    });
    return this.writes;
  }
  async close(): Promise<void> {
    if (this.closed) { await this.writes; return; }
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.writeTimer) clearTimeout(this.writeTimer);
    await this.reading?.catch(() => {});
    await this.flush(true);
  }
}

/**
 * Registers `observatory.quota.get` and the sampler. The daemon handle comes with each page read (a plugin gets no
 * handle of its own), and only page reads keep the sampler going (opus-F41): no lifecycle hook is registered, so Agents
 * working while nobody looks (heartbeats, schedules, background work) never make the daemon ask the vendors.
 * index.server.ts: `const removeQuota = registerQuota(server);` and `await removeQuota()` on close.
 */
export function registerQuota(server: PluginServerContext, options: QuotaRecorderOptions = {}): () => Promise<void> {
  const recorder = new QuotaRecorder(options);
  server.handle(getQuota, (input, { paseo }) => recorder.request(paseo, input.revision));
  return () => recorder.close();
}
