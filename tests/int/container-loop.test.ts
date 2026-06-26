import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { runContainerLoop } from "../../src/container.js"
import type { ExecutorInput, ExecutorOutput } from "../../src/executor.js"
import type { TaskState } from "../../src/state.js"

/**
 * Direct tests for the container loop (extracted from executor.ts). The loop
 * runs children sequentially in-process and routes on the action each child
 * emits into task-state. We drive it through the executor's built-in test
 * seams — `__runChild` (stub the child invocation) and `__readTaskState`
 * (stub the state each child "wrote") — so routing, idempotency, failure
 * synthesis, and the abort guards are exercised without spawning real
 * executables or touching GitHub.
 */

function state(opts: {
  attempts?: Record<string, number>
  lastAction?: { exec: string; type: string }
  prUrl?: string
}): TaskState {
  const executables: Record<string, unknown> = {}
  if (opts.lastAction) {
    executables[opts.lastAction.exec] = {
      lastAction: { type: opts.lastAction.type, payload: {}, timestamp: "2026-01-01T00:00:00Z" },
    }
  }
  return {
    schemaVersion: 1,
    core: {
      phase: "idle",
      status: "pending",
      currentExecutable: null,
      lastOutcome: null,
      attempts: opts.attempts ?? {},
      ...(opts.prUrl ? { prUrl: opts.prUrl } : {}),
    },
    executables,
    artifacts: {},
    history: [],
  } as unknown as TaskState
}

function makeProfile(children: Profile["children"], extra: Partial<Profile> = {}): Profile {
  return {
    name: "test-container",
    role: "container",
    children,
    // git reset between children is best-effort; with a tmp cwd it no-ops.
    ...extra,
  } as unknown as Profile
}

function makeCtx(cwd: string, issue?: number): Context {
  return {
    args: issue ? { issue } : {},
    cwd,
    config: {} as unknown,
    data: {},
    output: { exitCode: 0 },
  } as unknown as Context
}

describe("integration: container loop", () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-container-"))
  })
  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it("exits 0 with a reason when the container has no children", async () => {
    const ctx = makeCtx(cwd, 1)
    await runContainerLoop(makeProfile([]), ctx, { cliArgs: {}, cwd } as ExecutorInput)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.output.reason).toMatch(/no children/)
  })

  it("routes to 'done' when a child writes a completing action", async () => {
    const ctx = makeCtx(cwd, 7)
    const profile = makeProfile([{ exec: "stage1", target: "issue", next: { STAGE1_DONE: "done", "*": "abort" } }])
    const readQueue = [
      state({ attempts: { stage1: 0 } }), // prior
      state({ attempts: { stage1: 1 }, lastAction: { exec: "stage1", type: "STAGE1_DONE" } }), // next
    ]
    const runChild = vi.fn<(name: string, input: ExecutorInput) => Promise<ExecutorOutput>>(async () => ({
      exitCode: 0,
    }))
    let i = 0
    await runContainerLoop(profile, ctx, {
      cliArgs: {},
      cwd,
      __runChild: runChild,
      __readTaskState: () => readQueue[i++] ?? readQueue[readQueue.length - 1]!,
    } as ExecutorInput)

    expect(runChild).toHaveBeenCalledOnce()
    expect(runChild).toHaveBeenCalledWith("stage1", expect.objectContaining({ cliArgs: { issue: 7 } }))
    expect(ctx.output.exitCode).toBe(0)
  })

  it("synthesizes <EXEC>_FAILED and routes via wildcard when a failed child writes no action", async () => {
    const ctx = makeCtx(cwd, 9)
    const profile = makeProfile([{ exec: "stage1", target: "issue", next: { STAGE1_DONE: "done", "*": "abort" } }])
    // Both reads return unchanged attempts → childWrote is false → synthesize.
    const runChild = vi.fn<(name: string, input: ExecutorInput) => Promise<ExecutorOutput>>(async () => ({
      exitCode: 1,
      reason: "boom",
    }))
    await runContainerLoop(profile, ctx, {
      cliArgs: {},
      cwd,
      __runChild: runChild,
      __readTaskState: () => state({ attempts: { stage1: 0 } }),
    } as ExecutorInput)

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/aborted/)
  })

  it("chains across multiple children until a 'done' route", async () => {
    const ctx = makeCtx(cwd, 3)
    const profile = makeProfile([
      { exec: "stage1", target: "issue", next: { STAGE1_DONE: "stage2" } },
      { exec: "stage2", target: "issue", next: { STAGE2_DONE: "done" } },
    ])
    const readQueue = [
      state({ attempts: { stage1: 0 } }), // iter1 prior
      state({ attempts: { stage1: 1 }, lastAction: { exec: "stage1", type: "STAGE1_DONE" } }), // iter1 next
      state({ attempts: { stage1: 1, stage2: 0 } }), // iter2 prior
      state({ attempts: { stage1: 1, stage2: 1 }, lastAction: { exec: "stage2", type: "STAGE2_DONE" } }), // iter2 next
    ]
    let i = 0
    const runChild = vi.fn<(name: string, input: ExecutorInput) => Promise<ExecutorOutput>>(async () => ({
      exitCode: 0,
    }))
    await runContainerLoop(profile, ctx, {
      cliArgs: {},
      cwd,
      __runChild: runChild,
      __readTaskState: () => readQueue[i++] ?? readQueue[readQueue.length - 1]!,
    } as ExecutorInput)

    expect(runChild).toHaveBeenCalledTimes(2)
    expect(ctx.output.exitCode).toBe(0)
  })

  it("aborts when there is no route for the emitted action", async () => {
    const ctx = makeCtx(cwd, 5)
    const profile = makeProfile([{ exec: "stage1", target: "issue", next: { SOMETHING_ELSE: "done" } }])
    const readQueue = [
      state({ attempts: { stage1: 0 } }),
      state({ attempts: { stage1: 1 }, lastAction: { exec: "stage1", type: "STAGE1_DONE" } }),
    ]
    let i = 0
    await runContainerLoop(profile, ctx, {
      cliArgs: {},
      cwd,
      __runChild: async () => ({ exitCode: 0 }),
      __readTaskState: () => readQueue[i++] ?? readQueue[readQueue.length - 1]!,
    } as ExecutorInput)

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/no route/)
  })

  it("aborts a pr-target child when no PR url is known yet", async () => {
    const ctx = makeCtx(cwd, 11)
    const profile = makeProfile([{ exec: "review", target: "pr", next: { "*": "done" } }])
    const runChild = vi.fn<(name: string, input: ExecutorInput) => Promise<ExecutorOutput>>(async () => ({
      exitCode: 0,
    }))
    await runContainerLoop(profile, ctx, {
      cliArgs: {},
      cwd,
      __runChild: runChild,
      __readTaskState: () => state({}), // no prUrl anywhere
    } as ExecutorInput)

    expect(runChild).not.toHaveBeenCalled()
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/needs --pr/)
  })
})
