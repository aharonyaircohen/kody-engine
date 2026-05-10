import { describe, expect, it } from "vitest"
import { computeFailureSuffix, renderMessage } from "../../src/scripts/postIssueComment.js"
import type { PrOutcome } from "../../src/scripts/prOutcome.js"

const URL = "https://github.com/o/r/pull/1"
const created: PrOutcome = { kind: "created", url: URL, number: 1, draft: true }
const updated: PrOutcome = { kind: "updated", url: URL, number: 1, draft: false }
const skipped: PrOutcome = { kind: "skipped", reason: "verify failed" }
const crashed: PrOutcome = { kind: "crashed", reason: "gh pr create exit 22" }

describe("postIssueComment.computeFailureSuffix", () => {
  it("returns ' — draft PR: <url>' when a brand-new PR was created", () => {
    expect(
      computeFailureSuffix({
        prResult: created,
        branch: "kody/x",
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe(" — draft PR: https://github.com/o/r/pull/1")
  })

  it("returns ' — PR: <url>' when an existing PR was updated", () => {
    expect(
      computeFailureSuffix({
        prResult: updated,
        branch: "kody/x",
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe(" — PR: https://github.com/o/r/pull/1")
  })

  it("returns a branch URL when ensurePr was skipped but the branch was pushed", () => {
    expect(
      computeFailureSuffix({
        prResult: skipped,
        branch: "kody/x",
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe(" — branch: https://github.com/o/r/tree/kody/x")
  })

  it("returns a branch URL when ensurePr crashed but the branch was pushed", () => {
    expect(
      computeFailureSuffix({
        prResult: crashed,
        branch: "kody/x",
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe(" — branch: https://github.com/o/r/tree/kody/x")
  })

  it("returns empty when nothing was pushed (no PR, no branch to inspect)", () => {
    expect(
      computeFailureSuffix({
        prResult: skipped,
        branch: "kody/x",
        branchPushed: false,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe("")
  })

  it("returns empty when the branch is unknown even if a commit was reported", () => {
    expect(
      computeFailureSuffix({
        prResult: skipped,
        branch: undefined,
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe("")
  })

  it("returns empty when github owner/repo are missing", () => {
    expect(
      computeFailureSuffix({
        prResult: skipped,
        branch: "kody/x",
        branchPushed: true,
        githubOwner: undefined,
        githubRepo: "r",
      }),
    ).toBe("")
  })
})

describe("postIssueComment.renderMessage", () => {
  const base = {
    isFailure: false,
    failureReason: "",
    justPushedToExistingPr: false,
    branch: "kody/x",
    branchPushed: true,
    githubOwner: "o",
    githubRepo: "r",
  }

  it("emits ✅ PR opened with the URL when prResult is created", () => {
    expect(renderMessage({ ...base, prResult: created })).toBe(`✅ kody PR opened: ${URL}`)
  })

  it("emits ✅ pushed to <url> when prResult is updated AND new commits landed", () => {
    expect(
      renderMessage({ ...base, prResult: updated, justPushedToExistingPr: true }),
    ).toBe(`✅ kody pushed to ${URL}`)
  })

  it("emits ℹ️ no changes when prResult is updated but nothing was pushed", () => {
    expect(renderMessage({ ...base, prResult: updated })).toBe(`ℹ️ kody made no changes — PR: ${URL}`)
  })

  it("never templates 'undefined' when prResult is skipped — surfaces the reason", () => {
    const msg = renderMessage({ ...base, prResult: skipped })
    expect(msg).not.toContain("undefined")
    expect(msg).toContain("verify failed")
    expect(msg).toContain("did not open a PR")
  })

  it("surfaces a crashed PR step explicitly with its error reason", () => {
    const msg = renderMessage({ ...base, prResult: crashed })
    expect(msg).not.toContain("undefined")
    expect(msg).toContain("PR step crashed")
    expect(msg).toContain("gh pr create exit 22")
  })

  it("when prResult is null (script never ran) refuses to claim success", () => {
    const msg = renderMessage({ ...base, prResult: null })
    expect(msg).not.toContain("undefined")
    expect(msg).toContain("PR step did not run")
  })

  it("failure path uses the failureReason and prepends ⚠️ regardless of prResult kind", () => {
    expect(
      renderMessage({
        ...base,
        prResult: created,
        isFailure: true,
        failureReason: "verify failed",
      }),
    ).toBe(`⚠️ kody FAILED: verify failed — draft PR: ${URL}`)
  })
})
