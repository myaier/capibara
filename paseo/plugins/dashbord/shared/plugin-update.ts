import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The installed release. tests/plugin-update.test.ts keeps it equal to package.json. */
export const OBSERVATORY_VERSION = "2.20.0-dev.4";
export const OBSERVATORY_PLUGIN_ID = "agent-observatory";
export const CHANGELOG_ENTRIES_MAX = 8;

const commit = z.string().regex(/^[0-9a-f]{40,64}$/);
const changelogEntry = z.object({ version: z.string().max(80), heading: z.string().max(200), body: z.string().max(6000) });
export type ChangelogEntry = z.infer<typeof changelogEntry>;
/** Where this installation comes from, in the form `paseo plugin add` takes, and the Git ref it follows (null: the default branch). */
const pluginSource = z.object({ reference: z.string().max(600), ref: z.string().max(200).nullable() });
export type PluginSource = z.infer<typeof pluginSource>;
export const updateStateSchema = z.object({
  version: z.string(), revision: z.string().nullable(),
  /** A newer revision on the installation's source, with the changelog entries after the installed version. */
  available: z.object({ commit, version: z.string().nullable(), entries: z.array(changelogEntry).max(CHANGELOG_ENTRIES_MAX), truncated: z.boolean() }).nullable(),
  /** The person chose 暂不更新 for this revision; a newer one prompts again. */
  dismissed: z.boolean(),
  checking: z.boolean(), checkedAt: z.string().nullable(), error: z.string().nullable(),
  updating: z.object({ commit, startedAt: z.string(), error: z.string().nullable() }).nullable(),
  /** This process is the revision an update started within the last 30 minutes switched to (from → to). */
  justUpdated: z.object({ from: z.string(), to: z.string(), commit, startedAt: z.string() }).nullable(),
  /** Known after the first check; servers before 2.20 omit it. Directory installations have none to reproduce. */
  source: pluginSource.nullable().optional(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;
export const getUpdate = defineRpc({ name: "observatory.update.get", input: z.object({ refresh: z.boolean().optional() }), output: updateStateSchema });
export const dismissUpdate = defineRpc({ name: "observatory.update.dismiss", input: z.object({ commit }), output: updateStateSchema });
/** Applies exactly the reviewed revision; a source that moved since the sheet opened is refused. */
export const applyUpdate = defineRpc({ name: "observatory.update.apply", input: z.object({ commit }), output: updateStateSchema });

/**
 * The source reference Paseo itself prints for an installation identity (its `formatPluginIdentity`), which `paseo plugin add`
 * parses back: `git:<remote>[:<path>]`, `npm:<package>[:<path>]` or a registry's `<host>/<id>`. Directory installations
 * exist only on their own disk, so they have no reference another host could install.
 */
export function formatPluginSource(identity: unknown): string | null {
  const value = identity && typeof identity === "object" ? identity as Record<string, unknown> : {};
  const registry = value.registry && typeof value.registry === "object" ? value.registry as Record<string, unknown> : null;
  if (registry && typeof registry.url === "string" && typeof registry.id === "string") {
    try { return `${new URL(registry.url).host}/${registry.id}`; } catch { return null; }
  }
  const path = typeof value.pluginPath === "string" ? value.pluginPath : ".";
  const source = value.kind === "git" && typeof value.remote === "string" ? `git:${value.remote}`
    : value.kind === "npm" && typeof value.packageName === "string" ? `npm:${value.packageName}` : null;
  return source && (path === "." ? source : `${source}:${path}`);
}

/** `## 2.18.0-dev.6 · Capibara · 2026-10-15` sections newer than `installed`, newest first. */
export function changelogSince(markdown: string, installed: string): { version: string | null; entries: ChangelogEntry[]; truncated: boolean } {
  const sections = markdown.split(/^## /m).slice(1).map(section => {
    const newline = section.indexOf("\n"), heading = (newline < 0 ? section : section.slice(0, newline)).trim();
    return { version: heading.split(/\s+·\s+|\s+/)[0] ?? "", heading: heading.slice(0, 200), body: (newline < 0 ? "" : section.slice(newline + 1)).trim().slice(0, 6000) };
  }).filter(section => section.version);
  const known = sections.findIndex(section => section.version === installed);
  const newer = known < 0 ? sections : sections.slice(0, known);
  return { version: sections[0]?.version ?? null, entries: newer.slice(0, CHANGELOG_ENTRIES_MAX), truncated: newer.length > CHANGELOG_ENTRIES_MAX || known < 0 };
}

export type UpdatePhase = "building" | "restarting" | "done";
/**
 * Paseo's apply is one request without progress events, so this is an estimate: fetching and building approach 85% over
 * about a minute, the plugin restarting (its reads fail) is at least 90%, and the new revision answering is 100%.
 */
export function estimateUpdateProgress(elapsedMs: number, phase: UpdatePhase): number {
  if (phase === "done") return 1;
  const building = Math.max(0.04, 0.85 * (1 - Math.exp(-Math.max(0, elapsedMs) / 25_000)));
  return phase === "restarting" ? Math.max(building, 0.9) : building;
}
