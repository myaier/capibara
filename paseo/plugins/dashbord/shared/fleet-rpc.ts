import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Only these reads may fan out. A write must resolve to exactly one owning installation. */
export const FLEET_READS = [
  "observatory.stats.get", "observatory.tokens.get", "observatory.tokens.live", "observatory.telemetry.get",
  "observatory.analytics.get", "observatory.background.get", "observatory.live.get", "observatory.read-state.list",
  "observatory.providers.bases", "observatory.quota.get", "observatory.attention.get", "observatory.schedules.list", "observatory.schedules.heartbeats",
] as const;
export const FLEET_TRANSFERS = [...FLEET_READS, "observatory.tokens.copies", "observatory.agents.list"] as const;
export const listHostAgents = defineRpc({ name: "observatory.agents.list", input: z.object({
  filter: z.object({ includeArchived: z.boolean() }), page: z.object({ limit: z.number().int().min(1).max(200), cursor: z.string().optional() }),
}), output: z.object({ entries: z.array(z.object({ agent: z.any(), project: z.any().optional() })).max(200),
  pageInfo: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }) }) });
export const fleetPartSchema = z.object({ snapshotId: z.string(), index: z.number().int().nonnegative(),
  parts: z.number().int().positive(), json: z.string().max(40_000) });
export const readFleetSnapshot = defineRpc({ name: "observatory.fleet.read", input: z.object({
  method: z.enum(FLEET_TRANSFERS), input: z.record(z.string(), z.unknown()),
  maxPartBytes: z.number().int().min(1024).max(40_000).optional(),
}), output: fleetPartSchema });
export const readFleetPart = defineRpc({ name: "observatory.fleet.part", input: z.object({
  snapshotId: z.string().uuid(), index: z.number().int().nonnegative(),
}), output: fleetPartSchema });

export interface FleetCoverage {
  hosts: Array<{ id: string; label: string; state: "live" | "cached" | "missing"; collectedAt: number | null; error?: string }>;
  notes?: string[];
}
