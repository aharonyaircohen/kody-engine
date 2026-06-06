/**
 * bin/mcp-http-server.ts
 *
 * Standalone entry point for the HTTP MCP server. Boots the server and listens
 * forever. Configured entirely via env vars (no kody.config.json needed —
 * matches the "configless" model of brain-serve).
 *
 * Env:
 *   KODY_MCP_HTTP_PORT    — port to listen on (default: 8643)
 *   KODY_MCP_HTTP_HOST    — host to bind (default: 127.0.0.1)
 *   KODY_MCP_HTTP_KEY     — API key (X-Api-Key / Authorization: Bearer). If unset, server is open.
 *   KODY_MCP_REPOS_ROOT   — directory where fetch_repo clones land (default: /workspace/repos)
 *   GITHUB_TOKEN          — PAT used by fetch_repo to clone private repos
 *
 * Routes exposed:
 *   POST /mcp/fetch-repo       — clone a repo into KODY_MCP_REPOS_ROOT
 *   POST /mcp/verify           — run the project's quality gates
 *   POST /mcp/submit-state     — capture a duty's next state
 *   POST /mcp/duty             — duty primitives (list_prs_to_repair, sync_pr, …)
 *   GET  /healthz              — liveness check
 *
 * When invoked, this is what Hermes connects to as an MCP client.
 */

import { type KodyConfig, loadConfig } from "../config.js"
import { dutyToolDefinitions } from "../dutyMcp.js"
import { fetchRepoToolDefinition } from "../fetchRepoMcp.js"
import { buildMcpHttpServer, listenMcpHttpServer, type McpRouteConfig } from "../servers/mcpHttpServer.js"
import { submitStateToolDefinition } from "../submitMcp.js"
import { verifyToolDefinition } from "../verifyMcp.js"
import { getApiKey, getReposRoot, requireEnv } from "./_httpShared.js"

export async function mcpHttpServer(): Promise<number> {
  requireEnv(["GITHUB_TOKEN"], "mcp-http-server")

  const port = Number(process.env.KODY_MCP_HTTP_PORT ?? 8643)
  const host = process.env.KODY_MCP_HTTP_HOST ?? "127.0.0.1"
  const apiKey = getApiKey()
  const reposRoot = getReposRoot()
  const repoToken = process.env.GITHUB_TOKEN

  // Discover verify config from the consumer's kody.config.json (cwd).
  // The verify tool needs a full KodyConfig — try to load it; fall back to a
  // minimal stub if absent (e.g. in unit tests).
  const config = await loadConfigSafe()

  const routes: McpRouteConfig[] = [
    {
      path: "/mcp/fetch-repo",
      name: "kody-fetch-repo",
      version: "0.1.0",
      tools: [fetchRepoToolDefinition({ reposRoot, ...(repoToken ? { repoToken } : {}) })],
    },
    {
      path: "/mcp/verify",
      name: "kody-verify",
      version: "0.1.0",
      tools: [
        verifyToolDefinition({
          config,
          cwd: process.cwd(),
          executable: "mcp-http",
        }),
      ],
    },
    {
      path: "/mcp/submit-state",
      name: "kody-submit",
      version: "0.1.0",
      tools: [submitStateToolDefinition({ setSubmitted: () => {} })],
    },
    {
      path: "/mcp/duty",
      name: "kody-duty",
      version: "0.1.0",
      tools: dutyToolDefinitions({
        repoSlug: process.env.GITHUB_REPOSITORY ?? "owner/repo",
        operatorMention: process.env.OPERATOR_MENTION ?? "",
      }),
    },
  ]

  const server = buildMcpHttpServer({ port, host, ...(apiKey ? { apiKey } : {}), routes })
  await listenMcpHttpServer(server, host)

  process.stdout.write(
    `[mcp-http] listening on http://${host}:${port} (routes: ${routes.map((r) => r.path).join(", ")})\n`,
  )

  // Graceful shutdown.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      process.stdout.write(`[mcp-http] ${sig} — shutting down\n`)
      void server.stop().then(() => process.exit(0))
    })
  }

  // Block forever.
  await new Promise(() => {})
  return 0
}

async function loadConfigSafe(): Promise<KodyConfig> {
  try {
    return loadConfig(process.cwd())
  } catch {
    // No kody.config.json — return a minimal stub so the verify tool can be
    // called (it'll return an error when invoked, but the server boots).
    return {
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "unknown", repo: "unknown" },
      agent: { model: "claude/claude-sonnet-4" },
    }
  }
}
