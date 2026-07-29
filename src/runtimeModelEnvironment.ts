import { type ProviderModel, providerApiKeyEnvVar } from "./config.js"
import type { Context } from "./implementations/types.js"
import { resolveRuntimeSecret } from "./scripts/runtimeSecrets.js"

export interface RuntimeModelEnvironment {
  environment: Record<string, string>
  warnings: string[]
}

/**
 * Resolve the one credential required by the selected model.
 *
 * This stays separate from capability secrets: the model belongs to the
 * generic agent runtime, while a capability owns only the secrets declared in
 * its contract.
 */
export async function resolveRuntimeModelEnvironment(
  model: ProviderModel,
  ctx: Pick<Context, "config">,
): Promise<RuntimeModelEnvironment> {
  const name = model.apiKeyEnvVar ?? providerApiKeyEnvVar(model.provider)
  const result = await resolveRuntimeSecret(name, ctx)
  const warnings = result.warning ? [result.warning] : []
  if (!result.value) {
    return {
      environment: {},
      warnings: [...warnings, `Model credential ${name} is missing from the Kody vault.`],
    }
  }
  return {
    environment: { [name]: result.value },
    warnings,
  }
}
