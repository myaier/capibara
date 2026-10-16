import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { buildProjectIdentities, resolveProjectIdentity, type ProjectIdentitySource } from "../shared/project-identity";
import { parseHostEntityId } from "../shared/fleet-scope";

/** A project's Paseo look: the fill of its mark, and its discovered or uploaded icon when the host has one. */
export interface ProjectIdentityView { color: string; icon: string | null }
export type ProjectIdentityResolver = (serverId: string | null, projectRef: string | null | undefined) => ProjectIdentityView | null;

/**
 * Where an agent's project lives and what references it, undoing the fleet's host-qualified id (shared/fleet-scope.ts)
 * when present; `fallbackHost` covers plain ids in the single-host view.
 */
export function agentProjectRef(projectId: string | null | undefined, fallbackHost: string | null): { serverId: string | null; ref: string | null } {
  const qualified = projectId ? parseHostEntityId(projectId) : null;
  return { serverId: qualified?.hostId ?? fallbackHost, ref: qualified?.id ?? projectId ?? null };
}

interface ProjectsApi {
  listProjects(): Promise<{ projects?: ProjectIdentitySource[] }>;
  getProjectIcon(projectId: string): Promise<{ icon: { data: string; mimeType: string } | null }>;
  requestProjectIcon(cwd: string): Promise<{ icon: { data: string; mimeType: string } | null }>;
}
interface HostProjects {
  identities: ReturnType<typeof buildProjectIdentities> | null;
  /** projectId → data URI of the fetched icon (failures are simply absent). */
  icons: Map<string, string>;
  /** projectId → the icon revision already fetched, so a list refresh refetches only changed icons. */
  fetchedRevisions: Map<string, string>;
  loading: boolean;
  lastRead: number;
}

const REFRESH_MS = 5 * 60_000;
const dataUri = (icon: { data: string; mimeType: string } | null): string | null => icon ? `data:${icon.mimeType};base64,${icon.data}` : null;

/**
 * Watches the app's hosts and reads each one's project list, so sessions can wear their project's Paseo color and icon.
 * Reads are per host and lazy: a host is read when it comes online and then every few minutes; icons are fetched once
 * per revision. Any failure (an older daemon, a refused read) leaves the project unresolved and the caller falls back
 * to the previous name-hash color.
 */
export function createProjectIdentityStore(acquire: (serverId: string) => ProjectsApi | null, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const hosts = new Map<string, HostProjects>();
  const listeners = new Set<() => void>();
  let version = 0;
  const publish = () => { version++; for (const listener of listeners) listener(); };

  async function fetchIcon(api: ProjectsApi, projectId: string, iconWorkingDir: string | null): Promise<string | null> {
    try { const uri = dataUri((await api.getProjectIcon(projectId)).icon); if (uri) return uri; } catch { /* an older daemon answers only the legacy lookup */ }
    if (iconWorkingDir) { try { return dataUri((await api.requestProjectIcon(iconWorkingDir)).icon); } catch { /* no icon, or the host went away */ } }
    return null;
  }

  async function refresh(serverId: string) {
    const state = hosts.get(serverId);
    if (!state || state.loading) return;
    state.loading = true;
    try {
      const api = acquire(serverId);
      if (!api) return;
      const result = await api.listProjects();
      if (hosts.get(serverId) !== state) return;
      state.identities = buildProjectIdentities(serverId, result.projects ?? []);
      state.lastRead = now();
      publish();
      for (const identity of state.identities.byId.values()) {
        if (!identity.iconRevision || state.fetchedRevisions.get(identity.projectId) === identity.iconRevision) continue;
        state.fetchedRevisions.set(identity.projectId, identity.iconRevision);
        void fetchIcon(api, identity.projectId, identity.iconWorkingDir).then(uri => {
          if (uri && hosts.get(serverId) === state) { state.icons.set(identity.projectId, uri); publish(); }
        });
      }
    } catch { /* an offline host or an older daemon: unresolved projects keep the fallback color */ }
    finally { state.loading = false; }
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getVersion: () => version,
    setHosts(list: readonly { serverId: string; status: string }[]) {
      const ids = new Set(list.map(host => host.serverId));
      for (const id of [...hosts.keys()]) if (!ids.has(id)) hosts.delete(id);
      for (const host of list) {
        if (host.status !== "online") continue;
        let state = hosts.get(host.serverId);
        if (!state) { state = { identities: null, icons: new Map(), fetchedRevisions: new Map(), loading: false, lastRead: 0 }; hosts.set(host.serverId, state); }
        if (now() - state.lastRead >= REFRESH_MS || state.lastRead === 0) void refresh(host.serverId);
      }
    },
    refreshOnline() { for (const id of hosts.keys()) void refresh(id); },
    resolve: ((serverId, projectRef) => {
      const state = serverId ? hosts.get(serverId) : null;
      const identity = resolveProjectIdentity(state?.identities ?? null, projectRef);
      return identity ? { color: identity.color, icon: state?.icons.get(identity.projectId) ?? null } : null;
    }) as ProjectIdentityResolver,
  };
}

let shared: ReturnType<typeof createProjectIdentityStore> | null = null;
/** One store per running client bundle, shared by every surface so each host's projects are read once. */
export function sharedProjectIdentityStore() {
  shared ??= createProjectIdentityStore(serverId => { try { return getPaseoClient(serverId) as unknown as ProjectsApi; } catch { return null; } });
  return shared;
}

const ProjectIdentityContext = createContext<ProjectIdentityResolver>(() => null);

export function ProjectIdentityProvider({ children }: { children: ReactNode }) {
  const hosts = useHosts();
  const store = useMemo(() => sharedProjectIdentityStore(), []);
  // Use values rather than the array identity: app providers may return an equivalent fresh array.
  const identity = JSON.stringify(hosts.map(host => [host.serverId, host.status]));
  useEffect(() => { store.setHosts(hosts); }, [store, identity]);
  useEffect(() => { const timer = setInterval(() => store.refreshOnline(), REFRESH_MS); return () => clearInterval(timer); }, [store]);
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // A fresh resolver identity per data version re-renders consumers; the function itself reads the store's live maps.
  const resolver = useMemo<ProjectIdentityResolver>(() => store.resolve, [store, version]);
  return <ProjectIdentityContext.Provider value={resolver}>{children}</ProjectIdentityContext.Provider>;
}

/** The resolver for the nearest provider; without one every project keeps its fallback look. */
export function useProjectIdentityResolver(): ProjectIdentityResolver {
  return useContext(ProjectIdentityContext);
}
export function useProjectIdentity(serverId: string | null, projectRef: string | null | undefined): ProjectIdentityView | null {
  return useContext(ProjectIdentityContext)(serverId, projectRef);
}
