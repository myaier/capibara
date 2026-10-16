import { hostEntityId, parseHostEntityId } from "./fleet-scope";

const screens = ["observatory", "archives", "schedule-runs"] as const;
// Contribution IDs only allow lowercase letters, digits and hyphens. Escape literal
// hyphens as well, so host IDs cannot collide with an encoded character sequence.
const encodeHost = (value: string) => value.replace(/[^a-z0-9]/g, char => `-${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
export function logicalScreenId(id: string): string {
  return screens.find(screen => id === screen || id.startsWith(`${screen}--`)) ?? id;
}
export function screenOwner(id: string): string | null {
  const logical = logicalScreenId(id); if (logical === id) return null;
  const encoded = id.slice(logical.length + 2), host = encoded.replace(/-([a-f0-9]{4})/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
  return host && encodeHost(host) === encoded ? host : null;
}
/** Each real screen ID belongs to one installation, so Paseo has no host choices for that screen. */
export function screenForHost(id: string, hostId: string): string {
  const logical = logicalScreenId(id);
  return (screens as readonly string[]).includes(logical) ? `${logical}--${encodeHost(hostId)}` : id;
}
export function screenLocationForHost(location: { screenId: string; params?: Readonly<Record<string, string>> }, hostId: string) {
  const owner = screenOwner(location.screenId);
  if (logicalScreenId(location.screenId) !== location.screenId && !owner) throw new Error("Invalid observatory screen owner");
  const source = owner ?? hostId;
  const params = location.params ? Object.fromEntries(Object.entries(location.params).map(([key, value]) => [key,
    ["agent", "schedule", "run", "workspace"].includes(key) && value && !parseHostEntityId(value) ? hostEntityId(source, value) : value])) : undefined;
  return { screenId: screenForHost(location.screenId, hostId), ...(params ? { params } : {}) };
}
