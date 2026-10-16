import { createHash } from "node:crypto";
import type { PaseoApi, PaseoAgent, PaseoAgentRefetchResult } from "./paseo-types";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { TelemetryEvent } from "../shared/telemetry";
import type { TelemetryStore } from "./telemetry";
import type { AnalyticsAgent, ReportedUsage } from "./analytics";

function attribution(agent: PaseoAgent, project: PaseoAgentRefetchResult["project"]): AnalyticsAgent {
  return { id: agent.id, provider: agent.provider, workspaceId: agent.workspaceId,
    projectId: project?.projectKey ?? null, projectName: project?.projectName ?? null,
    projectRootPath: project?.checkout.mainRepoRoot ?? project?.checkout.worktreeRoot ?? project?.checkout.cwd ?? null };
}
function usageFields(usage: ReportedUsage | null | undefined): ReportedUsage | null {
  return usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens, totalCostUsd: usage.totalCostUsd } : null;
}

/**
 * Metadata-only reads. This never downloads a timeline or creates a second SDK connection.
 * Reported provider snapshots have incompatible accounting semantics, so they are
 * retained as samples and peak values; no subtraction or billing-total inference occurs.
 */
export function createAnalyticsEnrichment(store: TelemetryStore) {
  let closed = false;
  let running = 0;
  let lastRefresh = 0;
  let refreshing = false;
  const queue: Array<() => Promise<void>> = [];
  const pump = () => {
    while (!closed && running < 4 && queue.length) {
      const task = queue.shift()!;
      running++;
      void task().catch(() => {}).finally(() => { running--; pump(); });
    }
  };
  return {
    captureEnd(event: TelemetryEvent, observed: PluginHookAgent, paseo: PaseoApi) {
      if (closed || queue.length >= 64) return;
      // The lifecycle summary has already been recorded even if enrichment fails.
      queue.push(async () => {
        const result = await paseo.agents.ref(observed.id).refresh();
        if (closed || !result) return;
        const agent = result.agent;
        const newerMessage = agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > Date.parse(event.at);
        // Never attach a subsequent active turn's snapshot to the preceding end.
        const usage = agent.activeTurn || newerMessage ? null : usageFields(agent.lastUsage);
        await store.recordUsage(event.id, attribution(agent, result.project), event.at, usage);
      });
      pump();
    },
    refreshRecent(paseo: PaseoApi) {
      const now = Date.now();
      if (closed || refreshing || now - lastRefresh < 30_000) return;
      lastRefresh = now; refreshing = true;
      // One bounded directory page supplies recent live usage and exact project placement.
      // The UI still obtains its complete agent directory independently through the SDK.
      void Promise.resolve().then(() => paseo.agents.list({ filter: { includeArchived: false }, sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 200 }, timeout: 12_000 })).then(async result => {
        if (closed) return;
        const at = new Date(now).toISOString();
        for (const entry of result.entries) {
          if (closed) return;
          const usage = usageFields(entry.agent.lastUsage);
          const key = `sample:${createHash("sha256").update(entry.agent.id).update(JSON.stringify(usage)).digest("hex")}`;
          await store.recordUsage(key, attribution(entry.agent, entry.project), at, usage);
        }
      }).catch(() => {}).finally(() => { refreshing = false; });
    },
    close() { closed = true; queue.length = 0; },
  };
}
