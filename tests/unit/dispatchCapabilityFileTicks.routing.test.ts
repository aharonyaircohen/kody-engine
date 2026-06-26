import { describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { dispatchCapabilityFileTicks } from "../../src/scripts/dispatchCapabilityFileTicks.js"

vi.mock("../../src/executor.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/executor.js")>("../../src/executor.js")
  return { ...actual, runExecutable: vi.fn() }
})

import { runExecutable } from "../../src/executor.js"

const PROFILE = {} as unknown as Profile

function ctxFor(): Context {
  return {
    args: {},
    cwd: process.cwd(),
    config: {
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "anthropic/test" },
    },
    data: {},
    output: { exitCode: 0 },
  } as unknown as Context
}

describe("dispatchCapabilityFileTicks", () => {
  it("is a compatibility no-op because goals and loops own capability cadence", async () => {
    const ctx = ctxFor()

    await dispatchCapabilityFileTicks(ctx, PROFILE, {})

    expect(runExecutable).not.toHaveBeenCalled()
    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.output.reason).toContain("capability scheduling")
    expect(ctx.output.reason).toContain("goals")
    expect(ctx.output.reason).toContain("loops")
    expect(ctx.data.jobTickResults).toEqual([])
  })
})
