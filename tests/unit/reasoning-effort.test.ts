import { describe, expect, it } from "vitest"
import {
  REASONING_BUDGETS,
  REASONING_EFFORTS,
  parseReasoningEffort,
} from "../../src/config.js"

/**
 * Cross-repo contract: the dashboard's `reasoning-adapter.ts` and the
 * engine's `REASONING_BUDGETS` MUST agree on the budget for each level.
 * The dashboard side pins this in its own test suite; here we pin the
 * engine side, so a one-line change in either file fails both test
 * suites and the reviewer has to consciously re-sync them.
 */
describe("config: ReasoningEffort", () => {
  it("exposes the canonical vocabulary in REASONING_EFFORTS", () => {
    expect(REASONING_EFFORTS).toEqual(["off", "low", "medium", "high"])
  })

  it("maps every non-off effort to a positive budget", () => {
    for (const effort of REASONING_EFFORTS) {
      if (effort === "off") continue
      expect(REASONING_BUDGETS[effort]).toBeGreaterThan(0)
    }
  })

  it("pins the canonical Anthropic budgets (matches dashboard adapter)", () => {
    // Drift between this and the dashboard's applyReasoning() means
    // chat-level and engine-level thinking budgets silently disagree.
    expect(REASONING_BUDGETS.low).toBe(2_048)
    expect(REASONING_BUDGETS.medium).toBe(10_000)
    expect(REASONING_BUDGETS.high).toBe(32_000)
  })

  describe("parseReasoningEffort", () => {
    it("returns null for undefined / empty / whitespace", () => {
      expect(parseReasoningEffort(undefined)).toBeNull()
      expect(parseReasoningEffort(null)).toBeNull()
      expect(parseReasoningEffort("")).toBeNull()
      expect(parseReasoningEffort("   ")).toBeNull()
    })

    it("returns the canonical value for each valid string", () => {
      expect(parseReasoningEffort("off")).toBe("off")
      expect(parseReasoningEffort("low")).toBe("low")
      expect(parseReasoningEffort("medium")).toBe("medium")
      expect(parseReasoningEffort("high")).toBe("high")
    })

    it("is case-insensitive and trims whitespace", () => {
      expect(parseReasoningEffort("HIGH")).toBe("high")
      expect(parseReasoningEffort("  Medium  ")).toBe("medium")
      expect(parseReasoningEffort("OfF")).toBe("off")
    })

    it("returns null for unknown values (caller falls through to next source)", () => {
      expect(parseReasoningEffort("nuclear")).toBeNull()
      expect(parseReasoningEffort("0")).toBeNull()
      expect(parseReasoningEffort("disable")).toBeNull()
    })
  })
})
