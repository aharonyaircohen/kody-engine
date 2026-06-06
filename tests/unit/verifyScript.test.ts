/**
 * Unit tests for the `verify` POSTFLIGHT SCRIPT (`src/scripts/verify.ts`).
 *
 * Note: the underlying `verifyAllWithRetry` / `summarizeFailure` library
 * functions in `src/verify.ts` are tested separately in verify.test.ts.
 * Here we test the postflight's behavior: it sets ctx.data flags, downgrades
 * a `*_COMPLETED` action when verify fails (so saveTaskState records the
 * truth), and surfaces crashes as a verify failure rather than a thrown
 * error that would crash the postflight chain.
 *
 * Mocks `src/verify.ts` so the script doesn't actually shell out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyAllWithRetry = vi.fn()
const summarizeFailure = vi.fn((r: { failed: string[] }) => `failed: ${r.failed.join(", ")}`)

vi.mock("../../src/verify.js", () => ({
  verifyAllWithRetry: (...args: unknown[]) => verifyAllWithRetry(...args),
  summarizeFailure: (...args: unknown[]) => summarizeFailure(...(args as [Parameters<typeof summarizeFailure>[0]])),
}))

import { verify } from "../../src/scripts/verify.js"
import type { Context, Profile } from "../../src/executables/types.js"
import type { Action } from "../../src/state.js"

const profile = {} as unknown as Profile

function makeCtx(action?: Action): Context {
  return {
    args: {},
    cwd: "/x",
    config: {
      quality: { typecheck: "", testUnit: "", lint: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
    } as never,
    data: action ? { action } : {},
    output: { exitCode: 0 } as { exitCode: number; reason?: string },
  } as unknown as Context
}

describe("verify postflight: success path", () => {
  beforeEach(() => {
    verifyAllWithRetry.mockReset()
    summarizeFailure.mockClear()
  })

  it("marks verifyOk=true and leaves a *_COMPLETED action alone", async () => {
    verifyAllWithRetry.mockResolvedValueOnce({ ok: true, failed: [], details: {} })
    const action: Action = { type: "RUN_COMPLETED", payload: {}, timestamp: "2026-06-06T00:00:00Z" }
    const ctx = makeCtx(action)
    await verify(ctx, profile, null, undefined)
    expect(ctx.data.verifyOk).toBe(true)
    expect(ctx.data.verifyReason).toBe("")
    // Action is preserved when verify passes — finishFlow's
    // exit-code mapping reads from this directly.
    expect((ctx.data.action as Action).type).toBe("RUN_COMPLETED")
  })

  it("surfaces the recovered-flake list so the dashboard can credit the retry", async () => {
    verifyAllWithRetry.mockResolvedValueOnce({
      ok: true,
      failed: [],
      details: {},
      recovered: ["test"],
    })
    const ctx = makeCtx()
    await verify(ctx, profile, null, undefined)
    expect(ctx.data.verifyRecovered).toEqual(["test"])
  })
})

describe("verify postflight: failure path", () => {
  beforeEach(() => {
    verifyAllWithRetry.mockReset()
    summarizeFailure.mockClear()
  })

  it("marks verifyOk=false and records the failure reason", async () => {
    verifyAllWithRetry.mockResolvedValueOnce({
      ok: false,
      failed: ["typecheck"],
      details: { typecheck: { exitCode: 1, durationMs: 200, tail: "TS error" } },
    })
    const ctx = makeCtx()
    await verify(ctx, profile, null, undefined)
    expect(ctx.data.verifyOk).toBe(false)
    expect(ctx.data.verifyReason).toMatch(/failed: typecheck/)
  })

  it("downgrades a *_COMPLETED action to *_FAILED when verify fails", async () => {
    // saveTaskState will record RUN_FAILED instead of RUN_COMPLETED, and
    // finishFlow's runWhens match the *_FAILED branch (e.g. posting a
    // "kody FAILED" comment instead of "fix applied"). Without this
    // downgrade, a green self-report + red verify would post a false
    // success comment.
    verifyAllWithRetry.mockResolvedValueOnce({
      ok: false,
      failed: ["test"],
      details: { test: { exitCode: 1, durationMs: 200, tail: "FAIL" } },
    })
    const action: Action = { type: "RUN_COMPLETED", payload: {}, timestamp: "2026-06-06T00:00:00Z" }
    const ctx = makeCtx(action)
    await verify(ctx, profile, null, undefined)
    const downgraded = ctx.data.action as Action
    expect(downgraded.type).toBe("RUN_FAILED")
    expect(downgraded.payload.downgradedFrom).toBe("RUN_COMPLETED")
    expect(downgraded.payload.reason).toMatch(/failed: test/)
  })

  it("leaves a *_FAILED action alone (idempotent on re-entry)", async () => {
    verifyAllWithRetry.mockResolvedValueOnce({
      ok: false,
      failed: ["lint"],
      details: { lint: { exitCode: 1, durationMs: 100, tail: "x" } },
    })
    const action: Action = { type: "RUN_FAILED", payload: { reason: "previous" }, timestamp: "x" }
    const ctx = makeCtx(action)
    await verify(ctx, profile, null, undefined)
    // The action stays RUN_FAILED — the postflight only rewrites _COMPLETED.
    expect((ctx.data.action as Action).type).toBe("RUN_FAILED")
  })

  it("does nothing when no action is in ctx.data (verify is standalone)", async () => {
    verifyAllWithRetry.mockResolvedValueOnce({
      ok: false,
      failed: ["typecheck"],
      details: {},
    })
    const ctx = makeCtx() // no action
    await verify(ctx, profile, null, undefined)
    expect(ctx.data.action).toBeUndefined()
    expect(ctx.data.verifyOk).toBe(false)
  })
})

describe("verify postflight: crash path", () => {
  beforeEach(() => {
    verifyAllWithRetry.mockReset()
  })

  it("catches a thrown error and surfaces it as a verify failure", async () => {
    // verifyAllWithRetry can throw if the cwd disappears mid-run, the
    // config is malformed, etc. The postflight must not propagate — that
    // would crash the whole postflight chain and skip the comment /
    // saveTaskState scripts that follow.
    verifyAllWithRetry.mockRejectedValueOnce(new Error("ENOENT: no such file"))
    const action: Action = { type: "RUN_COMPLETED", payload: {}, timestamp: "x" }
    const ctx = makeCtx(action)
    await verify(ctx, profile, null, undefined)
    expect(ctx.data.verifyOk).toBe(false)
    expect(ctx.data.verifyReason).toMatch(/verify crashed: ENOENT/)
    // The action is still downgraded — a crashed verify is a verify
    // failure for routing purposes.
    expect((ctx.data.action as Action).type).toBe("RUN_FAILED")
  })
})
