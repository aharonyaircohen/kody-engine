/**
 * Tests verifying the in-process and HTTP transports expose the SAME tool
 * list. This is the contract that lets Hermes (HTTP client) and Claude Code
 * (in-process) reach the same tool implementations.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildCapabilityMcpServer,
  CAPABILITY_MCP_TOOL_NAMES,
  capabilityToolDefinitions,
} from "../../src/capabilityMcp.js"
import {
  buildDashboardCmsMcpServer,
  DASHBOARD_CMS_MCP_TOOL_NAMES,
  dashboardCmsToolDefinitions,
} from "../../src/dashboardCmsMcp.js"
import { buildFetchRepoMcpServer, fetchRepoToolDefinition } from "../../src/fetchRepoMcp.js"
import { buildMcpHttpServer, listenMcpHttpServer, type McpRouteConfig } from "../../src/servers/mcpHttpServer.js"
import { buildSubmitMcpServer, submitStateToolDefinition } from "../../src/submitMcp.js"
import { buildVerifyMcpServer, verifyToolDefinition } from "../../src/verifyMcp.js"

interface RunningServer {
  url: string
  stop: () => Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// fetch_repo
// ────────────────────────────────────────────────────────────────────────────

describe("transport parity: fetch_repo", () => {
  it("exposes one tool named 'fetch_repo' via in-process adapter", () => {
    const server = buildFetchRepoMcpServer({ reposRoot: "/tmp/parity" })
    expect(server.name).toBe("kody-fetch-repo")
  })

  it("exposes the same tool via the transport-agnostic definition", () => {
    const def = fetchRepoToolDefinition({ reposRoot: "/tmp/parity" })
    expect(def.name).toBe("fetch_repo")
    expect(def.description).toBeTruthy()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// verify
// ────────────────────────────────────────────────────────────────────────────

describe("transport parity: verify", () => {
  it("exposes the verify tool via the transport-agnostic definition", () => {
    const def = verifyToolDefinition({
      config: {
        quality: { typecheck: "", lint: "", format: "", testUnit: "" },
        git: { defaultBranch: "main" },
        github: { owner: "x", repo: "y" },
        agent: { model: "claude/claude-sonnet-4" },
      },
      cwd: "/tmp/parity",
      executable: "test",
    })
    expect(def.name).toBe("verify")
    expect(def.description).toBeTruthy()
  })

  it("buildVerifyMcpServer returns the in-process adapter", () => {
    const server = buildVerifyMcpServer({
      config: {
        quality: { typecheck: "", lint: "", format: "", testUnit: "" },
        git: { defaultBranch: "main" },
        github: { owner: "x", repo: "y" },
        agent: { model: "claude/claude-sonnet-4" },
      },
      cwd: "/tmp/parity",
      executable: "test",
    })
    expect(server.name).toBe("kody-verify")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// submit_state
// ────────────────────────────────────────────────────────────────────────────

describe("transport parity: submit_state", () => {
  it("exposes the submit_state tool via the transport-agnostic definition", () => {
    const def = submitStateToolDefinition({ setSubmitted: () => {} })
    expect(def.name).toBe("submit_state")
    expect(def.description).toBeTruthy()
  })

  it("buildSubmitMcpServer returns the in-process adapter", () => {
    const handle = buildSubmitMcpServer()
    expect(handle.getSubmitted()).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// capability
// ────────────────────────────────────────────────────────────────────────────

describe("transport parity: capability", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.KODY_CMS_DASHBOARD_URL
    delete process.env.KODY_CMS_TOKEN
  })

  it("exposes the same tool list via the transport-agnostic definition", () => {
    const defs = capabilityToolDefinitions({
      repoSlug: "owner/repo",
      operatorMention: "@user",
    })
    const names = defs.map((d) => d.name).sort()
    const expected = [...CAPABILITY_MCP_TOOL_NAMES].sort()
    expect(names).toEqual(expected)
  })

  it("buildCapabilityMcpServer returns the in-process adapter with the same name", () => {
    const server = buildCapabilityMcpServer({
      repoSlug: "owner/repo",
      operatorMention: "@user",
    })
    expect(server.server.name).toBe("kody-capability")
  })

  it("calls the Dashboard CMS API with repo auth headers", async () => {
    process.env.KODY_CMS_DASHBOARD_URL = "https://dashboard.example.test/cms"
    process.env.KODY_CMS_TOKEN = "test-token"
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ docs: [], total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const tool = capabilityToolDefinitions({
      repoSlug: "owner/repo",
      operatorMention: "@user",
    }).find((def) => def.name === "cms_list_documents")
    if (!tool) throw new Error("cms_list_documents missing")

    const result = await tool.handler({
      collection: "lessons",
      q: "intro",
      limit: 5,
    })

    expect(result.isError).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://dashboard.example.test/api/kody/cms/lessons?q=intro&limit=5")
    expect(init.headers).toMatchObject({
      "x-kody-token": "test-token",
      "x-kody-owner": "owner",
      "x-kody-repo": "repo",
    })
  })

  it("normalizes Dashboard content-entry URLs before CMS document get calls", async () => {
    process.env.KODY_CMS_DASHBOARD_URL = "https://dashboard.example.test"
    process.env.KODY_CMS_TOKEN = "test-token"
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ document: { _id: "6a408b5d4a2dd57df6b116ea" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const tool = capabilityToolDefinitions({
      repoSlug: "owner/repo",
      operatorMention: "@user",
    }).find((def) => def.name === "cms_get_document")
    if (!tool) throw new Error("cms_get_document missing")

    const result = await tool.handler({
      collection: "courses",
      id: "https://dashboard.example.test/content/entries/courses/6a408b5d4a2dd57df6b116ea/edit?collectionSearch=course",
    })

    expect(result.isError).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://dashboard.example.test/api/kody/cms/courses/6a408b5d4a2dd57df6b116ea")
  })

  it("refuses CMS writes while the capability is in ask mode", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const tool = capabilityToolDefinitions({
      repoSlug: "owner/repo",
      operatorMention: "@user",
      capabilitySlug: "cms-content-editor",
    }).find((def) => def.name === "cms_update_document")
    if (!tool) throw new Error("cms_update_document missing")

    const result = await tool.handler({
      collection: "lessons",
      id: "1",
      data: { title: "New title" },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.content[0]?.text).toContain("ASK mode")
  })
})

describe("transport parity: dashboard CMS", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("exposes the dedicated Dashboard CMS tool list", () => {
    const defs = dashboardCmsToolDefinitions({
      repoSlug: "owner/repo",
      dashboardUrl: "https://dashboard.example.test",
      token: "test-token",
    })
    expect(defs.map((d) => d.name).sort()).toEqual([...DASHBOARD_CMS_MCP_TOOL_NAMES].sort())
  })

  it("buildDashboardCmsMcpServer returns the in-process adapter", () => {
    const handle = buildDashboardCmsMcpServer({
      repoSlug: "owner/repo",
      dashboardUrl: "https://dashboard.example.test",
      token: "test-token",
    })
    expect(handle.server.name).toBe("kody-cms")
  })

  it("calls the provided Dashboard CMS origin and token instead of ambient env", async () => {
    process.env.KODY_CMS_DASHBOARD_URL = "https://wrong.example.test"
    process.env.KODY_CMS_TOKEN = "wrong-token"
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ docs: [], total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const tool = dashboardCmsToolDefinitions({
      repoSlug: "owner/repo",
      dashboardUrl: "https://dashboard.example.test/cms",
      token: "test-token",
      storeRepoUrl: "https://github.com/acme/kody-store",
      storeRef: "stable",
    }).find((def) => def.name === "cms_list_documents")
    if (!tool) throw new Error("cms_list_documents missing")

    const result = await tool.handler({
      collection: "courses",
      q: "intro",
      limit: 5,
    })

    expect(result.isError).toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://dashboard.example.test/api/kody/cms/courses?q=intro&limit=5")
    expect(init.headers).toMatchObject({
      "x-kody-token": "test-token",
      "x-kody-owner": "owner",
      "x-kody-repo": "repo",
      "x-kody-store-repo-url": "https://github.com/acme/kody-store",
      "x-kody-store-ref": "stable",
    })
  })

  it("normalizes Dashboard content-entry URLs before document get calls", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ document: { _id: "6a408b5d4a2dd57df6b116ea" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const tool = dashboardCmsToolDefinitions({
      repoSlug: "owner/repo",
      dashboardUrl: "https://dashboard.example.test",
      token: "test-token",
    }).find((def) => def.name === "cms_get_document")
    if (!tool) throw new Error("cms_get_document missing")

    await tool.handler({
      collection: "courses",
      id: "https://dashboard.example.test/content/entries/courses/6a408b5d4a2dd57df6b116ea/edit?collectionSearch=course",
    })

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://dashboard.example.test/api/kody/cms/courses/6a408b5d4a2dd57df6b116ea")
  })

  it("lets callers own write authorization policy", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const tool = dashboardCmsToolDefinitions({
      repoSlug: "owner/repo",
      dashboardUrl: "https://dashboard.example.test",
      token: "test-token",
      assertWriteAllowed: () => "write blocked by test policy",
    }).find((def) => def.name === "cms_update_document")
    if (!tool) throw new Error("cms_update_document missing")

    const result = await tool.handler({
      collection: "courses",
      id: "1",
      data: { title: "new" },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.content[0]?.text).toBe("write blocked by test policy")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// End-to-end parity: HTTP and in-process advertise the same tool list.
// ────────────────────────────────────────────────────────────────────────────

describe("transport parity: HTTP server advertises the same tool list as in-process", () => {
  let server: RunningServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it("exposes the same names for the capability tool list", async () => {
    const routes: McpRouteConfig[] = [
      {
        path: "/mcp/capability",
        name: "kody-capability",
        version: "0.1.0",
        tools: capabilityToolDefinitions({ repoSlug: "owner/repo", operatorMention: "@user" }),
      },
    ]
    const mcp = buildMcpHttpServer({ port: 0, host: "127.0.0.1", routes })
    await listenMcpHttpServer(mcp, "127.0.0.1")
    const url = `http://127.0.0.1:${mcp.port}`

    // initialize
    const initRes = await fetch(`${url}/mcp/capability`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    })
    const sessionId = initRes.headers.get("mcp-session-id")

    // tools/list
    const listRes = await fetch(`${url}/mcp/capability`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    })

    // Response can be JSON or SSE-wrapped; read the body either way.
    const text = await listRes.text()
    let listedNames: string[] = []
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const parsed = JSON.parse(line.slice(6)) as { result?: { tools?: Array<{ name: string }> } }
        if (parsed.result?.tools) {
          listedNames = parsed.result.tools.map((t) => t.name)
        }
      }
    }
    if (listedNames.length === 0) {
      // Direct JSON response
      const parsed = JSON.parse(text) as { result?: { tools?: Array<{ name: string }> } }
      listedNames = (parsed.result?.tools ?? []).map((t) => t.name)
    }

    const expected = [...CAPABILITY_MCP_TOOL_NAMES].sort()
    expect(listedNames.sort()).toEqual(expected)

    await mcp.stop()
  })
})
