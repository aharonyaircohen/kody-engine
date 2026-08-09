import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ listChangedFiles: vi.fn(() => [] as string[]) }))

vi.mock("../../src/commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/commit.js")>()),
  listChangedFiles: mocks.listChangedFiles,
}))

import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/implementations/types.js"
import { retryMissingDeliveryChange } from "../../src/scripts/retryMissingDeliveryChange.js"

describe("retryMissingDeliveryChange", () => {
  it("retries one false fixed claim for pull-request delivery", async () => {
    const invoker = vi.fn(async (_prompt: string): Promise<AgentResult> =>
      ({
        outcome: "completed",
        outcomeKind: "ok",
        finalText: JSON.stringify({ status: "fixed", summary: "Changed the failing line" }),
        durationMs: 1,
        ndjsonPath: "/tmp/agent.ndjson",
      }),
    )
    const ctx = {
      args: {},
      cwd: "/tmp/repo",
      config: {} as Context["config"],
      data: {
        jobDelivery: "pull-request",
        capabilityOutput: { status: "fixed", summary: "Already fixed" },
        prompt: "Repair the supplied failure",
        __invokeAgent: invoker,
      },
      output: { exitCode: 0 },
    } as Context

    await retryMissingDeliveryChange(ctx, { name: "capability-delivery" } as Profile, null)

    expect(invoker).toHaveBeenCalledOnce()
    expect(invoker.mock.calls[0]?.[0]).toContain("no repository file changed")
    expect(ctx.data.capabilityOutput).toEqual({ status: "fixed", summary: "Changed the failing line" })
  })

  it("does not retry when the agent already changed a repository file", async () => {
    mocks.listChangedFiles.mockReturnValueOnce(["src/fix.ts"])
    const invoker = vi.fn()
    const ctx = {
      args: {},
      cwd: "/tmp/repo",
      config: {} as Context["config"],
      data: {
        jobDelivery: "pull-request",
        capabilityOutput: { status: "fixed", summary: "Fixed" },
        prompt: "Repair",
        __invokeAgent: invoker,
      },
      output: { exitCode: 0 },
    } as Context

    await retryMissingDeliveryChange(ctx, { name: "capability-delivery" } as Profile, null)

    expect(invoker).not.toHaveBeenCalled()
  })
})
