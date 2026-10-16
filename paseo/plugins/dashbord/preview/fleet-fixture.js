import { listHostAgents } from "../shared/fleet-rpc";
import { getProviderBases } from "../shared/provider-bases";
import { hostRegistry } from "../client/host-registry";
import { fixtureRpc, fixturePaseo } from "./sdk-adapter";
import { rawAgents } from "./fixtures";
import { buildStatsSnapshot } from "../server/stats-snapshot";
import { emptyStatsMetrics } from "../shared/stats";
import { HOST_DATA_VERSION } from "../shared/host-data";
import * as stats from "../shared/stats";
import * as tokens from "../shared/tokens";
import * as telemetry from "../shared/telemetry";
import * as analytics from "../shared/analytics";
import * as background from "../shared/background";
import * as attention from "../shared/attention";
import * as receipts from "../shared/read-state";
import * as quota from "../shared/quota";
import * as schedules from "../shared/schedules";

export function setupFleetFixture() {
  const contracts = Object.values({ listHostAgents, getProviderBases, ...stats, ...tokens, ...telemetry, ...analytics, ...background, ...attention, ...receipts, ...quota, ...schedules }).filter(value => value?.name && value?.output);
  globalThis.__fleetPreviewHosts = [{ serverId: "mac", label: "MacBook Pro", status: "online" }, { serverId: "win", label: "WIN-DEMO-PC", status: "online" }];
  globalThis.__fleetPreviewClients = {};
  globalThis.__previewFleetCalls = [];
  globalThis.__previewFleetHostStatus = (id, status) => { globalThis.__fleetPreviewHosts = globalThis.__fleetPreviewHosts.map(host => host.serverId === id ? { ...host, status } : host); globalThis.dispatchEvent(new Event("fleet-hosts")); };
  for (const host of globalThis.__fleetPreviewHosts) {
    const agents = structuredClone(rawAgents.filter(agent => !agent.archivedAt && !agent.parentAgentId).slice(0, host.serverId === "mac" ? 3 : 2));
    for (const [i, agent] of agents.entries()) { agent.title = `${host.serverId === "mac" ? "Mac" : "Windows"} 会话 ${i + 1}`; agent.model = host.serverId === "mac" ? "mac-model" : "win-model"; agent.provider = host.serverId === "mac" ? "codex" : "claude"; agent.createdAt = new Date().toISOString(); }
    const ids = new Set(agents.map(agent => agent.id)), chunks = new Map();
    globalThis.__fleetPreviewClients[host.serverId] = { ...fixturePaseo, agents: { ...fixturePaseo.agents,
      list: async () => { throw new Error("Native directory transport unavailable in the fleet fixture"); },
      ref: id => ({ ...fixturePaseo.agents.ref(id), refresh: async () => ({ agent: agents.find(agent => agent.id === id), project: null }),
        archive: async () => { globalThis.__previewFleetCalls.push({ host: host.serverId, method: "archive", id }); agents.find(agent => agent.id === id).archivedAt = new Date().toISOString(); },
      }),
    } };
    const invoke = async (contract, input) => {
      globalThis.__previewFleetCalls.push({ host: host.serverId, method: contract.name, input });
      if (contract.name === "observatory.fleet.part") return { snapshotId: input.snapshotId, index: input.index, parts: chunks.get(input.snapshotId).length, json: chunks.get(input.snapshotId)[input.index] };
      if (contract.name === "observatory.fleet.read") {
        const target = contracts.find(contract => contract.name === input.method); if (!target) throw new Error(input.method);
        const data = await invoke(target, input.input), text = JSON.stringify(data), parts = [];
        for (let i = 0; i < text.length; i += 24000) parts.push(text.slice(i, i + 24000));
        const snapshotId = crypto.randomUUID(); chunks.set(snapshotId, parts); return { snapshotId, index: 0, parts: parts.length, json: parts[0] };
      }
      if (contract.name === "observatory.agents.list") return { entries: agents.filter(agent => input.filter?.includeArchived || !agent.archivedAt).map(agent => ({ agent })), pageInfo: { nextCursor: null, hasMore: false } };
      if (contract.name === "observatory.stats.get") {
        const now = Date.now(), stamp = new Date(now).toISOString();
        return { ...buildStatsSnapshot({ now, range: input.range, utcOffsetMinutes: input.utcOffsetMinutes, timeZone: input.timeZone, complete: true, filters: input.filters,
          hours: [{ ...emptyStatsMetrics(), hour: stamp, turns: agents.length * 2 }], toolHours: [], attributions: agents.map(agent => ({ ...emptyStatsMetrics(), agentId: agent.id, hour: stamp, lastActiveAt: stamp, turns: 2 })), records: [], running: new Map(), observedSince: stamp, contentSince: stamp, directoryTruncated: false,
          directory: agents.map(agent => ({ id: agent.id, title: agent.title, createdAt: stamp, provider: agent.provider, model: agent.model, parentAgentId: null,
            projectKey: agent.projectId || agent.projectRootPath || agent.projectName, projectName: agent.projectName, status: agent.status, archivedAt: agent.archivedAt, requiresAttention: false, attentionReason: null, pendingPermissions: 0, activeTurn: false, contextUsed: null, contextMax: null })) }), mode: "full", unchanged: false, revision: `fixture:${now}` };
      }
      const result = await fixtureRpc(contract, input);
      if (result.agents) result.agents = result.agents.filter(agent => ids.has(agent.agentId));
      if (result.events) result.events = result.events.filter(event => ids.has(event.agentId));
      if (result.receipts) result.receipts = result.receipts.filter(receipt => ids.has(receipt.agentId));
      if (contract.name === "observatory.tokens.get") result.fleetDetails = { speedBins: [], filtered: false, sessionDetailLimited: false, dedupeKeys: [] };
      return result;
    };
    hostRegistry.register({ serverId: host.serverId, hostname: host.label, protocol: 1, version: HOST_DATA_VERSION, capabilities: ["fleet-read-v1", "fleet-directory-v1"], now: new Date().toISOString(), nonce: "" }, invoke);
  }
}
