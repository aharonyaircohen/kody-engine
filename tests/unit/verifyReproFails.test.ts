import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

// A fake child process: a spawn() returns this, and we drive stdout/exit
// from the test via the recorded options. vi.hoisted shares the spy with
// the mock factory (hoisted above all top-level code).
const mocks = vi.hoisted(() => {
  let nextRun: { exitCode: number; output?: string; chunks?: string[]; emitError?: string } = {
    exitCode: 1,
    output: "",
  }
  const spawn = vi.fn((command: string) => {
    void command
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
      killed: boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    child.killed = false
    // Drive output + exit on the next tick so listeners are attached first.
    queueMicrotask(() => {
      if (nextRun.emitError) {
        child.emit("error", new Error(nextRun.emitError))
        return
      }
      const chunks = nextRun.chunks ?? (nextRun.output ? [nextRun.output] : [])
      for (const chunk of chunks) child.stdout.emit("data", Buffer.from(chunk, "utf-8"))
      child.emit("exit", nextRun.exitCode)
    })
    return child
  })
  return {
    spawn,
    setNextRun: (run: { exitCode: number; output?: string; chunks?: string[]; emitError?: string }) => {
      nextRun = run
    },
  }
})

vi.mock("node:child_process", async (orig) => {
  const actual = (await orig()) as typeof import("node:child_process")
  return { ...actual, spawn: mocks.spawn }
})

import type { Context, Profile } from "../../src/executables/types.js"
import { verifyReproFails } from "../../src/scripts/verifyReproFails.js"

const profile = { name: "reproduce" } as Profile

const SIGNATURE = {
  errorType: "AssertionError",
  messageContains: "expected 5 but got 4",
  stackContains: "src/calc.ts",
}

function makeCtx(data: Record<string, unknown> = {}, testUnit = "vitest run"): Context {
  return {
    args: {},
    cwd: "/repo",
    config: { quality: { testUnit } } as never,
    data,
    output: { exitCode: 0 },
    skipAgent: false,
  }
}

function reproData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: { type: "REPRODUCE_COMPLETED", payload: {}, timestamp: "" },
    reproTestPath: "tests/repro-issue-42.test.ts",
    reproFailureSignature: JSON.stringify(SIGNATURE),
    ...over,
  }
}

describe("verifyReproFails", () => {
  beforeEach(() => {
    mocks.spawn.mockClear()
    mocks.setNextRun({ exitCode: 1, output: "" })
  })

  it("no-ops when parseReproOutput already downgraded (agentDone === false)", async () => {
    const ctx = makeCtx({ agentDone: false, action: { type: "REPRODUCE_FAILED", payload: {}, timestamp: "" } })
    await verifyReproFails(ctx, profile, null)
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(ctx.data.reproVerified).toBeUndefined()
    expect(ctx.data.agentDone).toBe(false)
  })

  it("downgrades when testPath is missing", async () => {
    const ctx = makeCtx(reproData({ reproTestPath: "" }))
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string }).type).toBe("REPRODUCE_FAILED")
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it("downgrades when the signature is not valid JSON", async () => {
    const ctx = makeCtx(reproData({ reproFailureSignature: "{not json" }))
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string }).type).toBe("REPRODUCE_FAILED")
    expect((ctx.data.action as { payload: { reason: string } }).payload.reason).toContain("not valid JSON")
  })

  it("downgrades when quality.testUnit is empty", async () => {
    const ctx = makeCtx(reproData(), "")
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { payload: { reason: string } }).payload.reason).toContain("testUnit is empty")
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it("downgrades when the test exits 0 (bug not actually reproduced)", async () => {
    mocks.setNextRun({ exitCode: 0, output: "all tests passed" })
    const ctx = makeCtx(reproData())
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.reproVerifyExitCode).toBe(0)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { payload: { reason: string } }).payload.reason).toContain("exited 0")
  })

  it("verifies success when exit is non-zero and signature matches", async () => {
    mocks.setNextRun({
      exitCode: 1,
      output: "AssertionError: expected 5 but got 4\n  at src/calc.ts:10",
    })
    const ctx = makeCtx(reproData())
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.reproVerified).toBe(true)
    expect(ctx.data.reproVerifyExitCode).toBe(1)
    expect(ctx.data.agentDone).not.toBe(false)
    expect(typeof ctx.data.reproVerifyTail).toBe("string")
  })

  it("downgrades when the failure message substring is absent", async () => {
    mocks.setNextRun({ exitCode: 1, output: "AssertionError: something totally different" })
    const ctx = makeCtx(reproData())
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.reproVerified).toBeUndefined()
    expect(ctx.data.agentDone).toBe(false)
    const reason = (ctx.data.action as { payload: { reason: string } }).payload.reason
    expect(reason).toContain("messageContains")
  })

  it("downgrades when the errorType substring is absent", async () => {
    mocks.setNextRun({ exitCode: 1, output: "expected 5 but got 4 — but no error type token here" })
    const ctx = makeCtx(reproData())
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    const reason = (ctx.data.action as { payload: { reason: string } }).payload.reason
    expect(reason).toContain("errorType")
  })

  it("passes when signature fields are empty (matching disabled)", async () => {
    mocks.setNextRun({ exitCode: 2, output: "boom, some unrelated failure output" })
    const ctx = makeCtx(reproData({ reproFailureSignature: JSON.stringify({ errorType: "", messageContains: "" }) }))
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.reproVerified).toBe(true)
  })

  it("appends the test path for known positional runners (vitest)", async () => {
    mocks.setNextRun({ exitCode: 1, output: "AssertionError: expected 5 but got 4 at src/calc.ts" })
    const ctx = makeCtx(reproData(), "vitest run")
    await verifyReproFails(ctx, profile, null)
    const cmd = mocks.spawn.mock.calls[0]?.[0] as string
    expect(cmd).toBe("vitest run tests/repro-issue-42.test.ts")
  })

  it("does NOT append the test path for unknown runners (full suite)", async () => {
    mocks.setNextRun({ exitCode: 1, output: "AssertionError: expected 5 but got 4 at src/calc.ts" })
    const ctx = makeCtx(reproData({ reproTestPath: "tests/repro.test.ts" }), "make test")
    await verifyReproFails(ctx, profile, null)
    const cmd = mocks.spawn.mock.calls[0]?.[0] as string
    expect(cmd).toBe("make test")
  })

  it("shell-quotes a test path containing spaces", async () => {
    mocks.setNextRun({ exitCode: 1, output: "AssertionError: expected 5 but got 4 at src/calc.ts" })
    const ctx = makeCtx(reproData({ reproTestPath: "tests/has space.test.ts" }), "jest")
    await verifyReproFails(ctx, profile, null)
    const cmd = mocks.spawn.mock.calls[0]?.[0] as string
    expect(cmd).toBe("jest 'tests/has space.test.ts'")
  })

  it("strips ANSI escape codes before matching the signature", async () => {
    mocks.setNextRun({
      exitCode: 1,
      output: "\x1B[31mAssertionError: expected 5 but got 4\x1B[0m at src/calc.ts",
    })
    const ctx = makeCtx(reproData())
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.reproVerified).toBe(true)
    expect(ctx.data.reproVerifyTail).not.toContain("\x1B[")
  })

  it("treats a spawn 'error' event as a failed run and downgrades", async () => {
    mocks.setNextRun({ exitCode: -1, output: "", emitError: "spawn ENOENT" })
    const ctx = makeCtx(reproData())
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.reproVerifyExitCode).toBe(-1)
    // exit code is non-zero, but the error message won't match the signature.
    expect(ctx.data.agentDone).toBe(false)
  })

  it("retains only the tail when output streams in over the buffer cap", async () => {
    // Emit many chunks far exceeding TAIL_CHARS * 4 so the buffer-trim loop
    // (buffers.shift) runs, then end with a matching signature so the tail
    // still contains it.
    const filler = Array.from({ length: 50 }, () => "z".repeat(2000))
    const tailMatch = "AssertionError: expected 5 but got 4 at src/calc.ts"
    mocks.setNextRun({ exitCode: 1, chunks: [...filler, tailMatch] })
    const ctx = makeCtx(reproData())
    await verifyReproFails(ctx, profile, null)
    expect(ctx.data.reproVerified).toBe(true)
    const tail = ctx.data.reproVerifyTail as string
    expect(tail).toContain("expected 5 but got 4")
    expect(tail.length).toBeLessThanOrEqual(8000)
  })
})
