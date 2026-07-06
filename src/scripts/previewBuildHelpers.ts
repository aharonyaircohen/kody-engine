/**
 * Pure helpers for the `preview-build` scripted implementation. Kept
 * separate from runPreviewBuild.ts so they're unit-testable without
 * touching docker / Fly / GitHub APIs.
 *
 * All functions here are referentially transparent: same inputs →
 * same outputs, no side effects.
 */

import { createDecipheriv, createHash, hkdfSync } from "node:crypto"

/**
 * Vault secret names that must NEVER be baked into a preview build.
 * Mirrors NEVER_PASS_TO_BUILD in
 * Kody-Dashboard/src/dashboard/lib/previews/vault-build-context.ts.
 */
export const NEVER_PASS_TO_BUILD: ReadonlySet<string> = new Set([
  "FLY_API_TOKEN",
  "FLY_ORG_SLUG",
  "FLY_DEFAULT_REGION",
  "KODY_MASTER_KEY",
  // Preview-config knob; consumed by the dispatcher before spawn.
  "KODY_PREVIEW_BUILD_MODE",
  "KODY_PREVIEW_VERIFY_KEY",
  "KODY_REPO_CONTEXT",
  "KODY_PR",
  "KODY_BRANCH",
])

const PREVIEW_KEY_INFO = "kody-preview:v1"

/** Short SHA-256 prefix used in deterministic app naming. */
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 6)
}

/**
 * Compose the per-PR Fly app name: `kp-<ownerHash>-<repoHash>-pr-<n>`.
 * MUST match `previewAppName` in
 * Kody-Dashboard/src/dashboard/lib/previews/preview-key.ts so the
 * URLs the engine builds match the URLs the dashboard's GET endpoint
 * already serves.
 */
export function previewAppName(repo: string, pr: number): string {
  const [owner, name] = repo.split("/")
  if (!owner || !name) {
    throw new Error(`invalid repo "${repo}", expected "owner/name"`)
  }
  return `kp-${shortHash(owner)}-${shortHash(name)}-pr-${pr}`
}

/**
 * Per-repo base-image app name: `kp-<ownerHash>-<repoHash>-base`.
 * MUST match `basePreviewAppName` in the dashboard.
 */
export function basePreviewAppName(repo: string): string {
  const [owner, name] = repo.split("/")
  if (!owner || !name) {
    throw new Error(`invalid repo "${repo}", expected "owner/name"`)
  }
  return `kp-${shortHash(owner)}-${shortHash(name)}-base`
}

/**
 * Decrypt a vault payload encrypted with
 * Kody-Dashboard/src/dashboard/lib/vault/crypto.ts.
 *
 * Format: `v1:<iv_b64>:<ct_b64>:<tag_b64>`, AES-256-GCM, 32-byte key
 * derived from KODY_MASTER_KEY (hex or base64).
 *
 * Throws on malformed payload or wrong key — the caller decides
 * whether that's fatal (e.g. no fallback build env) or recoverable.
 */
export function decryptVaultPayload(payload: string, keyRaw: string): string {
  const parts = payload.split(":")
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("invalid vault payload format")
  }
  const [, ivB64, ctB64, tagB64] = parts
  const key = decodeMasterKey(keyRaw)
  if (key.length !== 32) {
    throw new Error("KODY_MASTER_KEY must decode to 32 bytes")
  }
  const iv = Buffer.from(ivB64!, "base64")
  const ct = Buffer.from(ctB64!, "base64")
  const tag = Buffer.from(tagB64!, "base64")
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
}

function decodeMasterKey(keyRaw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(keyRaw)) return Buffer.from(keyRaw, "hex")
  return Buffer.from(keyRaw.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

export function derivePreviewVerifyKey(masterKeyRaw: string): string {
  const masterKey = decodeMasterKey(masterKeyRaw)
  if (masterKey.length !== 32) {
    throw new Error("KODY_MASTER_KEY must decode to 32 bytes")
  }
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), PREVIEW_KEY_INFO, 32)).toString("hex")
}

export function previewRuntimeEnv(args: {
  buildEnv: Record<string, string>
  masterKey: string
  pr: number
  repo: string
}): Record<string, string> {
  return {
    ...args.buildEnv,
    KODY_PREVIEW_VERIFY_KEY: derivePreviewVerifyKey(args.masterKey),
    KODY_REPO_CONTEXT: args.repo,
    KODY_PR: String(args.pr),
  }
}

/**
 * Shape of the decrypted vault document — only the fields we need
 * for a preview build.
 */
export interface VaultDoc {
  version: number
  secrets: Record<string, { value: string } | undefined>
}

/**
 * Extract the build env + build mode from a decrypted vault doc.
 *
 *   - Drops names listed in NEVER_PASS_TO_BUILD.
 *   - Drops entries with empty values.
 *   - Reads KODY_PREVIEW_BUILD_MODE from the doc (defaults to "prod").
 *
 * Returns the same shape the dashboard sends as BUILD_ENV_JSON, so
 * the bundled Dockerfile templates work identically on both paths.
 */
export function buildEnvFromVault(doc: VaultDoc): {
  buildEnv: Record<string, string>
  buildMode: "dev" | "prod"
} {
  const buildEnv: Record<string, string> = {}
  for (const [name, entry] of Object.entries(doc.secrets ?? {})) {
    if (!entry?.value) continue
    if (NEVER_PASS_TO_BUILD.has(name)) continue
    buildEnv[name] = entry.value
  }
  const raw = doc.secrets?.KODY_PREVIEW_BUILD_MODE?.value
  const buildMode = raw?.toLowerCase().trim() === "dev" ? "dev" : "prod"
  return { buildEnv, buildMode }
}

/**
 * Format the preview-ready comment body with the
 * `<!-- kody-fly-preview -->` marker the dashboard uses to dedupe.
 * Matches the body shape posted by Kody-Dashboard/builder/src/builder.ts
 * so a build run by either path appears identically on the PR.
 */
export function formatPreviewComment(args: { appName: string; ref: string; nowIso: string }): string {
  return [
    "<!-- kody-fly-preview -->",
    "✅ **Preview ready** — open it from the Kody dashboard.",
    "",
    `<sub>App: \`${args.appName}\` · Commit: \`${args.ref.slice(0, 7)}\` · Updated: ${args.nowIso}</sub>`,
  ].join("\n")
}

/**
 * Per-PR image tag — 12-char SHA-256 prefix over `repo@ref`.
 * Matches `defaultTagFor` in
 * Kody-Dashboard/src/dashboard/lib/previews/builder-client.ts.
 */
export function defaultImageTag(repo: string, ref: string): string {
  return createHash("sha256").update(`${repo}@${ref}`).digest("hex").slice(0, 12)
}
