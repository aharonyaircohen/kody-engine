import { readRepoSecret } from "../backendVault.js"
import type { Context } from "../implementations/types.js"
import { masterKeyBytes } from "../pool/keys.js"

export type RuntimeSecretSource = "vault" | "env" | "missing"

export interface RuntimeSecretResult {
  value: string
  source: RuntimeSecretSource
  warning?: string
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
