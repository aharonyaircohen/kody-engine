import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/branch.js", () => ({
  ensureFeatureBranch: vi.fn(() => ({ branch: "42-foo", created: true })),
}))
vi.mock("../../src/issue.js", () => ({
  DEFAULT_COMMENT_LIMIT: 50,
  DEFAULT_COMMENT_MAX_BYTES: 16_000,
  formatIssueComments: vi.fn(() => "comments-formatted"),
  getIssue: vi.fn(() => ({
    number: 42,
    title: "Foo",
    body: "body",
    comments: [],
    labels: [],
  })),
  postIssueComment: vi.fn(),
}))
vi.mock("../../src/gha.js", () => ({
  getRunUrl: vi.fn(() => ""),
}))

import type { Context, Profile } from "../../src/agent-actions/types.js"
import { runFlow } from "../../src/scripts/runFlow.js"

const profile = {} as Profile

function makeCtx(args: Record<string, unknown>): Context {
  return {
    args,
    cwd: "/tmp",
    config: { git: { defaultBranch: "main" } } as Context["config"],
    data: {},
    output: { exitCode: 0 },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("runFlow: feedback handling (issue #39)", () => {
  // The dashboard's Rerun action forwards `Rerun.feedback` through the
  // `run.feedback` input. runFlow must surface that string on ctx.data
  // so `composePrompt` can render the `{{feedback}}` token. The prompt
  // formatter is exercised in composePrompt.test.ts; this file pins
  // the runFlow-side wiring.
  it("puts the feedback input on ctx.data when supplied via args", async () => {
    const ctx = makeCtx({ issue: 42, feedback: "add a CLI flag" })
    await runFlow(ctx, profile)
    expect(ctx.data.feedback).toBe("add a CLI flag")
  })

  it("omits ctx.data.feedback when no feedback was supplied (regular run)", async () => {
    const ctx = makeCtx({ issue: 42 })
    await runFlow(ctx, profile)
    expect(ctx.data.feedback).toBeUndefined()
  })

  it("ignores an all-whitespace feedback string (no spurious block in prompt)", async () => {
    const ctx = makeCtx({ issue: 42, feedback: "   \n  " })
    await runFlow(ctx, profile)
    expect(ctx.data.feedback).toBeUndefined()
  })
})
