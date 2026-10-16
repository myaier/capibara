import { isInternalAgent } from "./internal-agents";
import { createAgentDirectory, type AgentDirectoryApi, type ObservatoryState } from "./directory-store";
import type { AgentRecord } from "./model";

export interface ObservatoryHost {
  serverId: string;
  label: string;
  status: "idle" | "connecting" | "online" | "offline" | "error";
}
export interface HostedAgent {
  serverId: string;
  agentId: string;
  hostLabel: string;
  /** Namespaced display identity. Never send this ID to a daemon. */
  agent: AgentRecord;
}
export interface HostDirectoryState {
  host: ObservatoryHost;
  directory: ObservatoryState;
}
export interface MultiHostState { hosts: readonly HostDirectoryState[] }
export const hostRecordKey = (host: string, id: string): string => JSON.stringify([host, id]);

export function hostedAgent(host: ObservatoryHost, agent: AgentRecord): HostedAgent {
  return { serverId: host.serverId, agentId: agent.id, hostLabel: host.label, agent: {
    ...agent, id: hostRecordKey(host.serverId, agent.id),
    parentAgentId: agent.parentAgentId ? hostRecordKey(host.serverId, agent.parentAgentId) : null,
    projectId: hostRecordKey(host.serverId, agent.projectId || agent.projectRootPath || agent.projectName),
    workspaceId: agent.workspaceId ? hostRecordKey(host.serverId, agent.workspaceId) : null,
  } };
}

/** All-host results exclude disconnected caches; selecting an offline host may show its clearly labelled cache. */
export function hostedAgents(state: MultiHostState, selectedHost = "all"): HostedAgent[] {
  return state.hosts.flatMap(({ host, directory }) => {
    if (selectedHost === "all" ? host.status !== "online" : host.serverId !== selectedHost) return [];
    return directory.agents.filter(agent => !isInternalAgent(agent)).map(agent => hostedAgent(host, agent));
  });
}

export type OpenHostedResult = "opened" | "offline" | "unavailable";
export function openHostedAgent(target: Pick<HostedAgent, "serverId" | "agentId">, hosts: readonly ObservatoryHost[],
  navigation?: { openAgent(input: { agentId: string; serverId: string }): void }): OpenHostedResult {
  if (!hosts.some(host => host.serverId === target.serverId && host.status === "online")) return "offline";
  if (!navigation) return "unavailable";
  navigation.openAgent({ agentId: target.agentId, serverId: target.serverId });
  return "opened";
}

type Directory = ReturnType<typeof createAgentDirectory>;
export type HostApi = AgentDirectoryApi;
interface Entry { host: ObservatoryHost; api: HostApi | null; directory: Directory | null; detach: (() => void) | null; state: ObservatoryState }
const blank = (): ObservatoryState => ({ agents: [], loading: true, error: null, lastSyncedAt: null, isRefreshing: false, truncated: false, live: false });

/** Owns only directory subscriptions, never the app's authenticated clients or connection lifecycle. */
export function createMultiHostDirectory(acquire: (serverId: string) => HostApi, options: { includeArchived: boolean; connectionCheckMs?: number }) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot: MultiHostState = { hosts: [] };
  let running = false, active = true;
  let timer: ReturnType<typeof setInterval> | null = null;

  function publish() {
    snapshot = { hosts: [...entries.values()].map(entry => ({ host: entry.host, directory: entry.state })) };
    for (const listener of listeners) listener();
  }
  function release(entry: Entry) {
    entry.detach?.(); entry.detach = null;
    entry.directory?.stop(); entry.directory = null; entry.api = null;
    entry.state = { ...entry.state, live: false, isRefreshing: false };
  }
  function connect(entry: Entry, force = false) {
    if (!running || !active || entry.host.status !== "online") return;
    try {
      const api = acquire(entry.host.serverId);
      if (!force && entry.api === api && entry.directory) return;
      // A new app connection invalidates old clients even if its status never visibly left online.
      release(entry);
      const directory = createAgentDirectory(api, { includeArchived: options.includeArchived });
      entry.api = api; entry.directory = directory;
      entry.state = { ...entry.state, loading: true, error: null };
      entry.detach = directory.subscribe(() => {
        if (!running || entries.get(entry.host.serverId) !== entry || entry.directory !== directory) return;
        const next = directory.getSnapshot();
        // Keep a prior successful snapshot visible while reconnecting, with loading/error state intact.
        entry.state = !next.lastSyncedAt && entry.state.lastSyncedAt
          ? { ...next, agents: entry.state.agents, lastSyncedAt: entry.state.lastSyncedAt }
          : next;
        publish();
      });
      directory.start(true);
    } catch (error) {
      release(entry);
      entry.state = { ...entry.state, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  function checkConnections() {
    if (!running || !active) return;
    for (const entry of entries.values()) connect(entry);
    publish();
  }
  function setTimer() {
    if (timer !== null) clearInterval(timer);
    timer = running && active ? setInterval(checkConnections, options.connectionCheckMs ?? 15_000) : null;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setHosts(hosts: readonly ObservatoryHost[]) {
      const ids = new Set(hosts.map(host => host.serverId));
      for (const [id, entry] of entries) if (!ids.has(id)) { release(entry); entries.delete(id); }
      for (const host of hosts) {
        let entry = entries.get(host.serverId);
        const previous = entry?.host.status;
        if (!entry) { entry = { host, api: null, directory: null, detach: null, state: blank() }; entries.set(host.serverId, entry); }
        else entry.host = host;
        if (host.status !== "online") { release(entry); entry.state = { ...entry.state, loading: false }; }
        else connect(entry, previous !== "online");
      }
      publish();
    },
    start(foreground = true) { running = true; active = foreground; checkConnections(); setTimer(); },
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      for (const entry of entries.values()) entry.directory?.setActive(value && entry.host.status === "online");
      if (value) checkConnections();
      setTimer(); publish();
    },
    async refresh() {
      if (!running || !active) return;
      checkConnections();
      await Promise.allSettled([...entries.values()].filter(entry => entry.host.status === "online").map(entry => entry.directory?.refresh()));
      publish();
    },
    stop() {
      running = false;
      setTimer();
      for (const entry of entries.values()) release(entry);
      publish();
    },
  };
}
