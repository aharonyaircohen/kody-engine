import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// gh is invoked via execFileSync. Drive its result with plain module-level
// flags rather than the spy's own implementation: vitest fails any test where
// a vi.fn throws, even when the code under test catches it.
const execFileSyncSpy = vi.fn()
let execReturn: Buffer = Buffer.from("")
let execError: (Error & { stdout?: Buffer; stderr?: Buffer; status?: number }) | null = null
vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[], opts: unknown) => {
      execFileSyncSpy(cmd, args, opts)
      if (execError) throw execError
      return execReturn
    },
  }
})

import type { Context, Profile } from "../../src/executables/types.js"
import { mergeReleasePr } from "../../src/scripts/mergeReleasePr.js"
import { type Action, emptyState, type TaskState } from "../../src/state.js"

const profile = { name: "release" } as Profile

function ctxWithPr(prUrl?: string): Context {
  const taskState: TaskState = emptyState()
  if (prUrl !== undefined) taskState.core.prUrl = prUrl
  return {
    args: {},
    cwd: "/repo",
    config: {} as never,
    data: { taskState },
    output: { exitCode: 0 },
    skipAgent: false,
  }
}

function action(ctx: Context): Action {
  return ctx.data.action as Action
}

function ghError(detail: string, status = 1): Error & { stderr: Buffer; status: number } {
  return Object.assign(new Error("Command failed"), { stderr: Buffer.from(detail), status })
}

beforeEach(() => {
  execFileSyncSpy.mockReset()
  execReturn = Buffer.from("")
  execError = null
  vi.spyOn(process.stderr, "write").mockReturnValue(true)
})

afterEach(() => vi.restoreAllMocks())

describe("mergeReleasePr: input guards", () => {
  it("fails without invoking gh when there is no PR url", async () => {
    const ctx = ctxWithPr()
    await mergeReleasePr(ctx, profile, null)
    expect(execFileSyncSpy).not.toHaveBeenCalled()
    expect(action(ctx).type).toBe("RELEASE_MERGE_FAILED")
    expect(action(ctx).payload.reason).toBe("no prUrl on task state")
    expect((ctx.data.taskState as TaskState).core.lastOutcome?.type).toBe("RELEASE_MERGE_FAILED")
  })

  it("does not throw when there is no task state at all", async () => {
    const ctx: Context = {
      args: {},
      cwd: "/repo",
      config: {} as never,
      data: {},
      output: { exitCode: 0 },
      skipAgent: false,
    }
    await mergeReleasePr(ctx, profile, null)
    expect(action(ctx).type).toBe("RELEASE_MERGE_FAILED")
  })

  it("fails when the PR number cannot be parsed from the url", async () => {
    const ctx = ctxWithPr("https://github.com/o/r/issues/5")
    await mergeReleasePr(ctx, profile, null)
    expect(execFileSyncSpy).not.toHaveBeenCalled()
    expect(action(ctx).type).toBe("RELEASE_MERGE_FAILED")
    expect(action(ctx).payload.reason).toMatch(/cannot parse PR number/)
  })
})

describe("mergeReleasePr: merge outcomes", () => {
  it("merges the PR and records COMPLETED", async () => {
    const ctx = ctxWithPr("https://github.com/o/r/pull/42")
    await mergeReleasePr(ctx, profile, null)
    expect(execFileSyncSpy).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = execFileSyncSpy.mock.calls[0] as [string, string[], { cwd: string }]
    expect(cmd).toBe("gh")
    expect(args).toEqual(["pr", "merge", "42", "--merge"])
    expect(opts.cwd).toBe("/repo")
    expect(action(ctx).type).toBe("RELEASE_MERGE_COMPLETED")
    expect(action(ctx).payload).toMatchObject({ prUrl: "https://github.com/o/r/pull/42" })
    expect((ctx.data.taskState as TaskState).core.lastOutcome?.type).toBe("RELEASE_MERGE_COMPLETED")
  })

  it("parses the PR number even with a trailing path segment", async () => {
    const ctx = ctxWithPr("https://github.com/o/r/pull/77/files")
    await mergeReleasePr(ctx, profile, null)
    expect(execFileSyncSpy.mock.calls[0]![1] as string[]).toContain("77")
    expect(action(ctx).type).toBe("RELEASE_MERGE_COMPLETED")
  })

  it("treats an already-merged PR as COMPLETED (idempotent re-run)", async () => {
    execError = ghError("Pull request #42 is already merged")
    const ctx = ctxWithPr("https://github.com/o/r/pull/42")
    await mergeReleasePr(ctx, profile, null)
    expect(action(ctx).type).toBe("RELEASE_MERGE_COMPLETED")
    expect(action(ctx).payload).toMatchObject({ alreadyMerged: true })
  })

  it("records FAILED with gh's detail on a real merge rejection", async () => {
    execError = ghError("Pull request is not mergeable: the base branch policy prohibits the merge.")
    const ctx = ctxWithPr("https://github.com/o/r/pull/42")
    await mergeReleasePr(ctx, profile, null)
    expect(action(ctx).type).toBe("RELEASE_MERGE_FAILED")
    expect(action(ctx).payload.reason).toMatch(/base branch policy/)
    expect(action(ctx).payload.prUrl).toBe("https://github.com/o/r/pull/42")
  })
})
