/**
 * Preflight: load a folder-duty's persistent memory store by slug
 * (= `profile.name`). This is the state-only half of `loadJobFromFile`: a
 * folder-duty's body lives in `prompt.md` (rendered by `composePrompt`) and its
 * identity in `profile.staff` (injected by the executor), so the only thing a
 * stateful duty needs loaded here is its cross-run state. It makes "scheduled ⇒
 * stateful" real: a scheduled folder-duty that declares this preflight (plus
 * `parseJobStateFromAgentResult` + `writeJobStateFile` postflights) carries
 * memory between runs, exactly like a markdown duty did under `job-tick`.
 *
 * Sets:
 *   ctx.data.jobSlug       the slug (profile.name)
 *   ctx.data.jobState      LoadedJobState (path/handle/state) — writeJobStateFile reads this
 *   ctx.data.jobStateJson  rendered prior state, for the prompt's {{jobStateJson}} token
 *
 * Stateless duties simply omit this preflight (and the state postflights) and
 * run with no memory — the same one duty shape, statefulness opted in by config.
 */

import type { PreflightScript } from "../executables/types.js"
import { resolveBackend } from "./jobState/index.js"

export const loadDutyState: PreflightScript = async (ctx, profile, args) => {
  const jobsDir = String(args?.jobsDir ?? ".kody/duties")
  const slug = profile.name
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  if (backend.hydrate) await backend.hydrate()
  const loaded = await backend.load(slug)
  ctx.data.jobSlug = slug
  ctx.data.jobState = loaded
  ctx.data.jobStateJson = JSON.stringify(loaded.state, null, 2)

  // Mentions → "@a @b" for the {{mentions}} prompt token + the duty-MCP
  // operator mention (mirrors loadJobFromFile).
  const mentions = (profile.mentions ?? []).map((l) => `@${l}`).join(" ")
  ctx.data.mentions = mentions

  // Locked-toolbox: a non-empty dutyTools palette flips the executor's
  // enableDutyTool, so the agent runs against the in-process kody-duty MCP
  // server. dutyToolsList feeds a prompt token; dutyOperatorMention feeds the
  // MCP server's operator handle.
  const declaredTools = profile.dutyTools ?? []
  if (declaredTools.length > 0) {
    ctx.data.dutyTools = declaredTools
    ctx.data.dutyToolsList = declaredTools.map((name) => `- \`${name}\``).join("\n")
    ctx.data.dutyOperatorMention = mentions
  }
}
