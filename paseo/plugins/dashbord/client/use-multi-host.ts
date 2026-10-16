import { hostRegistry } from "./host-registry";
import { readHostSnapshot } from "./fleet-reader";
import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createMultiHostDirectory, type HostApi } from "../shared/multi-host";
import { useForeground } from "./use-foreground";

export function useMultiHostDirectory(includeArchived: boolean, enabled = true) {
  const hosts = useHosts(), foreground = useForeground();
  const peers = useSyncExternalStore(hostRegistry.subscribe, hostRegistry.getSnapshot, hostRegistry.getSnapshot);
  const store = useMemo(() => {
    // Cache adapters by authenticated API identity so the store can detect connection replacement.
    const adapters = new WeakMap<ReturnType<typeof getPaseoClient>, HostApi>();
    const backends = new Map<string, { generation: number; api: HostApi }>();
    return createMultiHostDirectory(serverId => {
      const peer = hostRegistry.getSnapshot().find(peer => peer.identity.serverId === serverId);
      if (peer?.identity.capabilities.includes("fleet-directory-v1")) {
        const previous = backends.get(serverId);
        if (previous?.generation === peer.generation) return previous.api;
        const api: HostApi = {
          list: options => readHostSnapshot(serverId, "observatory.agents.list", { filter: options.filter, page: options.page }),
          // Native subscriptions are optional: their availability cannot block a healthy backend directory read.
          observe: async options => (await getPaseoClient(serverId).agents.list({ ...options, subscribe: {} })).subscription,
        };
        backends.set(serverId, { generation: peer.generation, api }); return api;
      }
      const client = getPaseoClient(serverId);
      let api = adapters.get(client);
      if (!api) {
        api = { list: options => client.agents.list(options),
          observe: options => client.agents.list({ ...options, subscribe: {} }).then(result => result.subscription) };
        adapters.set(client, api);
      }
      return api;
    }, { includeArchived });
  }, [includeArchived]);
  // Use values rather than the array identity: app providers may return an equivalent fresh array.
  const identity = JSON.stringify([hosts.map(host => [host.serverId, host.label, host.status]), peers.map(peer => [peer.identity.serverId, peer.generation])]);
  useEffect(() => { store.setHosts(hosts); }, [store, identity]);
  useEffect(() => { if (enabled) store.start(foreground); return () => store.stop(); }, [store, enabled]);
  useEffect(() => { store.setActive(foreground); }, [store, foreground]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...state, refresh: store.refresh };
}
