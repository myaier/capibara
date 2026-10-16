import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const counters = z.record(z.string().max(80), z.number().finite().nullable());
export const fleetDiagnosticSchema = z.object({ method: z.string().max(100), at: z.iso.datetime(), complete: z.boolean(),
  sources: z.array(z.object({ serverId: z.string().max(256), generatedAt: z.string().nullable(), counters })).max(64), counters,
});
/** Last displayed numeric rollups only, held in memory for troubleshooting. No messages or credentials. */
export const reportFleetDiagnostic = defineRpc({ name: "observatory.fleet.diagnostics.report", input: fleetDiagnosticSchema, output: z.object({ ok: z.boolean() }) });
export const getFleetDiagnostics = defineRpc({ name: "observatory.fleet.diagnostics.get", input: z.object({}), output: z.array(fleetDiagnosticSchema).max(16) });
export function fleetCounters(method: string, data: any): Record<string, number | null> {
  const pick = (value: any) => Object.fromEntries(Object.entries(value ?? {}).filter(([, value]) => value === null || typeof value === "number")) as Record<string, number | null>;
  if (method === "observatory.stats.get") return { ...pick(data.totals), ...Object.fromEntries(Object.entries(pick(data.live)).map(([key, value]) => [`live.${key}`, value])) };
  if (method === "observatory.tokens.get") return pick(data.totals);
  if (method === "observatory.tokens.live") return pick(data.now);
  if (method === "observatory.schedules.list") return { runs: data.runs?.length ?? 0, ...pick(data.week) };
  return { ...(data.agents ? { agents: data.agents.length } : {}), ...(data.events ? { events: data.events.length } : {}) };
}
