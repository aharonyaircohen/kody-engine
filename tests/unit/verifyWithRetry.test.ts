import { describe, expect, it, vi } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { verifyWithRetry } from "../../src/scripts/verifyWithRetry.js"
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
    cwd: process.cwd(),
    config: baseConfig,
    data: {},
    output: { exitCode: 0 },
    ...overrides,
  }
}

const profile = { name: "test" } as unknown as Profile

function makeAgentResult(completed: boolean, finalText = ""): AgentResult {
  return {
    outcome: completed ? "completed" : "failed",
    finalText,
  } as AgentResult
}

describe("verifyWithRetry", () => {
  it("passes through when verify is green (no commands → ok)", async () => {
    const ctx = makeCtx()
    await verifyWithRetry(ctx, profile, null)
    expect(ctx.data.verifyOk).toBe(true)
    expect(ctx.data.verifyReason).toBe("")
  })

  it("downgrades *_COMPLETED → *_FAILED when verify fails and no retry possible", async () => {
    const action: Action = {
      type: "RUN_COMPLETED",
      payload: {},
      timestamp: new Date().toISOString(),
    }
    const ctx = makeCtx({
      config: { ...baseConfig, quality: { ...baseConfig.quality, typecheck: "false" } },
      data: { action, agentDone: true },
    })
    await verifyWithRetry(ctx, profile, null)
    expect(ctx.data.verifyOk).toBe(false)
    const downgraded = ctx.data.action as Action
    expect(downgraded.type).toBe("RUN_FAILED")
    expect((downgraded.payload as { downgradedFrom?: string }).downgradedFrom).toBe("RUN_COMPLETED")
  })

  it("does not retry when agentDone is falsy", async () => {
    const invoker = vi.fn<(p: string) => Promise<AgentResult>>()
    const ctx = makeCtx({
      config: { ...baseConfig, quality: { ...baseConfig.quality, typecheck: "false" } },
      data: { agentDone: false, __invokeAgent: invoker, prompt: "P" },
    })
    await verifyWithRetry(ctx, profile, null)
    expect(invoker).not.toHaveBeenCalled()
    expect(ctx.data.verifyOk).toBe(false)
  })

  it("does not retry when invokeAgent closure is missing", async () => {
    const ctx = makeCtx({
      config: { ...baseConfig, quality: { ...baseConfig.quality, typecheck: "false" } },
      data: { agentDone: true, prompt: "P" },
    })
    await verifyWithRetry(ctx, profile, null)
    expect(ctx.data.verifyOk).toBe(false)
  })

  it("retries the agent with verify output as feedback when verify fails", async () => {
    let typecheckCmd = "false"
    const cfg: KodyConfig = {
      ...baseConfig,
      quality: {
        ...baseConfig.quality,
        get typecheck() {
          return typecheckCmd
        },
      } as KodyConfig["quality"],
    }
    const invoker = vi.fn<(p: string) => Promise<AgentResult>>(async () => {
      typecheckCmd = "true"
      return makeAgentResult(true, JSON.stringify({ done: true, commitMessage: "fix", prSummary: "ok" }))
    })
    const action: Action = {
      type: "RUN_COMPLETED",
      payload: {},
      timestamp: new Date().toISOString(),
    }
    const ctx = makeCtx({
      config: cfg,
      data: { agentDone: true, __invokeAgent: invoker, prompt: "BASE", action },
    })
    await verifyWithRetry(ctx, profile, null)
    expect(invoker).toHaveBeenCalledOnce()
    const prompt = invoker.mock.calls[0]![0]
    expect(prompt).toContain("BASE")
    expect(prompt).toContain("Verify failure (retry)")
    expect(ctx.data.verifyOk).toBe(true)
    expect((ctx.data.action as Action).type).toBe("RUN_COMPLETED")
  })

  it("retries once only and downgrades action when verify still fails", async () => {
    const cfg: KodyConfig = {
      ...baseConfig,
      quality: { ...baseConfig.quality, typecheck: "false" },
    }
    const invoker = vi.fn<(p: string) => Promise<AgentResult>>(async () =>
      makeAgentResult(true, JSON.stringify({ done: true })),
    )
    const action: Action = {
      type: "FIX_COMPLETED",
      payload: {},
      timestamp: new Date().toISOString(),
    }
    const ctx = makeCtx({
      config: cfg,
      data: { agentDone: true, __invokeAgent: invoker, prompt: "BASE", action },
    })
    await verifyWithRetry(ctx, profile, null)
    expect(invoker).toHaveBeenCalledOnce()
    expect(ctx.data.verifyOk).toBe(false)
    const downgraded = ctx.data.action as Action
    expect(downgraded.type).toBe("FIX_FAILED")
    expect((downgraded.payload as { downgradedFrom?: string }).downgradedFrom).toBe("FIX_COMPLETED")
  })

  it("survives a thrown retry — falls back to the downgraded outcome", async () => {
    const cfg: KodyConfig = {
      ...baseConfig,
      quality: { ...baseConfig.quality, typecheck: "false" },
    }
    const invoker = vi.fn<(p: string) => Promise<AgentResult>>(async () => {
      throw new Error("agent crashed")
    })
    const action: Action = {
      type: "RUN_COMPLETED",
      payload: {},
      timestamp: new Date().toISOString(),
    }
    const ctx = makeCtx({
      config: cfg,
      data: { agentDone: true, __invokeAgent: invoker, prompt: "BASE", action },
    })
    await verifyWithRetry(ctx, profile, null)
    expect(invoker).toHaveBeenCalledOnce()
    expect(ctx.data.verifyOk).toBe(false)
    expect((ctx.data.action as Action).type).toBe("RUN_FAILED")
  })

  it("leaves non-_COMPLETED actions untouched on failure", async () => {
    const action: Action = {
      type: "REPRODUCE_FAILED",
      payload: {},
      timestamp: new Date().toISOString(),
    }
    const ctx = makeCtx({
      config: { ...baseConfig, quality: { ...baseConfig.quality, typecheck: "false" } },
      data: { agentDone: true, action },
    })
    await verifyWithRetry(ctx, profile, null)
    expect((ctx.data.action as Action).type).toBe("REPRODUCE_FAILED")
  })
})
