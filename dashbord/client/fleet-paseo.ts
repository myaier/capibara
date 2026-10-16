import type { usePaseo } from "@getpaseo/plugin/client";
import { hostEntityId, parseHostEntityId } from "../shared/fleet-scope";
import { qualifyFleetResult } from "../shared/fleet-entities";
import type { ObservatoryHost } from "../shared/multi-host";

type Paseo = ReturnType<typeof usePaseo>;
type Path = Array<string | symbol>;

/** Acquire a connection when an operation runs, never while React constructs a detail or its timeline store. */
function lazyHandle(resolve: () => any, id?: string): any {
  const cache = new Map<string, any>();
  const at = (path: Path) => path.reduce((value, key) => value[key], resolve());
  const proxy = (path: Path): any => {
    const cacheKey = path.map(String).join("/"); if (cache.has(cacheKey)) return cache.get(cacheKey);
    const invoke = (...args: any[]) => {
      const run = () => { const parent = at(path.slice(0, -1)); return parent[path.at(-1)!](...args); };
      const name = path.at(-1);
      if (name === "getSnapshot") { try { return run(); } catch { return undefined; } }
      if (name === "subscribe") {
        try {
          const remove = run();
          if (typeof remove !== "function") return remove;
          const safe = () => { try { return remove(); } catch { return undefined; } };
          return "ready" in remove ? Object.assign(safe, { ready: remove.ready }) : safe;
        } catch { return () => {}; }
      }
      return Promise.resolve().then(run);
    };
    const result = new Proxy(invoke, { get(target, key) {
      if (key === "then") return undefined;
      if (key === "id" && path.length === 0 && id !== undefined) return id;
      if (["call", "apply", "bind"].includes(String(key))) return Reflect.get(target, key).bind(target);
      return proxy([...path, key]);
    } });
    cache.set(cacheKey, result); return result;
  };
  return proxy([]);
}

export function createFleetPaseo(defaultHost: string, hosts: readonly ObservatoryHost[], acquire: (id: string) => Paseo): Paseo {
  const connection = (hostId: string) => {
    if (!hosts.some(host => host.serverId === hostId && host.status === "online")) throw new Error("The source machine is offline");
    return acquire(hostId);
  };
  const reference = (id: string) => parseHostEntityId(id) ?? { hostId: defaultHost, id };
  const defaultApi = lazyHandle(() => connection(defaultHost));
  const agents = new Proxy({}, { get(_target, key) {
    if (key === "ref") return (value: string) => { const ref = reference(value); return lazyHandle(() => connection(ref.hostId).agents.ref(ref.id), ref.id); };
    if (key === "subscribe") return (listener: any) => {
      const removers: Array<() => void> = [];
      for (const host of hosts.filter(host => host.status === "online")) {
        try { removers.push(connection(host.serverId).agents.subscribe(event => listener(qualifyFleetResult(event, host.serverId)))); }
        catch { /* An individual connection may disappear before useHosts publishes its new status. */ }
      }
      return () => { for (const remove of removers) { try { remove(); } catch { /* already disconnected */ } } };
    };
    return defaultApi.agents[key];
  } });
  const workspaces = new Proxy({}, { get(_target, key) {
    if (key !== "ref") return defaultApi.workspaces[key];
    return (value: string) => {
      const ref = reference(value), resolve = () => connection(ref.hostId).workspaces.ref(ref.id), handle = lazyHandle(resolve, ref.id);
      const create = (...args: any[]) => Promise.resolve().then(async () => {
        const created = await (resolve().agents.create as any)(...args);
        return new Proxy({}, { get(_target, key) { const value = Reflect.get(created, key);
          return key === "id" ? hostEntityId(ref.hostId, created.id) : typeof value === "function" ? value.bind(created) : value; } });
      });
      return new Proxy({}, { get(_target, key) { return key === "agents" ? new Proxy({}, { get(_target, key) { return key === "create" ? create : handle.agents[key]; } }) : handle[key]; } });
    };
  } });
  return new Proxy({}, { get(_target, key) { return key === "agents" ? agents : key === "workspaces" ? workspaces : defaultApi[key]; } }) as Paseo;
}
