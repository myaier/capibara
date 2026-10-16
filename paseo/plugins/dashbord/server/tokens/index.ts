import { randomUUID } from "node:crypto";
import { copyFingerprint, getTokenCopies, prepareTokenExclusion } from "../../shared/token-copies";
import type { LedgerCall } from "./types";
import { filterTokenData } from "./fleet-filter";
import type { PaseoApi } from "../paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { StatsDirectory } from "../stats-directory";
import { digestSchema } from "../../shared/digest";
import { getTokenLive, getTokens, type TokenSource } from "../../shared/tokens";
import { TokenStore, type TokenStoreOptions } from "./store";
import { buildTokenLive } from "./live";
import { LocalTokenCallSource } from "./source";

export interface TokenModule {
  /** 复盘's token calls, and 恢复后续跑's marker look-up in a session's own logs after a restart (server/resume). */
  source: LocalTokenCallSource;
  /** Looks for custom provider log roots in the daemon config (rate limited; safe to call on every hook). */
  discover(paseo: PaseoApi): void;
  close(): Promise<void>;
}

/**
 * The log sources 复盘 can show (its `tokens.source`, shared/digest): a session of another source is left out of its
 * token history rather than failing the whole digest, until that schema lists the source too.
 */
export const digestTokenSources = (): ReadonlySet<TokenSource> => new Set(digestSchema.shape.tokens.unwrap().shape.source.options);

/**
 * Background provider-log ingestion; RPC reads only project the in-memory ledger. `zones` (server/device-zone) learns the
 * device's time zone from the Token page's reads, as it does from the statistics pages'. `store`: roots, data directory
 * and clock for tests.
 */
export function registerTokens(server: PluginServerContext, deps: { directory: StatsDirectory; zones?: { note(zone: unknown): void }; store?: Omit<TokenStoreOptions, "agents"> }): TokenModule {
  const store = new TokenStore({ ...deps.store, agents: deps.directory });
  const copySource = new LocalTokenCallSource(store.ingester, store.initialized);
  const resolved = new Map<string, LedgerCall>();
  const exclusions = new Map<string, { at: number; calls: Map<string, LedgerCall> }>();
  const resolve = async (keys: string[]) => {
    await store.initialized;
    for (const key of keys) { const recent = store.data.mutable.get(key) ?? store.data.recent.get(key); if (recent) resolved.set(key, recent); }
    const unknown = keys.filter(key => !resolved.has(key));
    if (unknown.length) for (const call of await copySource.ledgerForKeys(unknown)) resolved.set(call.key, call);
    while (resolved.size > 200_000) resolved.delete(resolved.keys().next().value!);
    return keys.flatMap(key => resolved.has(key) ? [resolved.get(key)!] : []);
  };
  server.handle(getTokenCopies, async ({ keys }) => {
    const calls = await resolve(keys), present = new Set(calls.map(call => call.key));
    return { calls: calls.map(({ key, source, at, start, model, input, cacheWrite, cacheRead, output, reasoning, calls }) => ({ key, source, at, start, model, input, cacheWrite, cacheRead, output, reasoning, calls })), missing: keys.filter(key => !present.has(key)) };
  });
  server.handle(prepareTokenExclusion, async ({ keys, expected, id }) => {
    for (const [id, entry] of exclusions) if (Date.now() - entry.at > 120_000) exclusions.delete(id);
    if (id && !exclusions.has(id)) throw new Error("Token deduplication projection expired");
    const entry = id ? exclusions.get(id)! : { at: Date.now(), calls: new Map<string, LedgerCall>() }, nextId = id ?? randomUUID();
    const calls = await resolve(keys); for (const call of calls) if (copyFingerprint(call) === expected[call.key]) entry.calls.set(call.key, call); entry.at = Date.now();
    exclusions.set(nextId, entry); while (exclusions.size > 8) exclusions.delete(exclusions.keys().next().value!);
    return { id: nextId, missing: keys.filter(key => !entry.calls.has(key)) };
  });
  server.handle(getTokens, (input, { paseo }) => {
    deps.zones?.note(input.timeZone); void store.discover(paseo);
    const exclusion = input.exclusionId ? exclusions.get(input.exclusionId) : null;
    if (input.exclusionId && (!exclusion || Date.now() - exclusion.at > 120_000)) throw new Error("Token deduplication projection expired");
    if (exclusion && [...exclusion.calls.values()].some(call => { const current = store.data.mutable.get(call.key) ?? store.data.recent.get(call.key); return store.ingester.seen.get(call.key) !== call.at || current && copyFingerprint(current) !== copyFingerprint(call); })) throw new Error("Token copies changed; retry the projection");
    return store.read(input, paseo, exclusion ? [...exclusion.calls.values()] : []);
  });
  server.handle(getTokenLive, (input, { paseo }) => {
    deps.zones?.note(input.timeZone); void deps.directory.refresh(paseo); void store.discover(paseo);
    return buildTokenLive(input.filters ? filterTokenData(store.data, input.filters, deps.directory.agents, store.owners()) : store.data, input, Date.now(), deps.directory);
  });
  return { source: new LocalTokenCallSource(store.ingester, store.initialized, { sources: digestTokenSources() }), discover: paseo => { void store.discover(paseo); }, close: () => store.close() };
}
