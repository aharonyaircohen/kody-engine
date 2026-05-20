/**
 * Push the current HEAD to origin with a fetch+rebase retry loop.
 *
 * Why: a one-shot `git push` silently loses commits when a concurrent push
 * lands on origin first. The push fails with "non-fast-forward / fetch first";
 * if the caller catches and shrugs, the work is gone after the ephemeral
 * runner is torn down. We've observed this on long-running chat sessions
 * overlapping with cron fan-out (every-15-min state updates).
 *
 * Strategy:
 *   1. Try `git push origin HEAD`.
 *   2. On success → done.
 *   3. On non-fast-forward rejection: `git fetch origin <branch>` + `git rebase
 *      origin/<branch>`, sleep with exponential backoff, retry.
 *   4. On rebase conflict: `git rebase --abort` + fail loud — conflict means
 *      real divergence, not just a race.
 *   5. After maxRetries → fail loud.
 *   6. Any non-rejection error (auth, network) → fail loud on first attempt;
 *      retrying won't help and we want the operator to see it.
 *
 * Linear history: rebase, not merge. Race-recovery merge commits are noise.
 *
 * Bounded: 3 attempts handles one or two concurrent pushes (the common case).
 * Beyond that is hot-spinning on a wedged remote.
 */

import { execFileSync } from "node:child_process"

export interface PushWithRetryOptions {
  cwd: string
  /** Branch to fetch/rebase against. Falls back to current HEAD's symbolic ref. */
  branch?: string
  maxRetries?: number
  /** First backoff in ms. Doubles each attempt, capped at 60s. */
  backoffMs?: number
  /** Pass `-u` so the local branch tracks origin/<branch> after push. */
  setUpstream?: boolean
}

export type PushWithRetryResult =
  | { ok: true; attempts: number }
  | { ok: false; reason: string; attempts: number }

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

const NON_FAST_FORWARD_RE = /non-fast-forward|fetch first|\(rejected\)|! \[rejected\]/i

function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

function runGit(args: string[], cwd: string): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, stdout: stdout?.toString() ?? "", stderr: "" }
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const stderr = e.stderr?.toString() ?? e.message ?? ""
    const stdout = e.stdout?.toString() ?? ""
    return { ok: false, stdout, stderr }
  }
}

function resolveBranch(cwd: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim()
  const r = runGit(["symbolic-ref", "--short", "HEAD"], cwd)
  return r.ok ? r.stdout.trim() : ""
}

export function pushWithRetry(opts: PushWithRetryOptions): PushWithRetryResult {
  const cwd = opts.cwd
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseBackoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const branch = resolveBranch(cwd, opts.branch)

  if (!branch) {
    return { ok: false, reason: "could not determine current branch (detached HEAD?)", attempts: 0 }
  }

  const pushArgs = opts.setUpstream
    ? ["push", "-u", "origin", `HEAD:${branch}`]
    : ["push", "origin", "HEAD"]

  let lastError = ""
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const push = runGit(pushArgs, cwd)
    if (push.ok) return { ok: true, attempts: attempt }

    lastError = push.stderr || push.stdout || "(no error detail)"

    // Only retry on non-fast-forward. Auth/network/permission failures
    // won't fix themselves with rebase — surface them immediately.
    if (!NON_FAST_FORWARD_RE.test(lastError)) {
      return { ok: false, reason: `push failed (not retryable): ${lastError.trim().slice(-400)}`, attempts: attempt }
    }

    if (attempt === maxRetries) break

    const fetch = runGit(["fetch", "origin", branch], cwd)
    if (!fetch.ok) {
      return {
        ok: false,
        reason: `fetch failed during retry: ${(fetch.stderr || fetch.stdout).trim().slice(-400)}`,
        attempts: attempt,
      }
    }

    const rebase = runGit(["rebase", `origin/${branch}`], cwd)
    if (!rebase.ok) {
      // Abort the rebase so the working tree is clean for the caller.
      runGit(["rebase", "--abort"], cwd)
      return {
        ok: false,
        reason: `rebase onto origin/${branch} failed (conflict?): ${(rebase.stderr || rebase.stdout).trim().slice(-400)}`,
        attempts: attempt,
      }
    }

    const delay = Math.min(baseBackoff * 2 ** (attempt - 1), MAX_BACKOFF_MS)
    sleepSync(delay)
  }

  return {
    ok: false,
    reason: `push rejected after ${maxRetries} attempts: ${lastError.trim().slice(-400)}`,
    attempts: maxRetries,
  }
}
