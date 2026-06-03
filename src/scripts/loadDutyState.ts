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
}
