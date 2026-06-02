/**
 * Postflight: run verify; on failure, give the agent ONE chance to fix the
 * underlying issue with the verify output as feedback, then re-verify.
 *
 * Drop-in replacement for the `verify` script — does everything `verify`
 * does (sets ctx.data.verifyOk / verifyReason / verifyRecovered, downgrades
 * `*_COMPLETED` → `*_FAILED` on failure) and adds a one-shot agent retry in
 * between. If the retry brings verify green, the previous `*_FAILED`
 * downgrade is unwound.
 *
 * The retry agent call happens via the executor's cached invokeAgent
 * closure, stashed on ctx.data.__invokeAgent — the same escape hatch
 * checkCoverageWithRetry uses. When the closure or original prompt is
 * unavailable (e.g. no-agent flows), this script behaves exactly like
 * `verify`.
 *
 * One retry only. Hallucinated types / undefined imports / missing
 * exports — the most common LLM mistakes that produce non-compiling code —
 * are usually fixed in a single follow-up with the compiler output in
 * hand. More retries rarely help and quickly chew budget.
 */

import type { AgentResult } from "../agent.js"
import type { Context, PostflightScript } from "../executables/types.js"
import { parseAgentResult } from "../prompt.js"
import type { Action } from "../state.js"
import { summarizeFailure, verifyAllWithRetry } from "../verify.js"

type Invoker = (prompt: string) => Promise<AgentResult>

async function runVerify(ctx: Context): Promise<void> {
  try {
    const result = await verifyAllWithRetry(ctx.config, ctx.cwd)
    ctx.data.verifyOk = result.ok
    ctx.data.verifyReason = result.ok ? "" : summarizeFailure(result)
    ctx.data.verifyRecovered = result.recovered ?? []
    if (result.recovered && result.recovered.length > 0) {
      process.stderr.write(`[kody verify] caught flake on: ${result.recovered.join(", ")} (passed on retry)\n`)
    }
  } catch (err) {
    ctx.data.verifyOk = false
    ctx.data.verifyReason = `verify crashed: ${err instanceof Error ? err.message : String(err)}`
  }
}

function downgradeActionOnFailure(ctx: Context): void {
  if (ctx.data.verifyOk !== false) return
  const action = ctx.data.action as Action | undefined
  if (!action?.type.endsWith("_COMPLETED")) return
  const reason = (ctx.data.verifyReason as string | undefined) || "verify failed"
  ctx.data.action = {
    type: action.type.replace(/_COMPLETED$/, "_FAILED"),
    payload: { reason, downgradedFrom: action.type },
    timestamp: new Date().toISOString(),
  }
}

function upgradeActionOnPass(ctx: Context): void {
  if (ctx.data.verifyOk !== true) return
  const action = ctx.data.action as Action | undefined
  if (!action?.type.endsWith("_FAILED")) return
  const downgradedFrom = (action.payload as { downgradedFrom?: string } | undefined)?.downgradedFrom
  if (!downgradedFrom?.endsWith("_COMPLETED")) return
  ctx.data.action = {
    type: downgradedFrom,
    payload: {},
    timestamp: new Date().toISOString(),
  }
}

export const verifyWithRetry: PostflightScript = async (ctx) => {
  await runVerify(ctx)

  if (ctx.data.verifyOk !== false) return
  if (!ctx.data.agentDone) {
    downgradeActionOnFailure(ctx)
    return
  }

  const invoker = ctx.data.__invokeAgent as Invoker | undefined
  const basePrompt = ctx.data.prompt as string | undefined
  if (!invoker || !basePrompt) {
    downgradeActionOnFailure(ctx)
    return
  }

  const reason = (ctx.data.verifyReason as string | undefined) || "verify failed"
  process.stderr.write(`[kody] verify failed; retrying agent once with verify output as feedback\n`)

  const retryPrompt = [
    basePrompt,
    "",
    "# Verify failure (retry)",
    "",
    "The quality gate failed after your previous attempt. Read the output below,",
    "fix the underlying issue (do NOT relax the gate or skip tests), then re-emit",
    "your result. You have one retry — make it count.",
    "",
    reason,
  ].join("\n")

  try {
    const retry = await invoker(retryPrompt)
    const parsed = parseAgentResult(retry.finalText)
    if (retry.outcome === "completed" && parsed.done) {
      ctx.data.agentDone = true
      ctx.data.commitMessage = parsed.commitMessage || (ctx.data.commitMessage as string)
      ctx.data.prSummary = parsed.prSummary || (ctx.data.prSummary as string)
    }
  } catch (err) {
    process.stderr.write(`[kody] verify retry crashed: ${err instanceof Error ? err.message : String(err)}\n`)
  }

  await runVerify(ctx)
  if ((ctx.data as Record<string, unknown>).verifyOk === true) {
    upgradeActionOnPass(ctx)
  } else {
    downgradeActionOnFailure(ctx)
  }
}
