import { describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { dispatchAgentResponsibilityFileTicks } from "../../src/scripts/dispatchAgentResponsibilityFileTicks.js"

const ghMock = vi.hoisted(() => vi.fn())
const runJobMock = vi.hoisted(() => vi.fn())

vi.mock("../../src/issue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/issue.js")>("../../src/issue.js")
  return { ...actual, gh: ghMock }
})

vi.mock("../../src/job.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/job.js")>("../../src/job.js")
  return { ...actual, runJob: runJobMock }
})

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

describe("dispatchAgentResponsibilityFileTicks multi-agentAction compatibility", () => {
  it("does not create task issues because flat responsibility fan-out is retired", async () => {
    const ctx = ctxFor()

    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {})

    expect(ghMock).not.toHaveBeenCalled()
    expect(runJobMock).not.toHaveBeenCalled()
    expect(ctx.skipAgent).toBe(true)
    expect(ctx.data.jobTickResults).toEqual([])
  })
})
