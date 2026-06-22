/**
 * Postflight: enforce kody.config.json testRequirements on newly added files.
 * If any sibling test is missing, re-invoke the agent once with the gap as
 * feedback. After retry, re-check; remaining misses become ctx.data.coverageMisses.
 *
 * The retry agent call happens via the executor's cached invokeAgent closure,
 * which the executor stashes on ctx.data.__invokeAgent before running
 * postflight. (Yes, this is a controlled escape-hatch — the only postflight
 * script that re-invokes the agent.)
 */

import type { AgentResult } from "../agent.js"
import { checkCoverage, formatMissesForFeedback, getAddedFiles } from "../coverage.js"
import type { Context, PostflightScript } from "../agent-actions/types.js"
import { parseAgentResult } from "../prompt.js"

type Invoker = (prompt: string) => Promise<AgentResult>

export const checkCoverageWithRetry: PostflightScript = async (ctx) => {
  const reqs = (ctx.data.coverageRules as { pattern: string; requireSibling: string }[]) ?? []
  if (reqs.length === 0) {
    ctx.data.coverageMisses = []
    return
  }
  if (!ctx.data.agentDone) {
    ctx.data.coverageMisses = []
    return
  }

  const misses = checkCoverage(getAddedFiles(ctx.config.git.defaultBranch, ctx.cwd), reqs)
  if (misses.length === 0) {
    ctx.data.coverageMisses = []
    return
  }

  const invoker = ctx.data.__invokeAgent as Invoker | undefined
  const basePrompt = ctx.data.prompt as string | undefined
  if (!invoker || !basePrompt) {
    ctx.data.coverageMisses = misses
    return
  }

  process.stderr.write(`[kody] coverage check found ${misses.length} missing test(s); retrying agent once\n`)
  const retryPrompt = `${basePrompt}\n\n# Coverage failure (retry)\n${formatMissesForFeedback(misses)}`
  let retry: AgentResult
  try {
    retry = await invoker(retryPrompt)
  } catch (err) {
    // The retry agent threw (model 5xx, MCP crash, auth, etc.). Preserve the
    // KNOWN gaps so downstream ensurePr opens a DRAFT PR flagged with the
    // missing tests instead of silently shipping a non-draft PR — without
    // this, coverageMisses would stay unset and the gate would read "no
    // misses". Best-effort: the agent crash is logged, the draft signal kept.
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[kody] coverage retry agent failed (${msg}); keeping ${misses.length} miss(es) — PR will draft\n`,
    )
    ctx.data.coverageMisses = misses
    return
  }
  const retryParsed = parseAgentResult(retry.finalText)
  if (retry.outcome === "completed" && retryParsed.done) {
    ctx.data.agentDone = true
    ctx.data.commitMessage = retryParsed.commitMessage || (ctx.data.commitMessage as string)
    ctx.data.prSummary = retryParsed.prSummary || (ctx.data.prSummary as string)
  }
  const finalMisses = checkCoverage(getAddedFiles(ctx.config.git.defaultBranch, ctx.cwd), reqs)
  ctx.data.coverageMisses = finalMisses
}

/** Type-only export for callers who want to construct the invoker. */
export type CoverageInvoker = (ctx: Context) => Invoker
