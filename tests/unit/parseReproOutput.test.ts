import { describe, expect, it } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { parseReproOutput } from "../../src/scripts/parseReproOutput.js"

const profile = { name: "reproduce" } as Profile

function makeCtx(data: Record<string, unknown> = {}): Context {
  return {
    args: {},
    cwd: "/x",
    config: {} as never,
    data,
    output: { exitCode: 0 },
    skipAgent: false,
  }
}

function makeResult(finalText: string): AgentResult {
  return { outcome: "completed", finalText, ndjsonPath: "/tmp/x.ndjson" }
}

const SIGNATURE = {
  errorType: "AssertionError",
  messageContains: "expected 5 but got 4",
  stackContains: "src/calc.ts",
}

function reproMessage(testPath: string, sigJson: string): string {
  return [
    "DONE",
    `TEST_PATH: ${testPath}`,
    "FAILURE_SIGNATURE:",
    "```json",
    sigJson,
    "```",
    "COMMIT_MSG: test: x",
  ].join("\n")
}

describe("parseReproOutput", () => {
  it("is a no-op when the agent did not run", async () => {
    const ctx = makeCtx({ agentDone: true })
    await parseReproOutput(ctx, profile, null)
    expect(ctx.data.reproTestPath).toBeUndefined()
  })

  it("is a no-op when the agent already reported failure", async () => {
    const ctx = makeCtx({ agentDone: false, action: { type: "REPRODUCE_FAILED", payload: {}, timestamp: "" } })
    await parseReproOutput(ctx, profile, makeResult("TEST_PATH: a\nFAILURE_SIGNATURE:\n```\n{}\n```"))
    expect(ctx.data.reproTestPath).toBeUndefined()
    expect(ctx.data.agentDone).toBe(false)
  })

  it("extracts test path and signature on a well-formed message", async () => {
    const ctx = makeCtx({ agentDone: true })
    await parseReproOutput(
      ctx,
      profile,
      makeResult(reproMessage("tests/repro-issue-42.test.ts", JSON.stringify(SIGNATURE))),
    )
    expect(ctx.data.reproTestPath).toBe("tests/repro-issue-42.test.ts")
    expect(JSON.parse(ctx.data.reproFailureSignature as string)).toEqual(SIGNATURE)
  })

  it("defaults stackContains to empty string when omitted", async () => {
    const ctx = makeCtx({ agentDone: true })
    const sig = JSON.stringify({ errorType: "TypeError", messageContains: "boom" })
    await parseReproOutput(ctx, profile, makeResult(reproMessage("tests/x.test.ts", sig)))
    expect(JSON.parse(ctx.data.reproFailureSignature as string).stackContains).toBe("")
  })

  it("strips backticks wrapping the TEST_PATH value", async () => {
    const ctx = makeCtx({ agentDone: true })
    const msg = ["DONE", "TEST_PATH: `tests/x.test.ts`", "FAILURE_SIGNATURE:", JSON.stringify(SIGNATURE)].join("\n")
    await parseReproOutput(ctx, profile, makeResult(msg))
    expect(ctx.data.reproTestPath).toBe("tests/x.test.ts")
  })

  it("downgrades a _COMPLETED action to _FAILED when TEST_PATH is missing", async () => {
    const ctx = makeCtx({
      agentDone: true,
      action: { type: "REPRODUCE_COMPLETED", payload: {}, timestamp: "" },
    })
    await parseReproOutput(ctx, profile, makeResult(`DONE\nFAILURE_SIGNATURE:\n${JSON.stringify(SIGNATURE)}`))
    expect((ctx.data.action as { type: string }).type).toBe("REPRODUCE_FAILED")
    expect((ctx.data.action as { payload: { reason: string } }).payload.reason).toMatch(/TEST_PATH/)
    expect(ctx.data.agentDone).toBe(false)
  })

  it("downgrades when the signature JSON is malformed", async () => {
    const ctx = makeCtx({
      agentDone: true,
      action: { type: "REPRODUCE_COMPLETED", payload: {}, timestamp: "" },
    })
    await parseReproOutput(ctx, profile, makeResult(reproMessage("tests/x.test.ts", "{not json")))
    expect((ctx.data.action as { type: string }).type).toBe("REPRODUCE_FAILED")
    expect(ctx.data.agentDone).toBe(false)
  })

  it("downgrades when the signature lacks required fields", async () => {
    const ctx = makeCtx({
      agentDone: true,
      action: { type: "REPRODUCE_COMPLETED", payload: {}, timestamp: "" },
    })
    await parseReproOutput(
      ctx,
      profile,
      makeResult(reproMessage("tests/x.test.ts", JSON.stringify({ errorType: "X" }))),
    )
    expect((ctx.data.action as { type: string }).type).toBe("REPRODUCE_FAILED")
    expect(ctx.data.reproFailureSignature).toBeUndefined()
  })
})
