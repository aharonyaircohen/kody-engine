/**
 * Tests for the HTTP MCP server.
 *
 * The HTTP MCP server exposes kody's MCP tools (fetch_repo, verify,
 * submit_state, capability) over HTTP transport. Hermes Agent connects to it as an
 * MCP client. These tests exercise the JSON-RPC + SSE handshake the same way
 * the official MCP SDK client would.
 */

import { afterEach, describe, expect, it } from "vitest"
import { fetchRepoToolDefinition } from "../../src/fetchRepoMcp.js"
import { buildMcpHttpServer, listenMcpHttpServer, type McpRouteConfig } from "../../src/servers/mcpHttpServer.js"
import { submitStateToolDefinition } from "../../src/submitMcp.js"

interface RunningServer {
  url: string
  stop: () => Promise<void>
}

async function startServer(routes: McpRouteConfig[], opts: { apiKey?: string } = {}): Promise<RunningServer> {
  const server = buildMcpHttpServer({
    port: 0,
    host: "127.0.0.1",
    routes,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
  })
  await listenMcpHttpServer(server, "127.0.0.1")
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(),
  }
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net")
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      s.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0))
    })
    s.on("error", reject)
  })
}

async function postRpc(url: string, body: unknown, sessionId?: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  if (sessionId) headers["mcp-session-id"] = sessionId
  if (init?.headers) Object.assign(headers, init.headers)
  return fetch(url, {
    method: "POST",
    ...init,
    headers,
    body: JSON.stringify(body),
  })
}

/**
 * Parse a JSON-RPC response from the MCP transport. The transport can reply
 * with a single JSON object OR with an SSE stream of one message — handle both.
 */
async function parseRpcResponse(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) {
    return await res.json()
  }
  // SSE stream — read all chunks, parse the first event's data line.
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  for (const line of buf.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6))
    }
  }
  throw new Error("no data: line in SSE response")
}

// ────────────────────────────────────────────────────────────────────────────
// fetch_repo
// ────────────────────────────────────────────────────────────────────────────

describe("HTTP MCP server: fetch_repo route", () => {
  let server: RunningServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it("responds to initialize and advertises the fetch_repo tool", async () => {
    const port = await findFreePort()
    server = await startServer([
      {
        path: "/mcp/fetch-repo",
        name: "kody-fetch-repo",
        version: "0.1.0",
        tools: [fetchRepoToolDefinition({ reposRoot: `/tmp/mcp-fetch-${port}` })],
      },
    ])

    // initialize
    const initRes = await postRpc(`${server.url}/mcp/fetch-repo`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    })
    const init = (await parseRpcResponse(initRes)) as { result: { serverInfo: { name: string } } }
    expect(init.result.serverInfo.name).toBe("kody-fetch-repo")
    const sessionId = initRes.headers.get("mcp-session-id")
    expect(sessionId).toBeTruthy()

    // Send initialized notification
    await postRpc(
      `${server.url}/mcp/fetch-repo`,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId ?? undefined,
    )

    // tools/list
    const listRes = await postRpc(
      `${server.url}/mcp/fetch-repo`,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      sessionId ?? undefined,
    )
    const list = (await parseRpcResponse(listRes)) as { result: { tools: Array<{ name: string }> } }
    expect(list.result.tools.map((t) => t.name)).toEqual(["fetch_repo"])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// submit_state
// ────────────────────────────────────────────────────────────────────────────

describe("HTTP MCP server: submit_state route", () => {
  let server: RunningServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it("captures the submitted state and returns a tool result", async () => {
    let captured: { cursor: string; data: Record<string, unknown>; done: boolean } | undefined
    server = await startServer([
      {
        path: "/mcp/submit-state",
        name: "kody-submit",
        version: "0.1.0",
        tools: [
          submitStateToolDefinition({
            setSubmitted: (s) => {
              captured = s
            },
          }),
        ],
      },
    ])

    // initialize
    const initRes = await postRpc(`${server.url}/mcp/submit-state`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    })
    const sessionId = initRes.headers.get("mcp-session-id")
    expect(sessionId).toBeTruthy()

    // tools/call
    const callRes = await postRpc(
      `${server.url}/mcp/submit-state`,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "submit_state",
          arguments: { cursor: "idle", data: { count: 3 }, done: false },
        },
      },
      sessionId ?? undefined,
    )
    const call = (await parseRpcResponse(callRes)) as { result: { content: Array<{ text: string }> } }
    expect(call.result.content[0]!.text).toContain("State recorded")
    expect(captured).toEqual({ cursor: "idle", data: { count: 3 }, done: false })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// healthz
// ────────────────────────────────────────────────────────────────────────────

describe("HTTP MCP server: /healthz", () => {
  let server: RunningServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it("returns 200 with the list of registered routes", async () => {
    server = await startServer([
      {
        path: "/mcp/fetch-repo",
        name: "kody-fetch-repo",
        version: "0.1.0",
        tools: [fetchRepoToolDefinition({ reposRoot: "/tmp/x" })],
      },
    ])
    const res = await fetch(`${server.url}/healthz`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.routes).toContain("/mcp/fetch-repo")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// auth
// ────────────────────────────────────────────────────────────────────────────

describe("HTTP MCP server: auth", () => {
  let server: RunningServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it("rejects unauthenticated requests with 401 when apiKey is set", async () => {
    server = await startServer(
      [
        {
          path: "/mcp/fetch-repo",
          name: "kody-fetch-repo",
          version: "0.1.0",
          tools: [fetchRepoToolDefinition({ reposRoot: "/tmp/x" })],
        },
      ],
      { apiKey: "secret" },
    )
    const res = await postRpc(`${server.url}/mcp/fetch-repo`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } },
    })
    expect(res.status).toBe(401)
  })

  it("accepts requests with the correct Bearer token", async () => {
    server = await startServer(
      [
        {
          path: "/mcp/fetch-repo",
          name: "kody-fetch-repo",
          version: "0.1.0",
          tools: [fetchRepoToolDefinition({ reposRoot: "/tmp/x" })],
        },
      ],
      { apiKey: "secret" },
    )
    const res = await postRpc(
      `${server.url}/mcp/fetch-repo`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } },
      },
      undefined,
      { headers: { Authorization: "Bearer secret" } },
    )
    expect(res.status).toBe(200)
  })

  it("rejects a bare apiKey without the Bearer prefix (matches brain-serve contract)", async () => {
    // Brain-serve's authOk (src/servers/brain-serve.ts) requires `Bearer `.
    // The MCP server used to accept `Authorization: <bare-apiKey>` too — a
    // harmless convenience that diverged from the brain-serve contract. A
    // future client author reading one implementation and applying it to
    // the other would be surprised; lock the contract to Bearer-only.
    server = await startServer(
      [
        {
          path: "/mcp/fetch-repo",
          name: "kody-fetch-repo",
          version: "0.1.0",
          tools: [fetchRepoToolDefinition({ reposRoot: "/tmp/x" })],
        },
      ],
      { apiKey: "secret" },
    )
    const res = await postRpc(
      `${server.url}/mcp/fetch-repo`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } },
      },
      undefined,
      { headers: { Authorization: "secret" } },
    )
    expect(res.status).toBe(401)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 404
// ────────────────────────────────────────────────────────────────────────────

describe("HTTP MCP server: 404 for unknown routes", () => {
  let server: RunningServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it("returns 404 for unknown paths", async () => {
    server = await startServer([])
    const res = await postRpc(`${server.url}/nope`, { jsonrpc: "2.0", id: 1, method: "ping" })
    expect(res.status).toBe(404)
  })
})
