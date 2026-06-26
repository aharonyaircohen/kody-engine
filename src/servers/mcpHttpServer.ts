/**
 * HTTP MCP server wrapper.
 *
 * Exposes kody's in-process MCP tools (fetch_repo, verify, submit_state, capability)
 * over HTTP transport so external MCP clients — most importantly the Hermes
 * Agent API server — can call them.
 *
 * Each tool server gets its own URL path (e.g. `/mcp/fetch-repo`, `/mcp/verify`).
 * Hermes configures each as a separate MCP server entry.
 *
 * The handlers are the SAME functions as the in-process server uses (extracted
 * into transport-agnostic tool definitions in fetchRepoMcp.ts, etc.). This
 * guarantees the HTTP and in-process transports produce identical behavior.
 *
 * Transport: `@modelcontextprotocol/sdk` (the official MCP SDK) using
 * `StreamableHTTPServerTransport` over Node's `http` server.
 */

import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { CapabilityToolDefinition } from "../capabilityMcp.js"
import type { FetchRepoToolDefinition } from "../fetchRepoMcp.js"
import type { SubmitStateToolDefinition } from "../submitMcp.js"
import type { VerifyToolDefinition } from "../verifyMcp.js"
import { authOk } from "./brain-serve.js"

export interface McpRouteConfig {
  /** URL path for this MCP server (e.g. "/mcp/fetch-repo"). */
  path: string
  /** MCP server name advertised to clients. */
  name: string
  /** MCP server version. */
  version: string
  /** Tool definitions to register. */
  tools: Array<
    FetchRepoToolDefinition | VerifyToolDefinition | SubmitStateToolDefinition | CapabilityToolDefinition
  >
}

export interface McpHttpServerOptions {
  /** HTTP port to listen on. */
  port: number
  /** Host to bind to. Default: "127.0.0.1" (loopback only — local services connect to it). */
  host?: string
  /** API key the server requires (Authorization: Bearer ...) or undefined for open access. */
  apiKey?: string
  /** Routes to register. */
  routes: McpRouteConfig[]
  /** Override the per-server factory (used by tests to inject transport). */
  __createTransport?: (sessionId: string | undefined) => StreamableHTTPServerTransport
}

export interface McpHttpServer {
  /** Underlying http.Server (for tests). */
  httpServer: import("node:http").Server
  /** URL prefixes registered (path -> name). */
  routes: Map<string, string>
  /** Stop the server. */
  stop: () => Promise<void>
  /** Port the server is listening on (after listen resolves). */
  port: number
}

/**
 * Build an HTTP MCP server exposing the given tool definitions.
 * Each route config becomes one MCP server at its own URL.
 */
export function buildMcpHttpServer(opts: McpHttpServerOptions): McpHttpServer {
  const routes = new Map<string, string>()

  // One transport per route. Each gets a session ID generator so concurrent
  // clients get isolated state. The transport handles JSON-RPC framing, SSE
  // chunking, and the MCP handshake.
  const transports = new Map<string, StreamableHTTPServerTransport>()

  for (const route of opts.routes) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })
    transports.set(route.path, transport)
    routes.set(route.path, route.name)

    const mcpServer = new McpServer({ name: route.name, version: route.version })

    for (const tool of route.tools) {
      // The MCP SDK's registerTool expects the input schema in its raw shape
      // (zod schemas). The tool definitions already expose a ZodRawShape, so we
      // pass it directly.
      mcpServer.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        async (args: Record<string, unknown>) => {
          // Each tool's handler has a stricter arg type, but at this boundary
          // we accept whatever the wire delivered. The cast is safe because
          // each tool's input schema is enforced upstream.
          const result = await (
            tool.handler as (a: Record<string, unknown>) => Promise<{
              content: Array<{ type: "text"; text: string }>
              isError?: boolean
            }>
          )(args)
          // MCP content shape: { content: [{ type: "text", text: "..." }], isError?: true }
          return {
            content: result.content,
            ...(result.isError ? { isError: true } : {}),
          }
        },
      )
    }

    // Connect (not awaited — we wire the request handler below).
    void mcpServer.connect(transport)
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    // Auth check (when configured). Matches brain-serve's authOk: requires
    // either `Authorization: Bearer <apiKey>` or `X-Api-Key: <apiKey>`. A
    // bare `Authorization: <apiKey>` (no Bearer) is rejected — divergence
    // here would let one transport's clients confuse the other.
    if (opts.apiKey) {
      const ok = authOk(req, opts.apiKey)
      if (!ok) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "unauthorized" }))
        return
      }
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const transport = transports.get(url.pathname)
    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not found", path: url.pathname }))
      return
    }

    try {
      await transport.handleRequest(req, res)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[mcp-http] transport error: ${msg}\n`)
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" })
      }
      res.end(JSON.stringify({ error: "internal error" }))
    }
  }

  const httpServer = createServer((req, res) => {
    // Health probe — handy for Fly readiness checks.
    if (req.url === "/healthz" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, routes: Array.from(routes.keys()) }))
      return
    }
    void handleRequest(req, res)
  })

  const port = opts.port

  return {
    httpServer,
    routes,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        // Close all transports first.
        let pending = transports.size
        if (pending === 0) {
          httpServer.close(() => resolve())
          return
        }
        for (const transport of transports.values()) {
          void transport.close().finally(() => {
            pending--
            if (pending === 0) httpServer.close(() => resolve())
          })
        }
      }),
  }
}

/**
 * Wait for the server to be listening on its port. Useful in tests.
 * Mutates `server.port` to the actual bound port (matters when the caller
 * passed port=0 to get a random free port).
 */
export function listenMcpHttpServer(server: McpHttpServer, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    server.httpServer.once("error", reject)
    server.httpServer.listen(server.port, host, () => {
      server.httpServer.off("error", reject)
      const addr = server.httpServer.address()
      if (addr && typeof addr === "object") {
        server.port = addr.port
      }
      resolve()
    })
  })
}
