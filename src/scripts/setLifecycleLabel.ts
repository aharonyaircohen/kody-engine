/**
 * Preflight: set a kody-owned label on the target issue/PR. Each profile
 * declares its own label inline via `with`, so this script knows nothing
 * about the set of valid labels — it just applies what the profile told
 * it to.
 *
 * Example profile entry:
 *   {
 *     "script": "setLifecycleLabel",
 *     "with": {
 *       "label": "kody:running",
 *       "color": "fbca04",
 *       "description": "kody2: implementing the change"
 *     }
 *   }
 *
 * Best-effort — labeling never blocks the flow. Reads the target number
 * from `ctx.args.issue` (preferred) or `ctx.args.pr`. PRs and issues
 * share the GitHub number space, so `gh issue edit` works for both.
 */

import type { PreflightScript } from "../executables/types.js"
import { KODY_LABEL_PREFIX, setKodyLabel } from "../lifecycleLabels.js"

export const setLifecycleLabel: PreflightScript = async (ctx, _profile, args) => {
  const label = args?.label
  if (typeof label !== "string" || !label.startsWith(KODY_LABEL_PREFIX)) {
    process.stderr.write(
      `[kody2] setLifecycleLabel: missing or invalid "label" arg (must start with "${KODY_LABEL_PREFIX}"): ${String(label)}\n`,
    )
    return
  }

  const issueNumber = resolveTargetNumber(ctx.args)
  if (issueNumber === undefined) return

  setKodyLabel(
    issueNumber,
    {
      label,
      color: typeof args?.color === "string" ? args.color : undefined,
      description: typeof args?.description === "string" ? args.description : undefined,
    },
    ctx.cwd,
  )
}

function resolveTargetNumber(args: Record<string, unknown>): number | undefined {
  const issue = args.issue
  if (typeof issue === "number" && Number.isFinite(issue)) return issue
  const pr = args.pr
  if (typeof pr === "number" && Number.isFinite(pr)) return pr
  return undefined
}
