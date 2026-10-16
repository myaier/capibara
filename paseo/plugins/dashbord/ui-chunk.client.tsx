import { FleetProvider, fleetNavigation } from "./client/fleet-client";
import { hostRegistry } from "./client/host-registry";
import { hostEntityId, parseHostEntityId } from "./shared/fleet-scope";
import { screenLocationForHost } from "./shared/screen-routing";
import { followText } from "./shared/i18n";
import type { ChunkExtras } from "./client/lazy-chunk";
import { LanguageScreen } from "./client/language-screen";
import type { ComponentType } from "react";
import type { PluginAgentPanelProps, PluginClientContext, PluginPopoverProps, PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ArchivedSurface, DashboardSurface, WorkspaceDashboard } from "./client/dashboard";
import { AgentInspector } from "./client/agent-inspector";
import { ScheduleSurface } from "./client/schedule-board";
import { focusScheduleRuns, scheduleScreenParams, type ScheduleFocus } from "./client/schedule-focus";
import { AttentionPopover } from "./client/attention-popover";
import { AttentionStoresContext } from "./client/attention-context";
import type { AttentionStore } from "./client/use-attention";

// Paseo freezes exports before running the module body; this declaration must be hoisted.
export default function chunk() { return { api: 1, createSurfaces }; }

function createSurfaces(client: PluginClientContext, extras?: ChunkExtras): Record<string, ComponentType<any>> {
  followText(extras?.text);
  const screens = typeof client.addScreen === "function";
  const open = (screenId: string, params?: Record<string, string>, hostId?: string) => {
    const location = params ? { screenId, params } : { screenId };
    if (hostRegistry.openScreen(location, hostId)) return;
    if (screens) client.openScreen(location); else client.openSurface(screenId);
  };
  // The schedule writer and reader remain in the same chunk, including the older-host fallback.
  const openSchedules = (focus: ScheduleFocus, hostId?: string) => { if (screens) open("schedule-runs", scheduleScreenParams(focus), hostId); else { focusScheduleRuns(focus); client.openSurface("schedule-runs"); } };
  const Overview = (props: PluginScreenProps) => <FleetProvider host={props.host}><DashboardSurface {...props} navigation={fleetNavigation(props.navigation, props.host.id)} onOpenArchive={() => open("archives", undefined, props.host.id)} onOpenSchedules={focus => openSchedules(focus, props.host.id)} /></FleetProvider>;
  const Archives = (props: PluginScreenProps) => <FleetProvider host={props.host}><ArchivedSurface {...props} navigation={fleetNavigation(props.navigation, props.host.id)} onOpenOverview={() => open("observatory", undefined, props.host.id)} onOpenSchedules={focus => openSchedules(focus, props.host.id)} /></FleetProvider>;
  const Schedules = (props: PluginScreenProps) => <FleetProvider host={props.host}><ScheduleSurface {...props} navigation={fleetNavigation(props.navigation, props.host.id)} /></FleetProvider>;
  const Popover = (props: PluginPopoverProps & { store: AttentionStore }) => <FleetProvider host={props.host}><AttentionPopover {...props}
    openScreen={location => props.openScreen(screenLocationForHost(location, props.host.id))} /></FleetProvider>;
  const qualifyFocus = (focus: ScheduleFocus, hostId: string): ScheduleFocus => ({ scheduleId: parseHostEntityId(focus.scheduleId) ? focus.scheduleId : hostEntityId(hostId, focus.scheduleId), ...(focus.runId ? { runId: parseHostEntityId(focus.runId) ? focus.runId : hostEntityId(hostId, focus.runId) } : {}) });
  const Workspace = (props: PluginWorkspacePanelProps) => <WorkspaceDashboard {...props} onOpenSchedules={focus => openSchedules(qualifyFocus(focus, props.host.id), props.host.id)} />;
  const Inspector = (props: PluginAgentPanelProps) => <AgentInspector {...props} onOpenSchedules={focus => openSchedules(qualifyFocus(focus, props.host.id), props.host.id)} onOpenOverview={agentId => open("observatory", screens ? { agent: parseHostEntityId(agentId) ? agentId : hostEntityId(props.host.id, agentId), t: Date.now().toString(36) } : undefined, props.host.id)} />;
  // Each surface provides the stub's 需要处理 stores (its `attentionStores` prop) to its subtree: a detail's 知道了 re-reads the badge.
  const provide = (Surface: ComponentType<any>): ComponentType<any> => (props: any) => <AttentionStoresContext.Provider value={props.attentionStores ?? null}><Surface {...props} /></AttentionStoresContext.Provider>;
  return { observatory: provide(Overview), archives: provide(Archives), "schedule-runs": provide(Schedules), "workspace-observatory": provide(Workspace), "agent-inspector": provide(Inspector), "attention-popover": Popover, language: LanguageScreen };
}
