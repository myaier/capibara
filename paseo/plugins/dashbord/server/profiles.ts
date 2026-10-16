import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listProfiles, PROFILE_NAME_MAX, PROFILE_NOTES_MAX, profileSchema, type ProfileSummary } from "../shared/profiles";

const FIELDS = ["id", "name", "provider", "model", "modeId", "thinkingOptionId", "featureValues", "notes"] as const;
/** Fields that are only shown, with the length they are shortened to. */
const SHOWN: Partial<Record<(typeof FIELDS)[number], number>> = { name: PROFILE_NAME_MAX, notes: PROFILE_NOTES_MAX };
function shortened(value: unknown, maximum: number | undefined): unknown {
  if (maximum === undefined || typeof value !== "string" || value.length <= maximum) return value;
  let end = maximum - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end) + "…";
}
/** Each profile's id, name, provider, model, mode, thinking option, feature values and notes; nothing else of the config. */
export function profileSummaries(profiles: readonly unknown[] | undefined): ProfileSummary[] {
  const result: ProfileSummary[] = [];
  for (const profile of (profiles ?? []).slice(0, 500)) {
    if (!profile || typeof profile !== "object") continue;
    const source = profile as Record<string, unknown>;
    const parsed = profileSchema.safeParse(Object.fromEntries(FIELDS.filter(field => source[field] !== undefined).map(field => [field, shortened(source[field], SHOWN[field])])));
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}

export function registerProfiles(server: PluginServerContext): void {
  server.handle(listProfiles, async (_input, { paseo }) => ({ profiles: profileSummaries((await paseo.config.get()).config.agentProfiles) }));
}
