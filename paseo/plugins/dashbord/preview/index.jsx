import { fixtureStats } from "./stats-fixture";
import "./i18n";
import React, { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Lucide from "lucide-react";
import { setupFleetFixture } from "./fleet-fixture";
import { FleetProvider, fleetNavigation } from "../client/fleet-client";
import { DashboardSurface, DashboardView } from "../client/dashboard";
import { providePlaza } from "../client/plaza-host";
import { AgentsPlaza } from "../client/plaza/scene";
import { ScheduleSurface } from "../client/schedule-board";
import { focusScheduleRuns } from "../client/schedule-focus";
import { ToastHost } from "./sdk-adapter";
import { paseoDark, paseoLight } from "./themes";
import { completeFixtureAgent, fixtureAgents, fixtureAnalytics, fixtureBackground, fixtureArchiveOrigins, fixtureReadReceipts, fixtureTelemetry, getFixtureRevision, readFixtureInNative, subscribeFixtureChanges, updateFixtureAgent } from "./fixtures";

const search = new URLSearchParams(location.search);
const scenario = search.get("scenario") ?? "all";
const fleet = scenario === "fleet" || scenario === "fleet-hosts";
if (fleet) setupFleetFixture({ uninstalled: scenario === "fleet-hosts" });
const light = search.get("theme") === "light";
const theme = light ? paseoLight : paseoDark;
globalThis.__previewTheme = theme;
document.documentElement.style.colorScheme = light ? "light" : "dark";
document.body.style.background = theme.colors.surface0;
providePlaza(props => <AgentsPlaza {...props} version="preview" />);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
globalThis.__previewSeedNativeStats = () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone, offset = -new Date().getTimezoneOffset();
  const local = fixtureStats("30d", offset); local.totals.sessions = 999;
  client.setQueryData(["agent-observatory", "mac", "stats", "30d", { projects: [], providers: [], models: [] }, offset, zone], local);
};
globalThis.__previewNativeReadAgent = readFixtureInNative;
globalThis.__previewCompleteAgent = completeFixtureAgent;
globalThis.__previewUpdateAgent = updateFixtureAgent;

/** Stand-in for the host's surface title bar; the plugin itself never repeats the title. */
function HostBar({ archiveMode, schedules }) {
  const Glyph = schedules ? Lucide.CalendarClock : archiveMode ? Lucide.Archive : Lucide.Orbit;
  return <div className="host-bar" style={{ borderBottom: `1px solid ${theme.colors.border}`, color: theme.colors.foreground }}>
    <Glyph size={15} color={theme.colors.foregroundMuted} strokeWidth={1.75} aria-hidden="true" />
    <span>{schedules ? "定时运行" : archiveMode ? "已归档会话" : "Agent 观测台"}</span>
    <span className="fixture-note" role="note" style={{ color: theme.colors.foregroundMuted }}>开发预览 · 模拟数据</span>
  </div>;
}

function Preview() {
  useSyncExternalStore(subscribeFixtureChanges, getFixtureRevision, getFixtureRevision);
  const [archiveMode, setArchiveMode] = useState(search.get("archives") === "1");
  // ?surface=schedules opens 定时运行; an Agent's 「查看全部运行」 switches here like the host's openSurface.
  const [surface, setSurface] = useState(search.get("surface") === "schedules" ? "schedules" : "dashboard");
  const [lastSyncedAt, setLastSyncedAt] = useState(new Date(Date.now() - (scenario === "stale" ? 60_000 : 0)).toISOString());
  const empty = scenario === "empty" || scenario === "loading" || scenario === "error" || scenario === "navigation-error";
  const refresh = async () => setLastSyncedAt(new Date().toISOString());
  const data = { agents: empty ? [] : fixtureAgents(archiveMode), loading: scenario === "loading",
    error: scenario === "error" || scenario === "retained-error" ? "模拟连接中断，请稍后重试" : null,
    lastSyncedAt, isRefreshing: false, truncated: scenario === "truncated", live: !["stale", "loading", "error", "retained-error"].includes(scenario), refresh };
  const host = { id: "fixture-host", label: "Local development" };
  const navigation = { openAgent({ agentId }) { if (scenario === "navigation-error") throw new Error("模拟宿主导航失败"); globalThis.__previewOpenedAgent = agentId; readFixtureInNative(agentId); }, openWorkspace({ workspaceId }) { globalThis.__previewOpenedWorkspace = workspaceId; } };
  const layout = { compact: innerWidth < 700, platform: "web" };
  if (fleet) {
    const host = { id: "mac", label: "MacBook Pro" };
    const navigation = { openAgent: value => { globalThis.__previewFleetNavigation = value; }, openWorkspace: value => { globalThis.__previewFleetNavigation = value; } };
    return <QueryClientProvider client={client}><HostBar archiveMode={archiveMode} /><div className="plugin-frame"><FleetProvider host={host}>
      <DashboardSurface theme={theme} host={host} layout={layout} navigation={fleetNavigation(navigation, host.id)} archiveMode={archiveMode} onOpenArchive={() => setArchiveMode(true)} onOpenOverview={() => setArchiveMode(false)} />
    </FleetProvider></div><ToastHost /></QueryClientProvider>;
  }
  if (surface === "schedules") return <QueryClientProvider client={client}>
    <HostBar schedules />
    <div className="plugin-frame"><ScheduleSurface theme={theme} host={host} navigation={navigation} layout={layout} /></div>
    <ToastHost />
  </QueryClientProvider>;
  return <QueryClientProvider client={client}>
    <HostBar archiveMode={archiveMode} />
    <div className="plugin-frame">
      <DashboardView key={archiveMode ? "archives" : "overview"} theme={theme} host={host} navigation={navigation} layout={{ compact: innerWidth < 700, platform: "web" }}
        data={data} telemetry={fixtureTelemetry} background={scenario === "background" ? fixtureBackground : undefined} analytics={fixtureAnalytics} readReceipts={fixtureReadReceipts} archiveOrigins={fixtureArchiveOrigins} archiveMode={archiveMode} onOpenArchive={() => setArchiveMode(true)} onOpenOverview={() => setArchiveMode(false)} onRefresh={refresh}
        onOpenSchedules={focus => { focusScheduleRuns(focus); setSurface("schedules"); }} />
    </div>
    <ToastHost />
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")).render(<Preview />);
