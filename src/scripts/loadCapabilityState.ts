/**
 * Preflight: load a folder-capability's persistent memory store by slug
 * (= `profile.name`). This is the state-only half of `loadJobFromFile`: a
 * folder-capability's body lives in `capability.md` (rendered by `composePrompt`) and its
 * identity in `profile.agent` (injected by the executor), so the only thing a
 * stateful capability needs loaded here is its cross-run state. It makes "scheduled ⇒
 * stateful" real: a scheduled folder-capability that declares this preflight (plus
 * `parseJobStateFromAgentResult` + `writeJobStateFile` postflights) carries
 * memory between runs, exactly like a markdown capability did under `capability-tick`.
 *
 * Sets:
 *   ctx.data.jobSlug       the slug (profile.name) — legacy token
 *   ctx.data.jobState      LoadedJobState (path/handle/state) — writeJobStateFile reads this
 *   ctx.data.jobStateJson  rendered prior state, for the prompt's {{jobStateJson}} token
 *
 *   ctx.data.capabilitySlug       alias of jobSlug
 *   ctx.data.capabilityTitle      profile.describe
 *   ctx.data.implementationSlug profile.implementation ?? profile.name
 *   ctx.data.agentSlug      profile.agent ?? ""
 *   ctx.data.capabilitySchedule   runtime job schedule when supplied, otherwise empty
 *
 * Stateless capabilities simply omit this preflight (and the state postflights) and
 * run with no memory — the same one capability shape, statefulness opted in by config.
 */

import { CAPABILITY_MCP_TOOL_NAMES } from "../capabilityMcp.js"
import { capabilitiesRoot } from "../definition-paths.js"
import type { PreflightScript } from "../implementations/types.js"
import { resolveBackend } from "./jobState/index.js"

const CAPABILITY_TOOL_PALETTE: ReadonlySet<string> = new Set(CAPABILITY_MCP_TOOL_NAMES)

export const loadCapabilityState: PreflightScript = async (ctx, profile, args) => {
  const jobsDir = String(args?.jobsDir ?? capabilitiesRoot(ctx.cwd))
  const slug = profile.name
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  if (backend.hydrate) await backend.hydrate()
  const loaded = await backend.load(slug)
  ctx.data.jobSlug = slug
  ctx.data.jobState = loaded
  ctx.data.jobStateJson = JSON.stringify(loaded.state, null, 2)

  // Capability-noun aliases. A folder-capability's body is the profile's own `capability.md`
  // (rendered by composePrompt via the `{{jobIntent}}` / `{{capabilityIntent}}`
  // token path is not relevant here — the folder capability's body comes from the
  // resolved implementation, not the capability). It still has a slug, a title (the
  // profile.describe), and a resolved implementation slug — all required for the
  // `{{capabilityReference}}` block.
  ctx.data.capabilitySlug = slug
  ctx.data.capabilityTitle = profile.describe
  ctx.data.implementationSlug = profile.implementation ?? profile.name
  ctx.data.agentSlug = profile.agent ?? ""
  ctx.data.agentTitle = ""
  // Runtime cadence comes from the scheduled job/goal/loop, not the capability profile.
  ctx.data.capabilitySchedule = String(ctx.data.jobSchedule ?? "")

  // Mentions → "@a @b" for the {{mentions}} prompt token + the capability-MCP
  // operator mention (mirrors loadJobFromFile).
  const mentions = (profile.mentions ?? []).map((l) => `@${l}`).join(" ")
  ctx.data.mentions = mentions

  // Capability MCP tools: default `lock` mode replaces the normal toolbox; `append`
  // mode keeps the normal toolbox and adds the declared MCP tools. Append is for
  // coordinator capabilities that still need repo-state shell operations but must
  // use engine primitives for narrow side effects such as dispatch.
  const declaredTools = profile.capabilityTools ?? profile.capabilityTools ?? []
  if (declaredTools.length > 0) {
    const unknown = declaredTools.filter((name) => !CAPABILITY_TOOL_PALETTE.has(name))
    if (unknown.length > 0) {
      throw new Error(
        `loadCapabilityState: capability '${slug}' declared capabilityTools not in the kody-capability palette: ${unknown.join(", ")}. ` +
          `Available: ${[...CAPABILITY_MCP_TOOL_NAMES].join(", ")}`,
      )
    }
    const mode = profile.capabilityToolMode ?? "lock"
    ctx.data.capabilityTools = declaredTools
    ctx.data.capabilityToolMode = mode
    ctx.data.capabilityToolsList = declaredTools.map((name) => `- \`${name}\``).join("\n")
    ctx.data.capabilityOperatorMention = mentions
    const mcpToolNames = declaredTools.map((name) => `mcp__kody-capability__${name}`)
    // State submission is Engine-owned and required in both lock and append modes.
    const submitStateTool = "mcp__kody-submit__submit_state"
    profile.claudeCode.enableSubmitTool = true
    if (mode === "append") {
      profile.claudeCode.tools = [...new Set([...(profile.claudeCode.tools ?? []), ...mcpToolNames, submitStateTool])]
      return
    }
    // Lock the toolbox: rewrite allowedTools to the capability MCP palette (+ submit),
    // revoking Bash/Read — mirrors loadJobFromFile. Without this the SDK blocks
    // the mcp__kody-capability__* calls for permission and the agent stalls.
    profile.claudeCode.tools = [...mcpToolNames, submitStateTool]
  }
}
