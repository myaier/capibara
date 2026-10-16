import { listHostAgents } from "../shared/fleet-rpc";
import { getProviderBases } from "../shared/provider-bases";
import { hostRegistry } from "../client/host-registry";
import { fixtureRpc, fixturePaseo, previewUpdateRpc, previewUpdateState } from "./sdk-adapter";
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

/**
 * Two installed machines. With `uninstalled`, a third connected host runs no observatory and a fourth is offline, last seen three
 * days ago on an older version. The third host's config says the plugin is not installed, or with `hostsCase=` `disabled`,
 * `too-old` (installed and enabled but never registers) or `plugins-off`; its terminal command reports success on the second read,
 * then the host registers at the newest revision (`hostsCase=no-cli` makes the command fail instead).
 */
export function setupFleetFixture({ uninstalled = false } = {}) {
  const contracts = Object.values({ listHostAgents, getProviderBases, ...stats, ...tokens, ...telemetry, ...analytics, ...background, ...attention, ...receipts, ...quota, ...schedules }).filter(value => value?.name && value?.output);
  globalThis.__fleetPreviewHosts = [{ serverId: "mac", label: "MacBook Pro", status: "online" }, { serverId: "win", label: "WIN-DEMO-PC", status: "online" },
    ...(uninstalled ? [{ serverId: "build", label: "BUILD-DEMO", status: "online" }, { serverId: "old", label: "OLD-DEMO-PC", status: "offline" }] : [])];
  globalThis.__fleetPreviewClients = {};
  globalThis.__previewFleetCalls = [];
  globalThis.__previewPageHost = "mac";
  globalThis.__previewFleetHostStatus = (id, status) => { globalThis.__fleetPreviewHosts = globalThis.__fleetPreviewHosts.map(host => host.serverId === id ? { ...host, status } : host); globalThis.dispatchEvent(new Event("fleet-hosts")); };
  // Each installation has its own update service; this page's (mac) is also the one the native useRpc stand-in answers.
  const updates = { mac: globalThis.__previewUpdate = previewUpdateState(uninstalled ? "update-available" : "fleet") };
  updates.win = structuredClone(updates.mac);
  for (const host of globalThis.__fleetPreviewHosts.filter(host => host.serverId !== "build")) {
    const agents = structuredClone(rawAgents.filter(agent => !agent.archivedAt && !agent.parentAgentId).slice(0, host.serverId === "mac" ? 3 : 2));
    for (const [i, agent] of agents.entries()) { agent.title = `${host.serverId === "mac" ? "Mac" : "Windows"} 会话 ${i + 1}`; agent.model = host.serverId === "mac" ? "mac-model" : "win-model"; agent.provider = host.serverId === "mac" ? "codex" : "claude"; agent.createdAt = new Date().toISOString(); }
    globalThis.__fleetPreviewClients[host.serverId] = { ...fixturePaseo, agents: { ...fixturePaseo.agents,
      list: async () => { throw new Error("Native directory transport unavailable in the fleet fixture"); },
      ref: id => ({ ...fixturePaseo.agents.ref(id), refresh: async () => ({ agent: agents.find(agent => agent.id === id), project: null }),
        archive: async () => { globalThis.__previewFleetCalls.push({ host: host.serverId, method: "archive", id }); agents.find(agent => agent.id === id).archivedAt = new Date().toISOString(); },
      }),
    } };
    hostRegistry.register({ serverId: host.serverId, hostname: host.label, protocol: 1, version: HOST_DATA_VERSION, capabilities: ["fleet-read-v1", "fleet-directory-v1"], now: new Date().toISOString(), nonce: "" },
      hostInvoke(host, agents, updates[host.serverId], contracts));
  }
  if (uninstalled) {
    setupUninstalledHost(contracts);
    // This page's installation remembers the offline host from three days ago, on the version before the newest.
    globalThis.__previewHostMemory = [{ serverId: "old", label: "OLD-DEMO-PC", version: "2.18.0-dev.10", revision: updates.mac.revision,
      seenAt: new Date(Date.now() - 3 * 86_400_000 - 3_600_000).toISOString() }];
  }
}

function setupUninstalledHost(contracts) {
  const host = { serverId: "build", label: "BUILD-DEMO" }, latest = previewUpdateState("fleet");
  Object.assign(latest, { version: "2.18.0-dev.11", revision: "8e1f2c3d4b5a69788796a5b4c3d2e1f00a1b2c3d" });
  const situation = new URLSearchParams(location.search).get("hostsCase");
  let installed = false;
  globalThis.__previewTerminals = [];
  globalThis.__previewConfigReads = [];
  globalThis.__fleetPreviewClients.build = { ...fixturePaseo,
    agents: { ...fixturePaseo.agents, list: async () => ({ entries: [], pageInfo: { nextCursor: null, hasMore: false } }) },
    // Like a daemon config, it carries provider settings next to the plugin entries; the panel keeps only the plugin flags.
    config: { get: async () => {
      globalThis.__previewConfigReads.push(host.serverId);
      const entry = installed || ["disabled", "too-old", "plugins-off"].includes(situation)
        ? { "agent-observatory": { source: "directory", path: "C:\\Users\\demo\\.paseo\\plugins\\agent-observatory", ...(situation === "disabled" && !installed ? { enabled: false } : {}) } } : {};
      return { requestId: "fixture-config", config: { pluginsEnabled: situation !== "plugins-off", providers: { claude: { env: { ANTHROPIC_API_KEY: "demo-not-a-key" } } }, plugins: entry } };
    } },
    workspaces: { list: async () => ({ requestId: "fixture-workspaces", entries: [{ id: "ws-build", projectRootPath: "C:\\Users\\demo\\repo", workspaceDirectory: "C:\\Users\\demo\\repo", archivingAt: null }],
      pageInfo: { nextCursor: null, prevCursor: null } }) },
    terminals: { create: async options => {
      const record = { host: host.serverId, options, polls: 0, killed: false };
      globalThis.__previewTerminals.push(record);
      const failure = situation === "no-cli";
      return { id: `term-build-${globalThis.__previewTerminals.length}`, kill: async () => { record.killed = true; }, capture: async () => {
        record.polls += 1;
        if (failure) return { terminalId: "term-build", totalLines: 1, lines: ["'paseo' is not recognized as an internal or external command,", "__OBSERVATORY_HOST_COMMAND__ no-cli"] };
        if (record.polls < 2) return { terminalId: "term-build", totalLines: 1, lines: ["Cloning https://github.com/myaier/capibara.git"] };
        if (!installed) {
          installed = true;
          // The host's daemon starts the new installation, which registers with this client a moment later.
          setTimeout(() => hostRegistry.register({ serverId: host.serverId, hostname: host.label, protocol: 1, version: latest.version, capabilities: ["fleet-read-v1", "fleet-directory-v1"], now: new Date().toISOString(), nonce: "" },
            hostInvoke(host, [], latest, contracts)), 400);
        }
        return { terminalId: "term-build", totalLines: 3, lines: ["Cloning https://github.com/myaier/capibara.git", "Installed agent-observatory", "__OBSERVATORY_HOST_COMMAND__ ok"] };
      } };
    } },
  };
}

function hostInvoke(host, agents, update, contracts) {
  const ids = new Set(agents.map(agent => agent.id)), chunks = new Map();
  const invoke = async (contract, input) => {
      globalThis.__previewFleetCalls.push({ host: host.serverId, method: contract.name, input });
      if (contract.name.startsWith("observatory.update.")) return previewUpdateRpc(update, contract, input, { host: host.serverId });
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
  return invoke;
}
