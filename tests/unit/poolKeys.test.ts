import { describe, expect, it } from "vitest"

import { bearerOk, derivePoolApiKey, deriveRunnerApiKey, masterKeyBytes } from "../../src/pool/keys.js"

const HEX_MASTER = "a".repeat(64) // valid 32-byte hex

describe("pool keys: derivation", () => {
  it("derives stable, distinct hex keys from the same master", () => {
    const m = masterKeyBytes(HEX_MASTER)
    const pool = derivePoolApiKey(m)
    const runner = deriveRunnerApiKey(m)
    expect(pool).toMatch(/^[0-9a-f]{64}$/)
    expect(runner).toMatch(/^[0-9a-f]{64}$/)
    expect(pool).not.toBe(runner) // different HKDF info → different keys
  })

  it("is deterministic across calls (dashboard + owner derive the same value)", () => {
    expect(derivePoolApiKey(masterKeyBytes(HEX_MASTER))).toBe(derivePoolApiKey(masterKeyBytes(HEX_MASTER)))
  })

  // KNOWN-ANSWER: these exact hex values are also asserted in the dashboard's
  // pool-keys test. If either side's HKDF params drift, one of the two suites
  // breaks — that's the cross-repo parity guard (auth would silently 401).
  it("matches the cross-repo known-answer for master='a'*64", () => {
    const m = masterKeyBytes(HEX_MASTER)
    expect(derivePoolApiKey(m)).toBe("c739037cabcd5935e1e7c4b301e0415855853903d3eae76f81e6d0fcb00a5679")
    expect(deriveRunnerApiKey(m)).toBe("b0d6a6f39c5f04d3f32422101ef8a6963fa5d970a166b8697a2b171c024dad82")
  })

  it("accepts base64url masters too", () => {
    const b64 = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url")
    expect(() => masterKeyBytes(b64)).not.toThrow()
  })
})

describe("pool keys: bearerOk", () => {
  const expected = "f".repeat(64)
  it("accepts matching X-Api-Key", () => {
    expect(bearerOk(undefined, expected, expected)).toBe(true)
  })
  it("accepts matching Bearer header", () => {
    expect(bearerOk(`Bearer ${expected}`, undefined, expected)).toBe(true)
  })
  it("rejects mismatches and missing", () => {
    expect(bearerOk(undefined, "g".repeat(64), expected)).toBe(false)
    expect(bearerOk(undefined, undefined, expected)).toBe(false)
    expect(bearerOk("Bearer short", undefined, expected)).toBe(false)
  })
})
