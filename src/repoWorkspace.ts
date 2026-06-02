/**
 * Shared multi-repo workspace helpers — one Brain machine serves many repos.
 *
 * A repo is cloned on demand into `<reposRoot>/<owner>/<name>` and reused
 * thereafter. Two entry points share one clone + dedupe path:
 *   - `ensureRepoCwd` — lenient: used by brain-serve to pick a turn's working
 *     dir from the per-message `repo` (falls back to a base cwd when absent).
 *   - `fetchRepo` — strict: used by the `fetch_repo` chat tool so the agent
 *     can pull in *another* repo mid-conversation (throws on a bad name).
 */

import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

/** `owner/name` with safe path chars only. Containment is re-checked below. */
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type CloneRepoFn = (repo: string, token: string | undefined, dir: string) => Promise<void>

// Per-target clone dedupe: concurrent callers for the same repo clone once.
const repoClones = new Map<string, Promise<void>>()

/**
 * Resolve `<reposRoot>/<repo>` and clone it on first use. Returns null when
 * `repo` is missing/malformed or would escape `reposRoot`. Shared core for
 * both `ensureRepoCwd` and `fetchRepo`. Clone errors propagate to the caller.
 */
async function resolveAndClone(
  reposRoot: string,
  repo: string | undefined,
  repoToken: string | undefined,
  cloneRepo: CloneRepoFn,
): Promise<string | null> {
  const name = repo?.trim()
  if (!name || !REPO_RE.test(name)) return null

  // Defense-in-depth: never let the resolved path escape reposRoot (guards
  // `..` segments the regex would otherwise admit).
  const root = path.resolve(reposRoot)
  const dir = path.resolve(root, name)
  if (dir !== root && !dir.startsWith(root + path.sep)) return null

  if (fs.existsSync(path.join(dir, ".git"))) return dir

  const inflight = repoClones.get(dir)
  if (inflight) {
    await inflight
    return dir
  }
  const p = cloneRepo(name, repoToken, dir).finally(() => {
    if (repoClones.get(dir) === p) repoClones.delete(dir)
  })
  repoClones.set(dir, p)
  await p
  return dir
}

/**
 * Pick a turn's working directory. Returns `baseCwd` (the boot dir) when
 * no/invalid repo is supplied; otherwise `<reposRoot>/<repo>`, cloning on
 * first use. Clone failures propagate so the caller can surface them.
 */
export async function ensureRepoCwd(opts: {
  baseCwd: string
  reposRoot: string
  repo?: string
  repoToken?: string
  cloneRepo: CloneRepoFn
}): Promise<string> {
  const dir = await resolveAndClone(opts.reposRoot, opts.repo, opts.repoToken, opts.cloneRepo)
  return dir ?? opts.baseCwd
}

/**
 * Strict fetch for the `fetch_repo` chat tool: clone `repo` into the shared
 * workspace and return its absolute path. Throws on a missing/invalid name so
 * the agent gets an actionable error instead of a silent fallback.
 */
export async function fetchRepo(opts: {
  reposRoot: string
  repo: string
  repoToken?: string
  cloneRepo?: CloneRepoFn
}): Promise<string> {
  const dir = await resolveAndClone(opts.reposRoot, opts.repo, opts.repoToken, opts.cloneRepo ?? defaultCloneRepo)
  if (!dir) {
    throw new Error(`invalid repo "${opts.repo}" — expected "owner/name" with no path escapes`)
  }
  return dir
}

/**
 * Default clone: shallow-clone the repo's default branch into `dir` (token
 * embedded in the remote so a later approved push works) and set a committer
 * identity. The token is never logged. Replaceable in tests.
 */
export const defaultCloneRepo: CloneRepoFn = (repo, token, dir) => {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const authUrl = token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", "--depth=1", authUrl, dir], {
      stdio: "inherit",
    })
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`git clone ${repo} failed (exit ${code})`))
        return
      }
      try {
        const name = process.env.GIT_AUTHOR_NAME ?? "Kody Bot"
        const email = process.env.GIT_AUTHOR_EMAIL ?? "kody-bot@users.noreply.github.com"
        spawnSync("git", ["-C", dir, "config", "user.name", name])
        spawnSync("git", ["-C", dir, "config", "user.email", email])
      } catch {
        /* best effort — identity only matters once the agent commits */
      }
      resolve()
    })
    child.on("error", reject)
  })
}
