import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { writeResponsibilityReport } from "../../src/scripts/writeResponsibilityReport.js"
import { readStateText, upsertStateText } from "../../src/stateRepo.js"

vi.mock("../../src/stateRepo.js", () => ({
  readStateText: vi.fn(),
  upsertStateText: vi.fn(),
}))

const PROFILE = { name: "model-health-audit" } as Profile

function ctxFor(data: Record<string, unknown>): Context {
  return {
    args: {},
    cwd: "/repo",
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "anthropic/claude" },
      state: { repo: "o/kody-state", path: "r" },
    },
    data,
    output: { exitCode: 0 },
  }
}

describe("writeResponsibilityReport", () => {
  beforeEach(() => {
    vi.mocked(readStateText).mockReset()
    vi.mocked(upsertStateText).mockReset()
    vi.mocked(readStateText).mockReturnValue(null)
  })

  it("saves prSummary as reports/<responsibility>.md when requested", async () => {
    const ctx = ctxFor({
      jobSaveReport: true,
      jobAgentResponsibility: "model-health-audit",
      prSummary: "# Model Health Audit\n",
    })

    await writeResponsibilityReport(ctx, PROFILE, null)

    expect(upsertStateText).toHaveBeenCalledWith(
      ctx.config,
      "/repo",
      "reports/model-health-audit.md",
      "# Model Health Audit\n",
      "chore(reports): refresh model-health-audit",
    )
    expect(ctx.data.responsibilityReport).toEqual({
      slug: "model-health-audit",
      path: "reports/model-health-audit.md",
      changed: true,
    })
  })
})
