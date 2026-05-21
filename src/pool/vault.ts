/**
 * Minimal read-only vault accessor for the warm-pool owner.
 *
 * The dashboard stores each repo's secrets in `.kody/secrets.enc` — a single
 * AES-256-GCM blob ("v1:<iv_b64>:<ct_b64>:<tag_b64>") of a JSON document
 * `{ version:1, secrets:{ NAME:{ value,... } } }`, keyed off KODY_MASTER_KEY.
 * The pool owner reads a repo's FLY_API_TOKEN from there so each repo's pool
 * runs in that repo's own Fly account — matching the dashboard's repo-scoped
 * model (nothing global, no token sent over the wire).
 *
 * MUST stay byte-compatible with Kody-Dashboard src/dashboard/lib/vault/crypto.ts.
 */

import { createDecipheriv } from "node:crypto"

const GITHUB_API = "https://api.github.com"
const VAULT_PATH = ".kody/secrets.enc"
const CACHE_TTL_MS = 60_000

interface VaultDocument {
  version: number
  secrets: Record<string, { value: string }>
}

interface CacheEntry {
  secrets: Record<string, string>
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/** AES-256-GCM decrypt of a "v1:iv:ct:tag" payload. Mirrors vault/crypto.ts decrypt(). */
export function decryptVault(payload: string, masterKey: Buffer): string {
  const parts = payload.split(":")
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("invalid vault payload format")
  }
  const [, ivB64, ctB64, tagB64] = parts
  const iv = Buffer.from(ivB64!, "base64")
  const ct = Buffer.from(ctB64!, "base64")
  const tag = Buffer.from(tagB64!, "base64")
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
}

/**
 * Read + decrypt a repo's vault into a flat { NAME: value } map. Returns {} if
 * the repo has no vault (404) or it's empty. Cached per repo for 60s. Never
 * throws on a missing vault; throws only on decrypt/parse corruption.
 */
async function readVaultSecrets(
  opts: { githubToken: string; masterKey: Buffer; owner: string; repo: string; fetchImpl?: typeof fetch },
): Promise<Record<string, string>> {
  const key = `${opts.owner}/${opts.repo}`.toLowerCase()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.secrets

  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/contents/${VAULT_PATH}`,
    {
      headers: {
        Authorization: `Bearer ${opts.githubToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "kody-pool-serve",
      },
    },
  )
  if (res.status === 404) {
    cache.set(key, { secrets: {}, expiresAt: Date.now() + CACHE_TTL_MS })
    return {}
  }
  if (!res.ok) {
    throw new Error(`vault read ${res.status} for ${key}: ${(await res.text().catch(() => "")).slice(0, 160)}`)
  }
  const body = (await res.json()) as { content?: string; encoding?: string }
  if (!body.content) {
    cache.set(key, { secrets: {}, expiresAt: Date.now() + CACHE_TTL_MS })
    return {}
  }
  const ciphertext = Buffer.from(body.content, (body.encoding ?? "base64") as BufferEncoding).toString("utf8").trim()
  const doc = JSON.parse(decryptVault(ciphertext, opts.masterKey)) as VaultDocument
  const flat: Record<string, string> = {}
  for (const [name, entry] of Object.entries(doc.secrets ?? {})) {
    if (entry && typeof entry.value === "string") flat[name] = entry.value
  }
  cache.set(key, { secrets: flat, expiresAt: Date.now() + CACHE_TTL_MS })
  return flat
}

/** Read a single secret from a repo's vault. null if absent. */
export async function readRepoSecret(
  opts: { githubToken: string; masterKey: Buffer; owner: string; repo: string; name: string; fetchImpl?: typeof fetch },
): Promise<string | null> {
  const secrets = await readVaultSecrets(opts)
  const v = secrets[opts.name]
  return v && v.trim() ? v : null
}

/** Read all of a repo's vault secrets (for forwarding ALL_SECRETS to a job). */
export async function readRepoSecrets(
  opts: { githubToken: string; masterKey: Buffer; owner: string; repo: string; fetchImpl?: typeof fetch },
): Promise<Record<string, string>> {
  return readVaultSecrets(opts)
}
