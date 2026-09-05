import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { commitAndPush, listChangedFiles } from "../../src/commit.js"

let root: string
let cwd: string
let remote: string
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}
function write(file: string, content: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true })
  writeFileSync(join(cwd, file), content)
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kody-delivery-safety-"))
  remote = join(root, "remote.git")
  cwd = join(root, "repo")
  git(root, "init", "--bare", remote)
  git(root, "clone", remote, cwd)
  git(cwd, "checkout", "-b", "main")
  git(cwd, "config", "user.name", "Test")
  git(cwd, "config", "user.email", "test@example.invalid")
  write("README.md", "initial\n")
  git(cwd, "add", ".")
  git(cwd, "commit", "-m", "initial")
  git(cwd, "push", "-u", "origin", "main")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("delivery through real git", () => {
  it("preserves both complete names in staged renames, including whitespace", () => {
    const source = "source name\nwith newline.txt"
    write(source, "content")
    git(cwd, "add", ".")
    git(cwd, "commit", "-m", "fixture")
    git(cwd, "mv", source, "destination.txt")
    expect(listChangedFiles(cwd).sort()).toEqual([source, "destination.txt"].sort())
  })

  it.each([
    "kody.config.json",
    ".env",
    ".github/workflows/ci.yml",
  ])("blocks both sides of a rename from protected %s", (source) => {
    write(source, "protected content")
    git(cwd, "add", ".")
    git(cwd, "commit", "-m", "fixture")
    git(cwd, "push")
    git(cwd, "mv", source, "backup.txt")
    write("README.md", "safe change\n")
    const result = commitAndPush("main", "fix: safe change", cwd)
    expect(result.pushed).toBe(true)
    expect(result.omittedFiles).toContain(source)
    expect(git(remote, "show", `main:${source}`)).toBe("protected content")
    expect(git(remote, "ls-tree", "--name-only", "main", "backup.txt")).toBe("")
    expect(git(remote, "show", "main:README.md")).toBe("safe change")
  })

  it("delivers an ordinary rename", () => {
    git(cwd, "mv", "README.md", "guide.md")
    const result = commitAndPush("main", "docs: rename guide", cwd)
    expect(result.pushed).toBe(true)
    expect(git(remote, "ls-tree", "--name-only", "main")).toBe("guide.md")
  })

  it("unstages a protected rename even when there is nothing else to deliver", () => {
    write("kody.config.json", "protected content")
    git(cwd, "add", ".")
    git(cwd, "commit", "-m", "fixture")
    git(cwd, "mv", "kody.config.json", "backup.txt")
    const head = git(cwd, "rev-parse", "HEAD")
    expect(commitAndPush("main", "chore: rename", cwd).committed).toBe(false)
    expect(git(cwd, "diff", "--cached", "--name-only")).toBe("")
    expect(git(cwd, "rev-parse", "HEAD")).toBe(head)
  })

  it("blocks a rename into a protected destination without deleting its source", () => {
    git(cwd, "mv", "README.md", ".env")
    write("safe.txt", "safe")
    const result = commitAndPush("main", "fix: safe change", cwd)
    expect(result.pushed).toBe(true)
    expect(git(remote, "show", "main:README.md")).toBe("initial")
    expect(git(remote, "ls-tree", "--name-only", "main", ".env")).toBe("")
  })

  it("delivers first-time activation through the allowlisted configuration boundary", () => {
    write("kody.config.json", JSON.stringify({ company: {} }))
    git(cwd, "add", ".")
    git(cwd, "commit", "-m", "fixture")
    const config = { company: { activeCapabilities: ["example"] } }
    write("kody.config.json", JSON.stringify(config))
    const result = commitAndPush("main", "chore: activate", cwd, ["kody.config.json"])
    expect(result.pushed).toBe(true)
    expect(JSON.parse(git(remote, "show", "main:kody.config.json"))).toEqual(config)
  })

  it("returns the commit actually pushed after concurrent changes require a rebase", () => {
    const other = join(root, "other")
    git(root, "clone", "-b", "main", remote, other)
    git(other, "config", "user.name", "Test")
    git(other, "config", "user.email", "test@example.invalid")
    writeFileSync(join(other, "other.txt"), "other\n")
    git(other, "add", ".")
    git(other, "commit", "-m", "concurrent")
    git(other, "push")
    write("local.txt", "local\n")
    const result = commitAndPush("main", "feat: local", cwd)
    expect(result.pushed).toBe(true)
    expect(result.sha).toBe(git(remote, "rev-parse", "main").slice(0, 7))
    expect(readFileSync(join(cwd, "other.txt"), "utf8")).toBe("other\n")
  })
})
