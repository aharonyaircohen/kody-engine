/**
 * Flow script for the `revert` executable.
 * Loads the PR, checks it out, validates each requested commit SHA is
 * reachable from the PR branch's HEAD, and stages metadata for the
 * downstream `revert.sh` (does the revert) + commitAndPush (commits & pushes).
 *
 * Skips the agent — revert is purely mechanical.
 */

import { execFileSync } from "node:child_process"
import { checkoutPrBranch, getCurrentBranch } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"
import { getRunUrl } from "../gha.js"
import { getPr, postPrReviewComment } from "../issue.js"

const SHA_RE = /^[0-9a-f]{4,40}$/i

export const revertFlow: PreflightScript = async (ctx) => {
  const prNumber = ctx.args.pr as number
  const pr = getPr(prNumber, ctx.cwd)
  if (pr.state !== "OPEN") {
    ctx.output.exitCode = 1
    ctx.output.reason = `PR #${prNumber} is not OPEN (state: ${pr.state})`
    ctx.skipAgent = true
    return
  }
  ctx.data.pr = pr
  ctx.data.commentTargetType = "pr"
  ctx.data.commentTargetNumber = prNumber

  checkoutPrBranch(prNumber, ctx.cwd)
  ctx.data.branch = getCurrentBranch(ctx.cwd)

  const shasArg = String(ctx.args.shas ?? "").trim()
  if (!shasArg) {
    ctx.output.exitCode = 64
    ctx.output.reason = "no commit SHAs provided — usage: @kody revert <sha> [<sha> …]"
    ctx.skipAgent = true
    tryPostPr(prNumber, `⚠️ kody revert FAILED: ${ctx.output.reason}`, ctx.cwd)
    return
  }

  const requested = shasArg.split(/\s+/).filter((s) => s.length > 0)
  const bad = requested.filter((s) => !SHA_RE.test(s))
  if (bad.length > 0) {
    ctx.output.exitCode = 64
    ctx.output.reason = `not valid SHA-shaped tokens: ${bad.join(", ")}`
    ctx.skipAgent = true
    tryPostPr(prNumber, `⚠️ kody revert FAILED: ${ctx.output.reason}`, ctx.cwd)
    return
  }

  // Resolve each token to a full SHA and verify it's reachable from HEAD.
  const resolved: { input: string; full: string; subject: string }[] = []
  const unreachable: string[] = []
  for (const s of requested) {
    let full: string
    try {
      full = git(["rev-parse", "--verify", `${s}^{commit}`], ctx.cwd)
    } catch {
      unreachable.push(s)
      continue
    }
    if (!isAncestorOfHead(full, ctx.cwd)) {
      unreachable.push(s)
      continue
    }
    let subject = ""
    try {
      subject = git(["log", "-1", "--format=%s", full], ctx.cwd)
    } catch {
      /* keep blank — not fatal */
    }
    resolved.push({ input: s, full, subject })
  }
  if (unreachable.length > 0) {
    ctx.output.exitCode = 64
    ctx.output.reason = `commit(s) not found in this PR branch: ${unreachable.join(", ")}`
    ctx.skipAgent = true
    tryPostPr(prNumber, `⚠️ kody revert FAILED: ${ctx.output.reason}`, ctx.cwd)
    return
  }

  // Pass the resolved (full) SHAs to revert.sh — it'll see them via env var.
  ctx.args.shas = resolved.map((r) => r.full).join(" ")

  ctx.data.commitMessage = buildCommitMessage(resolved)
  ctx.data.prSummary = buildPrSummary(resolved)
  // We bypass the agent entirely. `ctx.data.agentDone` is NOT set here —
  // the mechanical revert.sh step might still fail (merge conflict). The
  // `markFlowSuccess` postflight sets it only after revert.sh exits clean.
  ctx.skipAgent = true

  const runUrl = getRunUrl()
  const runSuffix = runUrl ? `, run ${runUrl}` : ""
  const shaList = resolved.map((r) => `\`${r.full.slice(0, 7)}\``).join(", ")
  tryPostPr(prNumber, `⚙️ kody revert started on \`${ctx.data.branch}\`${runSuffix} — reverting ${shaList}`, ctx.cwd)
}

function buildCommitMessage(resolved: { full: string; subject: string }[]): string {
  if (resolved.length === 1) {
    const { full, subject } = resolved[0]!
    return subject ? `revert: "${subject}" (${full.slice(0, 7)})` : `revert: ${full.slice(0, 7)}`
  }
  const shas = resolved.map((r) => r.full.slice(0, 7)).join(", ")
  return `revert: ${resolved.length} commit(s) (${shas})`
}

function buildPrSummary(resolved: { full: string; subject: string }[]): string {
  return resolved.map((r) => `- Reverted \`${r.full.slice(0, 7)}\`${r.subject ? ` — ${r.subject}` : ""}`).join("\n")
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: 30_000,
    cwd,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

function isAncestorOfHead(sha: string, cwd?: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd,
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
      stdio: ["ignore", "ignore", "ignore"],
    })
    return true
  } catch {
    return false
  }
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try {
    postPrReviewComment(prNumber, body, cwd)
  } catch (err) {
    // Non-fatal — but operators should see GitHub API failures explicitly,
    // not have them swallowed. The flow continues either way (the comment
    // is informational, not the source of truth).
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody revertFlow] PR comment on #${prNumber} failed: ${msg}\n`)
  }
}
