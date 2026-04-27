/**
 * Postflight (orchestrator-only): wait for CI on a PR and emit an Action so
 * the orchestrator's transition table can route to fix-ci on failure or to
 * finishFlow on success.
 *
 * Resolves the PR number from `state.core.prUrl` (the most recently produced
 * PR — e.g. the deploy PR after release-deploy). Polls `gh pr checks <N>`
 * with a bounded timeout. Emits one of:
 *
 *   CI_PASSED   — every check is pass/skipping
 *   CI_FAILED   — any check failed/cancelled AND fix-ci attempts < cap
 *   CI_GIVEUP   — any check failed/cancelled AND fix-ci attempts ≥ cap
 *   CI_TIMEOUT  — polling exceeded `timeoutMinutes` (treated as terminal)
 *
 * Args (from profile entry's `with` object):
 *   - timeoutMinutes:     max wall-clock to poll (default 30)
 *   - pollSeconds:        interval between polls (default 30)
 *   - initialWaitSeconds: sleep before first poll, lets CI register after a
 *                         push (default 15)
 *   - maxFixCiAttempts:   cap on fix-ci retries before CI_GIVEUP (default 3)
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript, ScriptArgs } from "../executables/types.js"
import { parsePrNumber, postPrReviewComment } from "../issue.js"
import { type Action, type TaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000

interface CheckRow {
  bucket?: string
  state?: string
  name?: string
  workflow?: string
  link?: string
}

export const waitForCi: PostflightScript = async (ctx, _profile, _agentResult, args?: ScriptArgs) => {
  const timeoutMinutes = numArg(args, "timeoutMinutes", 30)
  const pollSeconds = numArg(args, "pollSeconds", 30)
  const initialWaitSeconds = numArg(args, "initialWaitSeconds", 15)
  const maxFixCiAttempts = numArg(args, "maxFixCiAttempts", 3)

  const state = ctx.data.taskState as TaskState | undefined
  const prUrl = state?.core.prUrl
  const prNumber = prUrl ? parsePrNumber(prUrl) : null

  if (!prNumber) {
    ctx.data.action = mkAction("CI_GIVEUP", { reason: "no PR url in state — nothing to wait for" })
    return
  }

  const fixCiAttempts = state?.core.attempts?.["fix-ci"] ?? 0

  await sleep(initialWaitSeconds * 1000)

  const deadline = Date.now() + timeoutMinutes * 60_000
  let lastSummary = ""

  while (Date.now() < deadline) {
    const rows = fetchChecks(prNumber, ctx.cwd)

    if (rows === null) {
      await sleep(pollSeconds * 1000)
      continue
    }

    if (rows.length === 0) {
      await sleep(pollSeconds * 1000)
      continue
    }

    const summary = summarize(rows)
    if (summary !== lastSummary) {
      lastSummary = summary
      tryPostPr(prNumber, `⏳ kody waitForCi: ${summary}`, ctx.cwd)
    }

    const failed = rows.filter((r) => r.bucket === "fail" || r.bucket === "cancel")
    const pending = rows.filter((r) => r.bucket === "pending")

    if (failed.length > 0) {
      const detail = failed
        .slice(0, 5)
        .map((r) => `${r.workflow ?? "?"} / ${r.name ?? "?"}${r.link ? ` (${r.link})` : ""}`)
        .join("; ")

      if (fixCiAttempts >= maxFixCiAttempts) {
        ctx.data.action = mkAction("CI_GIVEUP", {
          reason: `fix-ci attempts (${fixCiAttempts}) hit cap (${maxFixCiAttempts})`,
          failedChecks: detail,
          prUrl,
        })
        tryPostPr(
          prNumber,
          `🛑 kody waitForCi: giving up after ${fixCiAttempts} fix-ci attempts. Failed: ${detail}`,
          ctx.cwd,
        )
      } else {
        ctx.data.action = mkAction("CI_FAILED", {
          failedChecks: detail,
          attempt: fixCiAttempts + 1,
          maxAttempts: maxFixCiAttempts,
          prUrl,
        })
        tryPostPr(
          prNumber,
          `❌ kody waitForCi: CI failed (attempt ${fixCiAttempts + 1}/${maxFixCiAttempts}). Dispatching fix-ci. Failed: ${detail}`,
          ctx.cwd,
        )
      }
      return
    }

    if (pending.length === 0) {
      ctx.data.action = mkAction("CI_PASSED", { checks: rows.length, prUrl })
      tryPostPr(prNumber, `✅ kody waitForCi: all ${rows.length} checks green on PR #${prNumber}`, ctx.cwd)
      return
    }

    await sleep(pollSeconds * 1000)
  }

  ctx.data.action = mkAction("CI_TIMEOUT", {
    reason: `CI did not complete within ${timeoutMinutes} minutes`,
    prUrl,
  })
  tryPostPr(prNumber, `⌛ kody waitForCi: timed out after ${timeoutMinutes} minutes`, ctx.cwd)
}

function fetchChecks(prNumber: number, cwd?: string): CheckRow[] | null {
  try {
    const raw = execFileSync("gh", ["pr", "checks", String(prNumber), "--json", "bucket,state,name,workflow,link"], {
      encoding: "utf-8",
      timeout: API_TIMEOUT_MS,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const parsed = JSON.parse(raw) as CheckRow[]
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    process.stderr.write(
      `[kody waitForCi] gh pr checks #${prNumber} failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return null
  }
}

function summarize(rows: CheckRow[]): string {
  const counts: Record<string, number> = {}
  for (const r of rows) {
    const k = r.bucket ?? "unknown"
    counts[k] = (counts[k] ?? 0) + 1
  }
  return Object.entries(counts)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ")
}

function mkAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}

function numArg(args: ScriptArgs | undefined, key: string, fallback: number): number {
  const v = args?.[key]
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v
  if (typeof v === "string") {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return fallback
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try {
    postPrReviewComment(prNumber, body, cwd)
  } catch {
    /* best effort */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
