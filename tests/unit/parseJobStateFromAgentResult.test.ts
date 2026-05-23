import { describe, expect, it } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/executables/types.js"
import type { StateEnvelope } from "../../src/scripts/issueStateComment.js"
import {
  extractNextStateFromText,
  parseJobStateFromAgentResult,
} from "../../src/scripts/parseJobStateFromAgentResult.js"

const profile = { name: "job-tick" } as Profile
const FENCE = "kody-job-next-state"

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
  return ["```" + label, body, "```"].join("\n")
}

describe("extractNextStateFromText", () => {
  it("errors when the labeled block is absent", () => {
    const r = extractNextStateFromText("no fence here", FENCE, 0)
    expect(r.error).toMatch(/missing `kody-job-next-state`/)
    expect(r.envelope).toBeUndefined()
  })

  it("errors on invalid JSON inside the block", () => {
    const r = extractNextStateFromText(fenced(FENCE, "{nope"), FENCE, 0)
    expect(r.error).toMatch(/JSON parse error/)
  })

  it("errors when the envelope shape is invalid", () => {
    const r = extractNextStateFromText(fenced(FENCE, JSON.stringify({ cursor: "", data: {}, done: false })), FENCE, 0)
    expect(r.error).toMatch(/string `cursor`/)
  })

  it("returns an envelope with rev bumped off prevRev", () => {
    const body = JSON.stringify({ cursor: "step-2", data: { n: 1 }, done: false })
    const r = extractNextStateFromText(fenced(FENCE, body), FENCE, 7)
    expect(r.error).toBeUndefined()
    expect(r.envelope).toEqual<StateEnvelope>({
      version: 1,
      rev: 8,
      cursor: "step-2",
      data: { n: 1 },
      done: false,
    })
  })

  it("escapes regex-special characters in the fence label", () => {
    const body = JSON.stringify({ cursor: "c", data: {}, done: true })
    const r = extractNextStateFromText(fenced("a.b+c", body), "a.b+c", 0)
    expect(r.envelope?.cursor).toBe("c")
  })
})

describe("parseJobStateFromAgentResult", () => {
  it("throws when fenceLabel is missing", async () => {
    await expect(parseJobStateFromAgentResult(makeCtx(), profile, makeResult("x"), {})).rejects.toThrow(
      /fenceLabel.*required/,
    )
  })

  it("records 'agent did not run' when there is no result", async () => {
    const ctx = makeCtx()
    await parseJobStateFromAgentResult(ctx, profile, null, { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBe("agent did not run")
  })

  it("uses legacy phrasing for the missing-block case", async () => {
    const ctx = makeCtx()
    await parseJobStateFromAgentResult(ctx, profile, makeResult("nothing"), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBe("agent did not emit a `kody-job-next-state` fenced block")
  })

  it("passes through the parse-error phrasing for malformed JSON", async () => {
    const ctx = makeCtx()
    await parseJobStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, "{bad")), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toMatch(/JSON parse error/)
  })

  it("builds nextJobState with rev=1 when no prior job state exists", async () => {
    const ctx = makeCtx()
    const body = JSON.stringify({ cursor: "start", data: { ok: true }, done: false })
    await parseJobStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, body)), { fenceLabel: FENCE })
    expect((ctx.data.nextJobState as StateEnvelope).rev).toBe(1)
    expect(ctx.data.nextStateParseError).toBeUndefined()
  })

  it("bumps rev off the loaded job state", async () => {
    const ctx = makeCtx({ jobState: { path: ".kody/state/x.json", token: null, state: { rev: 3 } } })
    const body = JSON.stringify({ cursor: "next", data: {}, done: true })
    await parseJobStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, body)), { fenceLabel: FENCE })
    expect((ctx.data.nextJobState as StateEnvelope).rev).toBe(4)
    expect((ctx.data.nextJobState as StateEnvelope).done).toBe(true)
  })

  it("prefers the submit_state tool payload over any fenced block", async () => {
    const ctx = makeCtx({ jobState: { path: "x", token: null, state: { rev: 2 } } })
    // finalText carries a DIFFERENT (older) block; the tool payload must win.
    const result: AgentResult = {
      outcome: "completed",
      finalText: fenced(FENCE, JSON.stringify({ cursor: "from-block", data: {}, done: false })),
      submittedState: { cursor: "from-tool", data: { acted: 1 }, done: false },
      ndjsonPath: "/tmp/x.ndjson",
    }
    await parseJobStateFromAgentResult(ctx, profile, result, { fenceLabel: FENCE })
    const next = ctx.data.nextJobState as StateEnvelope
    expect(next).toEqual<StateEnvelope>({ version: 1, rev: 3, cursor: "from-tool", data: { acted: 1 }, done: false })
    expect(ctx.data.nextStateParseError).toBeUndefined()
  })

  it("falls back to the fenced block when submit_state has an empty cursor", async () => {
    const ctx = makeCtx()
    const result: AgentResult = {
      outcome: "completed",
      finalText: fenced(FENCE, JSON.stringify({ cursor: "block-cursor", data: { b: 2 }, done: false })),
      submittedState: { cursor: "", data: {}, done: false },
      ndjsonPath: "/tmp/x.ndjson",
    }
    await parseJobStateFromAgentResult(ctx, profile, result, { fenceLabel: FENCE })
    expect((ctx.data.nextJobState as StateEnvelope).cursor).toBe("block-cursor")
  })
})
