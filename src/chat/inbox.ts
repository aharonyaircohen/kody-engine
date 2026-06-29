/**
 * Session-file inbox: poll for new user messages appended by the dashboard.
 *
 * The dashboard writes user messages to `.kody/sessions/<id>.jsonl` via the
 * GitHub Contents API. Inside an Actions runner, we see those writes only
 * after a `git pull`. This primitive owns the pull + diff loop so mode
 * orchestrators stay declarative.
 *
 * Single-writer rule: the dashboard appends user turns, the runner appends
 * assistant turns. They never write to the same line, so concurrent commits
 * resolve cleanly under fast-forward / rebase pulls.
 */

import { execFileSync } from "node:child_process"
import type { ChatTurn } from "./session.js"
import { readSession } from "./session.js"

export interface InboxOptions {
  sessionFile: string
  cwd: string
  /** Index in the turns array up to which we've already replied. New user turns must appear at indices >= this. */
  watermark: number
  /** Stop polling after this many ms with no new message (idle exit). */
  idleTimeoutMs: number
  /** Stop polling at this absolute deadline (ms epoch). Honors session hard cap. */
  deadlineMs: number
  /** Pull frequency. Defaults to 30s — slower = cheaper, faster = snappier. */
  pollIntervalMs?: number
  /** Optional logger; defaults to stderr. */
  logger?: { warn: (msg: string) => void; debug?: (msg: string) => void }
  /** Test seam: skip the actual git pull. */
  skipPull?: boolean
}

export type InboxResult =
  | { kind: "message"; turn: ChatTurn; turnIndex: number }
  | { kind: "idle-timeout" }
  | { kind: "deadline" }

// 3s — keeps runner-side latency to ~1.5s avg before a new user message
// is picked up. `git fetch + merge --ff-only` against an idle remote takes
// ~200ms on GHA runners, so 3s polls don't pile up. Combined with the
// dashboard's 2s event poll, total user-visible roundtrip drops from
// ~35s to ~8-12s for a fast-reply turn.
const DEFAULT_POLL_MS = 3_000

/**
 * Wait for the next new user message in the session file, or exit on idle/deadline.
 * Returns the new turn and its index so the caller can advance its watermark.
 */
export async function waitForNextUserMessage(opts: InboxOptions): Promise<InboxResult> {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const logger = opts.logger ?? {
    warn: (m) => process.stderr.write(`[kody:chat:inbox] ${m}\n`),
  }
  const idleStart = Date.now()

  while (true) {
    const now = Date.now()
    if (now >= opts.deadlineMs) return { kind: "deadline" }
    if (now - idleStart >= opts.idleTimeoutMs) return { kind: "idle-timeout" }

    if (!opts.skipPull) {
      try {
        // Resolve the current branch; fall back to detached HEAD's tracked
        // ref when checkout left us on a SHA. `git pull origin HEAD` is the
        // wrong command — server-side HEAD = the remote's default branch,
        // which is usually NOT the branch we're on.
        const branch = currentBranch(opts.cwd)
        if (branch) {
          execFileSync("git", ["fetch", "--quiet", "origin", branch], { cwd: opts.cwd, stdio: "pipe" })
          execFileSync("git", ["merge", "--ff-only", "--quiet", `origin/${branch}`], {
            cwd: opts.cwd,
            stdio: "pipe",
          })
        } else {
          // Detached HEAD with no tracking — fetch all + just bail; the
          // runner can't safely merge anything in this state.
          execFileSync("git", ["fetch", "--quiet", "--all"], { cwd: opts.cwd, stdio: "pipe" })
        }
      } catch (err) {
        // Non-fatal — the next poll will retry. A push from the runner that
        // hasn't been pulled yet can also cause a non-ff state; we'll resync
        // on the next iteration.
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(`git pull failed (will retry): ${msg}`)
      }
    }

    const turns = readSession(opts.sessionFile)
    for (let i = opts.watermark; i < turns.length; i++) {
      const t = turns[i]!
      if (t.role === "user") {
        return { kind: "message", turn: t, turnIndex: i }
      }
    }

    // No new user message yet — sleep, but cap by remaining deadline / idle budget.
    const remainingDeadline = opts.deadlineMs - Date.now()
    const remainingIdle = opts.idleTimeoutMs - (Date.now() - idleStart)
    const sleepMs = Math.max(0, Math.min(pollMs, remainingDeadline, remainingIdle))
    if (sleepMs === 0) continue
    await sleep(sleepMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Returns the current branch name, or null when on detached HEAD with no
 * resolvable upstream. Uses `symbolic-ref` (only succeeds on a real branch)
 * to avoid the "HEAD" pseudo-name from `rev-parse --abbrev-ref` in detached
 * mode.
 */
function currentBranch(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const branch = out.toString("utf-8").trim()
    return branch || null
  } catch {
    return null
  }
}
