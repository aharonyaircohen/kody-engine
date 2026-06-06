/**
 * In-process MCP server exposing a `fetch_repo` tool to the chat agent.
 *
 * Why this exists: a repo-less Brain serves many repos, but the agent is
 * otherwise scoped to the one repo handed to it for the current message. When
 * the user asks about a *different* repo, the agent had no way to pull it in —
 * it would just say "I'm scoped to this repo." This tool lets the agent clone
 * any repo it has access to into the shared workspace and then read/work on it
 * with its normal Read/Grep/Bash tools (granted via `additionalDirectories`).
 *
 * Built per-runAgent invocation so it binds the caller's reposRoot + token.
 * Clones are deduped + reused across the machine (see repoWorkspace.ts), so a
 * second fetch of the same repo returns instantly.
 *
 * Transport: tool definitions are extracted into `fetchRepoToolDefinition` so
 * the same handler powers both the in-process MCP server (via claude-agent-sdk)
 * and the HTTP MCP server (via @modelcontextprotocol/sdk). The HTTP server is
 * what Hermes connects to as an MCP client.
 */

import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import type { ZodRawShape } from "zod"
import { z } from "zod"

import { fetchRepo } from "./repoWorkspace.js"

export interface FetchRepoToolOptions {
  /** Root the repo is cloned under (`<reposRoot>/<owner>/<name>`). */
  reposRoot: string
  /** GitHub token used to clone private repos (the user's PAT). */
  repoToken?: string
}

/**
 * Transport-agnostic tool definition. Both the in-process and HTTP adapters
 * consume this shape — the handler logic is the same regardless of transport.
 */
export interface FetchRepoToolDefinition {
  name: "fetch_repo"
  description: string
  inputSchema: ZodRawShape
  handler: (args: { repo: string }) => Promise<{
    content: Array<{ type: "text"; text: string }>
    isError?: boolean
  }>
}

const DESCRIPTION =
  'Clone another GitHub repository into your workspace so you can read and work on it. Pass `repo` as "owner/name" (e.g. "A-Guy-educ/A-Guy"). Returns the absolute path of the clone — then use your Read/Grep/Glob/Bash tools at that path to inspect it. Already-fetched repos are reused instantly. Use this whenever the user asks about a repository other than your current one — you are NOT limited to a single repo.'

const INPUT_SCHEMA: ZodRawShape = {
  repo: z.string().describe('GitHub repository as "owner/name", e.g. "A-Guy-educ/A-Guy".'),
}

/**
 * Build the tool definition (transport-agnostic). Used by both adapters.
 */
export function fetchRepoToolDefinition(opts: FetchRepoToolOptions): FetchRepoToolDefinition {
  return {
    name: "fetch_repo",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    handler: async (args) => {
      const repo = String(args.repo ?? "").trim()
      try {
        const dir = await fetchRepo({
          reposRoot: opts.reposRoot,
          repo,
          repoToken: opts.repoToken,
        })
        return {
          content: [
            {
              type: "text",
              text: `Cloned ${repo} → ${dir}\nUse Read/Grep/Glob/Bash at that absolute path to explore it. It now lives in your workspace alongside any other repos you've fetched.`,
            },
          ],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `Could not fetch ${repo}: ${msg}` }],
          isError: true,
        }
      }
    },
  }
}

/**
 * Build an in-process MCP server with one tool: `fetch_repo`. Drop the result
 * into `mcpServers["kody-fetch-repo"]` and grant the agent read access to
 * `reposRoot` via `additionalDirectories`.
 */
export function buildFetchRepoMcpServer(opts: FetchRepoToolOptions): McpSdkServerConfigWithInstance {
  const def = fetchRepoToolDefinition(opts)
  const fetchTool = tool(def.name, def.description, def.inputSchema, async (args) => {
    return def.handler({ repo: String(args.repo ?? "") })
  })

  return createSdkMcpServer({
    name: "kody-fetch-repo",
    version: "0.1.0",
    tools: [fetchTool],
  })
}
