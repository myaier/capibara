import { excludeCall } from "./data";
import type { LedgerCall } from "./types";
import type { FleetFilters } from "../../shared/fleet-scope";
import { translator } from "../../shared/i18n";
import { t } from "../../shared/text";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { PaseoApi } from "../paseo-types";
import type { StatsRange } from "../../shared/stats";
import type { TokenImportLimits, TokenResponse, TokenSnapshot } from "../../shared/tokens";
import { StatsDirectory } from "../stats-directory";
import { statsDayText, statsLocalDay, statsZone } from "../stats-types";
import { telemetryDirectory } from "../telemetry";
import { addCall, emptyData, noteThread, pruneData, sessionKey, settleCall, type TokenData } from "./data";
import { TokenIngester } from "./ingester";
import { TokenPersistence } from "./persistence";
import { providerRoots, rootIdentity, type RootContext } from "./roots";
import { buildTokenSnapshot } from "./snapshot";
import { dayOf, iso, safeError, type LogRoot } from "./types";

/** The daemon config is read for custom provider log roots at most this often. */
const DISCOVERY_MS = 5 * 60_000;
export interface TokenStoreOptions {
  directory?: string; agents?: StatsDirectory; roots?: LogRoot[]; now?: () => number;
  /** Deterministic tests and standalone verification can drive polling themselves. */
  poll?: boolean;
  /** Home, environment and launcher reads for provider root discovery (tests). */
  rootContext?: RootContext;
  /** Smaller import budgets (tests); the defaults are TOKEN_IMPORT_LIMITS. */
  limits?: Partial<TokenImportLimits>;
}
export class TokenStore {
  data: TokenData = emptyData();
  readonly ingester: TokenIngester;
  readonly directory: StatsDirectory;
  readonly persistence: TokenPersistence;
  readonly initialized: Promise<void>;
  readonly ready: Promise<void>;
  private readonly now: () => number;
  private change = 0;
  private dirty = false;
  private closed = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private lastScan = 0;
  private lastPrune = 0;
  private discoveredAt = -Infinity;
  private discovering: Promise<void> | null = null;
  private readonly rootContext: RootContext;
  private cached = new Map<string, Extract<TokenResponse, { mode: "full" }>>();
  constructor(options: TokenStoreOptions = {}) {
    this.now = options.now ?? Date.now; this.directory = options.agents ?? new StatsDirectory(this.now);
    this.rootContext = options.rootContext ?? { home: homedir(), env: process.env };
    this.persistence = new TokenPersistence(options.directory ?? telemetryDirectory());
    this.ingester = new TokenIngester({ roots: options.roots, now: this.now, limits: options.limits,
      onCall: (call, previous) => {
        addCall(this.data, call, previous, this.now());
        if (this.data.sessions.size > 5100) pruneData(this.data, this.now());
      }, onSettle: call => settleCall(this.data, call, this.now()), onChange: () => this.changed(),
      onThread: (child, parent) => { if (noteThread(this.data, child, parent)) this.changed(); } });
    this.initialized = this.persistence.restore(this.ingester).then(async saved => {
      this.data = saved.data; this.change += saved.change;
      pruneData(this.data, this.now()); this.lastPrune = dayOf(this.now());
      await this.ingester.scan();
      // Once after upgrading to 2.13: Codex subagent threads imported earlier learn their parent session.
      if (await this.ingester.probeThreads()) this.changed();
    });
    this.ready = this.initialized.then(() => this.ingester.backfillAll()).catch(error => {
      console.warn(t("serverTokensStore.m001", { value1: safeError(error) }));
    }).finally(() => {
      this.lastScan = this.now();
      if (options.poll !== false) this.schedulePoll();
    });
  }
  private changed(): void { this.change++; this.dirty = true; this.cached.clear(); this.scheduleWrite(); }
  private scheduleWrite(): void {
    if (this.closed || this.writeTimer) return;
    // Offsets are saved with the counts they produced, so a crash only re-reads the last minute of log bytes.
    this.writeTimer = setTimeout(() => { this.writeTimer = null; void this.flush(); }, 60_000);
    this.writeTimer.unref?.();
  }
  private schedulePoll(): void {
    if (this.closed || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().finally(() => this.schedulePoll());
    }, 2000);
    this.pollTimer.unref?.();
  }
  async poll(forceScan = false): Promise<void> {
    await this.ready;
    if (this.closed) return;
    const now = this.now(), rescan = forceScan || now - this.lastScan >= 30_000;
    await this.ingester.poll(rescan);
    if (rescan) this.lastScan = now;
    if (dayOf(now) !== this.lastPrune) { pruneData(this.data, now); this.lastPrune = dayOf(now); this.changed(); }
    else for (const [key, call] of this.data.recent) if (call.at < now - 75 * 60_000) this.data.recent.delete(key);
  }
  /**
   * Custom providers built on Claude Code, Codex, Grok CLI or Pi (see ./roots) that keep their logs elsewhere, from the
   * daemon's provider config: their `env`, command line or launcher text, or Pi's settings. New roots are watched from the
   * next scan. A root that only one custom provider uses, and that is not a standard one, is that provider's (gemini-B9):
   * its sessions without a Paseo agent count for it. Read at most every 5 minutes.
   */
  discover(paseo: PaseoApi): Promise<void> {
    if (this.discovering) return this.discovering;
    if (this.closed || this.now() - this.discoveredAt < DISCOVERY_MS) return Promise.resolve();
    this.discoveredAt = this.now();
    this.discovering = (async () => {
      await this.initialized;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { config } = await Promise.race([paseo.config.get(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 10_000); timer.unref?.();
      })]).finally(() => clearTimeout(timer));
      // The built-in Pi provider needs no config entry; its settings may still move its sessions.
      const providers = { pi: {}, ...config.providers as Record<string, unknown> | undefined };
      const found = await providerRoots(providers, this.rootContext);
      const identities = await Promise.all(this.ingester.roots.map(root => rootIdentity(root.path)));
      const known = new Set(identities), standard = new Set(identities.slice(0, this.ingester.baseRoots));
      const claims = new Map<string, Set<string>>(), fresh: LogRoot[] = [];
      for (const root of found) {
        const identity = await rootIdentity(root.path);
        const providersOf = claims.get(identity) ?? new Set<string>(); providersOf.add(root.provider); claims.set(identity, providersOf);
        if (!known.has(identity)) { known.add(identity); fresh.push({ source: root.source, path: root.path }); }
      }
      if (this.closed) return;
      const added = this.ingester.addRoots(fresh);
      // Ownership follows the current config: a root another provider starts to share, or no provider names, loses it.
      let owned = false;
      for (const [index, root] of this.ingester.roots.entries()) {
        const identity = identities[index] ?? await rootIdentity(root.path), owners = claims.get(identity);
        const owner = !standard.has(identity) && owners?.size === 1 ? [...owners][0] : undefined;
        if (root.provider !== owner) { if (owner) root.provider = owner; else delete root.provider; owned = true; }
      }
      if (!added && !owned) return;
      this.changed();
      if (added) void this.poll(true);
    })().catch(() => { /* the default roots keep working; the next read retries after the interval */ })
      .finally(() => { this.discovering = null; });
    return this.discovering;
  }
  coverage(): TokenSnapshot["coverage"] {
    return { earliestAt: this.data.earliestAt === null ? null : iso(this.data.earliestAt), latestAt: this.data.latestAt === null ? null : iso(this.data.latestAt),
      backfill: { ...this.ingester.backfill }, roots: this.ingester.roots.map(root => ({ source: root.source, path: root.path.slice(0, 1024), files: root.files, error: root.error })),
      truncated: { ...this.ingester.truncated } };
  }
  /** Sessions read from a root one custom provider owns: session key → that provider (Provider 用量 for unmatched sessions). */
  owners(): Map<string, string> {
    const owners = new Map<string, string>();
    for (const file of this.ingester.files.values()) {
      const provider = this.ingester.roots[file.root]?.provider;
      if (provider) for (const id of [file.state.sessionId, ...file.state.sessions]) owners.set(sessionKey(file.source, id), provider);
    }
    return owners;
  }
  async read(input: { complete?: boolean; filters?: FleetFilters; exclusionId?: string; range: StatsRange; utcOffsetMinutes: number; timeZone?: string; revision?: string }, paseo?: PaseoApi, excluded: readonly LedgerCall[] = []): Promise<TokenResponse> {
    await this.initialized;
    if (paseo) await this.directory.refresh(paseo);
    const now = this.now();
    if (dayOf(now) !== this.lastPrune) { pruneData(this.data, now); this.lastPrune = dayOf(now); this.changed(); }
    // The zone actually applied (null: the fixed offset) and its local today belong to the revision, so another zone, or the
    // same zone past local midnight, never reuses an earlier projection (as observatory.stats.get does).
    const zone = statsZone(input.utcOffsetMinutes, input.timeZone, now), today = statsDayText(statsLocalDay(now, zone));
    const revision = createHash("sha256").update(JSON.stringify([translator().language, translator().hash, this.change, input.complete, input.filters, input.exclusionId, input.range, input.utcOffsetMinutes, zone.name, today, this.directory.digest, this.ingester.roots, this.ingester.backfill, this.ingester.truncated])).digest("hex").slice(0, 24);
    if (input.revision === revision) return { mode: "unchanged", unchanged: true, revision };
    const cached = this.cached.get(revision); if (cached) return cached;
    const projected = excluded.length ? structuredClone(this.data) : this.data;
    for (const call of excluded) excludeCall(projected, call, now);
    const snapshot = buildTokenSnapshot(projected, { complete: input.complete, filters: input.filters, range: input.range, utcOffsetMinutes: input.utcOffsetMinutes, timeZone: zone.name }, now, this.directory, this.coverage(), this.owners());
    if (snapshot.fleetDetails) {
      snapshot.fleetDetails.dedupeKeys = [...this.ingester.seen.keys()];
      snapshot.fleetDetails.dedupeLimited = this.ingester.seenFloor !== null;
    }
    const result: Extract<TokenResponse, { mode: "full" }> = { ...snapshot, mode: "full", unchanged: false, revision };
    this.cached.set(revision, result);
    if (this.cached.size > 8) this.cached.delete(this.cached.keys().next().value!);
    return result;
  }
  /** Serialized writes cannot interleave checkpoints. No periodic write occurs while clean. */
  flush(durable = false): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    this.writes = this.writes.then(async () => {
      await this.initialized;
      if (!this.dirty) return;
      pruneData(this.data, this.now());
      const change = this.change, payload = this.persistence.serialize(this.data, this.ingester, change);
      if (await this.persistence.write(payload, durable)) this.dirty = this.change !== change;
    }).catch(error => { console.warn(t("serverTokensStore.m002", { value1: safeError(error) })); }).finally(() => { if (this.dirty) this.scheduleWrite(); });
    return this.writes;
  }
  async close(): Promise<void> {
    if (this.closed) { await this.writes; return; }
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.writeTimer) clearTimeout(this.writeTimer);
    await this.ingester.close(); await this.ready; await this.flush(true);
  }
}
