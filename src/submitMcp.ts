/**
 * In-process MCP server exposing a `submit_state` tool to the agent.
 *
 * Why this exists: a agent-responsibility-tick agent must persist its decision as a state
 * envelope. The legacy contract asked the model to END its reply with a
 * fenced `kody-job-next-state` JSON block — which long/complex agentResponsibilities (e.g.
 * approval-gate) routinely forgot, so the tick failed "agent did not emit a
 * fenced block" and the agentResponsibility never did its work. A structured tool the model
 * CALLS is far more reliable than a trailing-text convention it must remember.
 *
 * The agent calls `submit_state({ cursor, data, done })` once when done; the
 * handler captures the payload into a per-invocation closure that `runAgent`
 * reads back as `AgentResult.submittedState`. The fenced-block path is kept as
 * a fallback (see parseJobStateFromAgentResult) so this is purely additive —
 * a agentResponsibility that still emits the block, or a model that ignores the tool, behaves
 * exactly as before.
 *
 * Built per-runAgent invocation (not module-level) so each call binds its own
 * capture slot. Uses `createSdkMcpServer` (in-process) — no subprocess.
 *
 * Transport: tool definitions are extracted into `submitStateToolDefinition` so
 * the same handler powers both the in-process MCP server (via claude-agent-sdk)
 * and the HTTP MCP server (via @modelcontextprotocol/sdk).
 */

import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import type { ZodRawShape } from "zod"
import { z } from "zod"

/** The state an agent submits — same shape the fenced block carried. */
export interface SubmittedState {
  cursor: string
  data: Record<string, unknown>
  done: boolean
}

export interface SubmitToolHandle {
  /** Config object to drop into `mcpServers["kody-submit"]`. */
  server: McpSdkServerConfigWithInstance
  /** The last submitted state, or undefined if the tool was never called. */
  getSubmitted: () => SubmittedState | undefined
}

export interface SubmitStateToolDefinition {
  name: "submit_state"
  description: string
  inputSchema: ZodRawShape
  handler: (args: SubmittedState) => Promise<{
    content: Array<{ type: "text"; text: string }>
    isError?: boolean
  }>
}

const DESCRIPTION =
  "Persist this tick's next state. Call this EXACTLY ONCE, at the very end, when you've finished your work — it is the ONLY way your decision is saved. Pass your next `cursor` (string), your next `data` (object — carry prior data forward and mutate what you acted on), and `done` (boolean). After calling it you are finished; do not take further actions."

const INPUT_SCHEMA: ZodRawShape = {
  cursor: z.string().describe('The next cursor value (e.g. "idle"). Must be a non-empty string.'),
  data: z
    .record(z.string(), z.unknown())
    .describe("The next `data` object. Carry forward prior data and mutate only what you acted on this tick."),
  done: z.boolean().describe("true only if this agentResponsibility is permanently finished; evergreen agentResponsibilities stay false."),
}

/**
 * Build the tool definition (transport-agnostic). Used by both adapters.
 */
export function submitStateToolDefinition(handle: {
  setSubmitted: (state: SubmittedState) => void
}): SubmitStateToolDefinition {
  return {
    name: "submit_state",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    handler: async (args) => {
      handle.setSubmitted({
        cursor: String(args.cursor ?? ""),
        data: (args.data ?? {}) as Record<string, unknown>,
        done: Boolean(args.done),
      })
      return {
        content: [
          {
            type: "text",
            text: "State recorded. You are done for this tick — no further action needed.",
          },
        ],
      }
    },
  }
}

/**
 * Build an in-process MCP server with one tool: `submit_state`. The returned
 * `getSubmitted()` yields whatever the agent last submitted (last call wins).
 */
export function buildSubmitMcpServer(): SubmitToolHandle {
  let submitted: SubmittedState | undefined

  const handle = {
    setSubmitted: (state: SubmittedState) => {
      submitted = state
    },
    getSubmitted: () => submitted,
  }

  const def = submitStateToolDefinition(handle)
  const submitTool = tool(def.name, def.description, def.inputSchema as Parameters<typeof tool>[2], async (args) => {
    return def.handler({
      cursor: String(args.cursor ?? ""),
      data: (args.data ?? {}) as Record<string, unknown>,
      done: Boolean(args.done),
    })
  })

  const server = createSdkMcpServer({
    name: "kody-submit",
    version: "0.1.0",
    tools: [submitTool],
  })

  return { server, getSubmitted: handle.getSubmitted }
}
