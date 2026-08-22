import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { prepareSimpleCapabilityRuntime } from "../../src/scripts/prepareSimpleCapabilityRuntime.js"

const roots: string[] = []

afterEach(() => {
  delete process.env.LOGIN_PASSWORD
  delete process.env.KODY_TOKEN
  delete process.env.MINIMAX_API_KEY
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): { ctx: Context; profile: Profile } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-capability-runtime-"))
  roots.push(cwd)
  const ctx = {
    cwd,
    args: {},
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "acme", repo: "shop" },
      agent: { model: "claude/haiku" },
    },
    data: {
      capabilityRequirements: {
        browser: true,
        qaCredentials: true,
      },
      capabilityInput: {
        url: "https://dashboard.example.test/repo/acme/shop",
      },
      prompt: "Review the UI.",
    },
    output: { exitCode: 0 },
  } as Context
  const profile = {
    claudeCode: {
      tools: ["Read", "Bash"],
      mcpServers: [],
    },
  } as unknown as Profile
  return { ctx, profile }
}

function writeLogin(cwd: string, login: string): void {
  const dir = path.join(cwd, ".kody-engine", "runtime")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "variables.json"),
    JSON.stringify({ version: 1, variables: { LOGIN_USER: { value: login } } }),
  )
}

describe("prepareSimpleCapabilityRuntime", () => {
  it("adds the browser runtime and explains missing QA credentials", async () => {
    const { ctx, profile } = fixture()

    await prepareSimpleCapabilityRuntime(ctx, profile)

    expect(profile.claudeCode.tools).toContain("mcp__playwright")
    expect(profile.claudeCode.mcpServers).toContainEqual({
      name: "playwright",
      command: "npx",
      args: ["-y", "--package=@playwright/mcp@latest", "--", "playwright-mcp", "--headless"],
    })
    expect(ctx.data.prompt).toContain("no QA credentials configured")
    expect(ctx.data.prompt).toContain("return a blocked result")
  })

  it("prepares the login without putting credentials in the agent prompt", async () => {
    const { ctx, profile } = fixture()
    writeLogin(ctx.cwd, "qa@example.com")
    process.env.LOGIN_PASSWORD = "private-password"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const headers = new Headers()
        headers.append("set-cookie", "better-auth.session_token=session; Path=/; HttpOnly; Secure; SameSite=Lax")
        return new Response("{}", { status: 200, headers })
      }),
    )

    await prepareSimpleCapabilityRuntime(ctx, profile)

    expect(ctx.data.prompt).toContain("already signed in")
    expect(ctx.data.prompt).not.toContain("qa@example.com")
    expect(ctx.data.prompt).not.toContain("private-password")
    expect(profile.claudeCode.mcpServers[0]?.args).toContain("--storage-state")
    expect(ctx.data.capabilityEnvironment).toBeUndefined()
    for (const cleanup of (ctx.data.__runtimeCleanup as Array<() => void> | undefined) ?? []) cleanup()
  })

  it("prepares an authenticated browser session without putting the protected GitHub token in the prompt", async () => {
    const { ctx, profile } = fixture()
    ctx.data.capabilityRequirements = {
      browser: true,
      qaCredentials: true,
      githubTestToken: true,
      qaAccountCredentials: ["MINIMAX_API_KEY"],
      qaAccountModelSettings: {
        models: [{ id: "minimax/MiniMax-M3", default: true }],
        automatic: { default: false },
      },
    }
    writeLogin(ctx.cwd, "qa@example.com")
    process.env.LOGIN_PASSWORD = "private-password"
    process.env.KODY_TOKEN = "protected-github-token"
    process.env.MINIMAX_API_KEY = "protected-model-key"
    const originalFetch = globalThis.fetch
    let savedRepositoryAuth: unknown
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/auth/sign-in/email")) {
        const headers = new Headers()
        headers.append("set-cookie", "better-auth.session_token=session; Path=/; HttpOnly; Secure; SameSite=Lax")
        return new Response("{}", { status: 200, headers })
      }
      if (url.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "qa-user", avatar_url: "https://img.test/qa", id: 42 }), {
          status: 200,
        })
      }
      if (url.endsWith("/repos/acme/shop")) {
        return new Response(JSON.stringify({ full_name: "acme/shop" }), { status: 200 })
      }
      if (url.endsWith("/api/kody/account/repositories")) {
        expect(new Headers(init?.headers).get("cookie")).toContain("better-auth.session_token=session")
        savedRepositoryAuth = JSON.parse(String(init?.body))
        return new Response("{}", { status: 200 })
      }
      if (url.endsWith("/api/kody/account/credentials")) {
        expect(new Headers(init?.headers).get("cookie")).toContain("better-auth.session_token=session")
        expect(JSON.parse(String(init?.body))).toEqual({
          name: "MINIMAX_API_KEY",
          value: "protected-model-key",
        })
        return new Response("{}", { status: 200 })
      }
      if (url.endsWith("/api/kody/models")) {
        expect(new Headers(init?.headers).get("cookie")).toContain("better-auth.session_token=session")
        expect(JSON.parse(String(init?.body))).toEqual({
          models: [{ id: "minimax/MiniMax-M3", default: true }],
          automatic: { default: false },
        })
        return new Response("{}", { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }

    try {
      await prepareSimpleCapabilityRuntime(ctx, profile)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(ctx.data.prompt).toContain("already authenticated")
    expect(ctx.data.prompt).not.toContain("protected-github-token")
    expect(ctx.data.prompt).not.toContain("protected-model-key")
    expect(profile.claudeCode.mcpServers[0]?.args).toContain("--storage-state")
    expect(profile.claudeCode.mcpServers[0]?.args).toContain("--isolated")
    const args = profile.claudeCode.mcpServers[0]?.args ?? []
    const storagePath = args[args.indexOf("--storage-state") + 1]!
    const storageState = JSON.parse(fs.readFileSync(storagePath, "utf-8")) as {
      cookies: Array<{ name: string }>
      origins: Array<{ localStorage: Array<{ name: string }> }>
    }
    expect(storageState.cookies.some(({ name }) => name === "better-auth.session_token")).toBe(true)
    expect(storageState.origins[0]?.localStorage.some(({ name }) => name === "kody_auth")).toBe(true)
    expect(savedRepositoryAuth).toMatchObject({
      auth: {
        owner: "acme",
        repo: "shop",
        token: "protected-github-token",
        user: { login: "qa-user" },
      },
    })
    expect(ctx.data.capabilityEnvironment).toBeUndefined()
    for (const cleanup of (ctx.data.__runtimeCleanup as Array<() => void> | undefined) ?? []) cleanup()
  })

  it("blocks authenticated Quality work when the repository token is missing", async () => {
    const { ctx, profile } = fixture()
    ctx.data.capabilityRequirements = { browser: true, qaCredentials: true, githubTestToken: true }

    await prepareSimpleCapabilityRuntime(ctx, profile)

    expect(ctx.data.prompt).toContain("no `KODY_TOKEN` secret was found")
    expect(ctx.data.prompt).toContain("return a blocked result")
  })

  it("restricts an agent-driven Quality browser to the selected deployment", async () => {
    const { ctx, profile } = fixture()
    ctx.data.capabilityRequirements = { browser: true, browserOnly: true }
    ctx.data.capabilityInput = {
      qualityRunId: "run-safe",
      targetUrl: "https://quality.example.com/path",
    }

    await prepareSimpleCapabilityRuntime(ctx, profile)

    expect(profile.claudeCode.tools).toEqual(["Write", "mcp__playwright"])
    expect(profile.claudeCode.disallowedTools).toEqual(
      expect.arrayContaining(["Agent", "Bash", "Edit", "Read", "TodoWrite", "WebFetch", "WebSearch"]),
    )
    expect(profile.claudeCode.permissionMode).toBe("default")
    expect(profile.claudeCode.maxTurns).toBe(100)
    expect(profile.claudeCode.mcpServers[0]?.args).toContain("--allowed-origins")
    expect(profile.claudeCode.mcpServers[0]?.args).toContain("https://quality.example.com")
    expect(profile.claudeCode.mcpServers[0]?.args).toContain("--output-dir")
    expect(profile.claudeCode.mcpServers[0]?.args?.join(" ")).toContain("test-results/quality-runs/run-safe")
  })

  it("rejects private targets for a restricted Quality browser", async () => {
    const { ctx, profile } = fixture()
    ctx.data.capabilityRequirements = { browser: true, browserOnly: true }
    ctx.data.capabilityInput = {
      qualityRunId: "run-safe",
      targetUrl: "https://127.0.0.1/internal",
    }

    await expect(prepareSimpleCapabilityRuntime(ctx, profile)).rejects.toThrow("public HTTPS targetUrl")
  })
})
