import { execFileSync } from "node:child_process"
import { pushWithRetry } from "./pushWithRetry.js"

export const FORBIDDEN_PATH_PREFIXES = [
  ".kody/", // legacy consumer state must never be reintroduced or committed
  ".kody-engine/",
  ".kody-lean/", // back-compat: stale runtime dir from kody-lean v0.5.x
  ".codegraph/", // codegraph repo-map tool's runtime scratch (daemon.pid, sock,
  // db, its own .gitignore) — machine-local, must never be committed. Without
  // this, a run that does no real work still commits codegraph's startup litter
  // and opens an empty PR.
  "node_modules/",
  "dist/",
  "build/",
]

// Durable Kody state belongs in the configured backend.
const ALLOWED_PATH_PREFIXES: string[] = []

// `kody.config.json` is the engine's trust anchor: it declares the model,
// allowed associations, and `publishCommand` (which the release path runs via
// `bash -c`). An agent that could rewrite it could escalate beyond the runner
// it already controls — so it is never an agent-writable path.
const FORBIDDEN_PATH_EXACT = new Set([".env", ".kody-pip-requirements.txt", "kody.config.json"])
const FORBIDDEN_PATH_SUFFIXES = [".log"]

function isGitHubYamlPath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\/+/, "")
  return normalized.startsWith(".github/") && /\.ya?ml$/i.test(normalized)
}

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

/**
 * Guarantee a committer identity before we commit. Production runs get one from
 * the CLI bootstrap (see kody-cli.ts), but a direct caller (tests, future
 * scripts) — or any runner with no global git config — would otherwise hit
 * `git commit` failing with "empty ident name … not allowed". We own the
 * fallback here so committing never depends on who invoked us.
 *
 * Only fills in what's missing — an existing name/email (local, global, or
 * system) is never clobbered. Mirrors the GIT_AUTHOR_* convention used by
 * repoWorkspace.ts / runnerServe.ts.
 */
function ensureGitIdentity(cwd?: string): void {
  if (!tryGit(["config", "user.name"], cwd)) {
    tryGit(["config", "user.name", process.env.GIT_AUTHOR_NAME ?? "Kody Bot"], cwd)
  }
  if (!tryGit(["config", "user.email"], cwd)) {
    tryGit(["config", "user.email", process.env.GIT_AUTHOR_EMAIL ?? "kody@users.noreply.github.com"], cwd)
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

function isExplicitlyAllowed(p: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) =>
    entry.endsWith("/**") ? p.startsWith(entry.slice(0, -2)) : p === entry,
  )
}

export function isForbiddenPath(p: string, deliveryPathAllowlist: readonly string[] = []): boolean {
  if (FORBIDDEN_PATH_EXACT.has(p)) return true
  for (const pre of FORBIDDEN_PATH_PREFIXES) if (p.startsWith(pre)) return true
  for (const suf of FORBIDDEN_PATH_SUFFIXES) if (p.endsWith(suf)) return true
  if (isExplicitlyAllowed(p, deliveryPathAllowlist)) return false
  // GitHub configuration is operator-owned. Kody may inspect it to diagnose
  // failures, but no agent-produced commit may create or modify GitHub YAML.
  if (isGitHubYamlPath(p)) return true
  for (const pre of ALLOWED_PATH_PREFIXES) if (p.startsWith(pre)) return false
  return false
}

export function listChangedFiles(cwd?: string): string[] {
  // List every untracked file instead of collapsing a new directory to one
  // entry. Path safety is file-specific (for example GitHub YAML), so staging
  // a summarized directory would bypass the guard for forbidden children.
  // Use NUL-delimited output to avoid quoting/whitespace issues with paths.
  // Each entry begins with a 2-char status code + 1 space, then the path.
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
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

export function commitAndPush(
  branch: string,
  agentMessage: string,
  cwd?: string,
  deliveryPathAllowlist: readonly string[] = [],
): CommitResult {
  // Note: abortUnfinishedGitOps() is intentionally NOT called here anymore.
  // The postflight script (src/scripts/commitAndPush.ts) decides when to
  // abort (non-resolve modes) vs preserve (resolve mode keeps MERGE_HEAD so
  // the merge commit can be created from it).
  const allChanged = listChangedFiles(cwd)
  const allowedFiles = allChanged.filter((f) => !isForbiddenPath(f, deliveryPathAllowlist))

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
  // engine runtime state. The per-file `git add` of allowedFiles below only
  // ADDS; it never un-stages, so without this reset the forbidden-path filter
  // is silently bypassed and those files land in the commit. Reset is per-file
  // (leaves MERGE_HEAD and resolved-file staging intact) and a harmless no-op
  // in non-resolve modes where nothing pre-staged them.
  const forbiddenFiles = allChanged.filter((f) => isForbiddenPath(f, deliveryPathAllowlist))
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
  ensureGitIdentity(cwd)
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
