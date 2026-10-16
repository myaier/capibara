import { randomUUID } from "node:crypto";
import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ZodType } from "zod";
import { FLEET_TRANSFERS, listHostAgents, readFleetPart, readFleetSnapshot } from "../shared/fleet-rpc";
import { getFleetDiagnostics, reportFleetDiagnostic } from "../shared/fleet-diagnostics";

/** Snapshot pages are immutable: no mixing revisions while fetching a large ledger over the relay. */
export function withFleetReads(host: PluginServerContext, now = Date.now) {
  const handlers = new Map<string, { input: ZodType; read: (input: any, context: PluginHandlerContext) => unknown }>();
  const snapshots = new Map<string, { at: number; parts: string[]; bytes: number }>();
  let disposed = false;
  const diagnostics = new Map<string, any>();
  host.handle(reportFleetDiagnostic, input => { diagnostics.set(input.method, input); while (diagnostics.size > 16) diagnostics.delete(diagnostics.keys().next().value!); return { ok: true }; });
  host.handle(getFleetDiagnostics, () => [...diagnostics.values()]);
  const prune = () => {
    for (const [id, value] of snapshots) if (now() - value.at > 120_000) snapshots.delete(id);
    while (snapshots.size > 16 || [...snapshots.values()].reduce((sum, value) => sum + value.bytes, 0) > 32 * 1024 * 1024) snapshots.delete(snapshots.keys().next().value!);
  };
  const part = (snapshotId: string, index: number) => {
    prune(); const value = snapshots.get(snapshotId);
    if (disposed || !value || index >= value.parts.length) throw new Error("Fleet snapshot expired; retry the read");
    return { snapshotId, index, parts: value.parts.length, json: value.parts[index]! };
  };
  host.handle(readFleetSnapshot, async ({ method, input, maxPartBytes }, context) => {
    if (disposed) throw new Error("Fleet reader is closed");
    const handler = handlers.get(method);
    if (!handler) throw new Error("This installation does not support the requested fleet read");
    const result = await handler.read(handler.input.parse(input), context);
    const json = JSON.stringify(result), encoded = Buffer.from(json), bytes = encoded.length;
    if (bytes > 16 * 1024 * 1024) throw new Error("Fleet snapshot exceeds 16 MiB; narrow the business filters");
    const parts: string[] = [];
    // At most 40k UTF-8 bytes, 80k after JSON escaping. Never split a UTF-8 code point.
    for (let start = 0; start < bytes;) {
      let end = Math.min(start + (maxPartBytes ?? 24_000), bytes);
      while (end < bytes && (encoded[end] & 0xc0) === 0x80) end--;
      parts.push(encoded.subarray(start, end).toString("utf8")); start = end;
    }
    const snapshotId = randomUUID(); snapshots.set(snapshotId, { at: now(), parts, bytes });
    return part(snapshotId, 0);
  });
  host.handle(readFleetPart, ({ snapshotId, index }) => part(snapshotId, index));
  const server: PluginServerContext = { ...host, handle(contract, handler) {
    if ((FLEET_TRANSFERS as readonly string[]).includes(contract.name)) handlers.set(contract.name, { input: contract.input, read: handler });
    host.handle(contract, handler);
  } };
  server.handle(listHostAgents, (input, { paseo }) => paseo.agents.list({ ...input, sort: [{ key: "updated_at", direction: "desc" }], timeout: 30_000 }));
  return { server, close() { disposed = true; handlers.clear(); snapshots.clear(); diagnostics.clear(); } };
}
