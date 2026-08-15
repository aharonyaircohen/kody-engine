import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { parseSimpleCapabilityOutput } from "../../src/scripts/parseSimpleCapabilityOutput.js"

describe("parseSimpleCapabilityOutput", () => {
  it("blocks when a required specialist was not invoked", async () => {
    const ctx = {
      data: { requiredSubagents: ["documentation-researcher"] },
      output: {},
    } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[0]

    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: JSON.stringify({ version: 1, status: "pass", summary: "Research complete" }),
        invokedSubagents: [],
      } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBe(64)
    expect(ctx.output.reason).toBe("Required specialist was not invoked: documentation-researcher")
    expect(ctx.data.capabilityResults).toEqual([
      expect.objectContaining({
        status: "blocked",
        blockers: ["Required specialist was not invoked: documentation-researcher"],
      }),
    ])
  })

  it("accepts output when every required specialist was invoked", async () => {
    const ctx = {
      data: { requiredSubagents: ["documentation-researcher"] },
      output: {},
    } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[0]

    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: JSON.stringify({ version: 1, status: "pass", summary: "Research complete" }),
        invokedSubagents: ["documentation-researcher"],
      } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBeUndefined()
    expect(ctx.data.capabilityOutput).toEqual({ version: 1, status: "pass", summary: "Research complete" })
  })

  it("returns a structured blocked result when the agent returns nothing", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(ctx, {} as Parameters<typeof parseSimpleCapabilityOutput>[1], null)

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toBe("Capability execution ended before returning a result")
    expect(ctx.data.capabilityOutput).toEqual({
      status: "blocked",
      reason: "Capability execution ended before returning a result",
      summary: "Capability execution ended before returning a result",
    })
    expect(ctx.data.capabilityResults).toEqual([
      expect.objectContaining({
        status: "blocked",
        blockers: ["Capability execution ended before returning a result"],
      }),
    ])
  })

  it("turns an execution limit into a normal blocked result", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: "",
        outcome: "failed",
        outcomeKind: "out_of_turns",
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.data.capabilityOutput).toEqual({
      status: "blocked",
      reason: "Capability execution limit reached",
      summary: "Capability execution limit reached",
    })
    expect(ctx.data.capabilityResults).toEqual([
      expect.objectContaining({
        status: "blocked",
        blockers: ["Capability execution limit reached"],
      }),
    ])
  })

  it("keeps the capability output and derives Workflow facts and a PR target", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: JSON.stringify({
          reason: "opened release PR",
          summary: "Release prepared",
          data: { pullRequest: 42, pullRequestUrl: "https://github.com/acme/repo/pull/42" },
        }),
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )
    expect(ctx.output.prUrl).toBe("https://github.com/acme/repo/pull/42")
    expect(ctx.data.capabilityOutput).toEqual({
      reason: "opened release PR",
      summary: "Release prepared",
      data: { pullRequest: 42, pullRequestUrl: "https://github.com/acme/repo/pull/42" },
    })
    expect(ctx.data.capabilityResults).toEqual([
      expect.objectContaining({ status: "changed", facts: expect.objectContaining({ pullRequest: 42 }) }),
    ])
  })

  it("accepts any fenced JSON value", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: 'Capability completed.\n\n```json\n["done",42]\n```',
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )
    expect(ctx.output.exitCode).toBeUndefined()
    expect(ctx.data.capabilityOutput).toEqual(["done", 42])
    expect(ctx.data.capabilityResults).toEqual([
      expect.objectContaining({ summary: "Capability completed", facts: { output: ["done", 42] } }),
    ])
  })

  it("uses the JSON fence when an earlier non-JSON fence explains the result", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: [
          "The capability skipped cleanly:",
          "```",
          "KODY_REASON=nothing to promote",
          "KODY_SKIP_AGENT=true",
          "```",
          "```json",
          '{"status":"skipped","reason":"nothing to promote"}',
          "```",
        ].join("\n"),
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBeUndefined()
    expect(ctx.data.capabilityOutput).toEqual({ status: "skipped", reason: "nothing to promote" })
  })

  it("accepts a single JSON result wrapped in final_status tags", async () => {
    const ctx = {
      data: {
        capabilityOutputSchema: {
          type: "object",
          properties: {
            status: { enum: ["fixed", "blocked"] },
            summary: { type: "string" },
          },
          required: ["status", "summary"],
          additionalProperties: true,
        },
      },
      output: {},
    } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[0]

    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: [
          "Repair complete.",
          "<final_status>",
          '{"status":"fixed","summary":"Repaired the failing check"}',
          "</final_status>",
        ].join("\n"),
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBeUndefined()
    expect(ctx.data.capabilityOutput).toEqual({
      status: "fixed",
      summary: "Repaired the failing check",
    })
  })

  it("uses a plain object output as Workflow facts", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: JSON.stringify({ releasePr: 42, releasePrUrl: "https://github.com/acme/repo/pull/42" }),
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.data.capabilityResults).toEqual([
      expect.objectContaining({
        facts: {
          releasePr: 42,
          releasePrUrl: "https://github.com/acme/repo/pull/42",
        },
      }),
    ])
  })

  it("accepts output that matches the capability contract", async () => {
    const ctx = {
      data: {
        capabilityOutputSchema: {
          type: "object",
          properties: { verdict: { enum: ["pass", "fix"] } },
          required: ["verdict"],
          additionalProperties: false,
        },
      },
      output: {},
    } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[0]

    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: JSON.stringify({ verdict: "pass" }),
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBeUndefined()
    expect(ctx.data.capabilityOutput).toEqual({ verdict: "pass" })
  })

  it("prefers the dedicated handoff file over a prose final response", async () => {
    const outputPath = path.join(os.tmpdir(), `capability-output-${crypto.randomUUID()}.json`)
    fs.writeFileSync(outputPath, JSON.stringify({ verdict: "pass" }))
    const ctx = {
      data: {
        capabilityOutputPath: outputPath,
        capabilityOutputSchema: {
          type: "object",
          properties: { verdict: { enum: ["pass", "fix"] } },
          required: ["verdict"],
        },
      },
      output: {},
    } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[0]

    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: "The capability completed successfully.",
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.data.capabilityOutput).toEqual({ verdict: "pass" })
    expect(fs.existsSync(outputPath)).toBe(false)
  })

  it("treats a valid authoritative handoff file as completion without a final chat message", async () => {
    const outputPath = path.join(os.tmpdir(), `capability-output-${crypto.randomUUID()}.json`)
    fs.writeFileSync(
      outputPath,
      JSON.stringify({ status: "applied", summary: "Healthy CI prepared", evidence: ["npm test"] }),
    )
    const ctx = {
      args: {},
      data: {
        capabilityOutputPath: outputPath,
        capabilityOutputSchema: {
          type: "object",
          properties: {
            status: { enum: ["applied", "blocked"] },
            summary: { type: "string" },
            evidence: { type: "array", items: { type: "string" } },
          },
          required: ["status", "summary", "evidence"],
        },
        agentDone: false,
        agentMarkerMissing: false,
        agentFailureReason: "agent produced no final message",
        action: {
          type: "CAPABILITY_DELIVERY_FAILED",
          payload: { reason: "agent produced no final message" },
          timestamp: "2026-08-14T00:00:00.000Z",
        },
      },
      output: {},
    } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[0]

    await parseSimpleCapabilityOutput(
      ctx,
      { name: "capability-delivery" } as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: "",
        outcome: "completed",
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBeUndefined()
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.agentFailureReason).toBeUndefined()
    expect(ctx.data.prSummary).toBe("Healthy CI prepared")
    expect(ctx.data.action).toEqual(
      expect.objectContaining({
        type: "CAPABILITY_DELIVERY_COMPLETED",
        payload: {},
      }),
    )
  })

  it("treats successful script output as completed delivery work", async () => {
    const ctx = {
      args: {},
      data: {
        capabilityScriptOutput: {
          status: "ready",
          summary: "Blueprint bundle installed",
        },
        agentDone: false,
        agentFailureReason: "agent did not run",
      },
      output: {},
    } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[0]

    await parseSimpleCapabilityOutput(
      ctx,
      { name: "capability-delivery" } as Parameters<typeof parseSimpleCapabilityOutput>[1],
      null,
    )

    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.agentFailureReason).toBeUndefined()
    expect(ctx.data.prSummary).toBe("Blueprint bundle installed")
    expect(ctx.data.action).toEqual(
      expect.objectContaining({
        type: "CAPABILITY_DELIVERY_COMPLETED",
        payload: {},
      }),
    )
  })

  it("blocks output that violates the capability contract", async () => {
    const ctx = {
      data: {
        capabilityOutputSchema: {
          type: "object",
          properties: { verdict: { enum: ["pass", "fix"] } },
          required: ["verdict"],
        },
      },
      output: {},
    } as unknown as Parameters<typeof parseSimpleCapabilityOutput>[0]

    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      {
        finalText: JSON.stringify({ summary: "markdown won" }),
      } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBe(64)
    expect(ctx.output.reason).toMatch(/Capability output does not match/)
    expect(ctx.data.capabilityResults).toEqual([
      expect.objectContaining({
        status: "blocked",
        blockers: [expect.stringMatching(/Capability output does not match/)],
      }),
    ])
  })

  it("normalizes legacy prose output instead of failing the workflow step", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(
      ctx,
      {} as Parameters<typeof parseSimpleCapabilityOutput>[1],
      { finalText: "DONE\\nPR_SUMMARY=No changes were needed" } as Parameters<typeof parseSimpleCapabilityOutput>[2],
    )

    expect(ctx.output.exitCode).toBeUndefined()
    expect(ctx.data.capabilityOutput).toEqual({
      summary: "DONE\\nPR_SUMMARY=No changes were needed",
      output: "DONE\\nPR_SUMMARY=No changes were needed",
    })
  })
})
