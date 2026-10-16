import { useEffect, type ComponentType } from "react";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { logicalScreenId, screenForHost, screenLocationForHost } from "./shared/screen-routing";
import type { PluginClientContext, PluginCommandCenterItemContribution, PluginWorkspaceCommandContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { lazySurfaces } from "./client/lazy-chunk";
import { createClientI18n } from "./client/i18n-client";
import { boot as bootEn } from "./shared/locales/en.json";
import { boot as bootZh } from "./shared/locales/zh-CN.json";
import { t, type MessageId } from "./shared/text";
import { getClientChunk } from "./shared/ui-chunk";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { ArchivesSidebarItem, ObservatorySidebarItem, ScheduleSidebarItem } from "./client/sidebar";
import { createAttentionStores } from "./client/use-attention";
import { registerClientHost, hostRegistry } from "./client/host-registry";

// The manifest requires Paseo 0.11.1, whose screen and sidebar APIs are always present.
export default function contribute(client: PluginClientContext) {
  const i18n = createClientI18n(client, { pluginId: "agent-observatory", boot: { "zh-CN": { boot: bootZh }, en: { boot: bootEn } } });
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t("boot.name"), text: i18n });
  // One set of attention stores per registration, shared by resident badges and lazy views.
  const attentionStores = createAttentionStores();
  const surface = (id: string): ComponentType<any> => { const Surface = lazy(id); return (props: any) => <Surface {...props} attentionStores={attentionStores} />; };
  const AttentionPopover = lazy("attention-popover");
  const Sidebar = (props: PluginSidebarItemProps) => <ObservatorySidebarItem {...props} stores={attentionStores} AttentionPopover={AttentionPopover} />;
  const Schedules = (props: PluginSidebarItemProps) => <ScheduleSidebarItem {...props} stores={attentionStores} />;
  const screenList: Array<[string, MessageId, ComponentType<PluginSidebarItemProps>]> = [
    ["observatory", "boot.screenTitle", Sidebar], ["archives", "boot.archivesTitle", ArchivesSidebarItem], ["schedule-runs", "boot.schedulesTitle", Schedules],
  ];
  const panels = [["workspace-observatory", "boot.screenTitle", "Activity", "workspace", "inspect-workspace", "boot.inspectWorkspace"], ["agent-inspector", "boot.inspectorTitle", "ScanLine", "agent", "inspect-agent", "boot.inspectAgent"]] as const;
  const cleanups: Array<() => void> = [];
  let ownHost: string | null = null, releaseScreens: (() => void) | null = null;
  // Paseo memoizes open surface titles; refresh their descriptors when the catalog changes too.
  const wrapSidebar = (Item: ComponentType<PluginSidebarItemProps>): ComponentType<PluginSidebarItemProps> => props => {
    const current = props.currentScreen;
    // Paseo's sidebar callback closes the mobile drawer/popover and remembers the selected host.
    // The registry's client.openScreen only changes the route, leaving that drawer over the page.
    const openScreen: PluginSidebarItemProps["openScreen"] = location => props.openScreen(screenLocationForHost(location, props.host.id));
    return <Item {...props} currentScreen={current ? { ...current, screenId: logicalScreenId(current.screenId) } : current}
      openScreen={openScreen} />;
  };
  const registerScreens = () => i18n.localized(() => {
    const registrations: Array<() => void> = [];
    screenList.forEach(([id, titleId, Item]) => {
      const title = () => t(titleId);
      registrations.push(client.addScreen({ id: screenForHost(id, ownHost!), title, Component: surface(id) }));
      // Old bookmarks enter the same page through a one-frame redirect, without changing their entity targets.
      const Legacy = (props: PluginScreenProps) => { useEffect(() => { client.openScreen(screenLocationForHost({ screenId: id, params: props.params }, props.host.id)); }, [props.host.id, props.params]); return null; };
      registrations.push(client.addScreen({ id, title, Component: Legacy }));
      registrations.push(client.addSidebarHeaderItem({ id, title: title(), Component: wrapSidebar(Item) }));
    });
    const screens = [["open-observatory", "boot.open", "Orbit", "observatory"], ["open-attention", "boot.openAttention", "BellRing", "observatory"], ["open-schedule-runs", "boot.openSchedules", "CalendarClock", "schedule-runs"], ["open-archives", "boot.openArchives", "Archive", "archives"]] as const;
    screens.forEach(([id, titleId, icon, screenId]) => {
      const attention = id === "open-attention";
      registrations.push(client.addCommandCenterItem({ id, title: t(titleId), icon, context: "global", keywords: attention ? [t("boot.attentionKeyword"), t("boot.approvalKeyword"), t("boot.unreadKeyword")] : undefined,
        onSelect(context) { context.openScreen(screenLocationForHost(attention ? { screenId, params: { focus: "attention", t: Date.now().toString(36) } } : { screenId }, ownHost!)); } }));
    });
    return registrations;
  });
  // Stable host-specific screen IDs keep an open route registered when other installations reconnect.
  // The shared sidebar name is still deduplicated by Paseo; all of these screens show the same fleet.
  const reconcileScreens = () => {
    if (ownHost && !releaseScreens && hostRegistry.getSnapshot().some(peer => peer.identity.serverId === ownHost)) releaseScreens = registerScreens();
  };
  const unsubscribe = hostRegistry.subscribe(reconcileScreens);
  const releaseHost = registerClientHost(client, hostRegistry, id => { ownHost = id; });
  cleanups.push(() => { unsubscribe(); releaseScreens?.(); releaseScreens = null; releaseHost(); });
  cleanups.push(i18n.localized(() => panels.map(([id, titleId, icon, context]) => {
    const title = t(titleId);
    return client.addWorkspacePanel({ id, title, icon, context, Component: surface(id) });
  })));
  // Registered once: re-registering the screen the user is on while choosing a language would take the page away.
  cleanups.push(client.addSettingsScreen({ id: "language", title: t("boot.settingsTitle"), icon: "Languages", Component: surface("language") }));
  cleanups.push(i18n.localized(() => {
    const commands: Array<() => void> = [];
    commands.push(
      ...panels.map(([id, _title, icon, context, commandId, titleId]) => client.addCommandCenterItem({ id: commandId, title: t(titleId), icon, context, onSelect(context: PluginWorkspaceCommandContext) { context.openPanel(id); } } as PluginCommandCenterItemContribution)),
      client.addSlashCommand({ name: "observe", argumentHint: "", description: t("boot.observeDescription"), context: "agent", onSubmit({ openPanel }) { openPanel("agent-inspector"); } }));
    return commands;
  }));
  cleanups.push(() => i18n.dispose());
  return () => { for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* the host is tearing down already */ } } };
}
