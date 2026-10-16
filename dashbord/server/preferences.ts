import { t } from "../shared/text";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { completionSnoozeSchema, defaultObservatorySettings, defaultViewPreferences, getPreferences, observatorySettingsSchema, savedViewSchema, updatePreferences, viewPreferencesSchema,
  type CompletionSnooze, type ObservatorySettings, type PreferencesSnapshot, type PreferencesUpdate, type PreferencesUpdateResult, type SavedView, type ViewPreferences } from "../shared/preferences";
import { telemetryDirectory } from "./telemetry";
import { ensurePrivateDirectory } from "./paseo-home";

const storedViewSchema = z.object({ key: z.string().min(1).max(256), updatedAt: z.iso.datetime({ offset: true }), view: viewPreferencesSchema, savedViews: z.array(savedViewSchema).max(12) });
// `settings` is optional: files written before 2.13 have none (and 2.12 ignores the key).
const fileSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), views: z.array(storedViewSchema).max(32), snoozes: z.array(completionSnoozeSchema).max(2000),
  settings: observatorySettingsSchema.partial().optional() });
type StoredView = z.infer<typeof storedViewSchema>;

export class PreferencesStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly now: () => number;
  private revision = 0;
  private views = new Map<string, StoredView>();
  private snoozes: CompletionSnooze[] = [];
  private settings: ObservatorySettings = { ...defaultObservatorySettings };
  private error: string | null = null;
  private corrupt = false;
  private closed = false;
  private mutations: Promise<void>;

  constructor(options: { directory?: string; now?: () => number } = {}) {
    this.directory = options.directory ?? telemetryDirectory(); this.file = join(this.directory, "preferences.json");
    this.now = options.now ?? Date.now; this.mutations = this.load();
  }

  private async load() {
    try {
      if ((await stat(this.file)).size > 32_000_000) throw new Error("preferences exceed storage limit");
      const data = fileSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      this.revision = data.revision;
      for (const view of data.views) this.views.set(view.key, view);
      this.snoozes = data.snoozes;
      this.settings = { ...defaultObservatorySettings, ...data.settings };
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        this.corrupt = true;
        this.error = t("serverPreferences.m001");
      }
    }
  }

  private current(viewKey: string): PreferencesSnapshot {
    const stored = this.views.get(viewKey);
    // The live view never carries search text (older clients saved it and it followed people to other devices); saved views keep theirs.
    return structuredClone({ revision: this.revision, view: { ...(stored?.view ?? defaultViewPreferences(viewKey)), query: "" }, savedViews: stored?.savedViews ?? [],
      snoozes: this.snoozes.filter(snooze => Date.parse(snooze.until) > this.now()), error: this.error, settings: { ...this.settings } });
  }

  /** What the server-side attention summary needs: live snoozes and the host settings. */
  async attentionInputs(): Promise<{ snoozes: CompletionSnooze[]; settings: ObservatorySettings }> {
    await this.mutations;
    return { snoozes: this.snoozes.filter(snooze => Date.parse(snooze.until) > this.now()).map(snooze => ({ ...snooze })), settings: { ...this.settings } };
  }

  async get(viewKey: string): Promise<PreferencesSnapshot> {
    getPreferences.input.parse({ viewKey });
    await this.mutations;
    return this.current(viewKey);
  }

  async update(input: PreferencesUpdate): Promise<PreferencesUpdateResult> {
    if (this.closed) throw new Error(t("serverPreferences.m002"));
    const validated = updatePreferences.input.parse(input);
    const task = this.mutations.then(() => this.apply(validated));
    this.mutations = task.then(() => {}, () => {});
    return task;
  }

  private async apply(input: PreferencesUpdate): Promise<PreferencesUpdateResult> {
    if (input.expectedRevision !== this.revision) return { status: "conflict", ...this.current(input.viewKey) };
    const now = this.now(), at = new Date(now).toISOString();
    const old = this.views.get(input.viewKey);
    const view: ViewPreferences = { ...(old?.view ?? defaultViewPreferences(input.viewKey)), ...input.view, query: "" };
    view.expanded = [...new Set(view.expanded)];
    let savedViews: SavedView[] = old ? structuredClone(old.savedViews) : [];
    let snoozes = this.snoozes.filter(snooze => Date.parse(snooze.until) > now);
    if (input.deleteSavedViewId) savedViews = savedViews.filter(saved => saved.id !== input.deleteSavedViewId);
    if (input.saveView) {
      const existing = input.saveView.id ? savedViews.find(saved => saved.id === input.saveView!.id) : undefined;
      if (input.saveView.id && !existing) throw new Error(t("serverPreferences.m003"));
      if (savedViews.some(saved => saved.name === input.saveView!.name && saved.id !== existing?.id)) throw new Error(t("serverPreferences.m004"));
      if (!existing && savedViews.length >= 12) throw new Error(t("serverPreferences.m005"));
      const saved: SavedView = { id: existing?.id ?? randomUUID(), name: input.saveView.name, createdAt: existing?.createdAt ?? at, updatedAt: at,
        view: { ...input.saveView.view, expanded: [...new Set(input.saveView.view.expanded)] } };
      savedViews = [saved, ...savedViews.filter(candidate => candidate.id !== saved.id)];
    }
    if (input.unsnooze) snoozes = snoozes.filter(snooze => snooze.agentId !== input.unsnooze!.agentId || Date.parse(snooze.completionAt) !== Date.parse(input.unsnooze!.completionAt));
    if (input.snooze) {
      const until = Date.parse(input.snooze.until);
      if (until <= now || until > now + 30 * 86_400_000) throw new Error(t("serverPreferences.m006"));
      if (Date.parse(input.snooze.completionAt) > now) throw new Error(t("serverPreferences.m007"));
      snoozes = snoozes.filter(snooze => snooze.agentId !== input.snooze!.agentId || Date.parse(snooze.completionAt) !== Date.parse(input.snooze!.completionAt));
      if (snoozes.length >= 2000) throw new Error(t("serverPreferences.m008"));
      snoozes.unshift({ ...input.snooze });
    }
    const settings: ObservatorySettings = { ...this.settings, ...input.settings };
    const changed = JSON.stringify(old?.view ?? defaultViewPreferences(input.viewKey)) !== JSON.stringify(view)
      || JSON.stringify(old?.savedViews ?? []) !== JSON.stringify(savedViews) || JSON.stringify(this.snoozes) !== JSON.stringify(snoozes)
      || JSON.stringify(this.settings) !== JSON.stringify(settings);
    if (!changed) return { status: "updated", ...this.current(input.viewKey) };
    if (!old && this.views.size >= 32) {
      const oldest = [...this.views.values()].filter(view => view.savedViews.length === 0).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (!oldest) throw new Error(t("serverPreferences.m009"));
      this.views.delete(oldest.key);
    }
    this.views.set(input.viewKey, { key: input.viewKey, updatedAt: at, view, savedViews });
    this.snoozes = snoozes; this.settings = settings; this.revision += 1;
    await this.persist();
    return { status: "updated", ...this.current(input.viewKey) };
  }

  private async persist() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await ensurePrivateDirectory(this.directory);
      if (this.corrupt) { try { await rename(this.file, `${this.file}.corrupt`); } catch { /* unreadable/absent original */ } this.corrupt = false; }
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, revision: this.revision, views: [...this.views.values()], snoozes: this.snoozes, settings: this.settings }), "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, this.file); this.error = null;
    } catch { this.error = t("serverPreferences.m010"); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async close() { this.closed = true; await this.mutations; }
}

export function registerPreferences(server: PluginServerContext) {
  const store = new PreferencesStore();
  server.handle(getPreferences, ({ viewKey }) => store.get(viewKey));
  server.handle(updatePreferences, input => store.update(input));
  return { store, close: () => store.close() };
}
