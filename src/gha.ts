/**
 * Thin helpers that read the GitHub Actions env and do GHA-specific side
 * effects (react to a trigger comment, build a run URL). Kept in one place
 * so flow scripts stay generic.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"

/** Link to the currently-running workflow run, or "" when not in Actions. */
export function getRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL
  const repo = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  if (!server || !repo || !runId) return ""
  return `${server}/${repo}/actions/runs/${runId}`
}

/**
 * When kody was triggered by an `issue_comment` event, read the comment id
 * from the GHA event payload and POST a 👀 reaction on it. Silent no-op when
 * not running in Actions or when the event isn't an issue_comment.
 *
 * The reaction is the user-visible signal that kody picked up the trigger,
 * so it must be reliable. We retry on transient failures (network blip,
 * GitHub 5xx, gh-cli flake) and log to stderr if all retries fail — that
 * way "did kody see this?" stops being silently ambiguous.
 */
export function reactToTriggerComment(cwd?: string): void {
  if (process.env.GITHUB_EVENT_NAME !== "issue_comment") return
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return

  let event: { comment?: { id?: number } } | null = null
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf-8"))
  } catch {
    return
  }
  const commentId = event?.comment?.id
  const repo = process.env.GITHUB_REPOSITORY
  if (!commentId || !repo) return

  const token = process.env.KODY_TOKEN?.trim() || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const args = [
    "api",
    "-X",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    `/repos/${repo}/issues/comments/${commentId}/reactions`,
    "-f",
    "content=eyes",
  ]
  const opts = {
    cwd,
    env: { ...process.env, GH_TOKEN: token ?? process.env.GH_TOKEN ?? "" },
    stdio: "pipe" as const,
    timeout: 15_000,
  }

  let lastErr: unknown = null
  // 3 attempts total; 0ms, 500ms, 1500ms backoff. Keeps total worst-case
  // under ~2s even if both retries fail, so the rest of preflight isn't
  // delayed materially.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) sleepMs(attempt === 1 ? 500 : 1500)
    try {
      execFileSync("gh", args, opts)
      return
    } catch (err) {
      lastErr = err
    }
  }
  process.stderr.write(
    `[kody] 👀 reaction failed after 3 attempts on comment ${commentId}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}\n`,
  )
}

function sleepMs(ms: number): void {
  // Synchronous sleep via posix `sleep` — cheaper than a busy-loop and only
  // ever invoked between failed reaction-API attempts (a slow path already).
  try {
    execFileSync("sleep", [(ms / 1000).toString()], { stdio: "ignore", timeout: ms + 1_000 })
  } catch {
    /* no big deal — worst case we retry sooner than intended */
  }
}
