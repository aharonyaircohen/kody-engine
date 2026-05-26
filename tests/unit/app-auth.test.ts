import { createVerify, generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mintAppInstallationToken, readAppCreds } from "../../src/app-auth.js"

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("app-auth: readAppCreds", () => {
  it("returns null when App id or key is missing", () => {
    expect(readAppCreds({})).toBeNull()
    expect(readAppCreds({ KODY_APP_ID: "1" })).toBeNull()
    expect(readAppCreds({ KODY_APP_PRIVATE_KEY: "k" })).toBeNull()
  })

  it("reads id, key, optional installation id and repo", () => {
    const creds = readAppCreds({
      KODY_APP_ID: " 42 ",
      KODY_APP_PRIVATE_KEY: privateKey,
      KODY_APP_INSTALLATION_ID: " 99 ",
      GITHUB_REPOSITORY: "A-Guy-educ/A-Guy",
    })
    expect(creds).toEqual({
      appId: "42",
      privateKey,
      installationId: "99",
      repo: "A-Guy-educ/A-Guy",
    })
  })
})

describe("app-auth: mintAppInstallationToken", () => {
  it("resolves installation from repo, then mints a token with a valid App JWT", async () => {
    const calls: Array<{ url: string; method: string; auth: string }> = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: String((init?.headers as Record<string, string>).Authorization),
      })
      const body = String(url).endsWith("/installation")
        ? JSON.stringify({ id: 12345 })
        : JSON.stringify({ token: "ghs_minted_abc" })
      return new Response(body, { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const token = await mintAppInstallationToken({
      appId: "42",
      privateKey,
      repo: "A-Guy-educ/A-Guy",
    })

    expect(token).toBe("ghs_minted_abc")
    expect(calls[0].url).toContain("/repos/A-Guy-educ/A-Guy/installation")
    expect(calls[1].url).toContain("/app/installations/12345/access_tokens")
    expect(calls[1].method).toBe("POST")

    // The Authorization header must carry a JWT signed by our App key.
    const jwt = calls[0].auth.replace(/^Bearer /, "")
    const [header, payload, signature] = jwt.split(".")
    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${header}.${payload}`)
    verifier.end()
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true)
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).iss).toBe("42")
  })

  it("skips installation lookup when an explicit installation id is given", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "ghs_x" }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const token = await mintAppInstallationToken({ appId: "1", privateKey, installationId: "777" })

    expect(token).toBe("ghs_x")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain("/app/installations/777/access_tokens")
  })

  it("throws when the installation cannot be resolved", async () => {
    await expect(mintAppInstallationToken({ appId: "1", privateKey })).rejects.toThrow(/GITHUB_REPOSITORY/)
  })

  it("throws with API status detail on a failed mint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad creds", { status: 401, statusText: "Unauthorized" })),
    )
    await expect(mintAppInstallationToken({ appId: "1", privateKey, installationId: "5" })).rejects.toThrow(/401/)
  })
})
