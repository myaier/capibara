import { t } from "../shared/text";
import type { PaseoApi, PaseoAgentCreateOptions, PaseoAgentHandle, PaseoAgentRunResult, PaseoProviderSnapshotResult, AgentMode } from "./paseo-types";
import { z } from "zod";
import { redactSecrets } from "./redaction";
import { providerModelId } from "../shared/provider-model";
import { lightModelRank, lowestEffort } from "../shared/session-actions";
import { markInternalAgent } from "./internal-agents";

type Access = "read" | "ask";
interface ModelOption { id: string; label: string; isDefault: boolean; thinking: { id: string; label: string }[]; defaultThinkingOptionId: string | null }
interface CatalogEntry { provider: string; enabled: boolean; status: string; modes: AgentMode[]; models: ModelOption[]; extends: string | null }
export interface MetadataPlan {
  info: { provider: string; model: string; thinkingOptionId: string | null; modeId: string | null };
  model: string; effort: string | null; access: Access; featureValues: Record<string, unknown>; providerOptions?: Record<string, unknown>;
}
const METADATA_FEATURES = new Set(["fast_mode", "fast", "service_tier", "reasoning", "reasoning_effort", "effort", "thinking"]);
const AUTO_ACCEPT_BASES = new Set(["acp", "copilot", "opencode"]);
const clipped = (value: string | undefined | null, length: number) => value?.trim().slice(0, length) || null;
const safeError = (value: unknown, length = 300) => redactSecrets(value instanceof Error ? value.message : String(value)).slice(0, length);
const validId = (value: string | undefined, max: number) => value && value.length <= max ? value : null;
/** The allowed switches with plain values; `auto_accept: false` (switching approval prompts back on) always passes. */
export function filterMetadataFeatures(values: Record<string, unknown> = {}): Record<string, unknown> {
  const plain = (value: unknown) => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 120);
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => (METADATA_FEATURES.has(key) && plain(value)) || (key === "auto_accept" && value === false)));
}
export interface MetadataMode { modeId: string | null; access: Access; providerOptions?: Record<string, unknown>; unsafe?: true }
/** Codex's read-only sandbox, applied on top of its default mode (create_agent rejects modes a provider does not list). */
export const CODEX_READ_ONLY_OPTIONS = { sandbox_mode: "read-only", approval_policy: "never" } as const;
/**
 * The mode a metadata task runs in, always explicit (create_agent otherwise inherits the parent Agent's mode, often
 * unattended, or maps an unattended parent to the target's unattended mode). Only modes whose restriction is known qualify:
 * - Codex and providers that extend it: the default mode in Codex's read-only sandbox without approvals (`read`);
 * - an `ask` mode (Cursor's read-only Ask; Oh My Pi's Always Ask) (`read`);
 * - a `default` mode the provider marks as safe, Claude Code's Always Ask: every tool that needs approval asks (`ask`);
 * - a plan mode (`read`).
 * A mode id alone proves nothing (an ACP agent's "default" or "agent" mode may edit without asking), and a provider with
 * no listed modes cannot be pinned to one: both are `unsafe` and never run.
 */
export function metadataMode(modes: readonly AgentMode[], provider: { codex?: boolean } = {}): MetadataMode {
  const usable = modes.filter(mode => !(mode as AgentMode & { isUnattended?: boolean }).isUnattended && mode.colorTier !== "dangerous");
  if (provider.codex && usable.some(mode => mode.id === "auto")) return { modeId: "auto", access: "read", providerOptions: { ...CODEX_READ_ONLY_OPTIONS } };
  const ask = usable.find(mode => mode.id === "ask");
  if (ask) return { modeId: ask.id, access: "read" };
  const gated = usable.find(mode => mode.id === "default" && mode.colorTier === "safe");
  if (gated) return { modeId: gated.id, access: "ask" };
  const plan = usable.find(mode => mode.id === "plan" || mode.colorTier === "planning");
  if (plan) return { modeId: plan.id, access: "read" };
  return { modeId: null, access: "ask", unsafe: true };
}
/** The built-ins a provider is or extends (custom providers name theirs in `extends`). */
const lineage = (entry: Pick<CatalogEntry, "provider" | "extends">) => [entry.provider, entry.extends].filter((id): id is string => !!id);
const modeOf = (entry: CatalogEntry) => metadataMode(entry.modes, { codex: lineage(entry).includes("codex") });
/** A metadata task never auto-accepts: ACP and OpenCode clients otherwise switch it on for children of unattended Agents. */
const lockedFeatures = (entry: CatalogEntry): Record<string, unknown> => lineage(entry).some(id => AUTO_ACCEPT_BASES.has(id)) ? { auto_accept: false } : {};

function normalizeModels(entry: PaseoProviderSnapshotResult["entries"][number], snapshot: PaseoProviderSnapshotResult): ModelOption[] {
  const compact = snapshot.compactSnapshot?.entries.find(candidate => candidate.provider === entry.provider);
  const raw = entry.models?.length ? entry.models : compact?.models ?? [];
  const seen = new Set<string>();
  return raw.flatMap(model => {
    if (!validId(model.id, 240) || seen.has(model.id)) return [];
    seen.add(model.id);
    const compactModel = compact?.models?.find(candidate => candidate.id === model.id);
    const setIndex = "thinkingSet" in model && typeof model.thinkingSet === "number" ? model.thinkingSet : compactModel?.thinkingSet;
    const set = setIndex === undefined ? undefined : snapshot.compactSnapshot?.thinkingSets[setIndex];
    const options = "thinkingOptions" in model && model.thinkingOptions?.length ? model.thinkingOptions : set?.options ?? [];
    const defaultThinkingOptionId = validId(model.defaultThinkingOptionId ?? set?.defaultOptionId ?? options.find(option => option.isDefault)?.id, 120);
    return [{ id: model.id, label: clipped(model.label, 240) ?? model.id, isDefault: !!model.isDefault,
      thinking: options.filter(option => validId(option.id, 120)).slice(0, 16).map(option => ({ id: option.id, label: clipped(option.label, 120) ?? option.id })), defaultThinkingOptionId }];
  }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).slice(0, 150);
}

async function catalogRequest<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([request, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(t("metadataRunner.m010"))), 12_000); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Provider snapshots are cached per connection; title generation only uses listed lightweight models. */
export class MetadataRunnerRegistry {
  private pending: { at: number; value: Promise<CatalogEntry[]> } | null = null;
  constructor(private readonly paseo: PaseoApi) {}
  private catalog(): Promise<CatalogEntry[]> {
    if (!this.pending || Date.now() - this.pending.at >= 60_000) {
      const value = catalogRequest(Promise.all([this.paseo.config.get(), this.paseo.providers.snapshot()])).then(([{ config }, snapshot]) => {
        const entries = snapshot.entries.length ? snapshot.entries : (snapshot.compactSnapshot?.entries ?? []);
        return entries.filter(entry => validId(entry.provider, 120)).map(entry => {
          const compact = snapshot.compactSnapshot?.entries.find(candidate => candidate.provider === entry.provider);
          const full = snapshot.entries.find(candidate => candidate.provider === entry.provider) ?? { ...entry, models: undefined };
          return { provider: entry.provider, enabled: entry.enabled !== false && config.providers?.[entry.provider]?.enabled !== false,
            status: entry.status, modes: entry.modes ?? compact?.modes ?? [], models: normalizeModels(full, snapshot),
            extends: validId((config.providers?.[entry.provider] as { extends?: unknown } | undefined)?.extends as string | undefined, 120) ?? null };
        });
      });
      this.pending = { at: Date.now(), value };
    }
    return this.pending.value;
  }
  async titlePlans(provider: string): Promise<MetadataPlan[]> {
    const entries = await this.catalog();
    const candidates = entries.filter(entry => entry.enabled && entry.status === "ready" && !modeOf(entry).unsafe)
      .flatMap(entry => entry.models.flatMap(model => {
        const rank = lightModelRank(`${model.id} ${model.label}`), effort = lowestEffort(model.thinking);
        if (rank === null || (model.thinking.length && !effort)) return [];
        return [{ entry, model: model.id, effort, rank }];
      })).sort((a, b) => Number(b.entry.provider === provider) - Number(a.entry.provider === provider) || a.rank - b.rank);
    return candidates.slice(0, 2).map(({ entry, model, effort }) => {
      const { modeId, access, providerOptions } = modeOf(entry);
      return { info: { provider: entry.provider, model, thinkingOptionId: effort, modeId }, model, effort, access,
        featureValues: lockedFeatures(entry), ...(providerOptions ? { providerOptions } : {}) };
    });
  }
}

export interface MetadataTimers { set(callback: () => void, delayMs: number): unknown; clear(timer: unknown): void }
export interface MetadataTaskOptions<T> {
  paseo: PaseoApi; plan: MetadataPlan; parent: { id: string; cwd: string | null }; jobId: string; prompt: string; systemPrompt: string;
  schema: z.ZodType; parse: (text: string) => T; signal: AbortSignal; title: string;
  onCleanupError?: (error: Error) => void; now?: () => number; timeoutMs?: number; timers?: MetadataTimers;
}
const defaultTimers: MetadataTimers = { set(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; }, clear(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); } };
async function boundedCleanup<T>(operation: Promise<T>, timers: MetadataTimers, timeoutMs = 5000): Promise<T> {
  let timer: unknown;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = timers.set(() => reject(new Error(t("metadataRunner.m021"))), timeoutMs); })]); }
  finally { if (timer !== undefined) timers.clear(timer); }
}

/** One restricted, automatically archived session for a short metadata task. */
export async function runMetadataTask<T>(options: MetadataTaskOptions<T>): Promise<{ value: T }> {
  const { paseo, plan, parent, signal } = options;
  // Never create a helper whose mode is not pinned to a verified restricted one: without a mode it would inherit the analysed Agent's.
  if (!plan.info.modeId || (plan.access !== "read" && plan.access !== "ask")) throw new Error(t("metadataRunner.m008"));
  if (signal.aborted) throw new Error(t("metadataRunner.m023"));
  const now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 20_000, deadline = now() + timeoutMs, timers = options.timers ?? defaultTimers;
  let handle: PaseoAgentHandle | undefined, terminated: Error | undefined, denials = 0;
  let rejectStop!: (error: Error) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  void stop.catch(() => {});
  const terminate = (message: string) => { terminated ??= new Error(message); rejectStop(terminated); };
  const cancel = () => terminate(t("metadataRunner.m024"));
  const timer = timers.set(() => terminate(t("metadataRunner.m025")), timeoutMs);
  signal.addEventListener("abort", cancel, { once: true });
  const remaining = () => { if (signal.aborted) cancel(); if (now() >= deadline) terminate(t("metadataRunner.m026")); if (terminated) throw terminated; return Math.max(1, deadline - now()); };
  const guarded = async <V>(operation: Promise<V>): Promise<V> => { remaining(); return Promise.race([operation, stop]); };
  const archive = async (target: PaseoAgentHandle) => { try { await boundedCleanup(target.archive(), timers); } catch (error) { const failure = new Error(t("metadataRunner.m027", { value1: safeError(error) })); if (options.onCleanupError) options.onCleanupError(failure); else console.warn(failure.message); } };
  const wait = async (initial?: PaseoAgentRunResult): Promise<PaseoAgentRunResult> => {
    let result = initial;
    for (;;) {
      result ??= await guarded(handle!.waitForFinish(remaining()));
      if (result.status === "timeout") throw new Error(t("metadataRunner.m028"));
      if (result.status === "error") throw new Error(t("metadataRunner.m029", { value1: safeError(result.error ?? result.final?.lastError ?? t("metadataRunner.m030"), 1200) }));
      if (result.status === "idle") return result;
      let permissions = result.final?.pendingPermissions ?? handle!.current()?.pendingPermissions ?? [];
      if (!permissions.length) permissions = (await guarded(handle!.refresh()))?.agent.pendingPermissions ?? [];
      if (!permissions.length) throw new Error(t("metadataRunner.m031"));
      for (const permission of permissions) {
        await guarded(handle!.respondToPermission({ requestId: permission.id, response: { behavior: "deny", message: t("metadataRunner.m004") } }));
        denials++;
      }
      if (denials > 8) throw new Error(t("metadataRunner.m032"));
      result = undefined;
    }
  };
  try {
    remaining();
    const config: PaseoAgentCreateOptions["config"] = { provider: providerModelId(plan.info.provider, plan.info.model),
      modeId: plan.info.modeId, ...(plan.info.thinkingOptionId ? { thinkingOptionId: plan.info.thinkingOptionId } : {}), featureValues: filterMetadataFeatures(plan.featureValues),
      ...(plan.providerOptions ? { options: plan.providerOptions as NonNullable<PaseoAgentCreateOptions["config"]["options"]> } : {}), systemPrompt: options.systemPrompt,
      toolPolicy: { preapproved: [] }, mcpServers: {} };
    const common = { config, title: options.title.slice(0, 60), prompt: options.prompt, outputSchema: z.toJSONSchema(options.schema),
      labels: { "observatory.role": "title", "observatory.job": options.jobId }, autoArchive: true };
    if (!parent.id || !parent.cwd) throw new Error(t("metadataRunner.m009"));
    const creation = paseo.agents.create({ ...common, cwd: parent.cwd, parent: parent.id });
    // Creation may complete after cancellation. The resulting handle still belongs to us.
    void creation.then(async created => { if (terminated && !handle) await archive(created); }).catch(() => {});
    handle = await guarded(creation);
    markInternalAgent(handle.id);
    const result = await wait();
    remaining();
    return { value: options.parse(result.lastMessage ?? "") };
  } finally {
    timers.clear(timer); signal.removeEventListener("abort", cancel);
    if (handle) await archive(handle);
  }
}
