import { execFileSync } from "node:child_process"
import { gh } from "./issue.js"

export interface BranchResult {
  branch: string
  created: boolean
}

const RERUN_PR_COMMENT = "Superseded by rerun."

/**
 * Result of rerun cleanup. The branch side of the work is local to the
 * runner; the PR-closing step is best-effort and may fail without network
 * access or the `gh` CLI — callers decide what to do with the report.
 */
export interface RerunCleanupResult {
  closedPrs: number
  remoteBranchDeleted: boolean
  localBranchDeleted: boolean
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

export function deriveBranchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "")
  // Never return a bare number: a purely-numeric branch name (e.g. when the
  // issue title is all non-ASCII and the slug comes out empty) makes git
  // ref-resolution ambiguous — `git rev-parse --verify 1678` resolves the
  // number as an object, so `git checkout 1678` detaches HEAD instead of
  // creating the branch and the later `git push origin 1678` fails with
  // "1678 cannot be resolved to branch". The `-task` suffix keeps the
  // leading `<issue>-` convention (goal/base allowlist patterns still match)
  // while guaranteeing a non-numeric name.
  return slug ? `${issueNumber}-${slug}` : `${issueNumber}-task`
}

export function getCurrentBranch(cwd?: string): string {
  return git(["branch", "--show-current"], cwd)
}

/**
 * Hard-reset tracked changes and remove untracked files. Used before
 * any checkout to ensure a clean working tree — kody runs on an
 * ephemeral CI runner, so nothing of value lives in the working tree
 * between invocations. Best-effort: failures don't abort (e.g. when
 * cwd isn't a git repo yet, downstream calls surface the real error).
 */
function resetWorkingTree(cwd?: string): void {
  try {
    execFileSync("git", ["reset", "--hard", "HEAD"], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
  } catch {
    /* best effort */
  }
  try {
    // `-e .kody` excludes kody's own directory from the clean. Consumer
    // agentActions live at `.kody/agent-actions/<name>/` and are TRACKED, but the
    // consumer repo's `.gitignore` ignores `.kody/*` and re-includes them via a
    // negation (`!.kody/agent-actions/**`). On the CI runner, `git clean -fd`'s
    // directory walk over that negated-ignore pattern removes the whole
    // `.kody/agent-actions/<name>` directory — so the next preflight (composePrompt)
    // crashes with "no prompt template found" (readdir ENOENT). Excluding `.kody`
    // keeps the engine's tracked assets intact; the ephemeral runtime state under
    // `.kody/` is gitignored bookkeeping that's safe to leave on an ephemeral runner.
    execFileSync("git", ["clean", "-fd", "-e", ".kody"], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
  } catch {
    /* best effort */
  }
}

/**
 * Check out an existing PR locally via `gh pr checkout`. Returns the
 * local branch name (gh picks a name matching the PR head ref).
 *
 * Discards any uncommitted local changes first. The runner's working tree
 * is ephemeral and may carry build artifacts written by earlier steps
 * (e.g. payload's `importMap.js` regenerated during `pnpm install`); these
 * would otherwise make `gh pr checkout` refuse with "Your local changes
 * would be overwritten by checkout" and crash the agentAction.
 *
 * Discarding is safe because nothing the engine cares about lives in the
 * runner's pre-checkout working tree — the PR's branch contents are the
 * source of truth.
 */
export function checkoutPrBranch(prNumber: number, cwd?: string): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUSKY: "0",
    SKIP_HOOKS: "1",
    GH_TOKEN: process.env.GH_PAT?.trim() || process.env.GH_TOKEN || "",
  }
  // Discard tracked-file modifications and remove untracked files so
  // gh pr checkout has a clean tree to switch into. Best effort — if
  // either git command fails (e.g. cwd isn't a git repo yet), let the
  // gh checkout call surface the real error.
  try {
    execFileSync("git", ["reset", "--hard", "HEAD"], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
  } catch {
    /* best effort */
  }
  try {
    // Exclude `.kody` for the same reason as resetWorkingTree: `git clean -fd`
    // otherwise removes the tracked-but-ignore-negated `.kody/agent-actions/<name>`
    // dirs on the CI runner, breaking PR-driven agentActions (fix/fix-ci/resolve).
    execFileSync("git", ["clean", "-fd", "-e", ".kody"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  } catch {
    /* best effort */
  }
  execFileSync("gh", ["pr", "checkout", String(prNumber)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })
  // The checkout can drop kody's tracked-but-ignore-negated `.kody/` assets;
  // restore them from the checked-out branch's HEAD tree (no-op if that branch
  // predates the agentActions — those PRs would need a rebase regardless).
  restoreKodyAssets(cwd)
  return getCurrentBranch(cwd)
}

/**
 * Merge `origin/<baseBranch>` into the current branch. Returns "clean" on
 * success, "conflict" if unmerged paths remain (conflict markers left in
 * working tree), "error" on any other git failure.
 */
export function mergeBase(baseBranch: string, cwd?: string): "clean" | "conflict" | "error" {
  try {
    git(["fetch", "origin", baseBranch], cwd)
  } catch {
    return "error"
  }
  try {
    git(["merge", `origin/${baseBranch}`, "--no-edit", "--no-ff"], cwd)
    return "clean"
  } catch {
    try {
      const unmerged = git(["diff", "--name-only", "--diff-filter=U"], cwd)
      if (unmerged.length > 0) return "conflict"
    } catch {
      /* ignore */
    }
    try {
      git(["merge", "--abort"], cwd)
    } catch {
      /* best effort */
    }
    return "error"
  }
}

/**
 * Force-restore kody's own tracked assets (`.kody/agent-actions`, `.kody/missions`,
 * …) into the working tree from the current HEAD tree. A branch checkout on the
 * CI runner can drop these: they're tracked, but the consumer repo's `.gitignore`
 * ignores `.kody/*` and re-includes them via a negation, and git's working-tree
 * update over that pattern removes the `.kody/agent-actions/<name>` directory —
 * which makes the next preflight (composePrompt) crash with readdir ENOENT.
 * `git checkout HEAD -- .kody` rematerialises whatever the branch dance dropped.
 * Best-effort: repos that don't track `.kody` just no-op (the checkout errors).
 */
function restoreKodyAssets(cwd?: string): void {
  try {
    execFileSync("git", ["checkout", "HEAD", "--", ".kody"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  } catch {
    /* .kody not tracked here, or nothing to restore — fine */
  }
}

/**
 * Rerun cleanup: close every open PR whose head ref matches `branchName`
 * with the "Superseded by rerun." comment, then delete the remote branch
 * (ignore not-found) and the local branch ref. Called by
 * `ensureFeatureBranch` when an existing remote branch is about to be
 * reused for a rerun — the new run starts from `origin/<defaultBranch>`
 * and must not carry any history from the old branch.
 *
 * All steps are best-effort: a missing `gh` token, no open PRs, or a
 * remote branch that's already gone must not abort the rerun. Returns
 * a summary so callers can decide whether to surface partial-failure
 * information to the operator.
 */
export function cleanupExistingBranchForRerun(branchName: string, cwd?: string): RerunCleanupResult {
  let closedPrs = 0
  let remoteBranchDeleted = false
  let localBranchDeleted = false

  // Close open PRs that point at this branch. `gh pr list` returns JSON
  // with `headRefName`/`number` — we filter client-side so the gh call
  // stays a single round trip and works for any number of matching PRs.
  // A `gh` failure here is non-fatal: the dashboard's Rerun contract
  // already warns the user that a re-rerun is idempotent, and an
  // unclosed PR from the prior run doesn't block the new one.
  try {
    const out = gh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--head",
        branchName,
        "--json",
        "number",
        "--limit",
        "100",
      ],
      { cwd },
    )
    const parsed = JSON.parse(out) as { number?: number }[]
    for (const pr of parsed) {
      if (typeof pr.number !== "number") continue
      try {
        gh(["pr", "close", String(pr.number), "--comment", RERUN_PR_COMMENT, "--delete-branch"], { cwd })
        closedPrs++
      } catch {
        /* one PR failing must not block the rest of the cleanup */
      }
    }
  } catch {
    /* `gh` unavailable, no auth, or no open PRs — proceed to branch delete */
  }

  // Remote branch delete: ignore not-found (the user may have already
  // closed the PR manually) and permission errors (the dashboard's
  // Rerun may run under a token that can close but not delete). The
  // subsequent local checkout will surface any "still exists" state.
  try {
    git(["push", "origin", "--delete", branchName], cwd)
    remoteBranchDeleted = true
  } catch {
    /* not found / no permission — fall through */
  }
  // Drop the local tracking ref so the create path below doesn't see
  // a stale `refs/remotes/origin/<name>` and short-circuit into a
  // checkout instead of a fresh `git checkout -b`.
  try {
    git(["update-ref", "-d", `refs/remotes/origin/${branchName}`], cwd)
  } catch {
    /* best effort */
  }
  // `git branch -D` refuses when the current branch is the one being
  // deleted. Detach HEAD first so the deletion is unconditional — the
  // caller (ensureFeatureBranch) follows up with a `git checkout -b`
  // from origin/<default>, so leaving HEAD detached here is safe.
  try {
    git(["checkout", "--detach", "HEAD"], cwd)
  } catch {
    /* nothing to detach from — fine, the -D below will surface the real error */
  }
  // Drop the local branch ref — checkout -b would otherwise fail.
  try {
    git(["branch", "-D", branchName], cwd)
    localBranchDeleted = true
  } catch {
    /* probably no local branch — fine */
  }

  return { closedPrs, remoteBranchDeleted, localBranchDeleted }
}

export function ensureFeatureBranch(
  issueNumber: number,
  title: string,
  defaultBranch: string,
  cwd?: string,
  baseBranch?: string,
): BranchResult {
  // The branch setup (reset/clean/checkout) can drop kody's tracked-but-
  // ignore-negated `.kody/` assets on the CI runner; restore them once the
  // branch is in place, before any downstream script reads them.
  const result = ensureFeatureBranchInner(issueNumber, title, defaultBranch, cwd, baseBranch)
  restoreKodyAssets(cwd)
  return result
}

function ensureFeatureBranchInner(
  issueNumber: number,
  title: string,
  defaultBranch: string,
  cwd?: string,
  baseBranch?: string,
): BranchResult {
  // baseBranch: optional fork point. When provided (e.g. by base override caller passing
  // --base goal-<id>), a brand-new feature branch is forked from origin/<base>
  // instead of origin/<defaultBranch>. If the feature branch already exists on
  // origin (re-running run on the same issue), we still pull it as-is — the
  // fork point only matters at creation time. The caller is responsible for
  // ensuring the base branch exists on origin first; if it doesn't, fall back
  // to defaultBranch so we don't crash.
  //
  // Working-tree hygiene: kody runs on an ephemeral CI runner. By the time
  // this is called, earlier workflow steps (pnpm install, codegen) may have
  // dirtied tracked files (e.g. Payload's `importMap.js`). Hard-reset and
  // clean any such state — nothing of value lives in the runner's pre-
  // checkout tree, and a dirty tree would otherwise block `git checkout`.
  const branchName = deriveBranchName(issueNumber, title)
  resetWorkingTree(cwd)
  const current = getCurrentBranch(cwd)

  if (current === branchName) {
    return { branch: branchName, created: false }
  }

  try {
    git(["fetch", "origin"], cwd)
  } catch {
    /* best effort */
  }

  // When a base override is supplied (goal flow), an existing remote branch
  // is only a valid resume target if it descends from origin/<base>. A
  // cancelled prior run can leave behind a feature branch forked from main —
  // reusing it would silently put the task on the wrong base. Detect that
  // case and delete the stale ref so we re-fork below.
  let originBranchExists = false
  try {
    // Explicit remote-tracking ref (not a bare `origin/<name>` rev-parse,
    // which can resolve non-branch objects) so a stale tag/object can't be
    // mistaken for the remote branch.
    git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branchName}`], cwd)
    originBranchExists = true
  } catch {
    /* not on remote */
  }

  if (originBranchExists && baseBranch && baseBranch !== defaultBranch) {
    let baseExists = false
    try {
      git(["rev-parse", "--verify", `origin/${baseBranch}`], cwd)
      baseExists = true
    } catch {
      /* base missing — leave the existing branch alone, fall through to checkout */
    }
    if (baseExists) {
      let descendsFromBase = false
      try {
        git(["merge-base", "--is-ancestor", `origin/${baseBranch}`, `origin/${branchName}`], cwd)
        descendsFromBase = true
      } catch {
        /* not a descendant */
      }
      if (!descendsFromBase) {
        process.stderr.write(
          `[kody branch] origin/${branchName} does not descend from origin/${baseBranch} — recreating from base\n`,
        )
        try {
          git(["push", "origin", "--delete", branchName], cwd)
        } catch {
          /* may already be gone or no permission — continue and let the create path try */
        }
        try {
          git(["update-ref", "-d", `refs/remotes/origin/${branchName}`], cwd)
        } catch {
          /* best effort cleanup of local tracking ref */
        }
        // Also delete a stale local branch by the same name — checkout -b
        // below would otherwise fail with "branch already exists".
        try {
          git(["branch", "-D", branchName], cwd)
        } catch {
          /* probably no local branch — fine */
        }
        originBranchExists = false
      }
    }
  }

  if (originBranchExists) {
    // Rerun path: an existing feature branch + open PR means a prior run
    // already produced a draft. Resume-as-rerun used to merge origin/<default>
    // into the stale branch, which left the new PR contaminated with every
    // drift commit from the prior session. The dashboard's Rerun action
    // now expects a fresh start (close prior PRs, delete the branch, fork
    // again from default) so the new PR carries only the new work.
    //
    // Skipped when a caller-supplied `baseBranch` is in play (goal flow):
    // those branches are intentionally forked from a non-default base and
    // the earlier descends-from-base guard already handled corruption —
    // rerun cleanup would clobber a goal-stack PR.
    if (!baseBranch || baseBranch === defaultBranch) {
      try {
        cleanupExistingBranchForRerun(branchName, cwd)
      } catch (err) {
        // Cleanup is best-effort: a missing `gh` token or no open PRs is
        // not fatal. Surface the error to stderr so the operator can see
        // it in the GHA log, then fall through and let the create path
        // try — at worst we recreate the branch on top of stale tip.
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[kody branch] rerun cleanup failed for '${branchName}': ${msg}\n`)
      }
      originBranchExists = false
      // Also drop the local branch ref so the create path below doesn't
      // find it via `git rev-parse --verify refs/heads/<name>` and fall
      // through to the bare `checkout` (which would just reattach HEAD).
      try {
        git(["branch", "-D", branchName], cwd)
      } catch {
        /* probably no local branch — fine */
      }
    } else {
      // Goal-tick path: keep the original "reuse + merge default" behavior
      // (the descends-from-base check earlier already enforced freshness).
      git(["checkout", branchName], cwd)
      try {
        git(["pull", "origin", branchName], cwd)
      } catch {
        /* best effort */
      }
      return { branch: branchName, created: false }
    }
  }

  // Only treat this as "local branch already exists" if an actual local
  // BRANCH ref exists — verify `refs/heads/<name>` explicitly. A bare
  // `rev-parse --verify <name>` also resolves tags/abbrev-SHAs/other
  // objects, so a name that happens to look like an object would make
  // `git checkout <name>` detach HEAD onto the base and the later push
  // fail with "<name> cannot be resolved to branch". Forcing the
  // refs/heads/ path means we fall through to the create branch below
  // instead of detaching.
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], cwd)
    git(["checkout", branchName], cwd)
    return { branch: branchName, created: false }
  } catch {
    /* no local branch by that name — fall through to create it */
  }

  // Resolve fork point: caller-supplied base (if it exists on origin), else
  // defaultBranch. We verify origin/<base> rather than blindly trusting the
  // arg so a stale or wrong --base doesn't make `git checkout -b` blow up.
  let forkPoint = defaultBranch
  if (baseBranch && baseBranch !== defaultBranch) {
    try {
      git(["rev-parse", "--verify", `origin/${baseBranch}`], cwd)
      forkPoint = baseBranch
    } catch {
      // origin/<base> doesn't exist — silently fall back. The base override caller is
      // expected to have created the goal branch before dispatching, so
      // this path should be rare. Logged in callers via the resulting
      // branch name (still defaultBranch-derived).
    }
  }

  try {
    git(["checkout", "-b", branchName, `origin/${forkPoint}`], cwd)
  } catch {
    git(["checkout", "-b", branchName], cwd)
  }
  return { branch: branchName, created: true }
}
