import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The host's agent profiles for 交给另一个 Provider and 交给 Agent: only the fields those sheets show or pass on to
 * `agents.create`, read by server/profiles.ts. The rest of the daemon config (provider env, commands, plugin sources)
 * never goes to the device. The host sets no length limits, so neither does this: a profile is never left out for a long
 * value. Only the name and notes, which are only shown, are shortened (server/profiles.ts).
 */
export const PROFILE_NAME_MAX = 400, PROFILE_NOTES_MAX = 4000;
export const profileSchema = z.object({ id: z.string(), name: z.string().max(PROFILE_NAME_MAX), provider: z.string(), model: z.string().optional(),
  modeId: z.string().optional(), thinkingOptionId: z.string().optional(), featureValues: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(PROFILE_NOTES_MAX).optional() });
export type ProfileSummary = z.infer<typeof profileSchema>;
export const listProfiles = defineRpc({ name: "observatory.profiles.list", input: z.object({}), output: z.object({ profiles: z.array(profileSchema).max(500) }) });
