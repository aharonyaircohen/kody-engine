import { describe, expect, it, vi } from "vitest"
import { finalizeMergedPullRequestEvent, mergedKodyPullRequestTargets } from "../../src/mergedPrLifecycle.js"

function event(overrides: Record<string, unknown> = {}) {
  return {
    action: "closed",
    number: 6,
    pull_request: {
      number: 6,
      merged: true,
      body: "Closes #5",
      labels: [{ name: "kody:reviewing" }],
    },
    ...overrides,
  }
}

describe("merged PR lifecycle", () => {
  it("finds the merged Kody PR and every linked closing issue", () => {
    const input = event({
      pull_request: {
        number: 12,
        merged: true,
        body: "Closes #5\nFixes #7\nResolves #5",
        labels: [{ name: "enhancement" }, { name: "kody:failed" }],
      },
    })
    expect(mergedKodyPullRequestTargets(input)).toEqual({ pr: 12, issues: [5, 7] })
  })

  it("ignores unmerged and non-Kody pull requests", () => {
    expect(
      mergedKodyPullRequestTargets(
        event({ pull_request: { number: 6, merged: false, body: "Closes #5", labels: [{ name: "kody:reviewing" }] } }),
      ),
    ).toBeNull()
    expect(
      mergedKodyPullRequestTargets(
        event({ pull_request: { number: 6, merged: true, body: "Closes #5", labels: [{ name: "feature" }] } }),
      ),
    ).toBeNull()
  })

  it("marks both the PR and its linked issue done", () => {
    const writeLabel = vi.fn()
    expect(finalizeMergedPullRequestEvent(event(), "/repo", writeLabel)).toEqual({ pr: 6, issues: [5] })
    expect(writeLabel).toHaveBeenNthCalledWith(1, 6, expect.objectContaining({ label: "kody:done" }), "/repo")
    expect(writeLabel).toHaveBeenNthCalledWith(2, 5, expect.objectContaining({ label: "kody:done" }), "/repo")
  })
})
