import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { performInit } from "../../src/scripts/initFlow.js"

function mkRepo(opts: { lockFile?: "pnpm-lock.yaml" | "yarn.lock" | "bun.lockb"; gitInit?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody2-init-"))
  if (opts.lockFile) fs.writeFileSync(path.join(dir, opts.lockFile), "")
  if (opts.gitInit) {
    execFileSync("git", ["init", "--initial-branch=main", "--quiet", dir], { stdio: "pipe" })
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/ACME/widgets.git"], { stdio: "pipe" })
  }
  return dir
}

describe("initFlow: performInit", () => {
  let dir: string
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("writes both files on a clean repo", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml", gitInit: true })
    const result = performInit(dir, false)
    expect(result.wrote.sort()).toEqual([".github/workflows/kody2.yml", "kody.config.json"])
    expect(result.skipped).toEqual([])
    expect(fs.existsSync(path.join(dir, "kody.config.json"))).toBe(true)
    expect(fs.existsSync(path.join(dir, ".github/workflows/kody2.yml"))).toBe(true)
  })

  it("detects package manager from lockfile", () => {
    dir = mkRepo({ lockFile: "yarn.lock", gitInit: true })
    performInit(dir, false)
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "kody.config.json"), "utf-8"))
    expect(cfg.quality.typecheck).toBe("yarn tsc --noEmit")
    expect(cfg.quality.testUnit).toBe("yarn test")
  })

  it("falls back to npm when no lockfile", () => {
    dir = mkRepo({ gitInit: true })
    performInit(dir, false)
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "kody.config.json"), "utf-8"))
    expect(cfg.quality.typecheck).toBe("npm tsc --noEmit")
  })

  it("detects owner/repo from git remote", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml", gitInit: true })
    performInit(dir, false)
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "kody.config.json"), "utf-8"))
    expect(cfg.github.owner).toBe("ACME")
    expect(cfg.github.repo).toBe("widgets")
  })

  it("falls back to OWNER/REPO placeholders without git", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml" })
    performInit(dir, false)
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "kody.config.json"), "utf-8"))
    expect(cfg.github.owner).toBe("OWNER")
    expect(cfg.github.repo).toBe("REPO")
  })

  it("is idempotent: skips existing files when force is false", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml", gitInit: true })
    performInit(dir, false)
    fs.writeFileSync(path.join(dir, "kody.config.json"), `{"user-edit":"keep me"}`)
    const second = performInit(dir, false)
    expect(second.wrote).toEqual([])
    expect(second.skipped.sort()).toEqual([".github/workflows/kody2.yml", "kody.config.json"])
    const after = fs.readFileSync(path.join(dir, "kody.config.json"), "utf-8")
    expect(after).toMatch(/user-edit/)
  })

  it("overwrites existing files when force is true", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml", gitInit: true })
    fs.writeFileSync(path.join(dir, "kody.config.json"), `{"user-edit":"stale"}`)
    const result = performInit(dir, true)
    expect(result.wrote).toContain("kody.config.json")
    const after = JSON.parse(fs.readFileSync(path.join(dir, "kody.config.json"), "utf-8"))
    expect(after.agent?.model).toBeDefined()
  })

  it("creates .github/workflows directory if missing", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml", gitInit: true })
    performInit(dir, false)
    const stat = fs.statSync(path.join(dir, ".github/workflows"))
    expect(stat.isDirectory()).toBe(true)
  })
})
