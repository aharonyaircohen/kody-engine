import { createVerify, generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { discoverAppRepositories, mintAppInstallationToken, readAppCreds } from "../../src/app-auth.js"

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
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ token: "ghs_x" }), { status: 200 }),
    )
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

describe("app-auth: discoverAppRepositories", () => {
  it("lists every installation repo with its installation token", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url)
      if (path.includes("/app/installations?")) {
        return new Response(JSON.stringify([{ id: 11 }, { id: 22 }]), { status: 200 })
      }
      if (path.endsWith("/app/installations/11/access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_11" }), { status: 200 })
      }
      if (path.endsWith("/app/installations/22/access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_22" }), { status: 200 })
      }
      const auth = String((init?.headers as Record<string, string>).Authorization)
      if (path.includes("/installation/repositories") && auth === "Bearer ghs_11") {
        return new Response(
          JSON.stringify({ repositories: [{ full_name: "acme/widgets" }, { full_name: "acme/gadgets" }] }),
          { status: 200 },
        )
      }
      if (path.includes("/installation/repositories") && auth === "Bearer ghs_22") {
        return new Response(JSON.stringify({ repositories: [{ full_name: "other/service" }] }), { status: 200 })
      }
      return new Response("unexpected request", { status: 500 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const repos = await discoverAppRepositories({ appId: "42", privateKey })

    expect(repos).toEqual([
      { repo: "acme/gadgets", token: "ghs_11" },
      { repo: "acme/widgets", token: "ghs_11" },
      { repo: "other/service", token: "ghs_22" },
    ])
  })

  it("paginates installations and repositories", async () => {
    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const path = String(url)
        calls.push(path)
        if (path.includes("/app/installations?") && path.includes("&page=1")) {
          return new Response(JSON.stringify([{ id: 7 }]), {
            status: 200,
            headers: { link: '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next"' },
          })
        }
        if (path.includes("/app/installations?") && path.includes("&page=2")) {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        if (path.endsWith("/app/installations/7/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_7" }), { status: 200 })
        }
        if (path.includes("/installation/repositories") && path.includes("&page=1")) {
          return new Response(JSON.stringify({ repositories: [{ full_name: "acme/one" }] }), {
            status: 200,
            headers: { link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"' },
          })
        }
        if (path.includes("/installation/repositories") && path.includes("&page=2")) {
          return new Response(JSON.stringify({ repositories: [] }), { status: 200 })
        }
        return new Response("unexpected request", { status: 500 })
      }),
    )

    await expect(discoverAppRepositories({ appId: "42", privateKey })).resolves.toEqual([
      { repo: "acme/one", token: "ghs_7" },
    ])
    expect(calls.some((url) => url.includes("/app/installations?") && url.includes("&page=2"))).toBe(true)
    expect(calls.some((url) => url.includes("/installation/repositories") && url.includes("&page=2"))).toBe(true)
  })
})
