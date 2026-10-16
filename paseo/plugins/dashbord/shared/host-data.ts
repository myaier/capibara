import { OBSERVATORY_VERSION } from "./plugin-update";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const HOST_DATA_PROTOCOL = 1;
export const HOST_DATA_VERSION = OBSERVATORY_VERSION;
export const hostIdentitySchema = z.object({
  serverId: z.string().min(1).max(256), hostname: z.string().max(256),
  protocol: z.literal(HOST_DATA_PROTOCOL), version: z.string().max(80),
  capabilities: z.array(z.string().max(64)).max(32),
  now: z.iso.datetime(), nonce: z.string().max(128),
});
export type HostIdentity = z.infer<typeof hostIdentitySchema>;
export const getHostIdentity = defineRpc({ name: "observatory.host.identity",
  input: z.object({ nonce: z.string().max(128).default("") }), output: hostIdentitySchema });

export const peerProbeSchema = z.object({ serverId: z.string().min(1).max(256),
  version: z.string().max(80).nullable(), ok: z.boolean(), error: z.string().max(240).nullable() });
export const hostDiagnosticsSchema = z.object({
  reporterId: z.string().max(256), at: z.iso.datetime().nullable(), peers: z.array(peerProbeSchema).max(64),
});
export const reportHostDiagnostics = defineRpc({ name: "observatory.host.diagnostics.report",
  input: hostDiagnosticsSchema.omit({ at: true }), output: z.object({ accepted: z.boolean() }) });
export const getHostDiagnostics = defineRpc({ name: "observatory.host.diagnostics.get",
  input: z.object({}), output: hostDiagnosticsSchema });
