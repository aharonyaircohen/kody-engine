/**
 * Sanity test for the Hermes config produced by entrypoint-brain.sh.
 *
 * This test extracts the heredoc that the entrypoint writes to
 * ~/.hermes/config.yaml, and verifies two things:
 *   1. The MCP servers key is `mcp_servers` (snake_case), NOT `mcpServers`
 *      (camelCase). Hermes silently ignores the wrong key.
 *   2. Each MCP server has the `headers:` block with Authorization.
 *
 * If the entrypoint regresses on these, the test catches it.
 */

import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const ENTRYPOINT_PATH = path.resolve(import.meta.dirname, "../../runner/entrypoint-brain.sh")

describe("entrypoint-brain.sh: Hermes config sanity", () => {
  const entrypoint = readFileSync(ENTRYPOINT_PATH, "utf-8")

  it("uses `mcp_servers:` (snake_case) — Hermes reads this, ignores `mcpServers`", () => {
    // The heredoc that writes the config MUST use the snake_case key.
    // If it regresses to mcpServers, MCP tools won't load silently.
    expect(entrypoint).toMatch(/^\s*mcp_servers:/m)
    expect(entrypoint).not.toMatch(/^\s*mcpServers:/m)
  })

  it("emits all 4 kody MCP server routes", () => {
    expect(entrypoint).toContain("/mcp/fetch-repo")
    expect(entrypoint).toContain("/mcp/verify")
    expect(entrypoint).toContain("/mcp/submit-state")
    expect(entrypoint).toContain("/mcp/agentResponsibility")
  })

  it("sends the Authorization header to kody's MCP server (which requires it)", () => {
    // The kody MCP server enforces apiKey. Without an Authorization
    // header in the MCP config, Hermes gets 401 on every request.
    expect(entrypoint).toMatch(/Authorization:.*\$\{BRAIN_API_KEY\}/)
  })

  it("waits for the kody MCP HTTP server's /healthz before declaring Hermes ready", () => {
    // The MCP server is started in the background right before Hermes. If
    // Hermes boots and starts connecting to MCP before the kody MCP server
    // has bound its port, the first tool call fails. The script must poll
    // the kody MCP server's /healthz as part of the same readiness loop it
    // already uses for Hermes's /health. Without this, the first chat
    // message in a fresh Hermes-mode machine can lose its MCP tools.
    expect(entrypoint).toMatch(/MCP_PORT.*healthz|healthz.*MCP_PORT/s)
  })
})
