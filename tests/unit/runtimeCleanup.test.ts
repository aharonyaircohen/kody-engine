import { describe, expect, it, vi } from "vitest"
import type { Context } from "../../src/implementations/types.js"
import { registerRuntimeCleanup, runRuntimeCleanup } from "../../src/runtimeCleanup.js"

function makeContext(): Context {
  return { data: {} } as Context
}

describe("runtime cleanup", () => {
  it("runs registered cleanup callbacks in reverse order and clears them", () => {
    const ctx = makeContext()
    const calls: string[] = []
    registerRuntimeCleanup(ctx, () => calls.push("first"))
    registerRuntimeCleanup(ctx, () => calls.push("second"))

    runRuntimeCleanup(ctx)

    expect(calls).toEqual(["second", "first"])
    expect(ctx.data.__runtimeCleanup).toBeUndefined()
  })

  it("continues cleanup when one callback fails", () => {
    const ctx = makeContext()
    const survivor = vi.fn()
    registerRuntimeCleanup(ctx, survivor)
    registerRuntimeCleanup(ctx, () => {
      throw new Error("cleanup failed")
    })

    expect(() => runRuntimeCleanup(ctx)).not.toThrow()
    expect(survivor).toHaveBeenCalledOnce()
    expect(ctx.data.__runtimeCleanup).toBeUndefined()
  })

  it("is safe when nothing was registered", () => {
    const ctx = makeContext()

    expect(() => runRuntimeCleanup(ctx)).not.toThrow()
    expect(ctx.data.__runtimeCleanup).toBeUndefined()
  })
})
