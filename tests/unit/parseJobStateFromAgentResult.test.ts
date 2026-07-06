import { describe, expect, it } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/implementations/types.js"
import type { StateEnvelope } from "../../src/scripts/issueStateComment.js"
import {
  extractNextStateFromText,
  parseJobStateFromAgentResult,
} from "../../src/scripts/parseJobStateFromAgentResult.js"

const profile = { name: "capability-tick" } as Profile
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
  return [`\`\`\`${label}`, body, "```"].join("\n")
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

  it("carries prior state forward when a clean finish emits no block", async () => {
    // Evergreen capability (e.g. approval-gate) checks its queue, finds nothing,
    // and stops without proposing state — a benign no-op, not a failure.
    const ctx = makeCtx({
      jobState: { path: "x", token: null, state: { rev: 4, cursor: "idle", data: { seen: 3 }, done: false } },
    })
    await parseJobStateFromAgentResult(ctx, profile, makeResult("checked queue, nothing to do"), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBeUndefined()
    expect(ctx.data.nextJobState).toEqual<StateEnvelope>({
      version: 1,
      rev: 5,
      cursor: "idle",
      data: { seen: 3 },
      done: false,
    })
  })

  it("still fails loudly when a cut-off run (outcome=failed) emits no block", async () => {
    // max_turns / error / stalled → the agent never reached its decision, so
    // missing state IS a real failure and must surface, even with prior state.
    const ctx = makeCtx({
      jobState: { path: "x", token: null, state: { rev: 4, cursor: "idle", data: {}, done: false } },
    })
    const cutOff: AgentResult = { outcome: "failed", finalText: "ran out of turns", ndjsonPath: "/tmp/x.ndjson" }
    await parseJobStateFromAgentResult(ctx, profile, cutOff, { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBe("agent did not emit a `kody-job-next-state` fenced block")
    expect(ctx.data.nextJobState).toBeUndefined()
  })
})

describe("parseJobStateFromAgentResult: kody-capability-next-state alias (Phase 1 rename)", () => {
  const NEW = "kody-capability-next-state"

  it("accepts a kody-capability-next-state block when the configured label is kody-job-next-state (newly-authored capability)", async () => {
    const ctx = makeCtx()
    const body = JSON.stringify({ cursor: "next", data: { fresh: true }, done: false })
    await parseJobStateFromAgentResult(ctx, profile, makeResult(fenced(NEW, body)), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBeUndefined()
    const next = ctx.data.nextJobState as StateEnvelope
    expect(next.cursor).toBe("next")
    expect(next.data).toEqual({ fresh: true })
    expect(next.rev).toBe(1)
  })

  it("accepts a kody-job-next-state block when the configured label is kody-capability-next-state (legacy agent, new profile)", async () => {
    // Symmetry: a profile that opts into the new label still recognises the
    // old one — prevents the same alias from being a one-way migration.
    const ctx = makeCtx()
    const body = JSON.stringify({ cursor: "sym", data: {}, done: false })
    await parseJobStateFromAgentResult(ctx, profile, makeResult(fenced(FENCE, body)), { fenceLabel: NEW })
    expect(ctx.data.nextStateParseError).toBeUndefined()
    expect((ctx.data.nextJobState as StateEnvelope).cursor).toBe("sym")
  })

  it("the error message still names the configured label, not the alias", async () => {
    // The error must name the label the agent was told to emit (the profile's
    // own fenceLabel), even when the alias is the one that would have parsed.
    // Otherwise operators chasing the log wouldn't know which label the
    // profile's prompt actually uses.
    const ctx = makeCtx()
    await parseJobStateFromAgentResult(ctx, profile, makeResult("nothing"), { fenceLabel: FENCE })
    expect(ctx.data.nextStateParseError).toBe("agent did not emit a `kody-job-next-state` fenced block")
  })

  it("alias block is rejected on malformed JSON (same as canonical)", async () => {
    // Aliases are recognised for *which* label to look at; the JSON-validity
    // check inside the block is unchanged.
    const ctx = makeCtx()
    await parseJobStateFromAgentResult(ctx, profile, makeResult(fenced(NEW, "{not-json")), {
      fenceLabel: FENCE,
    })
    expect(ctx.data.nextStateParseError).toMatch(/JSON parse error/)
  })

  it("alias does NOT trigger for a fence label that has no alias (only the two capability labels are aliased)", async () => {
    // Generic labels like "kody-issue-next-state" are NOT aliased — the alias
    // is a Phase 1 capability-pipeline concern, not a generic parser behaviour.
    // A profile that declares fenceLabel="kody-issue-next-state" should NOT
    // pick up a stray kody-capability-next-state block.
    const ctx = makeCtx()
    const body = JSON.stringify({ cursor: "x", data: {}, done: false })
    await parseJobStateFromAgentResult(ctx, profile, makeResult(fenced("kody-capability-next-state", body)), {
      fenceLabel: "kody-issue-next-state",
    })
    expect(ctx.data.nextStateParseError).toMatch(/kody-issue-next-state/)
    expect(ctx.data.nextJobState).toBeUndefined()
  })
})
