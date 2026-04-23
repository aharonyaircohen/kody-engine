/**
 * Flow script for the `fix-ci` executable.
 * Loads PR, checks it out, fetches the failing workflow run + log tail.
 */

import { checkoutPrBranch, getCurrentBranch } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"
import { getRunUrl } from "../gha.js"
import { getPr, getPrDiff, postPrReviewComment } from "../issue.js"
import { getFailedRunLogTail, pickFailedRunForFixCi } from "../workflow.js"

const LOG_MAX_BYTES = 30_000
const RUN_LOOKBACK = 20

export const fixCiFlow: PreflightScript = async (ctx) => {
  const prNumber = ctx.args.pr as number
  const pr = getPr(prNumber, ctx.cwd)
  if (pr.state !== "OPEN") {
    bail(ctx, prNumber, `PR #${prNumber} is not OPEN (state: ${pr.state})`)
    return
  }
  ctx.data.pr = pr
  ctx.data.commentTargetType = "pr"
  ctx.data.commentTargetNumber = prNumber

  checkoutPrBranch(prNumber, ctx.cwd)
  ctx.data.branch = getCurrentBranch(ctx.cwd)

  const explicitRunId = ctx.args.runId as string | undefined

  let runId: string
  let workflowName = ""
  let failedRunUrl = ""
  let logTail = ""

  if (explicitRunId) {
    runId = explicitRunId
    logTail = getFailedRunLogTail(runId, LOG_MAX_BYTES, ctx.cwd)
    if (!logTail) {
      bail(
        ctx,
        prNumber,
        `failed to fetch log tail for run ${runId} (logs may be expired, the run may have no failed steps, or the run belongs to a workflow whose logs aren't accessible)`,
      )
      return
    }
  } else {
    const picked = pickFailedRunForFixCi(prNumber, LOG_MAX_BYTES, RUN_LOOKBACK, ctx.cwd)
    if (!picked) {
      bail(
        ctx,
        prNumber,
        `no actionable failed workflow run found on PR #${prNumber}'s branch (looked at last ${RUN_LOOKBACK} failed runs — all were either kody's own dispatch workflow or had no fetchable logs; pass --run-id to target a specific run)`,
      )
      return
    }
    runId = picked.run.id
    workflowName = picked.run.workflowName
    failedRunUrl = picked.run.url
    logTail = picked.logTail
  }

  ctx.data.failedRunId = runId
  ctx.data.failedWorkflowName = workflowName
  ctx.data.failedRunUrl = failedRunUrl
  ctx.data.failedLogTail = logTail
  ctx.data.prDiff = getPrDiff(prNumber, ctx.cwd)

  const runUrl = getRunUrl()
  const runSuffix = runUrl ? `, kody run ${runUrl}` : ""
  tryPostPr(
    prNumber,
    `⚙️ kody fix-ci started on \`${ctx.data.branch}\`${runSuffix} — analyzing workflow run ${runId}`,
    ctx.cwd,
  )
}

function bail(ctx: Parameters<PreflightScript>[0], prNumber: number, reason: string): void {
  ctx.output.exitCode = 1
  ctx.output.reason = reason
  ctx.skipAgent = true
  const runUrl = getRunUrl()
  const runSuffix = runUrl ? ` ([logs](${runUrl}))` : ""
  tryPostPr(prNumber, `❌ kody fix-ci could not run${runSuffix}: ${reason}`, ctx.cwd)
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try {
    postPrReviewComment(prNumber, body, cwd)
  } catch {
    /* best effort */
  }
}
