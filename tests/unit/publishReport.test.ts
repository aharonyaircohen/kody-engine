import { beforeEach, describe, expect, it, vi } from "vitest"

const { writeStateText } = vi.hoisted(() => ({ writeStateText: vi.fn() }))
vi.mock("../../src/stateRepo.js", () => ({ writeStateText }))

import { buildRuntimeReportMarkdown, publishReport } from "../../src/scripts/publishReport.js"

describe("publishReport", () => {
  beforeEach(() => writeStateText.mockReset())

  it("builds an extensible typed report from ordinary capability facts", () => {
    const markdown = buildRuntimeReportMarkdown({
      generatedAt: "2026-07-14T12:00:00.000Z",
      reportType: "security-audit",
      reportTypeVersion: 2,
      owner: "security-loop",
      capability: "scan-repository",
      title: "Repository security audit",
      summary: "Two risky dependencies were found",
      data: { riskCount: 2 },
    })

    expect(markdown).toContain("reportType: security-audit")
    expect(markdown).toContain("reportTypeVersion: 2")
    expect(markdown).toContain("  model: security-loop")
    expect(markdown).toContain("  capability: scan-repository")
    expect(markdown).toContain("# Repository security audit")
    expect(markdown).toContain('"riskCount": 2')
  })

  it("publishes only when the workflow-selected fact exists", async () => {
    const ctx = {
      config: { state: { repo: "o/kody-state", path: "r" } },
      cwd: "/repo",
      data: {
        jobCapability: "observe-repo-ci",
        reportPublication: {
          type: "finding",
          version: 1,
          owner: "agency-observer",
          slugFact: "finding.id",
          titleFact: "finding.title",
          publishWhenFact: "finding.id",
        },
        capabilityResults: [
          {
            version: 1,
            status: "fail",
            summary: "Default branch CI is failing",
            facts: {
              finding: {
                id: "finding-repo-ci-main",
                title: "Default branch CI is failing",
              },
            },
            artifacts: [],
            missingEvidence: [],
            blockers: [],
          },
        ],
      },
      output: { exitCode: 0 },
    }

    await publishReport(ctx as never, {} as never, null)

    expect(writeStateText).toHaveBeenCalledOnce()
    expect(writeStateText.mock.calls[0]![2]).toMatch(
      /^reports\/finding-repo-ci-main\/runs\/.+\.md$/,
    )
    expect(writeStateText.mock.calls[0]![3]).toContain("reportType: finding")
  })

  it("does nothing when a conditional report has no matching fact", async () => {
    const ctx = {
      config: { state: { repo: "o/kody-state", path: "r" } },
      cwd: "/repo",
      data: {
        reportPublication: {
          type: "learning",
          owner: "agency-operating-loop",
          slugFact: "learning.id",
          publishWhenFact: "learning.id",
        },
        capabilityResults: [
          {
            version: 1,
            status: "pass",
            summary: "Finding operation completed",
            facts: { operation: { phase: "learn" } },
            artifacts: [],
            missingEvidence: [],
            blockers: [],
          },
        ],
      },
      output: { exitCode: 0 },
    }

    await publishReport(ctx as never, {} as never, null)

    expect(writeStateText).not.toHaveBeenCalled()
  })

  it("publishes a learning report from workflow state data", async () => {
    const ctx = {
      config: { state: { repo: "o/kody-state", path: "r" } },
      cwd: "/repo",
      data: {
        jobCapability: "operate-findings",
        reportPublication: {
          type: "learning",
          owner: "agency-operating-loop",
          slugFact: "learning.id",
          titleFact: "learning.summary",
          publishWhenFact: "learning.id",
        },
        capabilityResults: [
          {
            version: 1,
            status: "pass",
            summary: "Finding operation completed",
            facts: { operation: { phase: "learn" } },
            artifacts: [],
            missingEvidence: [],
            blockers: [],
          },
        ],
        nextJobState: {
          data: {
            learning: {
              id: "learning-finding-repo-ci-main",
              summary: "The repository recovered after its CI fix",
              findingId: "finding-repo-ci-main",
            },
          },
        },
      },
      output: { exitCode: 0 },
    }

    await publishReport(ctx as never, {} as never, null)

    expect(writeStateText).toHaveBeenCalledOnce()
    expect(writeStateText.mock.calls[0]![2]).toMatch(
      /^reports\/learning-finding-repo-ci-main\/runs\/.+\.md$/,
    )
    expect(writeStateText.mock.calls[0]![3]).toContain("reportType: learning")
    expect(writeStateText.mock.calls[0]![3]).toContain(
      "# The repository recovered after its CI fix",
    )
  })
})
