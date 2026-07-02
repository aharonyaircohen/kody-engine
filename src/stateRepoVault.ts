/**
 * Read-only accessor for the dashboard-managed repo vault in the configured
 * Kody state repo.
 *
 * The dashboard stores each repo's secrets as `secrets.enc`: a single
 * AES-256-GCM blob ("v1:<iv_b64>:<ct_b64>:<tag_b64>") of a JSON document
 * `{ version:1, secrets:{ NAME:{ value,... } } }`, keyed off KODY_MASTER_KEY.
 *
 * MUST stay byte-compatible with Kody-Dashboard src/dashboard/lib/vault/crypto.ts.
 */

import { createDecipheriv, createHash } from "node:crypto"
import { readGithubStateText } from "./stateRepoGithub.js"

const VAULT_PATH = "secrets.enc"
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

function cacheKey(owner: string, repo: string, masterKey: Buffer): string {
  const keyHash = createHash("sha256").update(masterKey).digest("hex").slice(0, 16)
  return `${owner}/${repo}:${keyHash}`.toLowerCase()
}

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
async function readVaultSecrets(opts: {
  githubToken: string
  masterKey: Buffer
  owner: string
  repo: string
  fetchImpl?: typeof fetch
}): Promise<Record<string, string>> {
  const key = cacheKey(opts.owner, opts.repo, opts.masterKey)
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.secrets

  const file = await readGithubStateText({
    owner: opts.owner,
    repo: opts.repo,
    filePath: VAULT_PATH,
    githubToken: opts.githubToken,
    fetchImpl: opts.fetchImpl,
  })
  if (!file) {
    cache.set(key, { secrets: {}, expiresAt: Date.now() + CACHE_TTL_MS })
    return {}
  }
  const ciphertext = file.content.trim()
  const doc = JSON.parse(decryptVault(ciphertext, opts.masterKey)) as VaultDocument
  const flat: Record<string, string> = {}
  for (const [name, entry] of Object.entries(doc.secrets ?? {})) {
    if (entry && typeof entry.value === "string") flat[name] = entry.value
  }
  cache.set(key, { secrets: flat, expiresAt: Date.now() + CACHE_TTL_MS })
  return flat
}

/** Read a single secret from a repo's vault. null if absent. */
export async function readRepoSecret(opts: {
  githubToken: string
  masterKey: Buffer
  owner: string
  repo: string
  name: string
  fetchImpl?: typeof fetch
}): Promise<string | null> {
  const secrets = await readVaultSecrets(opts)
  const v = secrets[opts.name]
  return v?.trim() ? v : null
}

/** Read all of a repo's vault secrets. */
export async function readRepoSecrets(opts: {
  githubToken: string
  masterKey: Buffer
  owner: string
  repo: string
  fetchImpl?: typeof fetch
}): Promise<Record<string, string>> {
  return readVaultSecrets(opts)
}
