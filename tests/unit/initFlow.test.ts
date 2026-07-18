import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { performInit, renderScheduledWorkflow } from "../../src/scripts/initFlow.js"

function mkRepo(opts: { lockFile?: "pnpm-lock.yaml" | "yarn.lock" | "bun.lockb"; gitInit?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-init-"))
  if (opts.lockFile) fs.writeFileSync(path.join(dir, opts.lockFile), "")
  if (opts.gitInit) {
    execFileSync("git", ["init", "--initial-branch=main", "--quiet", dir], { stdio: "pipe" })
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/ACME/widgets.git"], {
      stdio: "pipe",
    })
  }
  return dir
}

describe("initFlow: performInit", () => {
  let dir: string
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("writes core files + scheduled workflows on a clean repo", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml", gitInit: true })
    const result = performInit(dir, false)
    expect(result.wrote).toContain("kody.config.json")
    expect(result.wrote).toContain(".github/workflows/kody.yml")
    expect(result.wrote.some((file) => file.startsWith(".kody/"))).toBe(false)
    // Every discovered scheduled implementation also gets its own workflow file.
    const scheduledWorkflows = result.wrote.filter((f) => /\.github\/workflows\/kody-.+\.yml$/.test(f))
    expect(scheduledWorkflows.length).toBeGreaterThanOrEqual(1)
    expect(result.skipped).toEqual([])
    expect(fs.existsSync(path.join(dir, "kody.config.json"))).toBe(true)
    expect(fs.existsSync(path.join(dir, ".github/workflows/kody.yml"))).toBe(true)
    const workflow = fs.readFileSync(path.join(dir, ".github/workflows/kody.yml"), "utf-8")
    expect(workflow).toContain("      capability:")
    expect(workflow).not.toContain("      implementation:")

    expect(result.wrote.some((file) => file.startsWith(".kody-engine/definitions/capabilities/"))).toBe(false)
    expect(fs.existsSync(path.join(dir, ".kody-engine/definitions/capabilities"))).toBe(false)
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
    expect(second.skipped).toContain("kody.config.json")
    expect(second.skipped).toContain(".github/workflows/kody.yml")
    expect(second.skipped.some((file) => file.startsWith(".kody/"))).toBe(false)
    expect(second.skipped.some((file) => file.startsWith(".kody-engine/definitions/capabilities/"))).toBe(false)
    const after = fs.readFileSync(path.join(dir, "kody.config.json"), "utf-8")
    expect(after).toMatch(/user-edit/)
  })

  it("does not manage local capability folders", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml", gitInit: true })
    const capabilityDir = path.join(dir, ".kody-engine/definitions/capabilities/local-only")
    fs.mkdirSync(capabilityDir, { recursive: true })
    const profilePath = path.join(capabilityDir, "profile.json")
    const bodyPath = path.join(capabilityDir, "capability.md")
    fs.writeFileSync(profilePath, `{"user-edit":"keep me on profile"}`)
    fs.writeFileSync(bodyPath, `# user-edited capability - do not clobber\n`)

    const result = performInit(dir, true)

    expect(result.wrote.some((file) => file.startsWith(".kody-engine/definitions/capabilities/"))).toBe(false)
    expect(result.skipped.some((file) => file.startsWith(".kody-engine/definitions/capabilities/"))).toBe(false)
    expect(fs.readFileSync(profilePath, "utf-8")).toMatch(/user-edit/)
    expect(fs.readFileSync(bodyPath, "utf-8")).toMatch(/user-edited capability/)
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

  it("does NOT scaffold a qa-guide (dashboard-managed QA context now)", () => {
    dir = mkRepo({ lockFile: "pnpm-lock.yaml", gitInit: true })
    fs.mkdirSync(path.join(dir, "src/app/login"), { recursive: true })
    fs.writeFileSync(path.join(dir, "src/app/page.tsx"), "export default () => null")
    fs.writeFileSync(path.join(dir, "src/app/login/page.tsx"), "export default () => null")
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }))

    const result = performInit(dir, false)
    expect(result.wrote).not.toContain(".kody/qa-guide.md")
    expect(fs.existsSync(path.join(dir, ".kody/qa-guide.md"))).toBe(false)
  })
})

describe("renderScheduledWorkflow", () => {
  it("sets up Python so non-Anthropic models (litellm) work on the scheduled path", () => {
    // Regression: scheduled workflows omitted Python, so litellm couldn't
    // install and scheduled capabilities failed on MiniMax/other non-Anthropic models.
    const yml = renderScheduledWorkflow("capability-scheduler", "*/5 * * * *")
    expect(yml).toMatch(/uses: actions\/setup-python/)
    expect(yml).toMatch(/python-version:/)
    expect(yml).toContain("kody-engine implementation capability-scheduler")
    expect(yml).toContain(
      "\n        run: npx -y -p @kody-ade/kody-engine@latest kody-engine implementation capability-scheduler",
    )
  })
})
