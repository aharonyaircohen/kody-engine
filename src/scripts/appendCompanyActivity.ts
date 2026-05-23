/**
 * Postflight: append a Company-Activity record after a duty tick.
 *
 * This is the engine-authored "what the company did" feed the dashboard
 * surfaces — a named, attributed action rather than a raw commit/PR. Every
 * `job-tick` (scheduled OR manual "Run now") passes through here, so each one
 * records WHO ran WHAT, WHY, and the RESULT:
 *
 *   { ts, action, duty, dutyTitle, staff, staffTitle, trigger, outcome,
 *     durationMs, runUrl }
 *
 * Appended as one JSON line to `.kody/activity/<YYYY-MM-DD>.jsonl` via the
 * GitHub Contents API (read blob → append → PUT), committed to the dedicated
 * `kody-state` branch (NOT the default branch — this fires on every tick) so
 * the dashboard can read it with no shared state. Best-effort: any failure is
 * logged and swallowed — activity logging must never fail a duty run.
 */
import type { PostflightScript } from "../executables/types.js"
import { gh } from "../issue.js"
import { getRunUrl } from "../gha.js"
import { STATE_BRANCH, ensureStateBranch } from "../stateBranch.js"

interface ActivityRecord {
  ts: string
  action: string
  duty: string
  dutyTitle: string | null
  staff: string | null
  staffTitle: string | null
  trigger: "schedule" | "manual" | "event"
  outcome: "completed" | "failed" | "unknown"
  durationMs: number | null
  runUrl: string | null
}

function resolveTrigger(force: boolean): ActivityRecord["trigger"] {
  const event = process.env.GITHUB_EVENT_NAME ?? ""
  if (event === "schedule") return "schedule"
  if (force || event === "issue_comment" || event === "workflow_dispatch")
    return "manual"
  return "event"
}

function appendLine(
  owner: string,
  repo: string,
  cwd: string,
  record: ActivityRecord,
): void {
  const filePath = `.kody/activity/${record.ts.slice(0, 10)}.jsonl`
  let existing = ""
  let sha: string | undefined

  try {
    const out = gh(["api", `/repos/${owner}/${repo}/contents/${filePath}?ref=${STATE_BRANCH}`], { cwd })
    const json = JSON.parse(out) as { content?: string; sha?: string }
    if (json.sha) sha = json.sha
    if (json.content) existing = Buffer.from(json.content, "base64").toString("utf-8")
  } catch {
    /* 404 — file (or state branch) doesn't exist yet; start fresh */
  }

  const body = `${existing}${JSON.stringify(record)}\n`
  const payload: Record<string, unknown> = {
    message: `chore(activity): ${record.action}`,
    content: Buffer.from(body, "utf-8").toString("base64"),
    // Keep this high-frequency feed off the default branch.
    branch: STATE_BRANCH,
  }
  if (sha) payload.sha = sha

  // The Contents API rejects a write to a branch that doesn't exist yet.
  ensureStateBranch(owner, repo, cwd)

  gh(
    ["api", "--method", "PUT", `/repos/${owner}/${repo}/contents/${filePath}`, "--input", "-"],
    { cwd, input: JSON.stringify(payload) },
  )
}

export const appendCompanyActivity: PostflightScript = async (ctx, _profile, agentResult) => {
  try {
    const owner = ctx.config?.github?.owner
    const repo = ctx.config?.github?.repo
    // `jobSlug` is set by loadJobFromFile (agent path); the scripted path
    // (runTickScript) doesn't, so fall back to the `--job` CLI arg, which
    // both paths always carry.
    const duty = String(ctx.data.jobSlug ?? ctx.args?.job ?? "").trim()
    if (!owner || !repo || !duty) return

    const dutyTitle = (ctx.data.jobTitle as string | undefined) ?? null
    const staff = (ctx.data.workerSlug as string | undefined) || null
    const staffTitle = (ctx.data.workerTitle as string | undefined) || null
    const force = ctx.args?.force === true

    const record: ActivityRecord = {
      ts: new Date().toISOString(),
      action: `Ran duty: ${dutyTitle ?? duty}`,
      duty,
      dutyTitle,
      staff,
      staffTitle,
      trigger: resolveTrigger(force),
      outcome: agentResult?.outcome ?? "unknown",
      durationMs: agentResult?.durationMs ?? null,
      runUrl: getRunUrl() || null,
    }

    appendLine(owner, repo, ctx.cwd, record)
  } catch (err) {
    process.stderr.write(
      `[activity] company-activity append failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
