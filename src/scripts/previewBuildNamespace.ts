/**
 * Namespace.so remote-builder setup for the preview build.
 *
 * Replaces the local `docker build` (which runs on the GHA runner's own
 * daemon) with a Namespace remote builder: faster cold builds + a
 * persistent build cache, with zero builder-machine management.
 *
 * Auth is OIDC federation — NOT a static token. The kody.yml workflow
 * grants `id-token: write`, GitHub mints a short-lived OIDC JWT, and
 * `nsc auth exchange-oidc-token` swaps it for a Namespace tenant token.
 * For this to be accepted, the Namespace tenant must trust the repo's
 * OIDC subject (`nsc auth trust-relationships add`, one-time, per org).
 *
 * Everything here is best-effort: any failure returns null and the
 * caller falls back to the proven local docker build, so a Namespace
 * outage or a misconfigured trust never blocks a preview.
 */

import { runCmd } from "./previewBuildRun.js"

/** Audience baked into the OIDC token; MUST match the trust relationship's
 *  `--audience`. We control both sides, so the exact string is arbitrary
 *  as long as it agrees with `nsc auth trust-relationships add`. */
export const NSC_OIDC_AUDIENCE = "https://namespace.so"

const REQ_TIMEOUT_MS = 15_000

/** Install the `nsc` binary to /usr/local/bin if missing. The official
 *  install.sh ships the unrelated `ns` CLI — the container tools live in
 *  a separate `nsc` package, fetched directly here. Idempotent. */
const NSC_INSTALL = `
set -euo pipefail
if [ ! -x /usr/local/bin/nsc ]; then
  ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  curl -fsSL "https://get.namespace.so/packages/nsc/latest?arch=\${ARCH}&os=\${OS}" -o /tmp/nsc.tar.gz
  mkdir -p /tmp/nsc-extract
  tar -xzf /tmp/nsc.tar.gz -C /tmp/nsc-extract
  NSC_BIN=$(find /tmp/nsc-extract -type f -name nsc | head -1)
  sudo install -m 0755 "$NSC_BIN" /usr/local/bin/nsc
fi
/usr/local/bin/nsc version
`

/** Ask GitHub's OIDC provider for a JWT with our audience. Returns null
 *  when the request-url/token env vars are absent (i.e. the workflow
 *  lacks `id-token: write`, or we're not in GitHub Actions at all). */
async function fetchGithubOidcToken(audience: string): Promise<string | null> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim()
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim()
  if (!url || !requestToken) return null
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`OIDC token request failed: ${res.status} ${res.statusText}`)
  }
  const data = (await res.json()) as { value?: string }
  if (!data.value) throw new Error("OIDC token response missing `value`")
  return data.value
}

/**
 * Install nsc, federate via OIDC, and register a buildx builder backed by
 * Namespace. Returns the builder name on success (pass it to
 * `docker buildx build --builder <name> --push`), or null to fall back to
 * the local docker build.
 */
export async function setupNamespaceBuilder(opts: { tenantId: string; builderName: string }): Promise<string | null> {
  try {
    await runCmd("bash", ["-c", NSC_INSTALL])

    const jwt = await fetchGithubOidcToken(NSC_OIDC_AUDIENCE)
    if (!jwt) {
      console.warn("[preview-build] no GitHub OIDC token (id-token: write missing?) — local docker build")
      return null
    }

    // Exchange the OIDC JWT for a tenant token; nsc stores it in the
    // keychain so the subsequent buildx command picks it up.
    await runCmd("nsc", ["auth", "exchange-oidc-token", "--tenant_id", opts.tenantId, "--token", jwt])

    await runCmd("nsc", ["docker", "buildx", "setup", "--name", opts.builderName])

    console.log(`[preview-build] Namespace remote builder ready (${opts.builderName})`)
    return opts.builderName
  } catch (err) {
    console.warn(
      "[preview-build] Namespace setup failed — falling back to local docker:",
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}
