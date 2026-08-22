import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { deriveBranchName, ensureFeatureBranch, getCurrentBranch } from "../../src/branch.js"
import { commitAndPush, hasCommitsAhead, listChangedFiles } from "../../src/commit.js"

interface TempRepo {
  workdir: string
  remote: string
  cleanup: () => void
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    cwd,
    env: {
      ...process.env,
      HUSKY: "0",
      SKIP_HOOKS: "1",
      GIT_AUTHOR_NAME: "Kody Test",
      GIT_AUTHOR_EMAIL: "test@kody",
      GIT_COMMITTER_NAME: "Kody Test",
      GIT_COMMITTER_EMAIL: "test@kody",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

function makeTempRepo(): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-int-"))
  const remote = path.join(root, "remote.git")
  const workdir = path.join(root, "work")
  fs.mkdirSync(workdir, { recursive: true })

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" })
  execFileSync("git", ["init", "--initial-branch=main", workdir], { stdio: "pipe" })
  git(workdir, ["remote", "add", "origin", remote])
  fs.writeFileSync(path.join(workdir, "README.md"), "# initial\n")
  git(workdir, ["add", "."])
  git(workdir, ["commit", "--no-gpg-sign", "-m", "initial"])
  git(workdir, ["push", "-u", "origin", "main"])

  return {
    workdir,
    remote,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
  }
}

describe("integration: git flow", () => {
  let repo: TempRepo

  beforeEach(() => {
    repo = makeTempRepo()
  })
  afterEach(() => {
    repo.cleanup()
  })

  it("creates a feature branch from main", () => {
    const result = ensureFeatureBranch(123, "Add cool thing", "main", repo.workdir)
    expect(result.branch).toBe(deriveBranchName(123, "Add cool thing"))
    expect(result.created).toBe(true)
    expect(getCurrentBranch(repo.workdir)).toBe(result.branch)
  })

  it("re-enters existing feature branch idempotently", () => {
    ensureFeatureBranch(7, "X", "main", repo.workdir)
    git(repo.workdir, ["checkout", "main"])
    const second = ensureFeatureBranch(7, "X", "main", repo.workdir)
    expect(second.created).toBe(false)
    expect(getCurrentBranch(repo.workdir)).toBe(second.branch)
  })

  it("resets tracked-file modifications before checkout (ephemeral CI tree)", () => {
    // kody runs on a fresh runner where pnpm install / codegen can dirty
    // tracked files (e.g. Payload's importMap.js). ensureFeatureBranch
    // hard-resets so the next branch op isn't blocked by leftover edits.
    ensureFeatureBranch(8, "Y", "main", repo.workdir)
    fs.writeFileSync(path.join(repo.workdir, "README.md"), "# initial\nWIP edit\n")
    expect(() => ensureFeatureBranch(8, "Y", "main", repo.workdir)).not.toThrow()
    expect(fs.readFileSync(path.join(repo.workdir, "README.md"), "utf-8")).toBe("# initial\n")
  })

  it("removes untracked files too (no work-in-progress protection)", () => {
    ensureFeatureBranch(81, "Z", "main", repo.workdir)
    fs.writeFileSync(path.join(repo.workdir, "scratch.tmp"), "junk")
    expect(() => ensureFeatureBranch(81, "Z", "main", repo.workdir)).not.toThrow()
    expect(fs.existsSync(path.join(repo.workdir, "scratch.tmp"))).toBe(false)
  })

  it("commits allowed files and pushes to remote", () => {
    const branch = ensureFeatureBranch(9, "Edit Z", "main", repo.workdir).branch
    fs.writeFileSync(path.join(repo.workdir, "src.txt"), "content")
    fs.mkdirSync(path.join(repo.workdir, "node_modules"), { recursive: true })
    fs.writeFileSync(path.join(repo.workdir, "node_modules/x.txt"), "should be excluded")

    expect(listChangedFiles(repo.workdir).length).toBeGreaterThan(0)

    const result = commitAndPush(branch, "feat: add stuff", repo.workdir)
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.message).toBe("feat: add stuff")
    expect(hasCommitsAhead(branch, "main", repo.workdir)).toBe(true)

    const log = git(repo.workdir, ["log", "--oneline", "-1"])
    expect(log).toMatch(/feat: add stuff/)

    const trackedFiles = git(repo.workdir, ["ls-files"]).split("\n")
    expect(trackedFiles).toContain("src.txt")
    expect(trackedFiles.find((f) => f.startsWith("node_modules/"))).toBeUndefined()
  })

  it("never commits GitHub YAML alongside a source-code repair", () => {
    const branch = ensureFeatureBranch(91, "Repair source only", "main", repo.workdir).branch
    fs.writeFileSync(path.join(repo.workdir, "src.txt"), "repaired")
    fs.mkdirSync(path.join(repo.workdir, ".github", "workflows"), { recursive: true })
    fs.writeFileSync(path.join(repo.workdir, ".github", "workflows", "ci.yml"), "name: changed\n")

    const result = commitAndPush(branch, "fix: repair source", repo.workdir)

    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)
    expect(git(repo.workdir, ["show", "--name-only", "--pretty=format:", "HEAD"]).split("\n")).toEqual(["src.txt"])
    expect(fs.existsSync(path.join(repo.workdir, ".github", "workflows", "ci.yml"))).toBe(true)
  })

  it("commits an ignored Store file only when its delivery contract allows it", () => {
    const branch = ensureFeatureBranch(92, "Install Store loop", "main", repo.workdir).branch
    fs.writeFileSync(path.join(repo.workdir, ".gitignore"), ".kody-engine/\n")
    git(repo.workdir, ["add", ".gitignore"])
    git(repo.workdir, ["commit", "--no-gpg-sign", "-m", "chore: ignore runtime state"])
    git(repo.workdir, ["push", "-u", "origin", branch])

    const loopPath = ".kody-engine/definitions/loops/web-release/loop.json"
    fs.mkdirSync(path.join(repo.workdir, path.dirname(loopPath)), { recursive: true })
    fs.writeFileSync(path.join(repo.workdir, loopPath), '{"id":"web-release"}\n')

    const withoutContract = commitAndPush(branch, "chore: install loop", repo.workdir)
    expect(withoutContract.committed).toBe(false)

    const withContract = commitAndPush(branch, "chore: install loop", repo.workdir, [
      ".kody-engine/definitions/loops/**",
    ])
    expect(withContract.committed).toBe(true)
    expect(git(repo.workdir, ["show", "--name-only", "--pretty=format:", "HEAD"]).split("\n")).toEqual([loopPath])
  })

  it("normalizes commit prefix when missing", () => {
    const branch = ensureFeatureBranch(10, "Edit W", "main", repo.workdir).branch
    fs.writeFileSync(path.join(repo.workdir, "x.txt"), "y")
    const result = commitAndPush(branch, "just an edit", repo.workdir)
    expect(result.message.startsWith("chore: ")).toBe(true)
  })

  it("commits when no git identity is configured (fresh CI runner)", () => {
    const branch = ensureFeatureBranch(12, "No identity", "main", repo.workdir).branch
    fs.writeFileSync(path.join(repo.workdir, "doc.md"), "hello")

    // Reproduce a containerized runner where git has NO identity and refuses to
    // invent one: a global config with user.useConfigOnly=true and no name/email
    // (a Mac/dev box would otherwise auto-derive user@hostname and hide the bug).
    // The temp repo has no local identity either, so without a fallback
    // `git commit` aborts with "user.useConfigOnly … no name was given" — the
    // exact failure that broke dogfooding @kody on the engine repo.
    const globalCfg = path.join(repo.workdir, "..", "fake-global.gitconfig")
    fs.writeFileSync(globalCfg, "[user]\n\tuseConfigOnly = true\n")
    const saved = { ...process.env }
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    process.env.GIT_CONFIG_GLOBAL = globalCfg
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL
    delete process.env.GIT_COMMITTER_NAME
    delete process.env.GIT_COMMITTER_EMAIL
    try {
      const result = commitAndPush(branch, "docs: add doc", repo.workdir)
      expect(result.committed).toBe(true)
    } finally {
      process.env = saved
    }
  })

  it("returns committed=false when only forbidden files changed", () => {
    const branch = ensureFeatureBranch(11, "Only excluded", "main", repo.workdir).branch
    fs.mkdirSync(path.join(repo.workdir, ".kody"), { recursive: true })
    fs.writeFileSync(path.join(repo.workdir, ".kody/run.jsonl"), "x")
    const result = commitAndPush(branch, "feat: bogus", repo.workdir)
    expect(result.committed).toBe(false)
    expect(hasCommitsAhead(branch, "main", repo.workdir)).toBe(false)
  })
})
