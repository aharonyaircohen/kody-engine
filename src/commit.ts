import { execFileSync } from "node:child_process"
import { pushWithRetry } from "./pushWithRetry.js"

const FORBIDDEN_PATH_PREFIXES = [
  ".kody/",
  ".kody-engine/",
  ".kody/",
  ".kody-lean/", // back-compat: stale runtime dir from kody-lean v0.5.x
  ".codegraph/", // codegraph repo-map tool's runtime scratch (daemon.pid, sock,
  // db, its own .gitignore) — machine-local, must never be committed. Without
  // this, a run that does no real work still commits codegraph's startup litter
  // and opens an empty PR.
  "node_modules/",
  "dist/",
  "build/",
]

// Paths that override the forbidden-prefix check. `.kody/` is blanket-blocked
// to keep agents out of runtime state and configs during run/fix/resolve, but
// a few narrow paths are legitimate write targets for the agent:
//   - `.kody/memory/` — the markdown knowledge base (memorize + sticky-note
//     inbox + filed memories).
//   - `.kody/tasks/` — per-task artifacts (context.json, memory-recs.json,
//     followups.json, handoff-notes.md) written by the agent at end of
//     every issue/agent-mode task per the task-artifacts contract.
const ALLOWED_PATH_PREFIXES = [".kody/memory/", ".kody/tasks/"]

// `kody.config.json` is the engine's trust anchor: it declares the model,
// allowed associations, and `publishCommand` (which the release path runs via
// `bash -c`). An agent that could rewrite it could escalate beyond the runner
// it already controls — so it is never an agent-writable path.
const FORBIDDEN_PATH_EXACT = new Set([".env", ".kody-pip-requirements.txt", "kody.config.json"])
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

  // Unstage any forbidden paths an earlier postflight may have staged. In
  // resolve mode `stageMergeConflicts` runs `git add -A`, which stages
  // EVERYTHING — including `.env`, `kody.config.json` (the trust anchor), and
  // runtime `.kody/` state. The per-file `git add` of allowedFiles below only
  // ADDS; it never un-stages, so without this reset the forbidden-path filter
  // is silently bypassed and those files land in the commit. Reset is per-file
  // (leaves MERGE_HEAD and resolved-file staging intact) and a harmless no-op
  // in non-resolve modes where nothing pre-staged them.
  const forbiddenFiles = allChanged.filter((f) => isForbiddenPath(f))
  for (const f of forbiddenFiles) {
    try {
      git(["reset", "-q", "--", f], cwd)
    } catch {
      /* not staged — fine */
    }
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

  // pushWithRetry handles the race: on non-fast-forward rejection it does
  // `git fetch + git rebase origin/<branch>` and retries. This replaces the
  // old plain → force-with-lease retry, which was dangerous (force-with-lease
  // can silently overwrite a concurrent push in narrow timing windows) and
  // didn't actually fix the data-loss bug — when origin moved during the
  // agent's run, retries kept failing because we never rebased.
  const pushResult = pushWithRetry({ cwd, branch, setUpstream: true })
  if (pushResult.ok) {
    return { committed: true, pushed: true, sha, message }
  }

  // Commit landed locally but push didn't. ensurePr will bail rather than
  // open a PR against a branch that's not on origin.
  return { committed: true, pushed: false, sha, message, pushError: pushResult.reason }
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
