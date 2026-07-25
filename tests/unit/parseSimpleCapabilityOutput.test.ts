import { describe, expect, it } from "vitest"
import { parseSimpleCapabilityOutput } from "../../src/scripts/parseSimpleCapabilityOutput.js"

describe("parseSimpleCapabilityOutput", () => {
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
})
