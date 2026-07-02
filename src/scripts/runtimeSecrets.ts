import type { Context } from "../executables/types.js"
import { masterKeyBytes } from "../pool/keys.js"
import { readRepoSecret } from "../stateRepoVault.js"

export type RuntimeSecretSource = "vault" | "env" | "missing"

export interface RuntimeSecretResult {
  value: string
  source: RuntimeSecretSource
  warning?: string
}

function tokenFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.KODY_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_PAT ?? "").trim()
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
    fetchImpl?: typeof fetch
  } = {},
): Promise<RuntimeSecretResult> {
  const env = opts.env ?? process.env
  const masterRaw = env.KODY_MASTER_KEY?.trim() ?? ""
  const githubToken = tokenFromEnv(env)
  if (!masterRaw || !githubToken) return envSecret(name, env)

  try {
    const masterKey = masterKeyBytes(masterRaw)
    if (masterKey.length !== 32) {
      throw new Error("KODY_MASTER_KEY must decode to 32 bytes")
    }
    const value = await readRepoSecret({
      owner: ctx.config.github.owner,
      repo: ctx.config.github.repo,
      name,
      githubToken,
      masterKey,
      fetchImpl: opts.fetchImpl,
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
