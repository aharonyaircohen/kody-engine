import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { prepareBrowserAuth, prepareEmailPasswordBrowserAuth } from "../../src/scripts/prepareBrowserAuth.js"

function makeCtx(cwd: string): Context {
  return {
    args: {},
    cwd,
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "acme", repo: "widgets" },
      agent: { model: "claude/haiku" },
    },
    data: {
      previewUrl: "https://dashboard.example.test/repo/acme/widgets",
      qaAuthBlock: "Auth: existing website login remains available.",
    },
    output: { exitCode: 0 },
  }
}

function writeVariables(cwd: string, vars: Record<string, string>): void {
  const variables = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, { value }]))
  const dir = path.join(cwd, ".kody-engine", "runtime")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "variables.json"), JSON.stringify({ version: 1, variables }))
}

function makeProfile(): Profile {
  return {
    auth: {
      methods: [
        {
          name: "Kody repository login",
          strategy: "browser-storage-state",
          adapter: "kody-repository",
          fields: [
            { label: "Repository", source: "variable", key: "KODY_LOGIN_REPO" },
            { label: "Personal access token", source: "secret", key: "KODY_LOGIN_PASS" },
          ],
        },
      ],
    },
    claudeCode: {
      mcpServers: [
        {
          name: "playwright",
          command: "npx",
          args: ["-y", "--package=@playwright/mcp@latest", "--", "playwright-mcp", "--headless"],
        },
      ],
    },
  } as Profile
}

describe("prepareBrowserAuth", () => {
  let tmp: string
  let previousPass: string | undefined
  let previousMasterKey: string | undefined

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-browser-auth-test-"))
    previousPass = process.env.KODY_LOGIN_PASS
    previousMasterKey = process.env.KODY_MASTER_KEY
    delete process.env.KODY_LOGIN_PASS
    delete process.env.KODY_MASTER_KEY
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    fs.rmSync(tmp, { recursive: true, force: true })
    if (previousPass === undefined) delete process.env.KODY_LOGIN_PASS
    else process.env.KODY_LOGIN_PASS = previousPass
    if (previousMasterKey === undefined) delete process.env.KODY_MASTER_KEY
    else process.env.KODY_MASTER_KEY = previousMasterKey
  })

  it("prepares an authenticated browser session without putting the PAT in agent context", async () => {
    writeVariables(tmp, { KODY_LOGIN_REPO: "https://github.com/acme/widgets/" })
    process.env.KODY_LOGIN_PASS = "github-pat"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith("/repos/acme/widgets")) {
          return new Response(
            JSON.stringify({ full_name: "acme/widgets", html_url: "https://untrusted.test/acme/widgets" }),
            { status: 200 },
          )
        }
        return new Response("not found", { status: 404 })
      }),
    )

    const ctx = makeCtx(tmp)
    const profile = makeProfile()
    await prepareBrowserAuth(ctx, profile)

    expect(ctx.data.qaAuthBlock).toContain("already authenticated")
    expect(ctx.data.qaAuthBlock).not.toContain("github-pat")
    const args = profile.claudeCode.mcpServers[0]!.args!
    expect(args).toContain("--isolated")
    const storageFlag = args.indexOf("--storage-state")
    expect(storageFlag).toBeGreaterThanOrEqual(0)
    const storagePath = args[storageFlag + 1]!
    expect(fs.statSync(storagePath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(storagePath)).mode & 0o777).toBe(0o700)
    const storageState = JSON.parse(fs.readFileSync(storagePath, "utf-8")) as {
      origins: Array<{ localStorage: Array<{ name: string; value: string }> }>
    }
    const authValue = storageState.origins[0]!.localStorage.find((entry) => entry.name === "kody_auth")!.value
    const auth = JSON.parse(authValue) as {
      token: string
      repoUrl: string
      user: { login: string }
      repos: Array<{ user?: unknown }>
    }
    expect(auth).toMatchObject({
      token: "github-pat",
      repoUrl: "https://github.com/acme/widgets",
      user: { login: "" },
    })
    expect(auth.repos[0]!.user).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalledWith("https://api.github.com/user", expect.anything())

    const cleanup = ctx.data.__runtimeCleanup as Array<() => void>
    expect(cleanup).toHaveLength(1)
    cleanup[0]!()
    expect(fs.existsSync(storagePath)).toBe(false)
  })

  it("signs into the app before the agent starts without exposing the password", async () => {
    process.env.LOGIN_PASSWORD = "private-password"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          email: "qa@example.com",
          password: "private-password",
          callbackURL: "/chat",
        })
        const headers = new Headers()
        headers.append(
          "set-cookie",
          "__Secure-better-auth.session_token=session-value; Path=/; HttpOnly; Secure; SameSite=Lax",
        )
        return new Response(JSON.stringify({ user: { email: "qa@example.com" } }), {
          status: 200,
          headers,
        })
      }),
    )
    const ctx = makeCtx(tmp)
    const profile = makeProfile()

    const prepared = await prepareEmailPasswordBrowserAuth(ctx, profile, {
      login: "qa@example.com",
      targetUrl: "https://dashboard.example.test/repo/acme/widgets",
    })

    expect(prepared).toBe(true)
    expect(ctx.data.qaAuthBlock).toContain("already signed in")
    expect(ctx.data.qaAuthBlock).not.toContain("private-password")
    const args = profile.claudeCode.mcpServers[0]!.args!
    const storagePath = args[args.indexOf("--storage-state") + 1]!
    const state = JSON.parse(fs.readFileSync(storagePath, "utf-8")) as {
      cookies: Array<{ name: string; value: string; domain: string }>
    }
    expect(state.cookies).toContainEqual(
      expect.objectContaining({
        name: "__Secure-better-auth.session_token",
        value: "session-value",
        domain: "dashboard.example.test",
      }),
    )
    const cleanup = ctx.data.__runtimeCleanup as Array<() => void>
    cleanup[0]!()
  })

  it("does nothing when the profile declares no authentication", async () => {
    const ctx = makeCtx(tmp)
    const profile = makeProfile()
    delete profile.auth

    await prepareBrowserAuth(ctx, profile)

    expect(ctx.data.qaAuthBlock).toBe("Auth: existing website login remains available.")
    expect(ctx.data.__runtimeCleanup).toBeUndefined()
    expect(profile.claudeCode.mcpServers[0]!.args).not.toContain("--storage-state")
  })

  it("does not expose an orphaned secret when the repository variable is missing", async () => {
    process.env.KODY_LOGIN_PASS = "orphaned-pat"
    const ctx = makeCtx(tmp)
    const profile = makeProfile()

    await prepareBrowserAuth(ctx, profile)

    expect(ctx.data.qaAuthBlock).toContain("no `KODY_LOGIN_REPO` variable was found")
    expect(ctx.data.qaAuthBlock).not.toContain("orphaned-pat")
    expect(profile.claudeCode.mcpServers[0]!.args).not.toContain("--storage-state")
  })

  it("fails safely when GitHub rejects the credential", async () => {
    writeVariables(tmp, { KODY_LOGIN_REPO: "https://github.com/acme/widgets/" })
    process.env.KODY_LOGIN_PASS = "rejected-pat"
    const fetchMock = vi.fn(async () => new Response("denied", { status: 401 }))
    vi.stubGlobal("fetch", fetchMock)
    const ctx = makeCtx(tmp)
    const profile = makeProfile()

    await prepareBrowserAuth(ctx, profile)

    expect(ctx.data.qaAuthBlock).toContain("GitHub repository check returned 401")
    expect(ctx.data.qaAuthBlock).not.toContain("rejected-pat")
    expect(profile.claudeCode.mcpServers[0]!.args).not.toContain("--storage-state")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries temporary GitHub failures before preparing the browser session", async () => {
    vi.useFakeTimers()
    writeVariables(tmp, { KODY_LOGIN_REPO: "https://github.com/acme/widgets" })
    process.env.KODY_LOGIN_PASS = "github-pat"
    let repositoryAttempts = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/repos/acme/widgets")) {
        repositoryAttempts += 1
        if (repositoryAttempts < 3) return new Response("unavailable", { status: 503 })
      }
      return new Response(JSON.stringify({ full_name: "acme/widgets" }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const ctx = makeCtx(tmp)
    const profile = makeProfile()
    const pending = prepareBrowserAuth(ctx, profile)
    await vi.runAllTimersAsync()
    await pending

    expect(repositoryAttempts).toBe(3)
    expect(ctx.data.qaAuthBlock).toContain("already authenticated")
    expect(ctx.data.qaAuthBlock).not.toContain("github-pat")
    const cleanup = ctx.data.__runtimeCleanup as Array<() => void>
    cleanup[0]!()
  })

  it("rejects a non-GitHub repository URL without calling GitHub or exposing the PAT", async () => {
    writeVariables(tmp, { KODY_LOGIN_REPO: "https://example.test/acme/widgets" })
    process.env.KODY_LOGIN_PASS = "private-pat"
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const ctx = makeCtx(tmp)
    const profile = makeProfile()

    await prepareBrowserAuth(ctx, profile)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ctx.data.qaAuthBlock).toContain("could not prepare Kody repository login")
    expect(ctx.data.qaAuthBlock).not.toContain("private-pat")
    expect(ctx.data.__runtimeCleanup).toBeUndefined()
  })

  it("removes an existing storage-state option before applying the isolated session", async () => {
    writeVariables(tmp, { KODY_LOGIN_REPO: "https://github.com/acme/widgets" })
    process.env.KODY_LOGIN_PASS = "github-pat"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ full_name: "acme/widgets" }), { status: 200 })),
    )
    const ctx = makeCtx(tmp)
    const profile = makeProfile()
    profile.claudeCode.mcpServers[0]!.args!.push("--storage-state=/tmp/stale.json")

    await prepareBrowserAuth(ctx, profile)

    const args = profile.claudeCode.mcpServers[0]!.args!
    expect(args.filter((arg) => arg.startsWith("--storage-state"))).toEqual(["--storage-state"])
    expect(args.filter((arg) => arg === "--isolated")).toHaveLength(1)
    const cleanup = ctx.data.__runtimeCleanup as Array<() => void>
    cleanup[0]!()
  })

  it("deletes a prepared credential file if Playwright is unavailable", async () => {
    writeVariables(tmp, { KODY_LOGIN_REPO: "https://github.com/acme/widgets" })
    process.env.KODY_LOGIN_PASS = "github-pat"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ full_name: "acme/widgets" }), { status: 200 })),
    )
    const ctx = makeCtx(tmp)
    const profile = makeProfile()
    profile.claudeCode.mcpServers = []
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("kody-browser-auth-")))

    await prepareBrowserAuth(ctx, profile)

    const after = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("kody-browser-auth-") && !before.has(name))
    expect(after).toEqual([])
    expect(ctx.data.qaAuthBlock).toContain("Playwright MCP server is not configured")
    expect(ctx.data.qaAuthBlock).not.toContain("github-pat")
  })
})
