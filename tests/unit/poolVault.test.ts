import { createCipheriv, randomBytes } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getRepoDoc: vi.fn() }))
vi.mock("../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => ({ getRepoDoc: mocks.getRepoDoc }),
}))

import { decryptVault, readRepoSecret } from "../../src/backendVault.js"

const MASTER = Buffer.from("a".repeat(64), "hex") // 32 bytes

/** Encrypt exactly like Kody-Dashboard vault/crypto.ts encrypt() — the parity guard. */
function dashboardEncrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`
}

describe("pool vault: decryptVault", () => {
  it("round-trips a payload encrypted the dashboard way", () => {
    const doc = JSON.stringify({ version: 1, secrets: { FLY_API_TOKEN: { value: "fly-xyz" } } })
    const blob = dashboardEncrypt(doc, MASTER)
    expect(decryptVault(blob, MASTER)).toBe(doc)
  })

  it("throws on a malformed payload", () => {
    expect(() => decryptVault("not-a-vault", MASTER)).toThrow(/format/)
  })

  it("fails authentication with the wrong key", () => {
    const blob = dashboardEncrypt("secret", MASTER)
    expect(() => decryptVault(blob, Buffer.from("b".repeat(64), "hex"))).toThrow()
  })
})

describe("pool vault: readRepoSecret", () => {
  beforeEach(() => {
    mocks.getRepoDoc.mockReset()
  })

  function vaultRecord(blob: string | null): unknown {
    return blob ? { doc: { ciphertext: blob }, updatedAt: "now" } : null
  }

  it("reads a named secret out of the encrypted vault", async () => {
    const doc = JSON.stringify({
      version: 1,
      secrets: { FLY_API_TOKEN: { value: "fly-abc" }, ANTHROPIC_API_KEY: { value: "sk-x" } },
    })
    mocks.getRepoDoc.mockResolvedValue(vaultRecord(dashboardEncrypt(doc, MASTER)))
    const out = await readRepoSecret({
      masterKey: MASTER,
      owner: "o",
      repo: "r-readsecret",
      name: "FLY_API_TOKEN",
    })
    expect(out).toBe("fly-abc")
    expect(mocks.getRepoDoc).toHaveBeenCalledWith("o/r-readsecret", "secrets.enc")
  })

  it("returns null when the repo has no vault (404)", async () => {
    mocks.getRepoDoc.mockResolvedValue(null)
    const out = await readRepoSecret({
      masterKey: MASTER,
      owner: "o",
      repo: "r-novault",
      name: "FLY_API_TOKEN",
    })
    expect(out).toBeNull()
  })

  it("returns null when the secret is absent from the vault", async () => {
    const doc = JSON.stringify({ version: 1, secrets: { OTHER: { value: "x" } } })
    mocks.getRepoDoc.mockResolvedValue(vaultRecord(dashboardEncrypt(doc, MASTER)))
    const out = await readRepoSecret({
      masterKey: MASTER,
      owner: "o",
      repo: "r-absent",
      name: "FLY_API_TOKEN",
    })
    expect(out).toBeNull()
  })
})
