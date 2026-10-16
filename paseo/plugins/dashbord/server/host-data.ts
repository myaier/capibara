import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getHostDiagnostics, getHostIdentity, HOST_DATA_PROTOCOL, HOST_DATA_VERSION, reportHostDiagnostics,
  type HostIdentity } from "../shared/host-data";
import { resolvePaseoHome } from "./paseo-home";

export async function readHostIdentity(home = resolvePaseoHome(), nonce = ""): Promise<HostIdentity> {
  const serverId = (await readFile(join(home, "server-id"), "utf8")).trim();
  if (!serverId || serverId.length > 256) throw new Error("Paseo server identity is unavailable");
  return { serverId, hostname: hostname(), protocol: HOST_DATA_PROTOCOL, version: HOST_DATA_VERSION,
    capabilities: ["identity", "host-rpc", "fleet-read-v1", "fleet-directory-v1"], now: new Date().toISOString(), nonce };
}

export function registerHostData(server: PluginServerContext, home?: string) {
  let closed = false;
  const liveIdentity = async (nonce = "") => {
    if (closed) throw new Error("Host data service is disposed");
    const info = await readHostIdentity(home, nonce);
    if (closed) throw new Error("Host data service is disposed");
    return info;
  };
  let diagnostics: { reporterId: string; at: string | null; peers: Array<{ serverId: string; version: string | null; ok: boolean; error: string | null }> }
    = { reporterId: "", at: null, peers: [] };
    server.handle(getHostIdentity, input => liveIdentity(input.nonce));
    server.handle(reportHostDiagnostics, async input => {
      const identity = await liveIdentity();
      if (input.reporterId !== identity.serverId) throw new Error("Diagnostics reporter belongs to another host");
      diagnostics = { ...input, at: new Date().toISOString() };
      return { accepted: true };
    });
    server.handle(getHostDiagnostics, async () => ({ ...diagnostics, reporterId: (await liveIdentity()).serverId }));
  // Paseo owns RPC registration teardown; handle() does not return an unregister callback.
  return () => { closed = true; diagnostics = { reporterId: "", at: null, peers: [] }; };
}
