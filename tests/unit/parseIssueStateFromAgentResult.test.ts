import { describe, expect, it } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import type { LoadedStateComment, StateEnvelope } from "../../src/scripts/issueStateComment.js"
import { parseIssueStateFromAgentResult } from "../../src/scripts/parseIssueStateFromAgentResult.js"

const profile = { name: "issue-state" } as Profile
const FENCE = "kody-issue-next-state"

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

function fenced(label: string, body: string): string {
  return [`\`\`\`${label}`, body, "```"].join("\n")
}

describe("parseIssueStateFromAgentResult", () => {
  it("throws when fenceLabel is missing", async () => {
    await expect(parseIssueStateFromAgentResult(makeCtx(), profile, makeResult("x"), {})).rejects.toThrow(
      /fenceLabel.*required/,
    )
  })

  it("records an error when the agent did not run", async () => {
    const ctx = makeCtx()
    await parseIssueStateFromAgentResult(ctx, profile, null, { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBe("agent did not run")
    expect(ctx.data.nextIssueState).toBeUndefined()
  })

  it("records an error when no fenced block is present", async () => {
    const ctx = makeCtx()
    await parseIssueStateFromAgentResult(ctx, profile, makeResult("no block here"), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toMatch(/did not emit/)
  })

  it("records an error when the block holds invalid JSON", async () => {
    const ctx = makeCtx()
    await parseIssueStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, "{not json")), {
      fenceLabel: FENCE,
    })
    expect(ctx.data.nextStateParseError).toMatch(/JSON parse error/)
  })

  it("rejects an envelope missing required fields", async () => {
    const ctx = makeCtx()
    const body = JSON.stringify({ cursor: "", data: {}, done: false })
    await parseIssueStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, body)), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toMatch(/string `cursor`/)
  })

  it("rejects when data is an array rather than an object", async () => {
    const ctx = makeCtx()
    const body = JSON.stringify({ cursor: "step-1", data: [], done: false })
    await parseIssueStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, body)), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBeDefined()
    expect(ctx.data.nextIssueState).toBeUndefined()
  })

  it("builds the next envelope with rev=1 when no prior state exists", async () => {
    const ctx = makeCtx()
    const body = JSON.stringify({ cursor: "step-1", data: { foo: "bar" }, done: false })
    await parseIssueStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, body)), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBeUndefined()
    expect(ctx.data.nextIssueState).toEqual<StateEnvelope>({
      version: 1,
      rev: 1,
      cursor: "step-1",
      data: { foo: "bar" },
      done: false,
    })
  })

  it("bumps rev off the previously-loaded state comment", async () => {
    const loaded: LoadedStateComment = {
      commentId: 7,
      commentNodeId: "node",
      state: { version: 1, rev: 4, cursor: "old", data: {}, done: false },
    }
    const ctx = makeCtx({ issueStateComment: loaded })
    const body = JSON.stringify({ cursor: "step-2", data: { ok: true }, done: true })
    await parseIssueStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, body)), { fenceLabel: FENCE })
    expect((ctx.data.nextIssueState as StateEnvelope).rev).toBe(5)
    expect((ctx.data.nextIssueState as StateEnvelope).done).toBe(true)
  })
})
