import { readRepoSecret } from "../backendVault.js"
import type { Context } from "../implementations/types.js"
import { hasGitHubActionsIdentity, readRuntimeSecretFromKody, writeRuntimeSecretsToKody } from "../kody-api-client.js"
import { masterKeyBytes } from "../pool/keys.js"

export type RuntimeSecretSource = "vault" | "env" | "missing"

export interface RuntimeSecretResult {
  value: string
  source: RuntimeSecretSource
  warning?: string
}

export interface RuntimeSecretsResult {
  environment: Record<string, string>
  warnings: string[]
}

function envSecret(name: string, env: NodeJS.ProcessEnv): RuntimeSecretResult {
  const value = env[name]?.trim() ? env[name]! : ""
  return value ? { value, source: "env" } : { value: "", source: "missing" }
}

/**
 * Resolve a repo-scoped runtime secret.
 *
 * Order is intentionally vault first, then env fallback for local/dev or older
 * workflows that still expose mirrored Actions secrets.
 */
export async function resolveRuntimeSecret(
  name: string,
  ctx: Pick<Context, "config">,
  opts: {
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<RuntimeSecretResult> {
  const env = opts.env ?? process.env
  if (hasGitHubActionsIdentity(env)) {
    try {
      const value = await readRuntimeSecretFromKody(name, env)
      if (value) return { value, source: "vault" }
      return envSecret(name, env)
    } catch (err) {
      const fallback = envSecret(name, env)
      return {
        ...fallback,
        warning: `Kody secret read failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  const masterRaw = env.KODY_MASTER_KEY?.trim() ?? ""
  if (!masterRaw || !env.CONVEX_URL?.trim() || !env.KODY_SERVICE_KEY?.trim()) return envSecret(name, env)

  try {
    const masterKey = masterKeyBytes(masterRaw)
    if (masterKey.length !== 32) {
      throw new Error("KODY_MASTER_KEY must decode to 32 bytes")
    }
    const value = await readRepoSecret({
      owner: ctx.config.github.owner,
      repo: ctx.config.github.repo,
      name,
      masterKey,
    })
    if (value) return { value, source: "vault" }
  } catch (err) {
    const fallback = envSecret(name, env)
    return {
      ...fallback,
      warning: `vault read failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return envSecret(name, env)
}

/** Resolve only the secret names declared by a trusted script Capability. */
export async function resolveRuntimeSecrets(
  names: unknown,
  ctx: Pick<Context, "config">,
  opts: {
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<RuntimeSecretsResult> {
  const declared = Array.isArray(names)
    ? [...new Set(names.filter((name): name is string => typeof name === "string" && /^[A-Z][A-Z0-9_]*$/.test(name)))]
    : []
  const resolved: Array<{ name: string; result: RuntimeSecretResult }> = []
  for (const name of declared) {
    resolved.push({ name, result: await resolveRuntimeSecret(name, ctx, opts) })
  }
  const warnings = resolved.flatMap(({ result }) => (result.warning ? [result.warning] : []))
  const fallbackSecrets = Object.fromEntries(
    resolved.flatMap(({ name, result }) => (result.source === "env" && result.value ? [[name, result.value]] : [])),
  )
  if (hasGitHubActionsIdentity(opts.env ?? process.env) && Object.keys(fallbackSecrets).length > 0) {
    try {
      await writeRuntimeSecretsToKody(fallbackSecrets, opts.env ?? process.env)
    } catch (err) {
      warnings.push(`Kody secret migration failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    environment: Object.fromEntries(
      resolved.flatMap(({ name, result }) => (result.value ? [[name, result.value]] : [])),
    ),
    warnings,
  }
}
