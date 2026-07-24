import { describe, expect, it } from "vitest"
import { parseSimpleCapabilityOutput } from "../../src/scripts/parseSimpleCapabilityOutput.js"

describe("parseSimpleCapabilityOutput", () => {
  it("turns the output contract into Workflow facts and a PR target", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(ctx, {} as Parameters<typeof parseSimpleCapabilityOutput>[1], {
      finalText: JSON.stringify({
        result: {
          reason: "opened release PR",
          summary: "Release prepared",
          data: { pullRequest: 42, pullRequestUrl: "https://github.com/acme/repo/pull/42" },
        },
      }),
    } as Parameters<typeof parseSimpleCapabilityOutput>[2])
    expect(ctx.output.prUrl).toBe("https://github.com/acme/repo/pull/42")
    expect(ctx.data.capabilityResults).toEqual([
      expect.objectContaining({ status: "changed", facts: expect.objectContaining({ pullRequest: 42 }) }),
    ])
  })

  it("accepts a fenced JSON contract value", async () => {
    const ctx = { data: {}, output: {} } as Parameters<typeof parseSimpleCapabilityOutput>[0]
    await parseSimpleCapabilityOutput(ctx, {} as Parameters<typeof parseSimpleCapabilityOutput>[1], {
      finalText: "Capability completed.\n\n```json\n{\"result\":{\"summary\":\"Done\",\"data\":{}}}\n```",
    } as Parameters<typeof parseSimpleCapabilityOutput>[2])
    expect(ctx.output.exitCode).toBeUndefined()
  })
})
