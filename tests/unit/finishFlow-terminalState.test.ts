import { beforeEach, describe, expect, it, vi } from "vitest"

const execFileSyncSpy = vi.fn().mockReturnValue("")
vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[], opts: unknown) => execFileSyncSpy(cmd, args, opts),
  }
})

const writeTaskStateSpy = vi.fn()
vi.mock("../../src/state.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    writeTaskState: (target: unknown, n: unknown, state: unknown, cwd: unknown) =>
      writeTaskStateSpy(target, n, state, cwd),
  }
})

import type { Context, Profile } from "../../src/implementations/types.js"
import { finishFlow } from "../../src/scripts/finishFlow.js"

function makeState() {
  return {
    schemaVersion: 1,
    core: {
      phase: "reviewing",
      status: "running",
      currentImplementation: "review",
      lastOutcome: { type: "REVIEW_PASS", payload: {}, timestamp: "x" },
      attempts: {},
    },
    implementations: {},
    artifacts: {},
    history: [],
  }
}

function makeCtx(taskState: unknown): Context {
  return {
    args: { issue: 42 },
    cwd: "/tmp",
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    config: {} as any,
    data: { taskState, commentTargetType: "issue", commentTargetNumber: 42 },
    output: { exitCode: 0 },
  }
}

const profile = { name: "bug" } as Profile

describe("finishFlow: terminal state-mirror update", () => {
  beforeEach(() => {
    execFileSyncSpy.mockClear()
    writeTaskStateSpy.mockClear()
  })

  it("flips phase to 'shipped' + status 'succeeded' on review-passed", async () => {
    const state = makeState()
    await finishFlow(makeCtx(state), profile, null, { reason: "review-passed" })
    expect(writeTaskStateSpy).toHaveBeenCalledOnce()
    const written = writeTaskStateSpy.mock.calls[0]![2] as ReturnType<typeof makeState>
    expect(written.core.phase).toBe("shipped")
    expect(written.core.status).toBe("succeeded")
    expect(written.core.currentImplementation).toBeNull()
  })

  it("flips to 'shipped'/'succeeded' on fix-applied as well", async () => {
    const state = makeState()
    await finishFlow(makeCtx(state), profile, null, { reason: "fix-applied" })
    const written = writeTaskStateSpy.mock.calls[0]![2] as ReturnType<typeof makeState>
    expect(written.core.phase).toBe("shipped")
    expect(written.core.status).toBe("succeeded")
  })

  it("flips to 'failed'/'failed' on review-failed", async () => {
    const state = makeState()
    await finishFlow(makeCtx(state), profile, null, { reason: "review-failed" })
    const written = writeTaskStateSpy.mock.calls[0]![2] as ReturnType<typeof makeState>
    expect(written.core.phase).toBe("failed")
    expect(written.core.status).toBe("failed")
  })

  it("flips to 'failed'/'failed' on aborted", async () => {
    const state = makeState()
    await finishFlow(makeCtx(state), profile, null, { reason: "aborted" })
    const written = writeTaskStateSpy.mock.calls[0]![2] as ReturnType<typeof makeState>
    expect(written.core.phase).toBe("failed")
    expect(written.core.status).toBe("failed")
  })

  it("does not call writeTaskState when reason is unknown", async () => {
    const state = makeState()
    await finishFlow(makeCtx(state), profile, null, { reason: "weird-custom-reason" })
    expect(writeTaskStateSpy).not.toHaveBeenCalled()
  })

  it("does not call writeTaskState when state is missing", async () => {
    const ctx = {
      args: { issue: 42 },
      cwd: "/tmp",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      config: {} as any,
      data: { commentTargetType: "issue", commentTargetNumber: 42 },
      output: { exitCode: 0 },
    } as Context
    await finishFlow(ctx, profile, null, { reason: "review-passed" })
    expect(writeTaskStateSpy).not.toHaveBeenCalled()
  })

  it("targets the PR thread when commentTargetType is 'pr'", async () => {
    const state = makeState()
    const ctx = {
      args: { issue: 42 },
      cwd: "/tmp",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      config: {} as any,
      data: { taskState: state, commentTargetType: "pr", commentTargetNumber: 1573 },
      output: { exitCode: 0 },
    } as Context
    await finishFlow(ctx, profile, null, { reason: "review-passed" })
    expect(writeTaskStateSpy.mock.calls[0]![0]).toBe("pr")
    expect(writeTaskStateSpy.mock.calls[0]![1]).toBe(1573)
  })
})
