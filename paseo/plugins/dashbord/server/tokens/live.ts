import { tokenInput, tokenTotal, type TokenLive, type TokenLiveAgent } from "../../shared/tokens";
import type { StatsDirectory } from "../stats-directory";
import { statsLocalDay, statsZone, type StatsDirectoryAgent } from "../stats-types";
import { modelCalls, rootSession, sessionKey, type TokenData } from "./data";
import { iso, type LedgerCall } from "./types";
import { outputPortion as portion, spreadOutput as spread } from "../../shared/token-live";

const BUCKET = 10_000;
const bucketOf = (at: number): number => Math.floor(at / BUCKET) * BUCKET;
function text(value: string | null): string | null {
  if (value === null || Buffer.byteLength(value) <= 96) return value;
  let result = "";
  for (const char of value) { if (Buffer.byteLength(result + char) > 93) break; result += char; }
  return result + "…";
}

/**
 * Pure in-memory projection. Directory refresh is deliberately outside this latency-critical path. `today` starts at the
 * device's local midnight (2.14: its IANA zone when known, as on the Token page), counting each UTC hour on the local
 * day it starts in.
 */
export function buildTokenLive(data: TokenData, input: { complete?: boolean; windowMinutes: 30 | 60; utcOffsetMinutes: number; timeZone?: string | null; detail: "full" | "agents" },
  now: number, directory: StatsDirectory): TokenLive {
  const count = input.windowMinutes * 6, start = bucketOf(now) - (count - 1) * BUCKET, miniStart = bucketOf(now) - 11 * BUCKET;
  const output = input.detail === "full" ? Array<number>(count).fill(0) : [], read = output.map(() => 0), calls = output.map(() => 0);
  const zone = statsZone(input.utcOffsetMinutes, input.timeZone, now), localDay = statsLocalDay(now, zone), today = { total: 0, output: 0, calls: 0 };
  for (const bucket of data.hours.values()) if (bucket.at <= now && statsLocalDay(bucket.at, zone) === localDay) {
    today.total += tokenTotal(bucket); today.output += bucket.output; today.calls += bucket.calls;
  }
  const agents = new Map<string, StatsDirectoryAgent>();
  for (const agent of directory.agents) if (agent.sessionId) {
    const prior = agents.get(agent.sessionId);
    if (!prior || agent.createdAt > prior.createdAt) agents.set(agent.sessionId, agent);
  }
  const rows = new Map<string, TokenLiveAgent>();
  const samples: NonNullable<TokenLive["fleetSamples"]> = [];
  let nowOutput = 0, nowInput = 0, nowCalls = 0;
  for (const call of data.recent.values()) {
    // A Grok record is a whole turn, logged when it ends with no response time: dropped into one 10 s bucket it would read
    // as a burst of thousands of tokens per second. It counts in today's totals (the hour buckets), not in the live speed.
    if (call.at > now || call.source === "grok") continue;
    if (input.complete) {
      const root = rootSession(data, call.source, call.sessionId), agent = agents.get(root);
      samples.push({ key: call.key, at: call.at, start: call.start, output: call.output, input: tokenInput(call), calls: modelCalls(call),
        source: call.source, sessionId: root, agentId: agent?.id ?? null, title: text(agent?.title ?? null), model: text(call.model) });
    }
    const endIndex = Math.floor((call.at - start) / BUCKET);
    if (input.detail === "full") {
      spread(call, start, output);
      if (endIndex >= 0 && endIndex < count) { read[endIndex] += tokenInput(call); calls[endIndex] += modelCalls(call); }
    }
    if (call.at >= now - 60_000) {
      nowOutput += portion(call, now - 60_000, now); nowInput += tokenInput(call); nowCalls += modelCalls(call);
    }
    if (call.at < now - 600_000) continue;
    // A Codex subagent thread's output shows on its parent session's row.
    const root = rootSession(data, call.source, call.sessionId), key = sessionKey(call.source, root), agent = agents.get(root);
    let row = rows.get(key);
    if (!row) {
      row = { sessionId: root, source: call.source, agentId: agent?.id ?? null, title: text(agent?.title ?? null), model: text(call.model),
        outputPerSec: 0, recent: Array<number>(12).fill(0), output10m: 0, calls10m: 0, lastCallAt: iso(call.at) };
      rows.set(key, row);
    }
    row.output10m += call.output; row.calls10m += modelCalls(call);
    row.outputPerSec += portion(call, now - 120_000, now) / 120;
    spread(call, miniStart, row.recent);
    if (iso(call.at) >= row.lastCallAt) { row.lastCallAt = iso(call.at); row.model = text(call.model); }
  }
  let peak: TokenLive["peak"] = null;
  if (input.detail === "full") for (let i = 0; i < output.length; i++) {
    if (output[i] > (peak?.outputPerSec ?? 0) * 10) peak = { outputPerSec: output[i] / 10, at: iso(start + i * BUCKET) };
  }
  const result: TokenLive = { ...(input.complete ? { fleetSamples: samples } : {}), generatedAt: iso(now), bucketMs: BUCKET, start: iso(start), output, input: read, calls,
    now: { outputPerSec: nowOutput / 60, inputPerSec: nowInput / 60, callsPerMin: nowCalls }, peak,
    agents: [...rows.values()].sort((a, b) => b.outputPerSec - a.outputPerSec || b.lastCallAt.localeCompare(a.lastCallAt) || a.sessionId.localeCompare(b.sessionId)).slice(0, input.complete ? Infinity : 12), today };
  while (!input.complete && result.agents.length && Buffer.byteLength(JSON.stringify(result)) >= 11_900) result.agents.pop();
  return result;
}
