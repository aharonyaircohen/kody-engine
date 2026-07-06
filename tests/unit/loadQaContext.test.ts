import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { loadQaContext } from "../../src/scripts/loadQaContext.js"

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-qactx-load-"))
}

function makeCtx(cwd: string, args: Record<string, unknown> = {}): Context {
  return {
    args,
    cwd,
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/haiku" },
    },
    data: {},
    output: { exitCode: 0 },
  }
}

const dummyProfile = {} as Profile

function writeVariables(cwd: string, vars: Record<string, string>): void {
  const variables: Record<string, { value: string }> = {}
  for (const [k, v] of Object.entries(vars)) variables[k] = { value: v }
  const dir = path.join(cwd, ".kody")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "variables.json"), JSON.stringify({ version: 1, variables }))
}

describe("loadQaContext", () => {
  let tmp: string
  let prevPassword: string | undefined

  beforeEach(() => {
    tmp = mktmp()
    prevPassword = process.env.LOGIN_PASSWORD
    delete process.env.LOGIN_PASSWORD
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    if (prevPassword === undefined) delete process.env.LOGIN_PASSWORD
    else process.env.LOGIN_PASSWORD = prevPassword
  })

  it("reads LOGIN_USER from variables into qaLogin and the auth block (no password)", async () => {
    writeVariables(tmp, { LOGIN_USER: "qa@example.com" })
    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaLogin).toBe("qa@example.com")
    expect(ctx.data.qaAuthBlock).toContain("qa@example.com")
    expect(ctx.data.qaAuthBlock).toContain("no `LOGIN_PASSWORD` secret was found")
  })

  it("uses LOGIN_PASSWORD from process.env as fallback for the full login auth block", async () => {
    writeVariables(tmp, { LOGIN_USER: "qa@example.com" })
    process.env.LOGIN_PASSWORD = "hunter2"

    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaLogin).toBe("qa@example.com")
    expect(ctx.data.qaPasswordSource).toBe("env")
    expect(ctx.data.qaAuthBlock).toContain("qa@example.com")
    expect(ctx.data.qaAuthBlock).toContain("hunter2")
    expect(ctx.data.qaAuthBlock).toContain("Re-use the session")
  })

  it("falls back to login-only when LOGIN_PASSWORD is unset", async () => {
    writeVariables(tmp, { LOGIN_USER: "qa@example.com" })
    // LOGIN_PASSWORD intentionally unset.
    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaAuthBlock).not.toContain("hunter2")
    expect(ctx.data.qaAuthBlock).toContain("no `LOGIN_PASSWORD` secret was found")
  })

  it("includes only sections whose agent contains qa-engineer; legacy audience is mapped, unassigned/chat/legacy-less excluded", async () => {
    const profileDir = path.join(tmp, ".kody", "context")
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(
      path.join(profileDir, "scenarios.md"),
      "---\nagent: [qa-engineer]\n---\n\nCheck the checkout flow.",
    )
    // Multi-agent section — included in QA because the list contains qa-engineer.
    fs.writeFileSync(
      path.join(profileDir, "shared.md"),
      "---\nagent: [kody, qa-engineer]\n---\n\nSeed data lives in fixtures.",
    )
    // Legacy audience list → mapped (qa → qa-engineer) → included.
    fs.writeFileSync(path.join(profileDir, "legacy.md"), "---\naudience: [qa]\n---\n\nLegacy QA note.")
    // All-agent wildcard → belongs to every agent → included.
    fs.writeFileSync(path.join(profileDir, "everywhere.md"), "---\nagent: [*]\n---\n\nApplies to all agent.")
    fs.writeFileSync(path.join(profileDir, "mission.md"), "---\nagent: [kody]\n---\n\nWe sell widgets.")
    // Explicit empty list → unassigned → excluded from QA.
    fs.writeFileSync(path.join(profileDir, "draft.md"), "---\nagent: []\n---\n\nUnassigned draft.")
    // Frontmatter-less file → defaults to [kody] → excluded from QA.
    fs.writeFileSync(path.join(profileDir, "about.md"), "about")

    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    const qaProfile = ctx.data.qaProfile as string
    // qa-engineer sections are included, with filename headings, frontmatter stripped.
    expect(qaProfile).toContain("## scenarios.md")
    expect(qaProfile).toContain("Check the checkout flow.")
    expect(qaProfile).toContain("## shared.md")
    expect(qaProfile).toContain("Seed data lives in fixtures.")
    expect(qaProfile).toContain("## legacy.md")
    expect(qaProfile).toContain("Legacy QA note.")
    expect(qaProfile).toContain("## everywhere.md")
    expect(qaProfile).toContain("Applies to all agent.")
    // chat-only, unassigned, and frontmatter-less files are excluded.
    expect(qaProfile).not.toContain("We sell widgets.")
    expect(qaProfile).not.toContain("## mission.md")
    expect(qaProfile).not.toContain("Unassigned draft.")
    expect(qaProfile).not.toContain("## draft.md")
    expect(qaProfile).not.toContain("## about.md")
    // frontmatter must not leak into the prompt.
    expect(qaProfile).not.toContain("agent:")
    expect(qaProfile).not.toContain("audience:")
  })

  it("emits the no-creds auth block and empty qaProfile when nothing is configured", async () => {
    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaLogin).toBe("")
    expect(ctx.data.qaProfile).toBe("")
    expect(ctx.data.qaAuthBlock).toContain("no QA credentials configured")
    expect(ctx.data.qaAuthBlock).toContain("Browse public routes only")
  })

  it("emits the storageState auth block when --auth-profile is passed", async () => {
    const ctx = makeCtx(tmp, { authProfile: ".kody/qa-storage-state.json" })
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaAuthBlock).toContain(".kody/qa-storage-state.json")
    expect(ctx.data.qaAuthBlock).toContain("storageState")
  })
})
