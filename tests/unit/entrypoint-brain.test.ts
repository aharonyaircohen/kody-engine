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
    expect(entrypoint).toContain("/mcp/capability")
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

  it("pre-warms LiteLLM from KODY_MODEL_CONFIG when Dashboard supplies one", () => {
    expect(entrypoint).toContain("KODY_MODEL_CONFIG")
    expect(entrypoint).toContain("modelName")
    expect(entrypoint).toContain("modelSpec")
    expect(entrypoint).toContain("modelGroup")
    expect(entrypoint).toContain("apiKeyEnvVar")
    expect(entrypoint).toContain("api_base")
    expect(entrypoint).toMatch(/modelGroup="\$modelSpec"|modelGroup="\$[{]modelSpec[}]"/)
    expect(entrypoint).toMatch(/protocol.*openai|openai.*protocol/s)
  })

  it("pre-warms LiteLLM with the exact MODEL fallback when Dashboard model config is absent", () => {
    expect(entrypoint).toMatch(/modelProvider="\$[{]MODEL%%\/[*][}]"/)
    expect(entrypoint).toMatch(/modelNameFromSpec="\$[{]MODEL#[*]\/[}]"/)
    expect(entrypoint).toMatch(/model_name: "\$[{]modelNameFromSpec[}]"/)
    expect(entrypoint).toMatch(/model: "\$[{]modelProvider[}]\/\$[{]modelNameFromSpec[}]"/)
  })

  it("restores Claude Code subscription auth from the encrypted vault bundle", () => {
    expect(entrypoint).toContain("CLAUDE_CODE_AUTH_B64")
    expect(entrypoint).toContain("restore_claude_code_auth")
    expect(entrypoint).toContain(".claude/.credentials.json")
    expect(entrypoint).toContain(".claude.json")
    expect(entrypoint).toMatch(/tar -tzf "\$archive"/)
    expect(entrypoint).toMatch(/tar -xzf "\$archive" -C "\$extract"/)
    expect(entrypoint).toMatch(/cp "\$extract\/\.claude\/\.credentials\.json" \/root\/\.claude\/\.credentials\.json/)
    expect(entrypoint).toContain("unset ANTHROPIC_API_KEY")
    expect(entrypoint).toContain("unset ANTHROPIC_AUTH_TOKEN")
    expect(entrypoint).toContain("CLAUDE_CODE_AUTH_ALLOW_ANTHROPIC_ENV")
  })

  it("rejects unexpected paths in the Claude Code auth archive", () => {
    expect(entrypoint).toMatch(/unsupported path/)
    expect(entrypoint).toMatch(/unsafe path/)
    expect(entrypoint).toMatch(/may contain only files and directories/)
    expect(entrypoint).toContain("*..*|*\\\\*)")
  })
})
