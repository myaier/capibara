import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { deferredSendContracts } from "./deferred-rpc";

/** At most this many ids in each list, and this many custom ids' bases (a daemon config has far fewer). */
export const MAX_SEND_IDS = 200;
const ids = z.array(z.string().max(64)).max(MAX_SEND_IDS);
/** Custom provider id → the built-in it extends (codex-obs-send-ui-F3). */
const bases = z.record(z.string().max(64), z.string().max(64)).refine(value => Object.keys(value).length <= MAX_SEND_IDS, "too many provider bases");
/**
 * How a running turn takes a message on this host (`readSendCapabilities()` in `server/steerable-providers.ts`, read from the
 * daemon config): `providers` steer at all (the built-ins plus custom ids extending them), `slashSteerable` also take a
 * steered slash command (Claude and the ids built on it), and `bases` names the built-in each custom id extends, so a command
 * into it is planned as its built-in runs it (a custom Codex's `/compact` runs beside the turn, as Codex's does). Used with
 * `client/send-plan.ts`. A server that does not send `slashSteerable` leaves only the built-in Claude taking slash commands
 * mid-turn: every other one is asked about first; one that does not send `bases` gets the cautious reading of commands into
 * custom ids.
 */
export const getSteerableProviders = defineRpc({
  name: "observatory.steerable.list",
  input: z.object({}),
  output: z.object({ providers: ids, slashSteerable: ids.default([]), bases: bases.default({}) }),
});
/** What `sendPlan` needs from the host besides the Agent itself. */
export interface SendCapabilities { steerable: readonly string[]; slashSteerable: readonly string[]; bases?: Readonly<Record<string, string>> }
/** Before the host's lists arrive (or when they cannot be read): the built-ins only, so a custom provider is asked about first. */
export const BUILTIN_SEND: SendCapabilities = { steerable: [], slashSteerable: [], bases: {} };

/** The server's reply from what `readSendCapabilities()` read: every list bounded, bases kept (ids past 64 characters dropped). */
export function steerableReply(capabilities: { steerable: readonly string[]; slashSteerable: readonly string[]; bases?: Readonly<Record<string, string>> }): z.input<typeof getSteerableProviders.output> {
  const short = (id: string) => id.length <= 64;
  return { providers: capabilities.steerable.filter(short).slice(0, MAX_SEND_IDS), slashSteerable: capabilities.slashSteerable.filter(short).slice(0, MAX_SEND_IDS),
    bases: Object.fromEntries(Object.entries(capabilities.bases ?? {}).filter(([id, base]) => short(id) && short(base)).slice(0, MAX_SEND_IDS)) };
}
/** The client's capabilities from the reply: all three, as they came. */
export function capabilitiesFromReply(answer: z.output<typeof getSteerableProviders.output>): SendCapabilities {
  return { steerable: answer.providers, slashSteerable: answer.slashSteerable, bases: answer.bases };
}

/**
 * Every message the observatory sends to an Agent (快捷回复, 发给这个 Agent) goes through the plugin server's ledger
 * (`server/deferred-send.ts`): sending now, planned again on the server at the last moment, and 「等这一轮结束再发」.
 */
export const observatoryDeferred = deferredSendContracts("observatory");
