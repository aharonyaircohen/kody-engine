import { describe, expect, it, vi } from "vitest"
import type { PrOutcome } from "../../src/scripts/prOutcome.js"
import { readPrOutcome } from "../../src/scripts/prOutcome.js"

// Note: ensurePr's full integration with `gh pr create` is exercised by the
// existing pr.test.ts and ensurePrCoverageShape.test.ts. This file pins the
// new contract: every code path must set ctx.data.prResult to a typed
// PrOutcome — no path may leave it undefined.

describe("readPrOutcome", () => {
  it("returns null when ctx.data.prResult is missing", () => {
    expect(readPrOutcome({})).toBeNull()
  })

  it("returns null for a non-object value", () => {
    expect(readPrOutcome({ prResult: "garbage" })).toBeNull()
    expect(readPrOutcome({ prResult: 42 })).toBeNull()
  })

  it("returns null for an object without a recognized kind", () => {
    expect(readPrOutcome({ prResult: { kind: "bogus" } })).toBeNull()
    expect(readPrOutcome({ prResult: {} })).toBeNull()
    // Legacy untyped shape from the old code path — must not be accepted
    // as a PrOutcome (forces consumers to migrate).
    expect(readPrOutcome({ prResult: { action: "created", url: "x" } })).toBeNull()
  })

  it("returns each of the four typed kinds verbatim", () => {
    const cases: PrOutcome[] = [
      { kind: "created", url: "u", number: 1, draft: true },
      { kind: "updated", url: "u", number: 1, draft: false },
      { kind: "skipped", reason: "verify failed" },
      { kind: "crashed", reason: "boom" },
    ]
    for (const c of cases) {
      expect(readPrOutcome({ prResult: c })).toEqual(c)
    }
  })
})

// Smoke test: import ensurePr and confirm it exports a function. (Full
// behavioral coverage is in pr.test.ts.)
describe("ensurePr export shape", () => {
  it("exports a postflight function", async () => {
    const mod = await import("../../src/scripts/ensurePr.js")
    expect(typeof mod.ensurePr).toBe("function")
  })
})

describe("checkpoint delivery", () => {
  it("provides the reason that keeps the pull request in draft", async () => {
    const { deliveryCheckpointReason } = await import("../../src/scripts/ensurePr.js")
    expect(deliveryCheckpointReason({ capabilityDeliveryPolicy: "checkpoint" })).toMatch(/deferred to pull request CI/i)
    expect(deliveryCheckpointReason({})).toBe("")
  })
})

// Anti-regression: when ensurePr's preconditions aren't met (e.g. no commits),
// the typed outcome must still be set. Imports the real module and runs it
// with a minimal ctx.
describe("ensurePr precondition-skip path", () => {
  it("does not treat successful script execution as a preflight failure", async () => {
    const { shouldSkipPrForPreflight } = await import("../../src/scripts/ensurePr.js")
    expect(
      shouldSkipPrForPreflight({
        skipAgent: true,
        output: { exitCode: 0 },
        data: { capabilityExecution: "script" },
      }),
    ).toBe(false)
    expect(
      shouldSkipPrForPreflight({
        skipAgent: true,
        output: { exitCode: 64 },
        data: {},
      }),
    ).toBe(true)
  })

  it("sets prResult.kind=skipped when there is nothing to ship", async () => {
    const { ensurePr } = await import("../../src/scripts/ensurePr.js")
    const ctx = {
      args: {},
      cwd: "/tmp",
      config: { git: { defaultBranch: "main" } } as never,
      data: {
        // commitResult missing AND hasCommitsAhead false → "nothing to ship"
      } as Record<string, unknown>,
      output: {} as { exitCode?: number; prUrl?: string; reason?: string },
      skipAgent: false,
    }
    await ensurePr(ctx as never, { name: "run" } as never, null)
    const outcome = readPrOutcome(ctx.data)
    expect(outcome?.kind).toBe("skipped")
    expect((outcome as { reason?: string })?.reason).toMatch(/no commits to ship/i)
  })

  it("sets prResult.kind=skipped when verifyOk === false", async () => {
    const { ensurePr } = await import("../../src/scripts/ensurePr.js")
    const ctx = {
      args: {},
      cwd: "/tmp",
      config: { git: { defaultBranch: "main" } } as never,
      data: {
        commitResult: { committed: true, pushed: true },
        verifyOk: false,
        verifyReason: "tsc errors",
      } as Record<string, unknown>,
      output: {} as { exitCode?: number; prUrl?: string; reason?: string },
      skipAgent: false,
    }
    await ensurePr(ctx as never, { name: "run" } as never, null)
    const outcome = readPrOutcome(ctx.data)
    expect(outcome?.kind).toBe("skipped")
    expect((outcome as { reason?: string })?.reason).toMatch(/verify failed.*tsc errors/i)
  })

  it("sets prResult.kind=skipped when commit succeeded but push failed", async () => {
    const { ensurePr } = await import("../../src/scripts/ensurePr.js")
    const ctx = {
      args: {},
      cwd: "/tmp",
      config: { git: { defaultBranch: "main" } } as never,
      data: {
        commitResult: { committed: true, pushed: false },
        verifyOk: true,
      } as Record<string, unknown>,
      output: {} as { exitCode?: number; prUrl?: string; reason?: string },
      skipAgent: false,
    }
    await ensurePr(ctx as never, { name: "run" } as never, null)
    const outcome = readPrOutcome(ctx.data)
    expect(outcome?.kind).toBe("skipped")
    expect((outcome as { reason?: string })?.reason).toMatch(/push failed/i)
  })
})

// Suppress unused vi import warning by exercising the mock surface in one
// trivial assertion. (The function-level tests above already use real impls.)
describe("vi available", () => {
  it("can construct a stub", () => {
    const fn = vi.fn(() => 1)
    expect(fn()).toBe(1)
  })
})
