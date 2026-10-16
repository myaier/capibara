import { withFleetReads } from "./server/fleet-rpc";
import { createLocaleService } from "./server/i18n-server";
import { BUILTIN_CATALOGS } from "./server/locales";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProcessBridge, registerProviderSubagents } from "./server/provider-subagents";
import { TelemetryStore } from "./server/telemetry";
import { getTelemetry } from "./shared/telemetry";
import { getAnalytics } from "./shared/analytics";
import { createAnalyticsEnrichment } from "./server/analytics-enrichment";
import { isInternalAgentAsync } from "./server/internal-agents";
import type { PaseoApi } from "./server/paseo-types";
import { registerHistory } from "./server/history";
import { registerResults } from "./server/results";
import { registerPreferences } from "./server/preferences";
import { registerReadState } from "./server/read-state";
import { StatsStore } from "./server/stats-store";
import { StatsDirectory } from "./server/stats-directory";
import { registerTokens } from "./server/tokens";
import { registerDigest } from "./server/digest";
import { getStats } from "./shared/stats";
import { finalReplyText, nudgeSentence, replyAsksUser, replyNudge } from "./shared/reply";
import { turnStop } from "./shared/stop-reason";
import { findChangeRequest } from "./shared/change-request";
import type { TimelineItem } from "./shared/timeline";
import { createReplyCheck } from "./server/reply-check";
import { registerSchedules } from "./server/schedules";
import { registerBackground } from "./server/background";
import { registerAttention } from "./server/attention";
import { registerResume } from "./server/resume";
import { getSteerableProviders, steerableReply } from "./shared/steer";
import { answeringGuard, createSendLedger, handingOver, registerSendLedger } from "./server/send-ledger";
import { readSendCapabilities } from "./server/steerable-providers";
import { resolvePaseoHome } from "./server/paseo-home";
import { createInterruptGrace } from "./server/interrupts";
import { registerQuota } from "./server/quota";
import { lifecycleHub } from "./server/lifecycle-hub";
import { DeviceZone } from "./server/device-zone";
import { registerProfiles } from "./server/profiles";
import { registerClientChunks } from "./server/ui-chunk";
import { registerHostData } from "./server/host-data";
import { registerSessionActions } from "./server/session-actions";
import { registerPluginUpdates } from "./server/plugin-update";
import { registerHostMemory } from "./server/host-memory";

export default function contribute(host: PluginServerContext) {
  const locales = createLocaleService(host, { pluginId: "agent-observatory", builtins: BUILTIN_CATALOGS });
  const telemetry = new TelemetryStore();
  // The ledger every message to an Agent goes through (server/send-ledger.ts); every RPC below hands it the daemon API. A quick
  // reply carries the turn it answers, checked against what the plugin observed right before it goes out (codex-obs-attn-R3).
  const deferred = createSendLedger({ guard: answeringGuard(telemetry) });
  // One host handler per lifecycle event, shared by every module below: the host clones a hook's input once per handler (opus-F15).
  const hub = lifecycleHub(handingOver(host, deferred));
  const fleet = withFleetReads(hub.server);
  const server = fleet.server;
  const removeHostData = registerHostData(server);
  // The UI chunk the resident client fetches on first use (shared/ui-chunk.ts): in parts, each reply under 128 KiB.
  registerClientChunks(server);
  // One bridge to the host session for every raw request (subagents, restore, clear attention, schedules).
  const bridge = createProcessBridge();
  const removeSessionActions = registerSessionActions(server, bridge);
  const removePluginUpdates = registerPluginUpdates(server, bridge);
  // 主机 panel: when each connected host was last seen and which version it ran.
  const removeHostMemory = registerHostMemory(server);
  const directory = new StatsDirectory();
  // Read limit notices without a zone and token days in the devices' time zone, not the daemon's (grok-F2).
  const zones = new DeviceZone();
  // Provider subagents that keep working after their parent's turn ended (后台执行中).
  const background = registerBackground(server, { directory, bridge });
  const stats = new StatsStore({ telemetry, agents: directory, background: background.tracker });
  const tokens = registerTokens(server, { directory, zones });
  // 额度: the host's provider usage windows (only `providers.listUsage()`), sampled every 10 minutes with history and forecasts.
  const removeQuota = registerQuota(server);
  const removeDigest = registerDigest(server, { tokens: tokens.source, telemetry });
  // 定时运行 shares the once-a-minute Agent walk with 看板 and Token; its ledger records runs in the background (opus-F11).
  const schedules = registerSchedules(server, { directory });
  const statsRemovers: Array<() => void> = [];
  let statsClosed = false;
  const analytics = createAnalyticsEnrichment(telemetry);
  registerProviderSubagents(server, bridge);
  registerProfiles(server);
  const removeHistory = registerHistory(server, bridge);
  // Telemetry checks 知道了 on a stop and the completion a 标记已读 receipt is for (opus-F34, codex-F5).
  const readState = registerReadState(server, bridge, telemetry);
  const preferences = registerPreferences(server);
  const removeResults=registerResults(server,async id=>(await telemetry.snapshot(id)).agents[0]??null,(id,reply)=>{void telemetry.recordReply(id,reply.userAt,{at:reply.at,asks:reply.asks,link:reply.link,nudge:reply.nudge??null});});
  const replyCheck = createReplyCheck(telemetry, directory, { zone: () => zones.current() });
  // 恢复后续跑 keeps a ledger and checks the heartbeats behind it until the prompt went in (grok-F5, opus-F38). After a restart
  // cut a wake short, the session's own provider log is one proof the prompt went in (codex-obs-resume-F2).
  const resume = registerResume(server, bridge, { zone: () => zones.current(), noteZone: zone => zones.note(zone), logs: tokens.source });
  // 需要处理 for the sidebar badge, computed with the page's own rules (and the running turns' todo progress).
  const attention = registerAttention(server, {
    telemetry: () => telemetry.snapshot(), background: () => background.tracker.snapshot(), isLive: id => background.tracker.isLive(id),
    receipts: () => readState.store.snapshot(), preferences: () => preferences.store.attentionInputs(),
    // The sidebar's 定时运行 row shows failed runs of the last 24 hours.
    scheduleFailures: sinceMs => schedules.failuresSince(sinceMs),
    // The badge polls most often: its reads carry the device's zone.
    noteZone: zone => zones.note(zone),
  });
  // Which providers take a message mid-turn on this host (client/send-plan.ts): the built-ins plus custom ids extending them,
  // those that also take a steered slash command (Claude and the ids built on it), and the built-in each custom id extends
  // (`bases`: how it runs a command, codex-obs-send-ui-F3).
  let capabilities: { at: number; value: ReturnType<typeof readSendCapabilities> } | null = null;
  server.handle(getSteerableProviders, async () => {
    if (!capabilities || Date.now() - capabilities.at > 5 * 60_000) capabilities = { at: Date.now(), value: readSendCapabilities({ PASEO_HOME: resolvePaseoHome() }) };
    return steerableReply(await capabilities.value);
  });
  // 拒绝并中断 makes some providers end the turn as failed; that turn was the user's choice, not an error.
  const interrupts = createInterruptGrace();
  const outcomeOf = (agentId: string, turnId: string | null, outcome: { kind: "completed" | "failed" | "canceled" }) => interrupts.outcome(agentId, outcome.kind, turnId);
  const observeWork = (paseo: PaseoApi, agent: { id: string }, record: () => unknown) => {
    void background.tracker.attach(paseo); tokens.discover(paseo);
    // Metadata helpers have their own usage; avoid counting their turns as productive work.
    // A failed label lookup must not drop the event: unknown counts as ordinary work.
    void isInternalAgentAsync(paseo, agent).catch(() => false).then(internal => { if (!internal && !statsClosed) return record(); }).catch(() => {});
  };
  // A lifecycle hook proves the Agent is loaded right now; only such Agents are ever asked for their subagents or todos.
  const live = (agent: { id: string }) => background.tracker.markLive(agent.id);
  const removers = [
    server.on("agent.created", ({ agent }, { paseo }) => { live(agent); observeWork(paseo, agent, () => telemetry.record({ type: "created", agent })); }),
    server.on("agent.turn_started", ({ agent, turnId }, { paseo }) => { live(agent); attention.turnStarted(agent.id); schedules.nudge(agent.id); observeWork(paseo, agent, () => telemetry.record({ type: "turn_started", agent, turnId })); }),
    server.on("agent.turn_ended", ({ agent, turnId, outcome, timeline }, { paseo }) => {
      // A message queued for the end of this turn goes out shortly, before the ledger's next poll.
      deferred.notify(agent.id, paseo);
      // Decided at once: the grace after 拒绝并中断 must not run out while the helper-label lookup below is slow.
      const kind = outcomeOf(agent.id, turnId, outcome);
      live(agent); attention.turnEnded(agent.id); schedules.nudge(agent.id);
      observeWork(paseo, agent, async () => {
        const items = timeline as unknown as TimelineItem[];
        // Only whether the final reply asks the user, and why the turn stopped (a limit, nothing, mid-way), are kept; never text.
        // The one sentence a quick reply would answer stays in memory for the popover, which shows it above the buttons.
        const stop = turnStop({ outcome: kind, error: outcome.kind === "failed" ? outcome.error.message : null, items, now: Date.now(), hostZone: zones.current() ?? undefined });
        const reply = kind === "completed" ? finalReplyText(items) : null;
        // Only the link to a merge or pull request the reply mentions is kept (opus-B16).
        const answered = reply !== null && stop?.kind !== "quota";
        // 快捷回复 (opus-B26) keeps only what the reply invites (go on / finish), by the same rule as 待回复.
        attention.noteAsk(agent.id, answered ? nudgeSentence(reply) : null, new Date().toISOString());
        const event = await telemetry.recordEvent({ type: "turn_ended", agent, turnId, outcome: kind, asks: answered ? replyAsksUser(reply) : null, nudge: answered ? replyNudge(reply) : null, stop, link: findChangeRequest(reply) });
        if (event) analytics.captureEnd(event, agent, paseo);
      });
    }),
    server.on("agent.permission_requested", ({ agent, request }, { paseo }) => { live(agent); observeWork(paseo, agent, () => telemetry.record({ type: "permission_requested", agent, requestId: request.id })); }),
    server.on("agent.permission_resolved", ({ agent, requestId, resolution }, { paseo }) => {
      // One waiting for the approval to be handled goes out once the turn has ended too.
      deferred.notify(agent.id, paseo);
      live(agent);
      if (resolution.behavior === "deny" && resolution.interrupt === true) interrupts.note(agent.id);
      observeWork(paseo, agent, () => telemetry.record({ type: "permission_resolved", agent, requestId, allowed: resolution.behavior === "allow" }));
    }),
    server.on("agent.archived", ({ agent }, { paseo }) => { background.tracker.markClosed(agent.id); observeWork(paseo, agent, () => telemetry.record({ type: "archived", agent })); }),
    // 0.11: the host closed (unloaded) the Agent. It is no longer loaded, and a turn still open will never end on its own.
    server.on("agent.closed", ({ agent }, { paseo }) => { background.tracker.markClosed(agent.id); attention.closedAgent(agent.id); observeWork(paseo, agent, () => telemetry.record({ type: "closed", agent })); }),
  ];
  // The backfill boundary is established before synchronous stats observation begins.
  void stats.ready.then(() => {
    if (statsClosed) return;
    statsRemovers.push(
      server.on("agent.turn_started", ({ agent }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "turn_started", agentId: agent.id }))),
      server.on("agent.turn_ended", ({ agent, turnId, outcome, timeline }, { paseo }) => {
        const kind = outcomeOf(agent.id, turnId, outcome);
        observeWork(paseo, agent, () => stats.record({ type: "turn_ended", agentId: agent.id, outcome: kind, timeline }));
      }),
      server.on("agent.permission_requested", ({ agent, request }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "permission_requested", agentId: agent.id, requestId: request.id }))),
      server.on("agent.permission_resolved", ({ agent, requestId }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "permission_resolved", agentId: agent.id, requestId }))),
    );
  });
  // 「等这一轮结束再发」 and sending now (`observatory.deferred.*`).
  registerSendLedger(server, deferred);
  server.handle(getStats, (input, { paseo }) => { zones.note(input.timeZone); void background.tracker.attach(paseo); tokens.discover(paseo); return stats.read(input, paseo); });
  server.handle(getTelemetry, (input, { paseo }) => { void background.tracker.attach(paseo); tokens.discover(paseo); void replyCheck.refresh(paseo); return telemetry.read(input); });
  server.handle(getAnalytics, (input, { paseo }) => { zones.note(input.timeZone); analytics.refreshRecent(paseo); return telemetry.analyticsRead(input); });
  return async () => {
    fleet.close();
    removeHostData();
    removeSessionActions();
    removePluginUpdates();
    removeHostMemory();
    locales.dispose();
    deferred.stop();
    statsClosed = true;
    replyCheck.close();
    attention.close();
    for (const remove of statsRemovers) remove();
    for (const remove of removers) remove();
    hub.close();
    analytics.close();
    removeHistory();
    await Promise.all([readState.close(), preferences.close(), Promise.resolve(removeResults()), telemetry.close(), stats.close(), tokens.close(), removeDigest(), schedules.close(), background.close(), removeQuota(), resume.close(), zones.close()]);
    bridge.dispose();
  };
}
