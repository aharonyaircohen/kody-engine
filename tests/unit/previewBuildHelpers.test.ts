import { createCipheriv, randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  basePreviewAppName,
  buildEnvFromVault,
  decryptVaultPayload,
  defaultImageTag,
  derivePreviewVerifyKey,
  formatPreviewComment,
  NEVER_PASS_TO_BUILD,
  previewAppName,
  previewRuntimeEnv,
  type VaultDoc,
} from "../../src/scripts/previewBuildHelpers.js"

/** Reference encrypt — matches `encrypt` in
 *  Kody-Dashboard/src/dashboard/lib/vault/crypto.ts so the
 *  round-trip test exercises the EXACT format the dashboard emits. */
function encryptForTest(plaintext: string, keyRaw: string): string {
  const key = /^[0-9a-fA-F]{64}$/.test(keyRaw) ? Buffer.from(keyRaw, "hex") : Buffer.from(keyRaw, "base64")
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()])
  const tag = c.getAuthTag()
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`
}

const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

describe("previewAppName", () => {
  it("derives deterministic per-PR app name", () => {
    expect(previewAppName("A-Guy-educ/A-Guy", 2180)).toBe("kp-866cab-8111e4-pr-2180")
  })

  it("matches the dashboard's hash scheme byte-for-byte", () => {
    // Pin against a known live preview URL the dashboard already serves.
    // If this changes, per-PR URLs become unreachable for already-built PRs.
    expect(previewAppName("A-Guy-educ/A-Guy", 1)).toMatch(/^kp-866cab-8111e4-pr-1$/)
  })

  it("rejects malformed repo", () => {
    expect(() => previewAppName("missing-slash", 1)).toThrow(/invalid repo/)
  })
})

describe("basePreviewAppName", () => {
  it("derives deterministic base app name", () => {
    expect(basePreviewAppName("A-Guy-educ/A-Guy")).toBe("kp-866cab-8111e4-base")
  })

  it("rejects malformed repo", () => {
    expect(() => basePreviewAppName("only-one")).toThrow(/invalid repo/)
  })
})

describe("decryptVaultPayload", () => {
  it("round-trips through encrypt", () => {
    const payload = encryptForTest("hello world", TEST_KEY_HEX)
    expect(decryptVaultPayload(payload, TEST_KEY_HEX)).toBe("hello world")
  })

  it("accepts base64-encoded keys", () => {
    const b64Key = Buffer.alloc(32, 7).toString("base64")
    const payload = encryptForTest("secret", b64Key)
    expect(decryptVaultPayload(payload, b64Key)).toBe("secret")
  })

  it("rejects malformed payload", () => {
    expect(() => decryptVaultPayload("not-the-format", TEST_KEY_HEX)).toThrow(/invalid vault payload format/)
  })

  it("rejects wrong-version payload", () => {
    expect(() => decryptVaultPayload("v2:a:b:c", TEST_KEY_HEX)).toThrow(/invalid vault payload format/)
  })

  it("rejects wrong-length keys", () => {
    const payload = encryptForTest("x", TEST_KEY_HEX)
    expect(() => decryptVaultPayload(payload, "abcd")).toThrow(/32 bytes/)
  })

  it("auth-tag failure surfaces as an error (wrong key)", () => {
    const payload = encryptForTest("payload", TEST_KEY_HEX)
    const wrongKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
    expect(() => decryptVaultPayload(payload, wrongKey)).toThrow()
  })
})

describe("buildEnvFromVault", () => {
  const baseDoc: VaultDoc = {
    version: 1,
    secrets: {
      DATABASE_URL: { value: "mongodb://..." },
      OPENAI_API_KEY: { value: "sk-..." },
      FLY_API_TOKEN: { value: "FlyV1 ..." },
      FLY_ORG_SLUG: { value: "personal" },
      KODY_MASTER_KEY: { value: "dont-leak" },
      KODY_PREVIEW_BUILD_MODE: { value: "dev" },
      KODY_PREVIEW_VERIFY_KEY: { value: "dont-leak-derived" },
      KODY_REPO_CONTEXT: { value: "wrong/repo" },
      KODY_PR: { value: "999" },
      KODY_BRANCH: { value: "feature" },
      EMPTY_ONE: { value: "" },
    },
  }

  it("drops infra secrets from build env", () => {
    const { buildEnv } = buildEnvFromVault(baseDoc)
    for (const name of NEVER_PASS_TO_BUILD) {
      expect(buildEnv[name]).toBeUndefined()
    }
  })

  it("keeps app secrets", () => {
    const { buildEnv } = buildEnvFromVault(baseDoc)
    expect(buildEnv.DATABASE_URL).toBe("mongodb://...")
    expect(buildEnv.OPENAI_API_KEY).toBe("sk-...")
  })

  it("drops empty entries", () => {
    const { buildEnv } = buildEnvFromVault(baseDoc)
    expect(buildEnv.EMPTY_ONE).toBeUndefined()
  })

  it("reads explicit dev mode", () => {
    expect(buildEnvFromVault(baseDoc).buildMode).toBe("dev")
  })

  it("defaults to prod mode when knob absent", () => {
    const noMode: VaultDoc = {
      version: 1,
      secrets: { OPENAI_API_KEY: { value: "k" } },
    }
    expect(buildEnvFromVault(noMode).buildMode).toBe("prod")
  })

  it("defaults to prod mode when knob is garbage", () => {
    const garbage: VaultDoc = {
      version: 1,
      secrets: { KODY_PREVIEW_BUILD_MODE: { value: "DEBUG" } },
    }
    expect(buildEnvFromVault(garbage).buildMode).toBe("prod")
  })

  it("handles missing secrets object", () => {
    const empty: VaultDoc = { version: 1, secrets: {} }
    expect(buildEnvFromVault(empty).buildEnv).toEqual({})
    expect(buildEnvFromVault(empty).buildMode).toBe("prod")
  })
})

describe("derivePreviewVerifyKey", () => {
  it("matches the dashboard HKDF preview-key derivation", () => {
    expect(derivePreviewVerifyKey(TEST_KEY_HEX)).toBe(
      "5f3e59bdb955bf2fd227068a6e221db6ca5c48f3f102aa59f778b2e7cb7a2423",
    )
  })

  it("accepts base64-url master keys", () => {
    const raw = Buffer.from(TEST_KEY_HEX, "hex").toString("base64url")
    expect(derivePreviewVerifyKey(raw)).toBe(derivePreviewVerifyKey(TEST_KEY_HEX))
  })

  it("rejects wrong-length keys", () => {
    expect(() => derivePreviewVerifyKey("abcd")).toThrow(/32 bytes/)
  })
})

describe("previewRuntimeEnv", () => {
  it("adds doorman runtime auth without losing app env", () => {
    const env = previewRuntimeEnv({
      buildEnv: { DATABASE_URL: "postgres://example" },
      masterKey: TEST_KEY_HEX,
      pr: 678,
      repo: "A-Guy-educ/A-Guy-Web",
    })

    expect(env).toMatchObject({
      DATABASE_URL: "postgres://example",
      KODY_PREVIEW_VERIFY_KEY: derivePreviewVerifyKey(TEST_KEY_HEX),
      KODY_REPO_CONTEXT: "A-Guy-educ/A-Guy-Web",
      KODY_PR: "678",
    })
  })

  it("control env wins over vault-provided names", () => {
    const env = previewRuntimeEnv({
      buildEnv: {
        KODY_PREVIEW_VERIFY_KEY: "bad",
        KODY_REPO_CONTEXT: "wrong/repo",
        KODY_PR: "1",
      },
      masterKey: TEST_KEY_HEX,
      pr: 678,
      repo: "A-Guy-educ/A-Guy-Web",
    })

    expect(env.KODY_PREVIEW_VERIFY_KEY).toBe(derivePreviewVerifyKey(TEST_KEY_HEX))
    expect(env.KODY_REPO_CONTEXT).toBe("A-Guy-educ/A-Guy-Web")
    expect(env.KODY_PR).toBe("678")
  })
})

describe("formatPreviewComment", () => {
  it("includes the dedupe marker", () => {
    const body = formatPreviewComment({
      appName: "kp-abc-def-pr-7",
      ref: "abcdef0123456789",
      nowIso: "2026-05-30T12:00:00.000Z",
    })
    expect(body).toContain("<!-- kody-fly-preview -->")
  })

  it("includes the URL + short SHA", () => {
    const body = formatPreviewComment({
      appName: "kp-abc-def-pr-7",
      ref: "abcdef0123456789",
      nowIso: "2026-05-30T12:00:00.000Z",
    })
    expect(body).toContain("https://kp-abc-def-pr-7.fly.dev")
    expect(body).toContain("abcdef0")
  })
})

describe("defaultImageTag", () => {
  it("is deterministic for the same repo+ref", () => {
    const a = defaultImageTag("o/r", "abc")
    const b = defaultImageTag("o/r", "abc")
    expect(a).toBe(b)
    expect(a).toHaveLength(12)
  })

  it("changes when ref changes", () => {
    expect(defaultImageTag("o/r", "abc")).not.toBe(defaultImageTag("o/r", "def"))
  })

  it("changes when repo changes", () => {
    expect(defaultImageTag("a/b", "ref")).not.toBe(defaultImageTag("c/d", "ref"))
  })
})
