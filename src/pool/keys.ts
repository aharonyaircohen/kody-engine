/**
 * Derived shared secrets for the warm pool, off the dashboard's single
 * canonical KODY_MASTER_KEY — same HKDF pattern as the dashboard's
 * vapid-keys / chat-token (no per-purpose env var, no fallback chains).
 *
 *   POOL_API_KEY    = HKDF(master, info="kody-pool-api:v1")    dashboard → pool owner
 *   RUNNER_API_KEY  = HKDF(master, info="kody-runner-api:v1")  pool owner → pooled machine
 *
 * The dashboard derives the same values from the same master, so neither
 * key is ever transmitted or stored — both sides compute them locally. The
 * runner key is baked into each pooled machine's env at create time, so a
 * machine never needs the master itself.
 */

import { hkdfSync } from "node:crypto"

export const POOL_API_KEY_INFO = "kody-pool-api:v1"
export const RUNNER_API_KEY_INFO = "kody-runner-api:v1"

/** Parse KODY_MASTER_KEY (hex-64 or base64url) into raw bytes. Mirrors the dashboard. */
export function masterKeyBytes(raw: string): Buffer {
  const v = raw.trim()
  if (!v) throw new Error("KODY_MASTER_KEY is empty")
  if (/^[0-9a-fA-F]+$/.test(v) && v.length === 64) {
    return Buffer.from(v, "hex")
  }
  return Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

/** HKDF-SHA256 → lowercase hex of `length` bytes (default 32). */
export function deriveKey(master: Buffer, info: string, length = 32): string {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, length)).toString("hex")
}

export function derivePoolApiKey(master: Buffer): string {
  return deriveKey(master, POOL_API_KEY_INFO)
}

export function deriveRunnerApiKey(master: Buffer): string {
  return deriveKey(master, RUNNER_API_KEY_INFO)
}

/** Constant-time-ish bearer/X-Api-Key check against an expected hex key. */
export function bearerOk(headerAuth: string | undefined, xApiKey: string | undefined, expected: string): boolean {
  const x = (xApiKey ?? "").trim()
  if (x && timingEqual(x, expected)) return true
  const a = (headerAuth ?? "").trim()
  if (a.toLowerCase().startsWith("bearer ")) {
    return timingEqual(a.slice(7).trim(), expected)
  }
  return false
}

function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
