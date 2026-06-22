import { describe, expect, it } from "vitest"
import { isMutatingPostflight, shouldBlockMutatingPostflight } from "../../src/executor.js"
import { postflightScripts } from "../../src/scripts/index.js"

/**
 * Failure-safety enforcement (structural, not by-convention).
 *
 * The executor refuses to run a state-mutating postflight (commitAndPush,
 * ensurePr) once the run has recorded any non-zero exit code — so a postflight
 * that forgets to self-guard can no longer commit/push a half-finished tree or
 * open a PR for a failed run. These tests lock that contract.
 */
describe("postflight failure-safety: which scripts are state-mutating", () => {
  it("classifies the known mutating postflights", () => {
    expect(isMutatingPostflight("commitAndPush")).toBe(true)
    expect(isMutatingPostflight("ensurePr")).toBe(true)
    expect(isMutatingPostflight("applyAgentResponsibilityReports")).toBe(true)
  })

  it("does NOT classify postflights that must run on failure (they report the failure)", () => {
    // These intentionally fire after a failed run to surface it to the
    // user/state machine — they must never be in the mutating set.
    for (const safe of [
      "postIssueComment",
      "writeAgentRunSummary",
      "recordOutcome",
      "saveTaskState",
      "notifyTerminal",
    ]) {
      expect(isMutatingPostflight(safe)).toBe(false)
    }
  })

  it("treats undefined / shell entries (no script name) as non-mutating", () => {
    expect(isMutatingPostflight(undefined)).toBe(false)
    expect(isMutatingPostflight("")).toBe(false)
  })

  it("every name in the mutating set is a real registered postflight", () => {
    // Guard against a typo'd entry that would silently never match.
    for (const name of ["commitAndPush", "ensurePr", "applyAgentResponsibilityReports"]) {
      expect(Object.keys(postflightScripts)).toContain(name)
    }
  })
})

describe("postflight failure-safety: shouldBlockMutatingPostflight", () => {
  it("blocks a mutating postflight when the run has already failed (any non-zero exit)", () => {
    for (const exit of [1, 2, 3, 4, 99, 124]) {
      expect(shouldBlockMutatingPostflight("commitAndPush", exit)).toBe(true)
      expect(shouldBlockMutatingPostflight("ensurePr", exit)).toBe(true)
    }
  })

  it("allows a mutating postflight to run on a clean (zero / unset) exit", () => {
    expect(shouldBlockMutatingPostflight("commitAndPush", 0)).toBe(false)
    expect(shouldBlockMutatingPostflight("commitAndPush", undefined)).toBe(false)
    expect(shouldBlockMutatingPostflight("ensurePr", 0)).toBe(false)
  })

  it("never blocks a non-mutating postflight, even on failure", () => {
    expect(shouldBlockMutatingPostflight("postIssueComment", 2)).toBe(false)
    expect(shouldBlockMutatingPostflight("recordOutcome", 99)).toBe(false)
    expect(shouldBlockMutatingPostflight(undefined, 1)).toBe(false)
  })
})
