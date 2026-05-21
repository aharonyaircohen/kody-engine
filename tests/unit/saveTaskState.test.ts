import { beforeEach, describe, expect, it, vi } from "vitest"

const writeTaskStateSpy = vi.fn()
vi.mock("../../src/state.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    writeTaskState: (target: unknown, n: unknown, state: unknown, cwd: unknown) =>
      writeTaskStateSpy(target, n, state, cwd),
  }
})

import type { Context, Profile } from "../../src/executables/types.js"
import { saveTaskState } from "../../src/scripts/saveTaskState.js"
import { type Action, emptyState, type TaskState } from "../../src/state.js"

const profile = { name: "run" } as Profile

function makeCtx(overrides: {
  data?: Record<string, unknown>
  output?: Partial<Context["output"]>
}): Context {
  return {
    args: {},
    cwd: "/repo",
    config: {} as never,
    data: overrides.data ?? {},
    output: { exitCode: 0, ...overrides.output },
    skipAgent: false,
  }
}

function targetedData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commentTargetType: "issue",
    commentTargetNumber: 42,
    taskState: emptyState(),
    ...extra,
  }
}

beforeEach(() => writeTaskStateSpy.mockClear())

describe("saveTaskState: guard clauses", () => {
  it("no-ops when the comment target type is absent", async () => {
    await saveTaskState(makeCtx({ data: { commentTargetNumber: 1, taskState: emptyState() } }), profile, null)
    expect(writeTaskStateSpy).not.toHaveBeenCalled()
  })

  it("no-ops when the target number is absent", async () => {
    await saveTaskState(makeCtx({ data: { commentTargetType: "issue", taskState: emptyState() } }), profile, null)
    expect(writeTaskStateSpy).not.toHaveBeenCalled()
  })

  it("no-ops when there is no task state", async () => {
    await saveTaskState(makeCtx({ data: { commentTargetType: "issue", commentTargetNumber: 1 } }), profile, null)
    expect(writeTaskStateSpy).not.toHaveBeenCalled()
  })
})

describe("saveTaskState: persistence", () => {
  it("writes the reduced state to the resolved target and renders it", async () => {
    const action: Action = { type: "RUN_COMPLETED", payload: {}, timestamp: "2026-01-01T00:00:00Z" }
    const ctx = makeCtx({ data: targetedData({ action }) })
    await saveTaskState(ctx, profile, null)

    expect(writeTaskStateSpy).toHaveBeenCalledTimes(1)
    const [target, number, next, cwd] = writeTaskStateSpy.mock.calls[0] as [string, number, TaskState, string]
    expect(target).toBe("issue")
    expect(number).toBe(42)
    expect(cwd).toBe("/repo")
    expect(next.core.lastOutcome?.type).toBe("RUN_COMPLETED")
    expect(next.core.currentExecutable).toBe("run")
    expect(typeof ctx.data.taskStateRendered).toBe("string")
  })

  it("synthesizes RUN_COMPLETED when no action and exit code is 0", async () => {
    const ctx = makeCtx({ data: targetedData(), output: { exitCode: 0 } })
    await saveTaskState(ctx, profile, null)
    const next = writeTaskStateSpy.mock.calls[0]![2] as TaskState
    expect(next.core.lastOutcome?.type).toBe("RUN_COMPLETED")
    expect(next.core.status).toBe("succeeded")
  })

  it("synthesizes RUN_FAILED when no action and exit code is non-zero", async () => {
    const ctx = makeCtx({ data: targetedData(), output: { exitCode: 2, reason: "boom" } })
    await saveTaskState(ctx, profile, null)
    const next = writeTaskStateSpy.mock.calls[0]![2] as TaskState
    expect(next.core.lastOutcome?.type).toBe("RUN_FAILED")
    expect(next.core.status).toBe("failed")
  })

  it("propagates a freshly created PR url into the persisted state", async () => {
    const ctx = makeCtx({ data: targetedData(), output: { exitCode: 0, prUrl: "https://github.com/x/y/pull/9" } })
    await saveTaskState(ctx, profile, null)
    const next = writeTaskStateSpy.mock.calls[0]![2] as TaskState
    expect(next.core.prUrl).toBe("https://github.com/x/y/pull/9")
  })

  it("propagates runUrl from ctx.data into the persisted state", async () => {
    const ctx = makeCtx({ data: targetedData({ runUrl: "https://github.com/x/y/actions/runs/1" }) })
    await saveTaskState(ctx, profile, null)
    const next = writeTaskStateSpy.mock.calls[0]![2] as TaskState
    expect(next.core.runUrl).toBe("https://github.com/x/y/actions/runs/1")
  })
})
