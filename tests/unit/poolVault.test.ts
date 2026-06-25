import { createCipheriv, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"

import { decryptVault, readRepoSecret } from "../../src/pool/vault.js"

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
  function contentResponse(content: string): Response {
    return new Response(
      JSON.stringify({
        type: "file",
        content: Buffer.from(content, "utf8").toString("base64"),
        encoding: "base64",
        sha: "sha",
      }),
      { status: 200 },
    )
  }

  function mockFetch(blob: string | null, calls: string[] = []): typeof fetch {
    return (async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith("/contents/kody.config.json")) {
        return contentResponse(
          JSON.stringify({
            github: { owner: "o", repo: "r" },
            state: { repo: "https://github.com/o/kody-state", path: "r" },
          }),
        )
      }
      if (blob === null) return new Response("not found", { status: 404 })
      return contentResponse(blob)
    }) as unknown as typeof fetch
  }

  it("reads a named secret out of the encrypted vault", async () => {
    const doc = JSON.stringify({
      version: 1,
      secrets: { FLY_API_TOKEN: { value: "fly-abc" }, ANTHROPIC_API_KEY: { value: "sk-x" } },
    })
    const calls: string[] = []
    const out = await readRepoSecret({
      githubToken: "ghp_op",
      masterKey: MASTER,
      owner: "o",
      repo: "r-readsecret",
      name: "FLY_API_TOKEN",
      fetchImpl: mockFetch(dashboardEncrypt(doc, MASTER), calls),
    })
    expect(out).toBe("fly-abc")
    expect(calls).toEqual([
      "https://api.github.com/repos/o/r-readsecret/contents/kody.config.json",
      "https://api.github.com/repos/o/kody-state/contents/r/secrets.enc",
    ])
  })

  it("returns null when the repo has no vault (404)", async () => {
    const out = await readRepoSecret({
      githubToken: "ghp_op",
      masterKey: MASTER,
      owner: "o",
      repo: "r-novault",
      name: "FLY_API_TOKEN",
      fetchImpl: mockFetch(null),
    })
    expect(out).toBeNull()
  })

  it("returns null when the secret is absent from the vault", async () => {
    const doc = JSON.stringify({ version: 1, secrets: { OTHER: { value: "x" } } })
    const out = await readRepoSecret({
      githubToken: "ghp_op",
      masterKey: MASTER,
      owner: "o",
      repo: "r-absent",
      name: "FLY_API_TOKEN",
      fetchImpl: mockFetch(dashboardEncrypt(doc, MASTER)),
    })
    expect(out).toBeNull()
  })
})
