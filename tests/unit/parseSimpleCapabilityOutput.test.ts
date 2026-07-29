import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { parseSimpleCapabilityOutput } from "../../src/scripts/parseSimpleCapabilityOutput.js"

describe("parseSimpleCapabilityOutput", () => {
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
