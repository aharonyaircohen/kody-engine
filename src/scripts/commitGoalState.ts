/**
 * Postflight: git-add `.kody/goals/<id>/state.json`, commit any change,
 * and push. Best-effort — push failures are logged + retried next tick.
 *
 * Mirrors tick.sh's `commit_state` helper. Skips silently when the
 * file has no diff.
 */

import { execFileSync } from "node:child_process"
import * as path from "node:path"
import type { PostflightScript } from "../executables/types.js"
import type { GoalCtx } from "./goalCtx.js"

export const commitGoalState: PostflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  const stateRel = path.posix.join(".kody", "goals", goal.id, "state.json")

  try {
    execFileSync("git", ["add", stateRel], { cwd: ctx.cwd, stdio: "pipe" })
  } catch (err) {
    process.stderr.write(
      `[goal-tick] commitGoalState: git add failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return
  }

  // Skip when nothing's staged (no real change this tick).
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: ctx.cwd, stdio: "pipe" })
    // diff --cached --quiet exits 0 when no diff → nothing to commit.
    return
  } catch {
    // Has staged changes; fall through to commit.
  }

  const msg = describeCommitMessage(goal)
  try {
    execFileSync("git", ["commit", "-m", msg, "--quiet"], { cwd: ctx.cwd, stdio: "pipe" })
  } catch (err) {
    process.stderr.write(
      `[goal-tick] commitGoalState: git commit failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return
  }

  try {
    execFileSync("git", ["push", "--quiet"], { cwd: ctx.cwd, stdio: "pipe" })
  } catch {
    process.stderr.write("[goal-tick] commitGoalState: push failed (will retry next tick)\n")
  }
}

function describeCommitMessage(goal: GoalCtx): string {
  if (goal.state === "closed") return `chore(goals): abandon ${goal.id} (cleanup complete)`
  if (goal.state === "awaiting-merge") return `chore(goals): park ${goal.id} awaiting merge`
  if (goal.state === "done") return `chore(goals): mark ${goal.id} done`
  if (goal.lastDispatchedIssue !== undefined) {
    return `chore(goals): dispatched #${goal.lastDispatchedIssue} for ${goal.id}`
  }
  if (goal.phase === "in-flight") {
    return `chore(goals): tick ${goal.id} (waiting for in-flight task)`
  }
  return `chore(goals): tick ${goal.id} (idle)`
}
