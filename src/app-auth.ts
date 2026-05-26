/**
 * GitHub App auth — mint an installation access token from the App's
 * id + private key when no ready-made PAT/token is available.
 *
 * Dependency-free: signs the App JWT with `node:crypto` (RS256) and calls
 * the REST API with global `fetch` (node >=22). Returns a short-lived
 * installation token (~1h TTL) suitable for use as `GH_TOKEN`.
 *
 * NOTE: installation tokens expire after ~1h. This mints ONCE. Long-running
 * callers that outlive the TTL need a refresh layer on top of this — not yet
 * built. See resolveAuthToken in kody-cli.ts for the single mint-on-startup
 * call site.
 */
import { createSign } from "node:crypto"

const GH_API = process.env.GITHUB_API_URL || "https://api.github.com"

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url")
}

/**
 * Accept the private key as raw PEM (the common case) or base64-encoded PEM
 * (some setups store it that way to avoid newline mangling in secrets).
 */
function normalizePem(key: string): string {
  const trimmed = key.trim()
  if (trimmed.includes("BEGIN")) return trimmed
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8")
    if (decoded.includes("BEGIN")) return decoded
  } catch {
    /* fall through — let the signer surface a clear error */
  }
  return trimmed
}

function buildAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "RS256", typ: "JWT" }
  // Backdate `iat` 60s for clock skew; `exp` 9 min out (GitHub max is 10).
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(normalizePem(privateKeyPem)).toString("base64url")
  return `${signingInput}.${signature}`
}

async function ghApp<T>(jwt: string, apiPath: string, method = "GET"): Promise<T> {
  const res = await fetch(`${GH_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kody-engine",
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(
      `GitHub App API ${method} ${apiPath} → ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
    )
  }
  return (await res.json()) as T
}

export interface AppCreds {
  appId: string
  privateKey: string
  /** Optional explicit installation id; otherwise resolved from the repo. */
  installationId?: string
  /** "owner/repo" used to resolve the installation when id is absent. */
  repo?: string
}

/**
 * Read GitHub App credentials from the environment. Returns null when the
 * App id or private key is absent (so callers can fall through cleanly).
 */
export function readAppCreds(env: NodeJS.ProcessEnv = process.env): AppCreds | null {
  const appId = env.KODY_APP_ID?.trim()
  const privateKey = env.KODY_APP_PRIVATE_KEY
  if (!appId || !privateKey) return null
  return {
    appId,
    privateKey,
    installationId: env.KODY_APP_INSTALLATION_ID?.trim() || undefined,
    repo: env.GITHUB_REPOSITORY?.trim() || undefined,
  }
}

/**
 * Mint a GitHub App installation access token. Resolves the installation id
 * from the repo when not given explicitly. Throws on misconfiguration or any
 * API failure — callers decide whether to warn-and-continue or abort.
 */
export async function mintAppInstallationToken(creds: AppCreds): Promise<string> {
  const jwt = buildAppJwt(creds.appId, creds.privateKey)

  let installationId = creds.installationId
  if (!installationId) {
    if (!creds.repo) {
      throw new Error("cannot resolve App installation: no KODY_APP_INSTALLATION_ID and no GITHUB_REPOSITORY")
    }
    const inst = await ghApp<{ id: number }>(jwt, `/repos/${creds.repo}/installation`)
    installationId = String(inst.id)
  }

  const tok = await ghApp<{ token: string }>(jwt, `/app/installations/${installationId}/access_tokens`, "POST")
  return tok.token
}
