import { Text } from "react-native";
import { parseHostEntityId } from "../shared/fleet-scope";
import type { PluginTheme } from "@getpaseo/plugin";
import { useFleet } from "./fleet-client";
import { Banner } from "./kit";
import { t } from "../shared/text";

export function FleetCoverageNotice({ theme, methods }: { theme: PluginTheme; methods: string[] }) {
  const fleet = useFleet(); if (!fleet) return null;
  const missing = new Map<string, { label: string; at?: number | null }>();
  for (const host of fleet.hosts) if (host.status !== "online") missing.set(host.serverId, { label: host.label });
  for (const method of methods) for (const host of fleet.coverage[method]?.hosts ?? []) if (host.state !== "live") missing.set(host.id, { label: host.label, at: host.collectedAt });
  const notes = [...new Set(methods.flatMap(method => fleet.coverage[method]?.notes ?? []))];
  if (!missing.size && !notes.length) return null;
  return <Banner theme={theme} tone="warning" message={[
    missing.size ? t("fleet.partial", { hosts: [...missing.values()].map(host => host.at ? `${host.label} (${new Date(host.at).toLocaleString()})` : host.label).join("、") }) : "", ...notes,
  ].filter(Boolean).join(" ")} />;
}

export function FleetSource({ theme, id }: { theme: PluginTheme; id: string }) {
  const fleet = useFleet(), source = parseHostEntityId(id)?.hostId;
  if (!source) return null;
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{fleet?.hosts.find(host => host.serverId === source)?.label ?? source}</Text>;
}
