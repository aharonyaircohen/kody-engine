/**
 * Preflight: resolve the URL `qa-engineer` will browse, in priority order.
 *
 *   1. ctx.args.url            — explicit --url
 *   2. ctx.args.goal           — look up the latest GitHub Deployment for
 *                                ref `goal-<id>` and use its environment_url
 *                                (Vercel's default behavior posts one per
 *                                push). Try the latest few deployments to
 *                                tolerate in-progress deploys with no URL
 *                                yet.
 *   3. process.env.PREVIEW_URL — env-injected URL (CI secret pattern)
 *   4. QA_URL variable         — `variables.json` key QA_URL in the state repo,
 *                                a per-repo stable dev URL managed via the dashboard.
 *   5. error                   — fail fast; the alternative is browsing a
 *                                non-existent host and emitting a useless
 *                                "page unreachable" report.
 *
 * Populates:
 *   ctx.data.previewUrl       — string, the resolved URL (template token)
 *   ctx.data.previewUrlSource — string, where it came from (for the prompt)
 */
import { execFileSync } from "node:child_process"
import type { PreflightScript } from "../agent-actions/types.js"
import { readKodyVariables } from "./kodyVariables.js"

interface DeploymentRow {
  id: number
  ref?: string
  environment?: string
  created_at?: string
}

interface DeploymentStatus {
  state?: string
  environment_url?: string
  target_url?: string
}

function ghQuery<T>(args: string[], cwd: string): T | null {
  try {
    const out = execFileSync("gh", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 15_000,
    }).trim()
    if (!out) return null
    return JSON.parse(out) as T
  } catch {
    return null
  }
}

/**
 * Look up the most recently successful deployment URL for `goal-<id>` ref.
 * Returns null if no deployment exists, no successful status was found, or
 * the gh CLI errored. Best-effort — a missing URL just falls through to the
 * next resolution step.
 */
function lookupGoalDeploymentUrl(goalId: string, owner: string, repo: string, cwd: string): string | null {
  const ref = `goal-${goalId}`
  // List up to 5 latest deployments for this ref (Vercel preview branch).
  // We want the most recent one whose status reached `success`. Older
  // deployments drift quickly so we only check the top few.
  const deployments = ghQuery<DeploymentRow[]>(
    ["api", `repos/${owner}/${repo}/deployments?ref=${encodeURIComponent(ref)}&per_page=5`],
    cwd,
  )
  if (!deployments || deployments.length === 0) return null

  for (const d of deployments) {
    const statuses = ghQuery<DeploymentStatus[]>(
      ["api", `repos/${owner}/${repo}/deployments/${d.id}/statuses?per_page=10`],
      cwd,
    )
    if (!statuses || statuses.length === 0) continue
    // Find the most recent success status (the array is ordered newest-first).
    const success = statuses.find((s) => s.state === "success")
    if (!success) continue
    const url = success.environment_url || success.target_url
    if (typeof url === "string" && /^https?:\/\//.test(url)) return url
  }
  return null
}

export const resolveQaUrl: PreflightScript = async (ctx) => {
  const explicit = (ctx.args.url as string | undefined)?.trim()
  if (explicit && explicit.length > 0) {
    ctx.data.previewUrl = explicit
    ctx.data.previewUrlSource = "--url flag"
    return
  }

  const goal = (ctx.args.goal as string | undefined)?.trim()
  if (goal && goal.length > 0) {
    const url = lookupGoalDeploymentUrl(goal, ctx.config.github.owner, ctx.config.github.repo, ctx.cwd)
    if (url) {
      ctx.data.previewUrl = url
      ctx.data.previewUrlSource = `goal-${goal} latest Vercel deployment`
      return
    }
    // Fall through — the goal might not have shipped yet, try other sources.
    process.stderr.write(
      `[resolveQaUrl] no successful deployment found for ref goal-${goal}; falling back to env/config\n`,
    )
  }

  const envUrl = process.env.PREVIEW_URL?.trim()
  if (envUrl && envUrl.length > 0) {
    ctx.data.previewUrl = envUrl
    ctx.data.previewUrlSource = "$PREVIEW_URL env var"
    return
  }

  const fallback = readKodyVariables(ctx.cwd).QA_URL?.trim()
  if (fallback && fallback.length > 0) {
    ctx.data.previewUrl = fallback
    ctx.data.previewUrlSource = "QA_URL variable (state repo variables.json)"
    return
  }

  throw new Error(
    "qa-engineer: no URL resolved. Pass --url, set --goal <id> on a goal that has a Vercel preview, " +
      "set $PREVIEW_URL, or set the QA_URL variable in the state repo variables.json.",
  )
}

// Exported for unit testing the deployment-lookup branch in isolation. The
// preflight itself is end-to-end; callers shouldn't reach for this directly.
export const __testing = { lookupGoalDeploymentUrl }
