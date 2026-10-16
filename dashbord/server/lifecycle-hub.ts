import type { PluginServerContext } from "@getpaseo/plugin/server";

type On = PluginServerContext["on"];
type Name = Parameters<On>[0];
type Handler = (input: unknown, context: unknown) => unknown;

/**
 * One host registration per lifecycle event (opus-F15). The host structuredClones a hook's input once for every handler
 * it calls, and `agent.turn_ended` carries the Agent's whole projected timeline: six handlers meant six deep copies of it
 * on every turn of every Agent. Modules keep calling `server.on` on the wrapped context; the hub registers a single host
 * handler per event and runs theirs in registration order on that one copy, one after another, each failure on its own,
 * as the host does. The input is shared, so handlers treat it as read-only (the timeline is typed readonly).
 */
export function lifecycleHub(server: PluginServerContext): { server: PluginServerContext; registered(): string[]; close(): void } {
  const handlers = new Map<Name, Set<Handler>>();
  const hosts = new Map<Name, () => void>();
  const dispatch = (name: Name) => async (input: unknown, context: unknown) => {
    for (const handler of [...(handlers.get(name) ?? [])]) {
      try { await handler(input, context); } catch (error) { console.error(`agent-observatory: ${name} handler failed`, error); }
    }
  };
  const on = ((name: Name, handler: Handler) => {
    let set = handlers.get(name);
    if (!set) { set = new Set(); handlers.set(name, set); }
    set.add(handler);
    if (!hosts.has(name)) hosts.set(name, server.on(name, dispatch(name) as never));
    return () => {
      const current = handlers.get(name);
      if (!current?.delete(handler) || current.size) return;
      handlers.delete(name);
      const remove = hosts.get(name); hosts.delete(name); remove?.();
    };
  }) as unknown as On;
  // Everything else (handle, registerSettings …) goes to the host context unchanged, called on the context itself.
  const wrapped = new Proxy(server, { get: (target, property) => {
    if (property === "on") return on;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return {
    server: wrapped,
    registered: () => [...hosts.keys()],
    close() { for (const remove of hosts.values()) remove(); hosts.clear(); handlers.clear(); },
  };
}
