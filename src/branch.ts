import { execFileSync } from "node:child_process"

export interface BranchResult {
  branch: string
  created: boolean
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
  return slug ? `${issueNumber}-${slug}` : `${issueNumber}`
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
    execFileSync("git", ["clean", "-fd"], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
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
 * would be overwritten by checkout" and crash the executable.
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
    execFileSync("git", ["clean", "-fd"], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
  } catch {
    /* best effort */
  }
  execFileSync("gh", ["pr", "checkout", String(prNumber)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })
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

export function ensureFeatureBranch(
  issueNumber: number,
  title: string,
  defaultBranch: string,
  cwd?: string,
  baseBranch?: string,
): BranchResult {
  // baseBranch: optional fork point. When provided (e.g. by goal-tick passing
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
    git(["rev-parse", "--verify", `origin/${branchName}`], cwd)
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
    git(["checkout", branchName], cwd)
    try {
      git(["pull", "origin", branchName], cwd)
    } catch {
      /* best effort */
    }
    return { branch: branchName, created: false }
  }

  try {
    git(["rev-parse", "--verify", branchName], cwd)
    git(["checkout", branchName], cwd)
    return { branch: branchName, created: false }
  } catch {
    /* not local either */
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
      // origin/<base> doesn't exist — silently fall back. The goal-tick is
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
