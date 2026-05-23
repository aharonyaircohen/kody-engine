/**
 * Dedicated branch for machine-written engine state.
 *
 * Background jobs/duties advance a per-job cursor every tick and persist it to
 * `.kody/duties/<slug>.state.json`. Committing those to the default branch
 * buried real code under a stream of `chore(jobs): update state …` commits.
 * Routing the writes here keeps the default branch clean — `kody-state` only
 * ever accumulates state commits and is never merged back.
 *
 * The branch is created on demand (off the default branch's current head) the
 * first time the engine writes state to a repo that doesn't have it yet, so no
 * manual setup is required per repo.
 */

import { gh } from "./issue.js"

export const STATE_BRANCH = "kody-state"

function is404(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP 404/i.test(msg) || /Not Found/i.test(msg)
}

/**
 * Ensure `kody-state` exists on the remote, creating it off the default
 * branch's head when missing. Idempotent and cheap (a single ref read on the
 * happy path). Swallows the 422 you get when a concurrent first-write wins the
 * create race; throws on any other API error.
 */
export function ensureStateBranch(owner: string, repo: string, cwd?: string): void {
  try {
    gh(["api", `/repos/${owner}/${repo}/git/ref/heads/${STATE_BRANCH}`], { cwd })
    return // already exists
  } catch (err) {
    if (!is404(err)) throw err
  }

  // Branch off the default branch's current head so the ref is guaranteed to
  // exist for the first Contents-API write.
  const repoInfo = JSON.parse(gh(["api", `/repos/${owner}/${repo}`], { cwd })) as {
    default_branch?: string
  }
  const defaultBranch = repoInfo.default_branch
  if (!defaultBranch) {
    throw new Error(`ensureStateBranch: could not resolve default branch for ${owner}/${repo}`)
  }
  const headRef = JSON.parse(
    gh(["api", `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`], { cwd }),
  ) as { object?: { sha?: string } }
  const sha = headRef.object?.sha
  if (!sha) {
    throw new Error(`ensureStateBranch: could not resolve head sha for ${owner}/${repo}@${defaultBranch}`)
  }

  try {
    gh(["api", "--method", "POST", `/repos/${owner}/${repo}/git/refs`, "--input", "-"], {
      cwd,
      input: JSON.stringify({ ref: `refs/heads/${STATE_BRANCH}`, sha }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Lost the create race with a concurrent first-write — branch now exists.
    if (/already exists/i.test(msg) || /HTTP 422/i.test(msg)) return
    throw err
  }
}
