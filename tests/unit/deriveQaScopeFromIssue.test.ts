import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { getIssue } from "../../src/issue.js"
import { deriveQaScopeFromIssue } from "../../src/scripts/deriveQaScopeFromIssue.js"

vi.mock("../../src/issue.js", () => ({
  getIssue: vi.fn(),
}))

function makeCtx(args: Record<string, unknown>): Context {
  return {
    args,
    cwd: "/tmp/repo",
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "owner", repo: "repo" },
      agent: { model: "model" },
    },
    data: {},
    output: { exitCode: 0 },
  }
}

const profile = {} as Profile

describe("deriveQaScopeFromIssue", () => {
  beforeEach(() => {
    vi.mocked(getIssue).mockReset()
  })

  it("derives a scoped changelog QA title", async () => {
    vi.mocked(getIssue).mockReturnValueOnce({ title: "QA: Remove free-registration button (#312)" } as never)
    const ctx = makeCtx({ issue: 687 })

    await deriveQaScopeFromIssue(ctx, profile)

    expect(ctx.args.scope).toBe("Remove free-registration button")
  })

  it("leaves broad sweep issues unscoped", async () => {
    vi.mocked(getIssue).mockReturnValueOnce({ title: "QA sweep 2026-07-01" } as never)
    const ctx = makeCtx({ issue: 688 })

    await deriveQaScopeFromIssue(ctx, profile)

    expect(ctx.args.scope).toBeUndefined()
  })

  it("does not override an explicit scope", async () => {
    const ctx = makeCtx({ issue: 687, scope: "manual scope" })

    await deriveQaScopeFromIssue(ctx, profile)

    expect(getIssue).not.toHaveBeenCalled()
    expect(ctx.args.scope).toBe("manual scope")
  })
})
