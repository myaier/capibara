/**
 * The SDK creates Agents from a single "provider/model" string and throws on a bare provider (`Expected config.provider in
 * "provider/model" format`). A provider that lists no models (ACP agents and other custom providers) is started with the
 * model id "default": the daemon then leaves the model to the agent itself.
 */
export const UNLISTED_MODEL = "default";

export function providerModelId(provider: string, model: string | null | undefined): string {
  return `${provider}/${model?.trim() || UNLISTED_MODEL}`;
}

/** A profile without a model runs the provider's default one: the model it marks default, else its first, else none. */
export function defaultModelOf(models: readonly { id: string; isDefault?: boolean }[] | undefined): string | null {
  return models?.find(model => model.isDefault)?.id ?? models?.[0]?.id ?? null;
}
