import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"

const mocks = vi.hoisted(() => ({
  readTaskState: vi.fn(),
  writeTaskState: vi.fn(),
  setKodyLabel: vi.fn(),
}))

vi.mock("../../src/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state.js")>()
  return {
    ...actual,
    readTaskState: mocks.readTaskState,
    writeTaskState: mocks.writeTaskState,
  }
})

vi.mock("../../src/lifecycleLabels.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lifecycleLabels.js")>()
  return {
    ...actual,
    setKodyLabel: mocks.setKodyLabel,
  }
})

import { finalizeTerminal } from "../../src/scripts/finalizeTerminal.js"
import { mirrorStateToPr } from "../../src/scripts/mirrorStateToPr.js"
import { saveTaskState } from "../../src/scripts/saveTaskState.js"
import { emptyState, type TaskState } from "../../src/state.js"

function state(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...emptyState(),
    ...overrides,
    core: { ...emptyState().core, ...(overrides.core ?? {}) },
  }
}

function ctx(taskState: TaskState, overrides: Partial<Context> = {}): Context {
  return {
    args: { issue: 42 },
    cwd: "/tmp/repo",
    config: { state: { repo: "acme/kody-state", path: "widgets" } } as Context["config"],
    data: {
      taskState,
      commentTargetType: "issue",
      commentTargetNumber: 42,
    },
    output: { exitCode: 0 },
    ...overrides,
  }
}

const runProfile = {
  name: "run",
  phase: "implementing",
  agent: "kody",
  lifecycleConfig: { finalize: true },
} as unknown as Profile

describe("task state finalization caching", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("saveTaskState writes reviewing state for standalone PR-producing runs", async () => {
    const taskState = state()
    const c = ctx(taskState, {
      output: {
        exitCode: 0,
        prUrl: "https://github.com/acme/widgets/pull/88",
      },
    })

    await saveTaskState(c, runProfile, null)

    expect(mocks.writeTaskState).toHaveBeenCalledOnce()
    const written = mocks.writeTaskState.mock.calls[0]![2] as TaskState
    expect(written.core.phase).toBe("reviewing")
    expect(written.core.status).toBe("succeeded")
    expect(written.core.currentImplementation).toBeNull()
    expect(c.data.taskState).toBe(written)
  })

  it("saveTaskState writes terminal failed state when a standalone finalizing run has no PR", async () => {
    const c = ctx(state(), { output: { exitCode: 0 } })

    await saveTaskState(c, runProfile, null)

    expect(mocks.writeTaskState).toHaveBeenCalledOnce()
    const written = mocks.writeTaskState.mock.calls[0]![2] as TaskState
    expect(written.core.phase).toBe("failed")
    expect(written.core.status).toBe("failed")
    expect(written.core.currentImplementation).toBeNull()
  })

  it("saveTaskState writes terminal shipped state when no delivery is needed", async () => {
    const c = ctx(state(), { output: { exitCode: 0 } })
    c.data.deliveryOutcome = { kind: "not_required", reason: "work already satisfied; no PR needed" }

    await saveTaskState(c, runProfile, null)

    expect(mocks.writeTaskState).toHaveBeenCalledOnce()
    const written = mocks.writeTaskState.mock.calls[0]![2] as TaskState
    expect(written.core.phase).toBe("shipped")
    expect(written.core.status).toBe("succeeded")
    expect(written.core.currentImplementation).toBeNull()
  })

  it("saveTaskState does not terminalize child flow runs", async () => {
    const taskState = state({
      flow: {
        name: "plan-build-review",
        step: "run",
        issueNumber: 42,
        startedAt: "2026-06-28T00:00:00.000Z",
      },
    })

    await saveTaskState(
      ctx(taskState, {
        output: {
          exitCode: 0,
          prUrl: "https://github.com/acme/widgets/pull/88",
        },
      }),
      runProfile,
      null,
    )

    const written = mocks.writeTaskState.mock.calls[0]![2] as TaskState
    expect(written.core.phase).toBe("implementing")
    expect(written.core.status).toBe("succeeded")
    expect(written.core.currentImplementation).toBe("run")
    expect(written.flow?.issueNumber).toBe(42)
  })

  it("mirrorStateToPr reuses cached issue state instead of reading it again", async () => {
    const taskState = state({
      core: { ...emptyState().core, prUrl: "https://github.com/acme/widgets/pull/88" },
    })

    await mirrorStateToPr(ctx(taskState), runProfile, null)

    expect(mocks.readTaskState).not.toHaveBeenCalled()
    expect(mocks.writeTaskState).toHaveBeenCalledWith("pr", 88, taskState, "/tmp/repo", expect.any(Object))
  })

  it("mirrorStateToPr injects a new PR URL without mutating the prior cached state", async () => {
    const taskState = state()
    const c = ctx(taskState, {
      output: {
        exitCode: 0,
        prUrl: "https://github.com/acme/widgets/pull/88",
      },
    })

    await mirrorStateToPr(c, runProfile, null)

    const mirrored = mocks.writeTaskState.mock.calls[0]![2] as TaskState
    expect(mirrored.core.prUrl).toBe("https://github.com/acme/widgets/pull/88")
    expect(taskState.core.prUrl).toBeUndefined()
    expect(c.data.taskState).toBe(mirrored)
  })

  it("mirrorStateToPr falls back to reading issue state when no cached state exists", async () => {
    const taskState = state({
      core: { ...emptyState().core, prUrl: "https://github.com/acme/widgets/pull/88" },
    })
    mocks.readTaskState.mockReturnValueOnce(taskState)
    const c = ctx(state(), {
      data: {
        commentTargetType: "issue",
        commentTargetNumber: 42,
      },
      output: {
        exitCode: 0,
        prUrl: "https://github.com/acme/widgets/pull/88",
      },
    })

    await mirrorStateToPr(c, runProfile, null)

    expect(mocks.readTaskState).toHaveBeenCalledWith("issue", 42, "/tmp/repo", expect.any(Object))
    expect(mocks.writeTaskState).toHaveBeenCalledWith("pr", 88, taskState, "/tmp/repo", expect.any(Object))
  })

  it("finalizeTerminal reuses already-reviewing cached state and avoids a second state write", async () => {
    const taskState = state({
      core: {
        ...emptyState().core,
        phase: "reviewing",
        status: "succeeded",
        currentImplementation: null,
        prUrl: "https://github.com/acme/widgets/pull/88",
      },
    })

    await finalizeTerminal(ctx(taskState), runProfile, null)

    expect(mocks.readTaskState).not.toHaveBeenCalled()
    expect(mocks.writeTaskState).not.toHaveBeenCalled()
    expect(mocks.setKodyLabel).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ label: "kody:reviewing" }),
      "/tmp/repo",
    )
    expect(mocks.setKodyLabel).toHaveBeenCalledWith(
      88,
      expect.objectContaining({ label: "kody:reviewing" }),
      "/tmp/repo",
    )
  })

  it("finalizeTerminal writes failed terminal state from cached nonterminal state", async () => {
    const c = ctx(state(), { output: { exitCode: 1 } })

    await finalizeTerminal(c, runProfile, null)

    expect(mocks.readTaskState).not.toHaveBeenCalled()
    expect(mocks.setKodyLabel).toHaveBeenCalledWith(42, expect.objectContaining({ label: "kody:failed" }), "/tmp/repo")
    expect(mocks.writeTaskState).toHaveBeenCalledOnce()
    const written = mocks.writeTaskState.mock.calls[0]![2] as TaskState
    expect(written.core.phase).toBe("failed")
    expect(written.core.status).toBe("failed")
    expect(written.core.currentImplementation).toBeNull()
    expect(c.data.taskState).toBe(written)
  })

  it("finalizeTerminal stamps done when no delivery is needed", async () => {
    const c = ctx(state(), { output: { exitCode: 0 } })
    c.data.deliveryOutcome = { kind: "not_required", reason: "work already satisfied; no PR needed" }

    await finalizeTerminal(c, runProfile, null)

    expect(mocks.setKodyLabel).toHaveBeenCalledWith(42, expect.objectContaining({ label: "kody:done" }), "/tmp/repo")
    expect(mocks.writeTaskState).toHaveBeenCalledOnce()
    const written = mocks.writeTaskState.mock.calls[0]![2] as TaskState
    expect(written.core.phase).toBe("shipped")
    expect(written.core.status).toBe("succeeded")
    expect(written.core.currentImplementation).toBeNull()
  })

  it("finalizeTerminal falls back to reading task state when no cached state exists", async () => {
    const taskState = state({
      core: { ...emptyState().core, prUrl: "https://github.com/acme/widgets/pull/88" },
    })
    mocks.readTaskState.mockReturnValueOnce(taskState)
    const c = ctx(state(), {
      data: {
        commentTargetType: "issue",
        commentTargetNumber: 42,
      },
      output: {
        exitCode: 0,
        prUrl: "https://github.com/acme/widgets/pull/88",
      },
    })

    await finalizeTerminal(c, runProfile, null)

    expect(mocks.readTaskState).toHaveBeenCalledWith("issue", 42, "/tmp/repo", expect.any(Object))
    expect(mocks.setKodyLabel).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ label: "kody:reviewing" }),
      "/tmp/repo",
    )
    expect(mocks.setKodyLabel).toHaveBeenCalledWith(
      88,
      expect.objectContaining({ label: "kody:reviewing" }),
      "/tmp/repo",
    )
    expect(mocks.writeTaskState).toHaveBeenCalledOnce()
    const written = mocks.writeTaskState.mock.calls[0]![2] as TaskState
    expect(written.core.phase).toBe("reviewing")
    expect(written.core.status).toBe("succeeded")
  })

  it("finalizeTerminal leaves child flow runs untouched", async () => {
    const taskState = state({
      flow: {
        name: "plan-build-review",
        step: "run",
        issueNumber: 42,
        startedAt: "2026-06-28T00:00:00.000Z",
      },
    })

    await finalizeTerminal(ctx(taskState), runProfile, null)

    expect(mocks.setKodyLabel).not.toHaveBeenCalled()
    expect(mocks.readTaskState).not.toHaveBeenCalled()
    expect(mocks.writeTaskState).not.toHaveBeenCalled()
  })
})
