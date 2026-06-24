import { describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { dispatchAgentResponsibilityFileTicks } from "../../src/scripts/dispatchAgentResponsibilityFileTicks.js"

vi.mock("../../src/executor.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/executor.js")>("../../src/executor.js")
  return { ...actual, runAgentAction: vi.fn() }
})

import { runAgentAction } from "../../src/executor.js"

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

describe("dispatchAgentResponsibilityFileTicks", () => {
  it("is a compatibility no-op because goals and loops own responsibility cadence", async () => {
    const ctx = ctxFor()

    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {})

    expect(runAgentAction).not.toHaveBeenCalled()
    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.output.reason).toContain("responsibility scheduling")
    expect(ctx.output.reason).toContain("goals")
    expect(ctx.output.reason).toContain("loops")
    expect(ctx.data.jobTickResults).toEqual([])
  })
})
