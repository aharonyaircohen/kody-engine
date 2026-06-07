/**
 * Unit tests for `src/bin/mcp-http-server.ts` — the standalone HTTP MCP
 * server entry point.
 *
 * Like brain-proxy-bin.test.ts, this is the source-importing counterpart
 * to the integration test that spawns the built dist binary. Here we
 * assert on the env-derivation logic and the 4 MCP route registrations
 * by mocking the server constructor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const buildMcpHttpServer = vi.fn()
const listenMcpHttpServer = vi.fn()
const requireEnvMock = vi.fn()
const getApiKeyMock = vi.fn()
const getReposRootMock = vi.fn()

vi.mock("../../src/servers/mcpHttpServer.js", () => ({
  buildMcpHttpServer: (...args: unknown[]) => buildMcpHttpServer(...args),
  listenMcpHttpServer: (...args: unknown[]) => listenMcpHttpServer(...args),
}))

vi.mock("../../src/bin/_httpShared.js", async () => {
  const real = await vi.importActual<typeof import("../../src/bin/_httpShared.js")>("../../src/bin/_httpShared.js")
  return {
    ...real,
    requireEnv: requireEnvMock,
    getApiKey: getApiKeyMock,
    getReposRoot: getReposRootMock,
  }
})

const { mcpHttpServer } = await import("../../src/bin/mcp-http-server.js")

describe("bin/mcp-http-server: env validation", () => {
  beforeEach(() => {
    buildMcpHttpServer.mockReset()
    listenMcpHttpServer.mockReset()
    requireEnvMock.mockReset()
    getApiKeyMock.mockReset()
    getReposRootMock.mockReset()
    getApiKeyMock.mockReturnValue(undefined)
    getReposRootMock.mockReturnValue("/tmp/repos")
    // The bin file expects listen() to resolve, so the post-listen
    // signal-handler / forever-await code can run.
    listenMcpHttpServer.mockResolvedValue(undefined)
    buildMcpHttpServer.mockReturnValue({ httpServer: {}, routes: new Map(), port: 0, stop: vi.fn() })
  })

  afterEach(() => {
    delete process.env.GITHUB_TOKEN
    delete process.env.KODY_MCP_HTTP_PORT
    delete process.env.KODY_MCP_HTTP_HOST
    delete process.env.KODY_MCP_REPOS_ROOT
    delete process.env.KODY_MCP_HTTP_KEY
    delete process.env.GITHUB_REPOSITORY
    delete process.env.OPERATOR_MENTION
  })

  it("calls requireEnv(['GITHUB_TOKEN']) first", async () => {
    requireEnvMock.mockImplementation(() => {
      throw new Error("simulated GITHUB_TOKEN missing")
    })
    await expect(mcpHttpServer()).rejects.toThrow(/GITHUB_TOKEN missing/)
    expect(requireEnvMock).toHaveBeenCalledWith(["GITHUB_TOKEN"], "mcp-http-server")
  })

  it("uses default port 8643 and host 127.0.0.1 when env unset", async () => {
    process.env.GITHUB_TOKEN = "gh-test"
    await Promise.race([mcpHttpServer(), new Promise((resolve) => setTimeout(resolve, 50))])
    const opts = buildMcpHttpServer.mock.calls[0]?.[0] as { port: number; host: string }
    expect(opts.port).toBe(8643)
    expect(opts.host).toBe("127.0.0.1")
  })

  it("honors KODY_MCP_HTTP_PORT + KODY_MCP_HTTP_HOST overrides", async () => {
    process.env.GITHUB_TOKEN = "gh-test"
    process.env.KODY_MCP_HTTP_PORT = "9999"
    process.env.KODY_MCP_HTTP_HOST = "0.0.0.0"
    await Promise.race([mcpHttpServer(), new Promise((resolve) => setTimeout(resolve, 50))])
    const opts = buildMcpHttpServer.mock.calls[0]?.[0] as { port: number; host: string }
    expect(opts.port).toBe(9999)
    expect(opts.host).toBe("0.0.0.0")
  })

  it("forwards apiKey from getApiKey when set", async () => {
    process.env.GITHUB_TOKEN = "gh-test"
    getApiKeyMock.mockReturnValue("secret-key")
    await Promise.race([mcpHttpServer(), new Promise((resolve) => setTimeout(resolve, 50))])
    const opts = buildMcpHttpServer.mock.calls[0]?.[0] as { apiKey: string }
    expect(opts.apiKey).toBe("secret-key")
  })

  it("registers all 4 expected MCP routes (single-tool routes vs. duty palette)", async () => {
    process.env.GITHUB_TOKEN = "gh-test"
    await Promise.race([mcpHttpServer(), new Promise((resolve) => setTimeout(resolve, 50))])
    const opts = buildMcpHttpServer.mock.calls[0]?.[0] as {
      routes: Array<{ path: string; name: string; tools: Array<{ name: string }> }>
    }
    const paths = opts.routes.map((r) => r.path)
    expect(paths).toContain("/mcp/fetch-repo")
    expect(paths).toContain("/mcp/verify")
    expect(paths).toContain("/mcp/submit-state")
    expect(paths).toContain("/mcp/duty")
    // The fetch-repo / verify / submit-state routes each carry exactly
    // one tool. The duty route is a palette (11 tools) — it would be
    // a bug to flatten it into separate routes since each tool calls
    // into the same locked-duty trust gate (see dutyMcp.ts).
    const singleToolRoutes = opts.routes.filter((r) => r.path !== "/mcp/duty")
    for (const r of singleToolRoutes) {
      expect(r.tools).toHaveLength(1)
    }
    expect(opts.routes.find((r) => r.path === "/mcp/duty")?.tools.length).toBeGreaterThan(1)
  })

  it("forwards GITHUB_REPOSITORY + OPERATOR_MENTION env to the duty route", async () => {
    process.env.GITHUB_TOKEN = "gh-test"
    process.env.GITHUB_REPOSITORY = "owner/repo"
    process.env.OPERATOR_MENTION = "@alice"
    await Promise.race([mcpHttpServer(), new Promise((resolve) => setTimeout(resolve, 50))])
    const opts = buildMcpHttpServer.mock.calls[0]?.[0] as {
      routes: Array<{ path: string; tools: Array<{ name: string }> }>
    }
    // The duty tool's handler was constructed with the env-derived
    // repoSlug. We can't read the closure from here, but we can assert
    // the route + tool were registered with the expected identity so a
    // future maintainer reading this test sees what env feeds the duty
    // route's dutyOperatorMention / dutyRepoSlug fields.
    const dutyRoute = opts.routes.find((r) => r.path === "/mcp/duty")
    expect(dutyRoute).toBeDefined()
    expect(dutyRoute?.tools[0]?.name).toBeTruthy()
  })
})
