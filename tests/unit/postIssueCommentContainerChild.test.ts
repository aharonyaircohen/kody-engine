import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  postIssueComment: vi.fn(),
  postPrReviewComment: vi.fn(),
  truncate: (s: string) => s,
}))

vi.mock("../../src/lifecycleLabels.js", () => ({
  KODY_NAMESPACE: "kody",
  setKodyLabel: vi.fn(),
}))

import type { Context, Profile } from "../../src/agent-actions/types.js"
import { postIssueComment as ghPostIssueComment } from "../../src/issue.js"
import { setKodyLabel } from "../../src/lifecycleLabels.js"
import { postIssueComment } from "../../src/scripts/postIssueComment.js"

const reproduceProfile = { name: "reproduce" } as Profile

/**
 * Build a context simulating the A-Guy #1568 scenario:
 *   - reproduce stage finished with no commits (signature mismatch)
 *   - agent did not emit DONE
 *   - parent container (bug) routes REPRODUCE_FAILED → plan, so this is NOT
 *     a terminal failure for the user
 */
function makeContainerChildCtx(): Context {
  return {
    args: { issue: 1568 },
    cwd: "/tmp",
    config: {} as Context["config"],
    data: {
      commentTargetType: "issue",
      commentTargetNumber: 1568,
      commitResult: { committed: false },
      hasCommitsAhead: false,
      agentDone: false,
      agentFailureReason: "verifyReproFails: signature did not match",
    },
    output: { exitCode: 0 },
  }
}

describe("postIssueComment: container-child softening", () => {
  beforeEach(() => {
    vi.mocked(ghPostIssueComment).mockClear()
    vi.mocked(setKodyLabel).mockClear()
    delete process.env.KODY_CONTAINER_PARENT
  })
  afterEach(() => {
    delete process.env.KODY_CONTAINER_PARENT
  })

  it("posts a ⚠️ FAILED + kody:failed label when NOT a container child", async () => {
    await postIssueComment(makeContainerChildCtx(), reproduceProfile, null)
    const body = vi.mocked(ghPostIssueComment).mock.calls[0]![1]
    expect(body).toMatch(/^⚠️ kody FAILED/)
    expect(vi.mocked(setKodyLabel)).toHaveBeenCalled()
    const labelArg = vi.mocked(setKodyLabel).mock.calls[0]![1]
    expect((labelArg as { label: string }).label).toBe("kody:failed")
  })

  it("posts a ℹ️ informational comment when running under a container parent", async () => {
    process.env.KODY_CONTAINER_PARENT = "bug"
    await postIssueComment(makeContainerChildCtx(), reproduceProfile, null)
    const body = String(vi.mocked(ghPostIssueComment).mock.calls[0]![1])
    expect(body).toMatch(/^ℹ️ kody reproduce/)
    expect(body).toContain("bug container will route to the next stage")
    expect(body).not.toMatch(/kody FAILED/)
  })

  it("does NOT stamp kody:failed when running under a container parent", async () => {
    process.env.KODY_CONTAINER_PARENT = "bug"
    await postIssueComment(makeContainerChildCtx(), reproduceProfile, null)
    expect(vi.mocked(setKodyLabel)).not.toHaveBeenCalled()
  })

  it("still sets exit code 3 so the container's routing fallback sees a non-zero exit", async () => {
    process.env.KODY_CONTAINER_PARENT = "bug"
    const ctx = makeContainerChildCtx()
    await postIssueComment(ctx, reproduceProfile, null)
    expect(ctx.output.exitCode).toBe(3)
  })

  it("includes the parent container's name in the informational message", async () => {
    process.env.KODY_CONTAINER_PARENT = "feature"
    await postIssueComment(makeContainerChildCtx(), reproduceProfile, null)
    const body = String(vi.mocked(ghPostIssueComment).mock.calls[0]![1])
    expect(body).toContain("feature container will route")
  })

  it("includes the child's agentAction name in the informational message", async () => {
    process.env.KODY_CONTAINER_PARENT = "bug"
    await postIssueComment(makeContainerChildCtx(), { name: "research" } as Profile, null)
    const body = String(vi.mocked(ghPostIssueComment).mock.calls[0]![1])
    expect(body).toMatch(/^ℹ️ kody research:/)
  })
})
