import { execFileSync } from "node:child_process"

const FORBIDDEN_PATH_PREFIXES = [
  ".kody/",
  ".kody-engine/",
  ".kody/",
  ".kody-lean/", // back-compat: stale runtime dir from kody-lean v0.5.x
  "node_modules/",
  "dist/",
  "build/",
]

// Paths that override the forbidden-prefix check. `.kody/` is blanket-blocked
// to keep agents out of runtime state and configs during run/fix/resolve, but
// the `memorize` job legitimately writes to `.kody/memory/` (the markdown
// knowledge base). Add narrow allowlist entries here, prefer-first.
const ALLOWED_PATH_PREFIXES = [".kody/memory/"]

const FORBIDDEN_PATH_EXACT = new Set([".env", ".kody-pip-requirements.txt"])
const FORBIDDEN_PATH_SUFFIXES = [".log"]

const CONVENTIONAL_PREFIXES = [
  "feat:",
  "fix:",
  "chore:",
  "docs:",
  "refactor:",
  "test:",
  "perf:",
  "ci:",
  "style:",
  "build:",
  "revert:",
]

export interface CommitResult {
  committed: boolean
  pushed: boolean
  sha: string
  message: string
  /**
   * Set when commit succeeded but push failed (network blip, auth, branch
   * protection). Lets downstream postflights distinguish "no commits made"
   * (`committed: false`) from "commits made but not on remote yet"
   * (`committed: true, pushed: false, pushError: <stderr tail>`).
   * ensurePr must bail in the latter case to avoid 422 from the GitHub API.
   */
  pushError?: string
}

// Backoff delays between push attempts. A transient failure (GitHub 5xx,
// network blip, brief auth hiccup) otherwise loses the only copy of the
// commit when the ephemeral runner is torn down. Total ~14s worst case.
const PUSH_RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

/** Synchronous sleep — commit/push runs in a sync code path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      timeout: 120_000,
      cwd,
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number; message?: string }
    const stderr = e.stderr?.toString().trim() ?? ""
    const stdout = e.stdout?.toString().trim() ?? ""
    const status = e.status ?? "?"
    const detail = stderr || stdout || e.message || "(no output)"
    throw new Error(`git ${args.join(" ")} (exit ${status}):\n${detail}`)
  }
}

function tryGit(args: string[], cwd?: string): boolean {
  try {
    git(args, cwd)
    return true
  } catch {
    return false
  }
}

import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Real-world models sometimes run `git stash`, `git checkout`, `git merge`, etc.
 * during their verification (despite prompt rules). When that leaves the repo
 * in an unfinished state, our subsequent `git commit` fails. Clean up the
 * common cases before staging.
 */
export function abortUnfinishedGitOps(cwd?: string): string[] {
  const aborted: string[] = []
  const gitDir = path.join(cwd ?? process.cwd(), ".git")
  if (!fs.existsSync(gitDir)) return aborted

  if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    if (tryGit(["merge", "--abort"], cwd)) aborted.push("merge")
  }
  if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
    if (tryGit(["cherry-pick", "--abort"], cwd)) aborted.push("cherry-pick")
  }
  if (fs.existsSync(path.join(gitDir, "REVERT_HEAD"))) {
    if (tryGit(["revert", "--abort"], cwd)) aborted.push("revert")
  }
  if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) {
    if (tryGit(["rebase", "--abort"], cwd)) aborted.push("rebase")
  }

  // Detect unmerged paths even without a sentinel file (rare).
  try {
    const unmerged = git(["diff", "--name-only", "--diff-filter=U"], cwd)
    if (unmerged) {
      tryGit(["reset", "--mixed", "HEAD"], cwd)
      aborted.push("unmerged-paths-reset")
    }
  } catch {
    /* best effort */
  }

  return aborted
}

export function isForbiddenPath(p: string): boolean {
  if (FORBIDDEN_PATH_EXACT.has(p)) return true
  for (const pre of ALLOWED_PATH_PREFIXES) if (p.startsWith(pre)) return false
  for (const pre of FORBIDDEN_PATH_PREFIXES) if (p.startsWith(pre)) return true
  for (const suf of FORBIDDEN_PATH_SUFFIXES) if (p.endsWith(suf)) return true
  return false
}

export function listChangedFiles(cwd?: string): string[] {
  // Use NUL-delimited output to avoid quoting/whitespace issues with paths.
  // Each entry begins with a 2-char status code + 1 space, then the path.
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (!raw) return []
  const entries = raw.split("\0").filter((e) => e.length > 0)
  return entries.map((e) => e.slice(3)).filter(Boolean)
}

/**
 * Files modified in a specific commit (default HEAD). Unlike listChangedFiles
 * this works AFTER commit — the working tree is clean, but the commit still
 * names its files. Used by postflights that need to know what the agent
 * actually committed (e.g. verifyFixAlignment checking review-named files).
 */
export function listFilesInCommit(ref: string = "HEAD", cwd?: string): string[] {
  try {
    const raw = execFileSync("git", ["show", "--name-only", "--pretty=format:", "-z", ref], {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    return raw
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function normalizeCommitMessage(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim()
  if (!trimmed) return "chore: kody update"
  const firstLine = trimmed.split("\n")[0]
  for (const prefix of CONVENTIONAL_PREFIXES) {
    if (firstLine.toLowerCase().startsWith(prefix)) return trimmed
  }
  return `chore: ${trimmed}`
}

export function commitAndPush(branch: string, agentMessage: string, cwd?: string): CommitResult {
  // Note: abortUnfinishedGitOps() is intentionally NOT called here anymore.
  // The postflight script (src/scripts/commitAndPush.ts) decides when to
  // abort (non-resolve modes) vs preserve (resolve mode keeps MERGE_HEAD so
  // the merge commit can be created from it).
  const allChanged = listChangedFiles(cwd)
  const allowedFiles = allChanged.filter((f) => !isForbiddenPath(f))

  // Detect in-progress merge (resolve mode): even if no files changed
  // vs HEAD (agent accepted one side verbatim), we still need to finalize
  // the merge commit with two parents.
  const mergeHeadExists = fs.existsSync(path.join(cwd ?? process.cwd(), ".git", "MERGE_HEAD"))

  if (allowedFiles.length === 0 && !mergeHeadExists) {
    return { committed: false, pushed: false, sha: "", message: "" }
  }

  for (const f of allowedFiles) {
    try {
      git(["add", "--", f], cwd)
    } catch {
      /* skip individual file errors */
    }
  }

  const message = normalizeCommitMessage(agentMessage)
  try {
    git(["commit", "--no-gpg-sign", "-m", message], cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/nothing to commit/i.test(msg)) {
      return { committed: false, pushed: false, sha: "", message }
    }
    throw err
  }

  const sha = git(["rev-parse", "HEAD"], cwd).slice(0, 7)

  // Retry the full push (plain, then force-with-lease) with backoff. The
  // two variants cover different failures — plain for the normal case,
  // force-with-lease for a stale remote — so the retry loop wraps both.
  let pushError = "push failed (no error detail)"
  for (let attempt = 0; attempt <= PUSH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      git(["push", "-u", "origin", branch], cwd)
      return { committed: true, pushed: true, sha, message }
    } catch (firstErr) {
      try {
        git(["push", "--force-with-lease", "-u", "origin", branch], cwd)
        return { committed: true, pushed: true, sha, message }
      } catch (secondErr) {
        const tail = (secondErr instanceof Error ? secondErr.message : String(secondErr)).slice(-400)
        const initial = firstErr instanceof Error ? firstErr.message : String(firstErr)
        pushError = `push failed: ${initial.slice(-200)} | force-with-lease failed: ${tail}`
        const delay = PUSH_RETRY_DELAYS_MS[attempt]
        if (delay === undefined) break // retries exhausted
        process.stderr.write(`[kody:commit] push failed (attempt ${attempt + 1}); retrying in ${delay}ms\n`)
        sleepSync(delay)
      }
    }
  }

  // Commit landed locally but no push attempt succeeded. Report the
  // partial outcome so downstream postflights (ensurePr) can bail
  // instead of opening a PR against a branch that is not on origin.
  return { committed: true, pushed: false, sha, message, pushError }
}

export function hasCommitsAhead(branch: string, defaultBranch: string, cwd?: string): boolean {
  try {
    const out = git(["rev-list", "--count", `origin/${defaultBranch}..${branch}`], cwd)
    return parseInt(out, 10) > 0
  } catch {
    try {
      const out = git(["rev-list", "--count", `${defaultBranch}..${branch}`], cwd)
      return parseInt(out, 10) > 0
    } catch {
      return false
    }
  }
}
