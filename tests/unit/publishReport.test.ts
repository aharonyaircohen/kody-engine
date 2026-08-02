import { beforeEach, describe, expect, it, vi } from "vitest"

const { saveReport } = vi.hoisted(() => ({ saveReport: vi.fn() }))
vi.mock("../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => ({ saveReport }),
  hasStateBackendConfig: () => true,
}))

import { buildRuntimeReportMarkdown, publishReport, publishWorkflowReport } from "../../src/scripts/publishReport.js"

describe("publishReport", () => {
  beforeEach(() => {
    saveReport.mockReset()
    process.env.CONVEX_URL = "https://example.convex.cloud"
    process.env.KODY_SERVICE_KEY = "service-key"
  })

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

    expect(markdown).toContain("# Repository security audit")
    expect(markdown).toContain("- **Type:** security-audit")
    expect(markdown).toContain("- **Version:** 2")
    expect(markdown).toContain("- **Owner:** security-loop")
    expect(markdown).toContain("- **Capability:** scan-repository")
    expect(markdown).toContain("## Results")
    expect(markdown).toContain("- **Risk Count:** 2")
    expect(markdown).not.toContain("```json")
    expect(markdown).not.toContain("## Report data")
  })

  it("publishes only when the workflow-selected fact exists", async () => {
    const ctx = {
      config: { github: { owner: "o", repo: "r" } },
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

    expect(saveReport).toHaveBeenCalledOnce()
    expect(saveReport.mock.calls[0]![1]).toBe("finding-repo-ci-main")
    expect(saveReport.mock.calls[0]![4]).toContain("- **Type:** finding")
    expect(saveReport.mock.calls[0]![4]).toContain("## Finding")
    expect(saveReport.mock.calls[0]![4]).not.toContain("```json")
  })

  it("does nothing when a conditional report has no matching fact", async () => {
    const ctx = {
      config: { github: { owner: "o", repo: "r" } },
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

    expect(saveReport).not.toHaveBeenCalled()
  })

  it("publishes a learning report from workflow state data", async () => {
    const ctx = {
      config: { github: { owner: "o", repo: "r" } },
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

    expect(saveReport).toHaveBeenCalledOnce()
    expect(saveReport.mock.calls[0]![1]).toBe("learning-finding-repo-ci-main")
    expect(saveReport.mock.calls[0]![4]).toContain("- **Type:** learning")
    expect(saveReport.mock.calls[0]![4]).toContain("# The repository recovered after its CI fix")
  })

  it("publishes one workflow summary report for a completed healthy run", async () => {
    await publishWorkflowReport({
      config: { github: { owner: "o", repo: "r" } } as never,
      publication: {
        type: "agency-observer",
        owner: "agency-observer",
        slug: "agency-observer",
        title: "Agency Observer",
      },
      workflowId: "agency-observer",
      workflowTitle: "Agency Observer",
      state: {
        status: "done",
        completedStepIds: ["source-health", "observe-ci", "observe-flow"],
        transitionCounts: {},
        facts: { finding: { status: "open" } },
        evidence: {},
        artifacts: [{ label: "Stale issue", url: "https://github.com/o/r/issues/63" }],
      },
    })

    expect(saveReport).toHaveBeenCalledOnce()
    expect(saveReport.mock.calls[0]![1]).toBe("agency-observer")
    expect(saveReport.mock.calls[0]![4]).toContain("# Agency Observer")
    expect(saveReport.mock.calls[0]![4]).toContain("## Completed checks")
    expect(saveReport.mock.calls[0]![4]).toContain("- Source Health")
    expect(saveReport.mock.calls[0]![4]).not.toContain("```json")
  })
})
