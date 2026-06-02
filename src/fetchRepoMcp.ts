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
 */

import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import { fetchRepo } from "./repoWorkspace.js"

export interface FetchRepoToolOptions {
  /** Root the repo is cloned under (`<reposRoot>/<owner>/<name>`). */
  reposRoot: string
  /** GitHub token used to clone private repos (the user's PAT). */
  repoToken?: string
}

/**
 * Build an in-process MCP server with one tool: `fetch_repo`. Drop the result
 * into `mcpServers["kody-fetch-repo"]` and grant the agent read access to
 * `reposRoot` via `additionalDirectories`.
 */
export function buildFetchRepoMcpServer(opts: FetchRepoToolOptions): McpSdkServerConfigWithInstance {
  const fetchTool = tool(
    "fetch_repo",
    'Clone another GitHub repository into your workspace so you can read and work on it. Pass `repo` as "owner/name" (e.g. "A-Guy-educ/A-Guy"). Returns the absolute path of the clone — then use your Read/Grep/Glob/Bash tools at that path to inspect it. Already-fetched repos are reused instantly. Use this whenever the user asks about a repository other than your current one — you are NOT limited to a single repo.',
    {
      repo: z.string().describe('GitHub repository as "owner/name", e.g. "A-Guy-educ/A-Guy".'),
    },
    async (args) => {
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
  )

  return createSdkMcpServer({
    name: "kody-fetch-repo",
    version: "0.1.0",
    tools: [fetchTool],
  })
}
