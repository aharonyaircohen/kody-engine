import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/implementations/types.js"

const mocks = vi.hoisted(() => ({ gh: vi.fn(), saveRepoDoc: vi.fn() }))
vi.mock("../../src/issue.js", () => ({ gh: mocks.gh }))
vi.mock("../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => ({ saveRepoDoc: mocks.saveRepoDoc }),
}))

import { openAgencyModelReviewPr, parseAgencyModelProposal } from "../../src/scripts/openAgencyModelReviewPr.js"

const agentResult = {
  outcome: "completed",
  outcomeKind: "ok",
  finalText: "",
  ndjsonPath: "/tmp/agent.ndjson",
} as AgentResult

function bundle(files = [{ path: "capabilities/example/profile.json", content: '{"name":"example"}\n' }]): string {
  return JSON.stringify({ title: "Add example", summary: "Review this definition.", files })
}

function makeCtx(summary = bundle()): Context {
  return {
    args: { issue: 42 },
    cwd: "/tmp/consumer",
    config: {
      github: { owner: "consumer", repo: "app" },
      git: { defaultBranch: "main" },
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      agent: { model: "claude/sonnet" },
    },
    data: { agentDone: true, prSummary: summary },
    output: { exitCode: 0 },
  }
}

describe("openAgencyModelReviewPr", () => {
  beforeEach(() => {
    mocks.gh.mockReset()
    mocks.saveRepoDoc.mockReset()
  })

  it("stores an inactive backend proposal and comments on the source issue", async () => {
    const ctx = makeCtx()
    await openAgencyModelReviewPr(ctx, { name: "capability-creator" } as Profile, agentResult)
    expect(mocks.saveRepoDoc).toHaveBeenCalledWith(
      "consumer/app",
      expect.stringMatching(/^definition-proposal:issue-42-/),
      expect.objectContaining({
        status: "pending-review",
        files: [{ path: "capabilities/example/profile.json", content: '{"name":"example"}\n' }],
      }),
    )
    expect(mocks.gh).toHaveBeenCalledWith(
      ["issue", "comment", "42", "--body-file", "-"],
      expect.objectContaining({ input: expect.stringContaining("inactive until it is approved") }),
    )
    expect(ctx.data.agencyModelProposal).toMatchObject({ status: "pending-review" })
  })

  it("validates a dry run without backend or GitHub writes", async () => {
    const ctx = makeCtx()
    ctx.args.dry_run = true
    await openAgencyModelReviewPr(ctx, {} as Profile, agentResult)
    expect(mocks.saveRepoDoc).not.toHaveBeenCalled()
    expect(mocks.gh).not.toHaveBeenCalled()
    expect(ctx.data.agencyModelProposal).toMatchObject({ status: "pending-review" })
  })

  it("rejects legacy .kody definition paths", async () => {
    const ctx = makeCtx(bundle([{ path: ".kody/capabilities/example/profile.json", content: "{}\r\n" }]))
    ctx.args.dry_run = true
    await expect(openAgencyModelReviewPr(ctx, {} as Profile, agentResult)).rejects.toThrow(/not a supported/)
  })

  it("rejects empty files and unsafe or unsupported paths", async () => {
    expect(() => parseAgencyModelProposal(JSON.stringify({ title: "x", summary: "x", files: [] }))).toThrow(/non-empty/)
    await expect(
      openAgencyModelReviewPr(makeCtx(bundle([{ path: "../secret", content: "nope" }])), {} as Profile, agentResult),
    ).rejects.toThrow(/unsafe/)
    await expect(
      openAgencyModelReviewPr(
        makeCtx(bundle([{ path: "implementations/example/profile.json", content: "{}" }])),
        {} as Profile,
        agentResult,
      ),
    ).rejects.toThrow(/not a supported definition path/)
  })
})
