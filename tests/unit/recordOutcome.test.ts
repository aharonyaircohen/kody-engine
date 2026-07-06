import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { recordOutcome } from "../../src/scripts/recordOutcome.js"
import type { Action } from "../../src/state.js"

function makeCtx(output: Partial<Context["output"]>): Context {
  return {
    args: {},
    cwd: "/x",
    config: {} as never,
    data: {},
    output: { exitCode: 0, ...output },
    skipAgent: false,
  }
}

const profile = { name: "release-prepare" } as Profile

describe("recordOutcome", () => {
  it("derives a _COMPLETED action name from the profile name on exit 0", async () => {
    const ctx = makeCtx({ exitCode: 0, prUrl: "https://pr/1", reason: "ok" })
    await recordOutcome(ctx, profile, null)
    const action = ctx.data.action as Action
    expect(action.type).toBe("RELEASE_PREPARE_COMPLETED")
    expect(action.payload).toMatchObject({ exitCode: 0, reason: "ok", prUrl: "https://pr/1" })
    expect(typeof action.timestamp).toBe("string")
  })

  it("derives a _FAILED action name on a non-zero exit", async () => {
    const ctx = makeCtx({ exitCode: 2 })
    await recordOutcome(ctx, profile, null)
    expect((ctx.data.action as Action).type).toBe("RELEASE_PREPARE_FAILED")
    expect((ctx.data.action as Action).payload.exitCode).toBe(2)
  })

  it("treats an undefined exit code as success", async () => {
    const ctx = makeCtx({})
    ctx.output = { exitCode: undefined as unknown as number }
    await recordOutcome(ctx, profile, null)
    expect((ctx.data.action as Action).type).toBe("RELEASE_PREPARE_COMPLETED")
    expect((ctx.data.action as Action).payload.exitCode).toBe(0)
  })

  it("upper-snakes multi-hyphen profile names", async () => {
    const ctx = makeCtx({ exitCode: 0 })
    await recordOutcome(ctx, { name: "watch-stale-prs" } as Profile, null)
    expect((ctx.data.action as Action).type).toBe("WATCH_STALE_PRS_COMPLETED")
  })
})
