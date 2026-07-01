import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ensureFeatureBranch, getCurrentBranch } from "../../src/branch.js"

/**
 * Stability guard for the branch-setup → `.kody`-asset-survival bug class
 * (engine v0.4.196–198). Consumer repos track their capability assets at
 * `.kody/capabilities/<name>/` but `.gitignore` ignores `.kody/*` and
 * re-includes them via a negation (`!.kody/capabilities/**`). On an ephemeral
 * CI runner, branch setup's `git clean -fd` directory-walk over that
 * negated-ignore pattern could nuke the whole `.kody/capabilities/<name>`
 * dir — so the next preflight (composePrompt) crashed with "no prompt
 * template found" (readdir ENOENT).
 *
 * The fix is twofold in src/branch.ts: `git clean -fd -e .kody` excludes the
 * tree, and `restoreKodyAssets` (`git checkout HEAD -- .kody`) rematerialises
 * anything the checkout dropped. These only ever broke live (env-specific),
 * never in unit tests — this integration test exercises the real git
 * sequence in a temp repo so the regression can't ship silently again.
 */

interface TempRepo {
  workdir: string
  cleanup: () => void
}

const GIT_ENV = {
  ...process.env,
  HUSKY: "0",
  SKIP_HOOKS: "1",
  GIT_AUTHOR_NAME: "Kody Test",
  GIT_AUTHOR_EMAIL: "test@kody",
  GIT_COMMITTER_NAME: "Kody Test",
  GIT_COMMITTER_EMAIL: "test@kody",
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8", cwd, env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] }).trim()
}

/**
 * A consumer repo with a tracked capability under the negated-ignore path —
 * the exact shape that triggered the bug.
 */
function makeConsumerRepo(): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-branch-"))
  const remote = path.join(root, "remote.git")
  const workdir = path.join(root, "work")
  fs.mkdirSync(workdir, { recursive: true })

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" })
  execFileSync("git", ["init", "--initial-branch=main", workdir], { stdio: "pipe" })
  git(workdir, ["remote", "add", "origin", remote])

  // Consumer .gitignore: ignore .kody/* but re-include tracked capabilities.
  fs.writeFileSync(path.join(workdir, ".gitignore"), ".kody/*\n!.kody/capabilities/\n!.kody/capabilities/**\n")
  fs.writeFileSync(path.join(workdir, "README.md"), "# consumer\n")
  const execDir = path.join(workdir, ".kody", "capabilities", "run")
  fs.mkdirSync(execDir, { recursive: true })
  fs.writeFileSync(path.join(execDir, "prompt.md"), "do the thing\n")
  fs.writeFileSync(path.join(execDir, "profile.json"), '{"name":"run"}\n')

  git(workdir, ["add", "-A"])
  git(workdir, ["commit", "--no-gpg-sign", "-m", "initial with tracked .kody capability"])
  git(workdir, ["push", "-u", "origin", "main"])

  return {
    workdir,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
  }
}

describe("integration: branch setup preserves tracked .kody assets", () => {
  let repo: TempRepo

  beforeEach(() => {
    repo = makeConsumerRepo()
  })
  afterEach(() => {
    repo.cleanup()
  })

  it("keeps .kody/capabilities/<name> intact when creating a feature branch", () => {
    const promptPath = path.join(repo.workdir, ".kody", "capabilities", "run", "prompt.md")
    expect(fs.existsSync(promptPath)).toBe(true)

    // Simulate an ephemeral runner: dirty a tracked file and drop untracked
    // junk (build artifacts, runtime bookkeeping) into the tree — exactly the
    // state `git clean -fd` is meant to wipe, INCLUDING junk under .kody/.
    fs.writeFileSync(path.join(repo.workdir, "README.md"), "# dirtied\n")
    fs.writeFileSync(path.join(repo.workdir, "untracked-artifact.tmp"), "junk\n")
    fs.mkdirSync(path.join(repo.workdir, ".kody", "runtime"), { recursive: true })
    fs.writeFileSync(path.join(repo.workdir, ".kody", "runtime", "scratch.json"), "{}\n")

    const result = ensureFeatureBranch(42, "Add a feature", "main", repo.workdir)

    expect(result.created).toBe(true)
    expect(getCurrentBranch(repo.workdir)).toBe("42-add-a-feature")
    // The load-bearing assertion: the tracked capability survived branch setup.
    expect(fs.existsSync(promptPath)).toBe(true)
    expect(fs.readFileSync(promptPath, "utf-8")).toBe("do the thing\n")
    expect(fs.existsSync(path.join(repo.workdir, ".kody", "capabilities", "run", "profile.json"))).toBe(true)
    // And the tree was actually cleaned (proves we exercised reset+clean, not a no-op).
    expect(fs.existsSync(path.join(repo.workdir, "untracked-artifact.tmp"))).toBe(false)
  })

  it("restores .kody assets even after they are removed from the working tree", () => {
    const promptPath = path.join(repo.workdir, ".kody", "capabilities", "run", "prompt.md")

    // Reproduce the worst case directly: the capability dir is gone from the
    // working tree (as the buggy `git clean -fd` left it). ensureFeatureBranch's
    // restoreKodyAssets (`git checkout HEAD -- .kody`) must bring it back.
    fs.rmSync(path.join(repo.workdir, ".kody", "capabilities"), { recursive: true, force: true })
    expect(fs.existsSync(promptPath)).toBe(false)

    ensureFeatureBranch(43, "Another feature", "main", repo.workdir)

    expect(fs.existsSync(promptPath)).toBe(true)
    expect(fs.readFileSync(promptPath, "utf-8")).toBe("do the thing\n")
  })
})
