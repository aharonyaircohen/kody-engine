/**
 * Preflight: load a folder-agentResponsibility's persistent memory store by slug
 * (= `profile.name`). This is the state-only half of `loadJobFromFile`: a
 * folder-agentResponsibility's body lives in `agent-responsibility.md` (rendered by `composePrompt`) and its
 * identity in `profile.agent` (injected by the executor), so the only thing a
 * stateful agentResponsibility needs loaded here is its cross-run state. It makes "scheduled ⇒
 * stateful" real: a scheduled folder-agentResponsibility that declares this preflight (plus
 * `parseJobStateFromAgentResult` + `writeJobStateFile` postflights) carries
 * memory between runs, exactly like a markdown agentResponsibility did under `agent-responsibility-tick`.
 *
 * Sets:
 *   ctx.data.jobSlug       the slug (profile.name) — legacy token
 *   ctx.data.jobState      LoadedJobState (path/handle/state) — writeJobStateFile reads this
 *   ctx.data.jobStateJson  rendered prior state, for the prompt's {{jobStateJson}} token
 *
 *   ctx.data.agentResponsibilitySlug       alias of jobSlug
 *   ctx.data.agentResponsibilityTitle      profile.describe
 *   ctx.data.agentActionSlug profile.agentAction ?? profile.name
 *   ctx.data.agentSlug      profile.agent ?? ""
 *   ctx.data.agentResponsibilitySchedule   runtime job schedule when supplied, otherwise empty
 *
 * Stateless agentResponsibilities simply omit this preflight (and the state postflights) and
 * run with no memory — the same one agentResponsibility shape, statefulness opted in by config.
 */

import type { PreflightScript } from "../agent-actions/types.js"
import { AGENT_RESPONSIBILITY_MCP_TOOL_NAMES } from "../agent-responsibilityMcp.js"
import { resolveBackend } from "./jobState/index.js"

const AGENT_RESPONSIBILITY_TOOL_PALETTE: ReadonlySet<string> = new Set(AGENT_RESPONSIBILITY_MCP_TOOL_NAMES)

export const loadAgentResponsibilityState: PreflightScript = async (ctx, profile, args) => {
  const jobsDir = String(args?.jobsDir ?? ".kody/agent-responsibilities")
  const slug = profile.name
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  if (backend.hydrate) await backend.hydrate()
  const loaded = await backend.load(slug)
  ctx.data.jobSlug = slug
  ctx.data.jobState = loaded
  ctx.data.jobStateJson = JSON.stringify(loaded.state, null, 2)

  // AgentResponsibility-noun aliases. A folder-agentResponsibility's body is the profile's own `agent-responsibility.md`
  // (rendered by composePrompt via the `{{jobIntent}}` / new `{{dutyIntent}}`
  // token path is not relevant here — the folder agentResponsibility's body comes from the
  // resolved agentAction, not the agentResponsibility). It still has a slug, a title (the
  // profile.describe), and a (resolved) agentAction slug — all required for the
  // `{{agentResponsibilityReference}}` block.
  ctx.data.agentResponsibilitySlug = slug
  ctx.data.agentResponsibilityTitle = profile.describe
  ctx.data.agentActionSlug = profile.agentAction ?? profile.name
  ctx.data.agentSlug = profile.agent ?? ""
  ctx.data.agentTitle = ""
  // Runtime cadence comes from the scheduled job/goal/loop, not the responsibility profile.
  ctx.data.agentResponsibilitySchedule = String(ctx.data.jobSchedule ?? "")

  // Mentions → "@a @b" for the {{mentions}} prompt token + the agentResponsibility-MCP
  // operator mention (mirrors loadJobFromFile).
  const mentions = (profile.mentions ?? []).map((l) => `@${l}`).join(" ")
  ctx.data.mentions = mentions

  // Locked-toolbox: a non-empty agentResponsibilityTools palette flips the executor's
  // enableAgentResponsibilityTool, so the agent runs against the in-process kody-agentResponsibility MCP
  // server. agentResponsibilityToolsList feeds a prompt token; agentResponsibilityOperatorMention feeds the
  // MCP server's operator handle.
  const declaredTools = profile.agentResponsibilityTools ?? []
  if (declaredTools.length > 0) {
    const unknown = declaredTools.filter((name) => !AGENT_RESPONSIBILITY_TOOL_PALETTE.has(name))
    if (unknown.length > 0) {
      throw new Error(
        `loadAgentResponsibilityState: agentResponsibility '${slug}' declared agentResponsibilityTools not in the kody-agentResponsibility palette: ${unknown.join(", ")}. ` +
          `Available: ${[...AGENT_RESPONSIBILITY_MCP_TOOL_NAMES].join(", ")}`,
      )
    }
    ctx.data.agentResponsibilityTools = declaredTools
    ctx.data.agentResponsibilityToolsList = declaredTools.map((name) => `- \`${name}\``).join("\n")
    ctx.data.agentResponsibilityOperatorMention = mentions
    // Lock the toolbox: rewrite allowedTools to the agentResponsibility MCP palette (+ submit),
    // revoking Bash/Read — mirrors loadJobFromFile. Without this the SDK blocks
    // the mcp__kody-agentResponsibility__* calls for permission and the agent stalls.
    const mcpToolNames = declaredTools.map((name) => `mcp__kody-agentResponsibility__${name}`)
    profile.claudeCode.tools = [...mcpToolNames, "mcp__kody-submit__submit_state"]
    // The submit tool is in the allowed list, so its MCP server MUST exist —
    // the executor only spins it up when enableSubmitTool is true. Force it on
    // (a locked agentResponsibility persists state via submit_state). Without this the model is
    // offered a tool that doesn't exist and stalls.
    profile.claudeCode.enableSubmitTool = true
  }
}
