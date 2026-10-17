import { Text } from "react-native";
import { useState } from "react";
import { parseHostEntityId } from "../shared/fleet-scope";
import type { PluginTheme } from "@getpaseo/plugin";
import { useFleet } from "./fleet-client";
import { Banner } from "./kit";
import { dismissNotices, hasUndismissed } from "../shared/notices";
import type { FleetCoverage } from "../shared/fleet-rpc";
import type { ObservatoryHost } from "../shared/multi-host";
import { t } from "../shared/text";

/** Machines missing from `methods` (all reported reads when omitted) and the notes those reads left, keyed for dismissal. */
export function fleetCoverageIssues(hosts: readonly ObservatoryHost[], coverage: Record<string, FleetCoverage>, methods: readonly string[] = Object.keys(coverage)) {
  const missing = new Map<string, { label: string; at?: number | null }>();
  for (const host of hosts) if (host.status !== "online") missing.set(host.serverId, { label: host.label });
  for (const method of methods) for (const host of coverage[method]?.hosts ?? []) if (host.state !== "live") missing.set(host.id, { label: host.label, at: host.collectedAt });
  const notes = [...new Set(methods.flatMap(method => coverage[method]?.notes ?? []))];
  return { missing, notes, keys: [...[...missing.keys()].map(id => `fleet:${id}`), ...notes.map(note => `note:${note}`)] };
}

/** Without `onDismiss` a closed notice stays closed for this page's lifetime only. */
export function FleetCoverageNotice({ theme, methods, dismissed, onDismiss }: {
  theme: PluginTheme; methods: string[]; dismissed?: readonly string[]; onDismiss?: (keys: string[]) => void;
}) {
  const fleet = useFleet(), [closed, setClosed] = useState<string[]>([]);
  if (!fleet) return null;
  const { missing, notes, keys } = fleetCoverageIssues(fleet.hosts, fleet.coverage, methods);
  if (!keys.length || !hasUndismissed(keys, [...(dismissed ?? []), ...closed])) return null;
  return <Banner theme={theme} tone="warning" onDismiss={() => onDismiss ? onDismiss(keys) : setClosed(previous => dismissNotices(previous, keys))} message={[
    missing.size ? t("fleet.partial", { hosts: [...missing.values()].map(host => host.at ? `${host.label} (${new Date(host.at).toLocaleString()})` : host.label).join("、") }) : "", ...notes,
  ].filter(Boolean).join(" ")} />;
}

export function FleetSource({ theme, id }: { theme: PluginTheme; id: string }) {
  const fleet = useFleet(), source = parseHostEntityId(id)?.hostId;
  if (!source) return null;
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{fleet?.hosts.find(host => host.serverId === source)?.label ?? source}</Text>;
}
