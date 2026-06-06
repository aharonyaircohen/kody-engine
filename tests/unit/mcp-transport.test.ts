/**
 * Tests verifying the in-process and HTTP transports expose the SAME tool
 * list. This is the contract that lets Hermes (HTTP client) and Claude Code
 * (in-process) reach the same tool implementations.
 */

import { afterEach, describe, expect, it } from "vitest"
import { buildDutyMcpServer, DUTY_MCP_TOOL_NAMES, dutyToolDefinitions } from "../../src/dutyMcp.js"
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
// duty
// ────────────────────────────────────────────────────────────────────────────

describe("transport parity: duty", () => {
  it("exposes the same tool list via the transport-agnostic definition", () => {
    const defs = dutyToolDefinitions({
      repoSlug: "owner/repo",
      operatorMention: "@user",
    })
    const names = defs.map((d) => d.name).sort()
    const expected = [...DUTY_MCP_TOOL_NAMES].sort()
    expect(names).toEqual(expected)
  })

  it("buildDutyMcpServer returns the in-process adapter with the same name", () => {
    const server = buildDutyMcpServer({
      repoSlug: "owner/repo",
      operatorMention: "@user",
    })
    expect(server.server.name).toBe("kody-duty")
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

  it("exposes the same names for the duty tool list", async () => {
    const routes: McpRouteConfig[] = [
      {
        path: "/mcp/duty",
        name: "kody-duty",
        version: "0.1.0",
        tools: dutyToolDefinitions({ repoSlug: "owner/repo", operatorMention: "@user" }),
      },
    ]
    const mcp = buildMcpHttpServer({ port: 0, host: "127.0.0.1", routes })
    await listenMcpHttpServer(mcp, "127.0.0.1")
    const url = `http://127.0.0.1:${mcp.port}`

    // initialize
    const initRes = await fetch(`${url}/mcp/duty`, {
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
    const listRes = await fetch(`${url}/mcp/duty`, {
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

    const expected = [...DUTY_MCP_TOOL_NAMES].sort()
    expect(listedNames.sort()).toEqual(expected)

    await mcp.stop()
  })
})
