import { beforeEach, describe, expect, it, vi } from "vitest"

const writeTaskStateSpy = vi.fn()
// Throw via this plain flag rather than the spy's own implementation: vitest
// tracks (and fails on) errors raised inside a vi.fn even when the code under
// test catches them, so the throw must originate outside the spy.
let writeError: Error | null = null
vi.mock("../../src/state.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    writeTaskState: (target: unknown, n: unknown, state: unknown, cwd: unknown) => {
      writeTaskStateSpy(target, n, state, cwd)
      if (writeError) throw writeError
    },
  }
})

import type { Context, Profile } from "../../src/executables/types.js"
import { persistFlowState } from "../../src/scripts/persistFlowState.js"
import { emptyState, type TaskState } from "../../src/state.js"

const profile = { name: "orchestrator" } as Profile

function makeCtx(args: Record<string, unknown>, data: Record<string, unknown>): Context {
  return {
    args,
    cwd: "/repo",
    config: {} as never,
    data,
    output: { exitCode: 0 },
    skipAgent: false,
  }
}

function flowState(issueNumber?: number): TaskState {
  const s = emptyState()
  if (issueNumber !== undefined) s.flow = { issueNumber } as TaskState["flow"]
  return s
}

beforeEach(() => {
  writeTaskStateSpy.mockReset()
  writeError = null
})

describe("persistFlowState", () => {
  it("no-ops when there is no task state", async () => {
    await persistFlowState(makeCtx({ issue: 5 }, {}), profile, null)
    expect(writeTaskStateSpy).not.toHaveBeenCalled()
  })

  it("writes the state untouched to the issue from ctx.args.issue", async () => {
    const state = flowState()
    await persistFlowState(makeCtx({ issue: 7 }, { taskState: state }), profile, null)
    expect(writeTaskStateSpy).toHaveBeenCalledWith("issue", 7, state, "/repo")
  })

  it("falls back to state.flow.issueNumber when no issue arg is present", async () => {
    const state = flowState(99)
    await persistFlowState(makeCtx({}, { taskState: state }), profile, null)
    expect(writeTaskStateSpy).toHaveBeenCalledWith("issue", 99, state, "/repo")
  })

  it("prefers the explicit issue arg over the flow issue number", async () => {
    const state = flowState(99)
    await persistFlowState(makeCtx({ issue: 7 }, { taskState: state }), profile, null)
    expect(writeTaskStateSpy).toHaveBeenCalledWith("issue", 7, state, "/repo")
  })

  it("no-ops when no issue number can be resolved", async () => {
    await persistFlowState(makeCtx({}, { taskState: flowState() }), profile, null)
    expect(writeTaskStateSpy).not.toHaveBeenCalled()
  })

  it("swallows write errors and logs instead of throwing", async () => {
    writeError = new Error("gh exploded")
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    await expect(
      persistFlowState(makeCtx({ issue: 7 }, { taskState: flowState() }), profile, null),
    ).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalledOnce()
    expect(String(errSpy.mock.calls[0]![0])).toMatch(/failed to write state on issue #7/)
    errSpy.mockRestore()
  })
})
