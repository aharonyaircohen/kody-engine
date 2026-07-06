import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { setCommentTarget } from "../../src/scripts/setCommentTarget.js"

const profile = { name: "release-prepare" } as Profile

function makeCtx(args: Record<string, unknown>): Context {
  return {
    args,
    cwd: "/x",
    config: {} as never,
    data: {},
    output: { exitCode: 0 },
    skipAgent: false,
  }
}

describe("setCommentTarget", () => {
  it("defaults to the issue arg when no type is given", async () => {
    const ctx = makeCtx({ issue: 42 })
    await setCommentTarget(ctx, profile)
    expect(ctx.data.commentTargetType).toBe("issue")
    expect(ctx.data.commentTargetNumber).toBe(42)
  })

  it("reads the pr arg when type is pr", async () => {
    const ctx = makeCtx({ pr: 7 })
    await setCommentTarget(ctx, profile, { type: "pr" })
    expect(ctx.data.commentTargetType).toBe("pr")
    expect(ctx.data.commentTargetNumber).toBe(7)
  })

  it("is a no-op when the target number is missing", async () => {
    const ctx = makeCtx({})
    await setCommentTarget(ctx, profile)
    expect(ctx.data.commentTargetType).toBeUndefined()
    expect(ctx.data.commentTargetNumber).toBeUndefined()
  })

  it("is a no-op for a non-positive number", async () => {
    const ctx = makeCtx({ issue: 0 })
    await setCommentTarget(ctx, profile)
    expect(ctx.data.commentTargetNumber).toBeUndefined()
  })

  it("ignores a non-numeric arg value", async () => {
    const ctx = makeCtx({ issue: "12" })
    await setCommentTarget(ctx, profile)
    expect(ctx.data.commentTargetType).toBeUndefined()
  })
})
