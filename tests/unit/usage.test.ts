import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appendRunUsageSummary,
  createRunUsage,
  formatRunUsageMarker,
  mergeRunUsage,
  parseRunUsage,
} from "../../src/usage.js"

describe("run usage", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps the provider token breakdown instead of collapsing it", () => {
    expect(
      createRunUsage({ input: 100, output: 20, cacheRead: 300, cacheCreate: 40 }, 1.25, {
        model: "minimax/MiniMax-M3",
        turns: 7,
      }),
    ).toEqual({
      version: 1,
      tokens: { input: 100, output: 20, cacheRead: 300, cacheCreate: 40, total: 460 },
      costUsd: 1.25,
      agentRuns: 1,
      turns: 7,
      byModel: {
        "minimax/MiniMax-M3": {
          tokens: { input: 100, output: 20, cacheRead: 300, cacheCreate: 40, total: 460 },
          costUsd: 1.25,
          agentRuns: 1,
          turns: 7,
        },
      },
    })
  })

  it("adds workflow children without losing per-model attribution", () => {
    const first = createRunUsage({ input: 100, output: 20, cacheRead: 30, cacheCreate: 0 }, 0.5, {
      model: "minimax/MiniMax-M3",
      turns: 4,
    })
    const second = createRunUsage({ input: 40, output: 10, cacheRead: 0, cacheCreate: 5 }, 0.2, {
      model: "openrouter/deepseek",
      turns: 2,
    })

    expect(mergeRunUsage(first, second)).toEqual({
      version: 1,
      tokens: { input: 140, output: 30, cacheRead: 30, cacheCreate: 5, total: 205 },
      costUsd: 0.7,
      agentRuns: 2,
      turns: 6,
      byModel: {
        "minimax/MiniMax-M3": first!.byModel["minimax/MiniMax-M3"],
        "openrouter/deepseek": second!.byModel["openrouter/deepseek"],
      },
    })
  })

  it("uses the provider's actual per-model report for automatic routing", () => {
    expect(
      createRunUsage({ input: 120, output: 25, cacheRead: 400, cacheCreate: 10 }, 0.42, {
        model: "automatic",
        turns: 3,
        modelUsage: {
          "MiniMax-M3": {
            inputTokens: 120,
            outputTokens: 25,
            cacheReadInputTokens: 400,
            cacheCreationInputTokens: 10,
            costUSD: 0.42,
          },
        },
      }),
    ).toMatchObject({
      byModel: {
        "MiniMax-M3": {
          tokens: { input: 120, output: 25, cacheRead: 400, cacheCreate: 10, total: 555 },
          costUsd: 0.42,
        },
      },
    })
  })

  it("rejects malformed persisted model usage", () => {
    const usage = createRunUsage({ input: 10, output: 2, cacheRead: 0, cacheCreate: 0 }, 0, {
      model: "minimax/MiniMax-M3",
      turns: 1,
    })!
    expect(parseRunUsage(usage)).toEqual(usage)
    expect(parseRunUsage({ ...usage, byModel: { broken: { tokens: { input: -1 } } } })).toBeUndefined()
  })

  it("returns the existing value when the other side has no model usage", () => {
    const usage = createRunUsage({ input: 10, output: 2, cacheRead: 0, cacheCreate: 0 }, 0, {
      model: "minimax/MiniMax-M3",
      turns: 1,
    })
    expect(mergeRunUsage(undefined, usage)).toEqual(usage)
    expect(mergeRunUsage(usage, undefined)).toEqual(usage)
    expect(mergeRunUsage(undefined, undefined)).toBeUndefined()
  })

  it("emits one machine-readable marker", () => {
    const usage = createRunUsage({ input: 10, output: 2, cacheRead: 3, cacheCreate: 0 }, 0.01, {
      model: "minimax/MiniMax-M3",
      turns: 1,
    })!
    const marker = formatRunUsageMarker("workflow:review-fix", usage)
    expect(marker.startsWith("KODY_USAGE=")).toBe(true)
    expect(JSON.parse(marker.slice("KODY_USAGE=".length))).toMatchObject({
      subject: "workflow:review-fix",
      tokens: { input: 10, output: 2, cacheRead: 3, total: 15 },
    })
  })

  it("preserves the breakdown in the GitHub step summary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-usage-summary-"))
    const summaryPath = path.join(dir, "summary.md")
    const usage = createRunUsage({ input: 1_000, output: 200, cacheRead: 3_000, cacheCreate: 50 }, 1.5, {
      model: "minimax/MiniMax-M3",
      turns: 8,
    })!

    appendRunUsageSummary(summaryPath, "workflow:review-fix", usage)

    const written = fs.readFileSync(summaryPath, "utf8")
    expect(written).toContain("workflow:review-fix")
    expect(written).toContain("1,000 input")
    expect(written).toContain("3,000 cache-read")
    expect(written).toContain("200 output")
    expect(written).toContain("8 turns")
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
