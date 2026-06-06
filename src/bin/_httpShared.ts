/**
 * bin/_httpShared.ts
 *
 * Env helpers shared by the standalone HTTP servers (mcp-http-server,
 * brain-proxy). Centralized so the env contract is consistent.
 */

const DEFAULT_REPOS_ROOT = "/workspace/repos"

export function requireEnv(names: string[], who: string): void {
  const missing: string[] = []
  for (const name of names) {
    const v = process.env[name]
    if (!v || v.trim().length === 0) missing.push(name)
  }
  if (missing.length > 0) {
    process.stderr.write(
      `[${who}] required env var(s) missing: ${missing.join(", ")} — set them in the Fly machine config before boot.\n`,
    )
    process.exit(2)
  }
}

/**
 * Resolve the API key. Prefers KODY_MCP_HTTP_KEY (mcp-http-server) or
 * BRAIN_API_KEY (brain-proxy); both names are accepted for symmetry.
 * Returns undefined when neither is set (server will run open).
 */
export function getApiKey(): string | undefined {
  return process.env.KODY_MCP_HTTP_KEY?.trim() || process.env.BRAIN_API_KEY?.trim() || undefined
}

/**
 * Resolve the repos root for fetch_repo clones.
 */
export function getReposRoot(): string {
  return process.env.KODY_MCP_REPOS_ROOT?.trim() || DEFAULT_REPOS_ROOT
}
