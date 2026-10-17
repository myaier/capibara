import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createAgentDirectory } from "../shared/directory-store";
import { isForeground } from "./use-foreground";
import { useFleet } from "./fleet-client";
import { useMultiHostDirectory } from "./use-multi-host";
import { fleetAgent } from "../shared/fleet-entities";

type Directory = ReturnType<typeof createAgentDirectory>;
interface Shared { directory: Directory; users: number; release: ReturnType<typeof setTimeout> | null; appState: { remove(): void } | null; stopped: boolean }
type Paseo = ReturnType<typeof usePaseo>;

/**
 * One directory per host connection and archive scope, shared by the page, the workspace panel and anything else open at
 * the same time (opus-F7): one observation and one paged read instead of one per view. A page switch remounts within
 * moments, so the last user keeps it a little longer instead of re-reading every Agent.
 */
const shared = new WeakMap<Paseo, Map<boolean, Shared>>();
const LINGER_MS = 15_000;

function sharedDirectory(paseo: Paseo, includeArchived: boolean): Shared {
  let scopes = shared.get(paseo);
  if (!scopes) { scopes = new Map(); shared.set(paseo, scopes); }
  let entry = scopes.get(includeArchived);
  if (!entry || entry.stopped) {
    entry = { users: 0, release: null, appState: null, stopped: false, directory: createAgentDirectory({
      list: options => paseo.agents.list(options),
      // Paseo 0.9 routes directory events only to observations this surface's API owns.
      observe: options => paseo.agents.list({ ...options, subscribe: {} }).then(result => result.subscription),
    }, { includeArchived }) };
    scopes.set(includeArchived, entry);
  }
  return entry;
}

function retain(paseo: Paseo, includeArchived: boolean, entry: Shared): () => void {
  if (entry.stopped) { entry.stopped = false; shared.get(paseo)?.set(includeArchived, entry); }
  entry.users += 1;
  if (entry.release) { clearTimeout(entry.release); entry.release = null; }
  if (!entry.appState) {
    entry.directory.start(isForeground(AppState.currentState));
    entry.appState = AppState.addEventListener("change", next => entry.directory.setActive(isForeground(next)));
  }
  return () => {
    entry.users -= 1;
    if (entry.users > 0) return;
    entry.release = setTimeout(() => {
      entry.release = null;
      if (entry.users > 0) return;
      entry.appState?.remove(); entry.appState = null;
      entry.stopped = true; entry.directory.stop();
      const scopes = shared.get(paseo);
      if (scopes?.get(includeArchived) === entry) scopes.delete(includeArchived);
    }, LINGER_MS);
  };
}

/** Keeps the shared directory of a connection and archive scope running; `release` lets it go after a short while. */
export function retainDirectory(paseo: Paseo, includeArchived: boolean): { directory: Directory; release: () => void } {
  const entry = sharedDirectory(paseo, includeArchived);
  return { directory: entry.directory, release: retain(paseo, includeArchived, entry) };
}

/** Host changes get their own directory; disposed host requests cannot leak data. */
export function useObservatory({ includeArchived }: { includeArchived: boolean }) {
  const fleet = useFleet();
  const multi = useMultiHostDirectory(includeArchived, !!fleet);
  const paseo = usePaseo();
  const entry = useMemo(() => sharedDirectory(paseo, includeArchived), [paseo, includeArchived]);
  useEffect(() => fleet ? undefined : retain(paseo, includeArchived, entry), [paseo, includeArchived, entry, !!fleet]);
  const state = useSyncExternalStore(entry.directory.subscribe, entry.directory.getSnapshot, entry.directory.getSnapshot);
  return useMemo(() => {
    if (!fleet) return { ...state, failedHosts: state.error ? ["local"] : [], refresh: entry.directory.refresh };
    const hosts = multi.hosts;
    const times = hosts.flatMap(({ directory }) => directory.lastSyncedAt ? [directory.lastSyncedAt] : []).sort();
    const failures = hosts.filter(({ host, directory }) => host.status !== "online" || directory.error);
    return { agents: hosts.flatMap(({ host, directory }) => directory.agents.map(agent => fleetAgent(host, agent))),
      loading: !hosts.length || hosts.every(({ directory }) => directory.loading && !directory.agents.length),
      error: failures.length ? failures.map(({ host, directory }) => `${host.label}: ${directory.error ?? host.status}`).join("; ") : null,
      failedHosts: failures.map(({ host }) => host.serverId),
      lastSyncedAt: times[0] ?? null, isRefreshing: hosts.some(({ directory }) => directory.isRefreshing),
      truncated: hosts.some(({ directory }) => directory.truncated) || failures.length > 0,
      live: hosts.length > 0 && hosts.every(({ host, directory }) => host.status === "online" && directory.live), refresh: multi.refresh };
  }, [state, entry, !!fleet, multi.hosts, multi.refresh]);
}
