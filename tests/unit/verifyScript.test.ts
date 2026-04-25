import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { verify } from "../../src/scripts/verify.js"
import type { Action } from "../../src/state.js"

const baseConfig: KodyConfig = {
  quality: { typecheck: "", testUnit: "", lint: "", format: "" },
  git: { defaultBranch: "main" },
  github: { owner: "o", repo: "r" },
  agent: { model: "m/x" },
}

function makeCtx(overrides: Partial<Context> = {}): Context {
  return {
    args: {},
    cwd: "/tmp",
    config: baseConfig,
    data: {},
    output: { exitCode: 0 },
    ...overrides,
  }
}

const stubProfile = { name: "fix" } as Profile

describe("scripts/verify", () => {
  it("does not touch ctx.data.action when verify passes", async () => {
    const ctx = makeCtx({
      data: {
        action: { type: "FIX_COMPLETED", payload: {}, timestamp: "t" } as Action,
      },
    })
    await verify(ctx, stubProfile, null)
    expect(ctx.data.verifyOk).toBe(true)
    expect((ctx.data.action as Action).type).toBe("FIX_COMPLETED")
  })

  it("downgrades *_COMPLETED action to *_FAILED when verify fails", async () => {
    const failingConfig: KodyConfig = {
      ...baseConfig,
      quality: { ...baseConfig.quality, typecheck: "false" },
    }
    const ctx = makeCtx({
      config: failingConfig,
      data: {
        action: { type: "FIX_COMPLETED", payload: { commitMessage: "x" }, timestamp: "t" } as Action,
      },
    })
    await verify(ctx, stubProfile, null)
    expect(ctx.data.verifyOk).toBe(false)
    const next = ctx.data.action as Action
    expect(next.type).toBe("FIX_FAILED")
    expect((next.payload as { downgradedFrom?: string }).downgradedFrom).toBe("FIX_COMPLETED")
    expect((next.payload as { reason?: string }).reason).toMatch(/typecheck/)
  })

  it("leaves a non-COMPLETED action alone on verify failure", async () => {
    const failingConfig: KodyConfig = {
      ...baseConfig,
      quality: { ...baseConfig.quality, typecheck: "false" },
    }
    const original: Action = { type: "RUN_FAILED", payload: { reason: "earlier" }, timestamp: "t" }
    const ctx = makeCtx({
      config: failingConfig,
      data: { action: original },
    })
    await verify(ctx, stubProfile, null)
    expect(ctx.data.verifyOk).toBe(false)
    expect(ctx.data.action).toBe(original)
  })

  it("is a no-op for action when none is set", async () => {
    const failingConfig: KodyConfig = {
      ...baseConfig,
      quality: { ...baseConfig.quality, typecheck: "false" },
    }
    const ctx = makeCtx({ config: failingConfig })
    await verify(ctx, stubProfile, null)
    expect(ctx.data.verifyOk).toBe(false)
    expect(ctx.data.action).toBeUndefined()
  })
})
