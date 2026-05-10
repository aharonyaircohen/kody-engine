import { describe, expect, it, vi } from "vitest"
import { applyTestRetries, summarizeFailure, type VerifyResult } from "../../src/verify.js"

function makeRunResult(exitCode: number, tail = ""): { exitCode: number; durationMs: number; tail: string } {
  return { exitCode, durationMs: 100, tail }
}

const TEST_CMD = "vitest run"

describe("applyTestRetries: rerun-on-flake for the `test` command", () => {
  it("returns recovered=[] when initial result is already ok (no retry needed)", async () => {
    const initial: VerifyResult = {
      ok: true,
      failed: [],
      details: {
        typecheck: makeRunResult(0),
        test: makeRunResult(0),
        lint: makeRunResult(0),
        format: makeRunResult(0),
      },
    }
    const runner = vi.fn(async () => makeRunResult(0))
    const result = await applyTestRetries(initial, TEST_CMD, undefined, runner, 2)
    expect(result.ok).toBe(true)
    expect(result.recovered).toEqual([])
    expect(runner).not.toHaveBeenCalled()
  })

  it("retries `test` and recovers when a retry passes (flake caught)", async () => {
    const initial: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: { test: makeRunResult(1, "FAIL: flaky test") },
    }
    let calls = 0
    const runner = vi.fn(async () => {
      calls++
      return makeRunResult(calls === 1 ? 1 : 0)
    })
    const result = await applyTestRetries(initial, TEST_CMD, undefined, runner, 2)
    expect(result.ok).toBe(true)
    expect(result.failed).toEqual([])
    expect(result.recovered).toEqual(["test"])
    expect(runner).toHaveBeenCalledTimes(2)
    expect(result.details["test (retry 1)"]).toBeDefined()
    expect(result.details["test (retry 2)"]).toBeDefined()
  })

  it("retries `test` and gives up when every retry fails (real failure)", async () => {
    const initial: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: { test: makeRunResult(1, "FAIL: real bug") },
    }
    const runner = vi.fn(async () => makeRunResult(1, "FAIL: still red"))
    const result = await applyTestRetries(initial, TEST_CMD, undefined, runner, 2)
    expect(result.ok).toBe(false)
    expect(result.failed).toEqual(["test"])
    expect(result.recovered).toEqual([])
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it("does NOT retry typecheck/lint/format failures (those are deterministic)", async () => {
    const initial: VerifyResult = {
      ok: false,
      failed: ["typecheck", "lint"],
      details: {
        typecheck: makeRunResult(2, "TS errors"),
        lint: makeRunResult(1, "lint errors"),
      },
    }
    const runner = vi.fn(async () => makeRunResult(0))
    const result = await applyTestRetries(initial, TEST_CMD, undefined, runner, 5)
    expect(result.ok).toBe(false)
    expect(result.failed).toEqual(["typecheck", "lint"])
    expect(result.recovered).toEqual([])
    expect(runner).not.toHaveBeenCalled()
  })

  it("when test AND typecheck fail: retries test only; even if test recovers, typecheck still fails the run", async () => {
    const initial: VerifyResult = {
      ok: false,
      failed: ["typecheck", "test"],
      details: {
        typecheck: makeRunResult(2, "TS errors"),
        test: makeRunResult(1, "flake"),
      },
    }
    const runner = vi.fn(async () => makeRunResult(0))
    const result = await applyTestRetries(initial, TEST_CMD, undefined, runner, 1)
    expect(result.ok).toBe(false)
    expect(result.failed).toEqual(["typecheck"])
    expect(result.recovered).toEqual(["test"])
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it("respects testRetries=0 (disables retry entirely)", async () => {
    const initial: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: { test: makeRunResult(1, "FAIL") },
    }
    const runner = vi.fn(async () => makeRunResult(0))
    const result = await applyTestRetries(initial, TEST_CMD, undefined, runner, 0)
    expect(result.ok).toBe(false)
    expect(result.failed).toEqual(["test"])
    expect(result.recovered).toEqual([])
    expect(runner).not.toHaveBeenCalled()
  })

  it("stops retrying as soon as a retry passes (does not waste budget)", async () => {
    const initial: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: { test: makeRunResult(1) },
    }
    const runner = vi.fn(async () => makeRunResult(0))
    const result = await applyTestRetries(initial, TEST_CMD, undefined, runner, 5)
    expect(result.ok).toBe(true)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it("does not retry when testCommand is undefined (nothing to rerun)", async () => {
    const initial: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: { test: makeRunResult(1) },
    }
    const runner = vi.fn(async () => makeRunResult(0))
    const result = await applyTestRetries(initial, undefined, undefined, runner, 2)
    expect(runner).not.toHaveBeenCalled()
    expect(result.recovered).toEqual([])
  })

  it("does not mutate the initial result object", async () => {
    const initial: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: { test: makeRunResult(1) },
    }
    const initialFailedRef = initial.failed
    const initialDetailsRef = initial.details
    await applyTestRetries(initial, TEST_CMD, undefined, async () => makeRunResult(0), 1)
    expect(initial.failed).toBe(initialFailedRef)
    expect(initial.details).toBe(initialDetailsRef)
    expect(initial.failed).toEqual(["test"])
    expect(initial.details["test (retry 1)"]).toBeUndefined()
  })
})

describe("summarizeFailure: includes retry attempts in the failure summary", () => {
  it("renders retry attempts under the test command when present", () => {
    const result: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: {
        test: makeRunResult(1, "first attempt fail"),
        "test (retry 1)": makeRunResult(1, "second attempt fail"),
        "test (retry 2)": makeRunResult(1, "third attempt fail"),
      },
    }
    const summary = summarizeFailure(result)
    expect(summary).toContain("verify failed: test")
    expect(summary).toContain("first attempt fail")
    expect(summary).toContain("retry 1")
    expect(summary).toContain("second attempt fail")
    expect(summary).toContain("retry 2")
    expect(summary).toContain("third attempt fail")
  })

  it("renders only the initial failure when no retries were recorded", () => {
    const result: VerifyResult = {
      ok: false,
      failed: ["typecheck"],
      details: { typecheck: makeRunResult(2, "TS errors") },
    }
    const summary = summarizeFailure(result)
    expect(summary).toContain("verify failed: typecheck")
    expect(summary).toContain("TS errors")
    expect(summary).not.toContain("retry 1")
  })
})
