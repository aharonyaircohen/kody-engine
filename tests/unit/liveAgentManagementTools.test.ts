import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const backend = vi.hoisted(() => ({
  listReports: vi.fn(),
  getRepoDoc: vi.fn(),
  saveRepoDoc: vi.fn(),
}))
const gh = vi.hoisted(() => vi.fn())

vi.mock("../../src/state-backend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state-backend.js")>()
  return { ...actual, createStateBackendFromEnv: () => backend }
})
vi.mock("../../src/issue.js", () => ({ gh }))

import { capabilityToolDefinitions } from "../../src/capabilityMcp.js"

function tool(name: string) {
  const selected = capabilityToolDefinitions({
    repoSlug: "acme/widgets",
    operatorMention: "@operator",
  }).find((candidate) => candidate.name === name)
  if (!selected) throw new Error(`missing tool ${name}`)
  return selected
}

function outputText(value: Awaited<ReturnType<ReturnType<typeof tool>["handler"]>>) {
  return value.content[0]?.text ?? ""
}

describe("live Agent management tools", () => {
  beforeEach(() => vi.clearAllMocks())

  it("requires a stable Todo item id", () => {
    const itemIdSchema = tool("reconcile_todo").inputSchema.itemId

    expect(z.safeParse(itemIdSchema, undefined).success).toBe(false)
  })

  it("reads the real status of an asynchronously started workflow run", async () => {
    gh.mockReturnValue(
      JSON.stringify({
        status: "completed",
        conclusion: "success",
        url: "https://github.com/acme/widgets/actions/runs/42",
        createdAt: "2026-08-30T07:17:31Z",
        updatedAt: "2026-08-30T07:18:58Z",
      }),
    )

    const result = await tool("read_workflow_run").handler({ runId: 42 })

    expect(JSON.parse(outputText(result))).toEqual({
      runId: 42,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/widgets/actions/runs/42",
      createdAt: "2026-08-30T07:17:31Z",
      updatedAt: "2026-08-30T07:18:58Z",
    })
    expect(gh).toHaveBeenCalledWith([
      "run",
      "view",
      "42",
      "--repo",
      "acme/widgets",
      "--json",
      "status,conclusion,url,createdAt,updatedAt",
    ])
  })

  it("returns the newest matching Report", async () => {
    backend.listReports.mockResolvedValue([
      { slug: "director-repo-ci", runId: "old", body: "old", meta: {}, updatedAt: "2026-08-25T00:00:00Z" },
      { slug: "other", runId: "newer", body: "ignore", meta: {}, updatedAt: "2026-08-27T00:00:00Z" },
      { slug: "director-repo-ci", runId: "new", body: "healthy", meta: {}, updatedAt: "2026-08-26T00:00:00Z" },
    ])

    const result = await tool("read_latest_report").handler({ slug: "director-repo-ci" })

    expect(JSON.parse(outputText(result))).toMatchObject({ found: true, runId: "new", body: "healthy" })
  })

  it("creates one stable Todo and reuses it on later cycles", async () => {
    let stored: Record<string, unknown> | null = null
    backend.getRepoDoc.mockImplementation(async () => (stored ? { doc: stored, updatedAt: "revision-1" } : null))
    backend.saveRepoDoc.mockImplementation(async (_tenant, _kind, doc) => {
      stored = doc as Record<string, unknown>
    })
    const input = {
      slug: "director-repo-ci",
      itemId: "repo-ci-main",
      title: "Restore repository CI",
      status: "open",
      reportSlug: "director-repo-ci",
      reportRunId: "run-1",
      evidence: "CI is failing",
    }

    const created = await tool("reconcile_todo").handler(input)

    expect(JSON.parse(outputText(created))).toMatchObject({ changed: true, slug: "director-repo-ci" })
    expect(backend.saveRepoDoc).toHaveBeenCalledWith(
      "acme/widgets",
      "todo:director-repo-ci",
      expect.objectContaining({
        items: [expect.objectContaining({ id: "repo-ci-main", completed: false })],
      }),
      undefined,
    )

    backend.saveRepoDoc.mockClear()

    const repeated = await tool("reconcile_todo").handler({ ...input, reportRunId: "run-2" })

    expect(JSON.parse(outputText(repeated))).toMatchObject({ changed: false })
    expect(backend.saveRepoDoc).not.toHaveBeenCalled()
  })

  it("derives the canonical Todo from the Report instead of a generated slug", async () => {
    let stored: Record<string, unknown> | null = null
    backend.getRepoDoc.mockImplementation(async () => (stored ? { doc: stored, updatedAt: "revision-1" } : null))
    backend.saveRepoDoc.mockImplementation(async (_tenant, _kind, doc) => {
      stored = doc as Record<string, unknown>
    })

    const result = await tool("reconcile_todo").handler({
      slug: "repo-ci-health",
      itemId: "repo-ci-main",
      title: "Repository CI health",
      status: "open",
      reportSlug: "director-repo-ci",
      reportRunId: "run-1",
      evidence: "CI is failing",
    })

    expect(JSON.parse(outputText(result))).toMatchObject({
      changed: true,
      slug: "director-repo-ci",
    })
    expect(backend.saveRepoDoc).toHaveBeenCalledWith(
      "acme/widgets",
      "todo:director-repo-ci",
      expect.any(Object),
      undefined,
    )
  })

  it("collapses the legacy fallback item for the same Report", async () => {
    let stored: Record<string, unknown> = {
      version: 1,
      title: "Repository CI health",
      items: [
        {
          id: "finding",
          title: "Legacy CI finding",
          completed: true,
          meta: { reportSlug: "director-repo-ci", reportRunId: "old-run" },
        },
        {
          id: "unrelated",
          title: "Keep me",
          completed: false,
          meta: { reportSlug: "another-report" },
        },
      ],
    }
    backend.getRepoDoc.mockImplementation(async () => ({ doc: stored, updatedAt: "revision-1" }))
    backend.saveRepoDoc.mockImplementation(async (_tenant, _kind, doc) => {
      stored = doc as Record<string, unknown>
    })

    await tool("reconcile_todo").handler({
      itemId: "repo-ci-main",
      title: "Repository CI health",
      status: "resolved",
      reportSlug: "director-repo-ci",
      reportRunId: "new-run",
      evidence: "CI is healthy",
    })

    expect((stored.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([
      "unrelated",
      "repo-ci-main",
    ])
  })

  it("verifies the Todo write and retries when the first write is not visible", async () => {
    let persisted: Record<string, unknown> | null = null
    let writes = 0
    backend.getRepoDoc.mockImplementation(async () => (persisted ? { doc: persisted, updatedAt: "revision-2" } : null))
    backend.saveRepoDoc.mockImplementation(async (_tenant, _kind, doc) => {
      writes += 1
      if (writes === 2) persisted = doc as Record<string, unknown>
    })

    const result = await tool("reconcile_todo").handler({
      slug: "director-repo-ci",
      itemId: "repo-ci-main",
      title: "Restore repository CI",
      status: "open",
      reportSlug: "director-repo-ci",
      reportRunId: "run-1",
      evidence: "CI is failing",
    })

    expect(JSON.parse(outputText(result))).toMatchObject({ changed: true, verified: true })
    expect(backend.saveRepoDoc).toHaveBeenCalledTimes(2)
  })

  it("closes and later reopens the same Todo item", async () => {
    const existing = {
      version: 1,
      title: "Restore repository CI",
      description: "",
      createdAt: "2026-08-25T00:00:00Z",
      items: [
        {
          id: "finding",
          title: "Restore repository CI",
          body: "CI is failing",
          completed: false,
          createdAt: "2026-08-25T00:00:00Z",
          completedAt: null,
          meta: { reportSlug: "director-repo-ci", status: "open" },
        },
      ],
    }
    let stored: Record<string, unknown> = existing
    backend.getRepoDoc.mockImplementation(async () => ({ doc: stored, updatedAt: "revision-1" }))
    backend.saveRepoDoc.mockImplementation(async (_tenant, _kind, doc) => {
      stored = doc as Record<string, unknown>
    })

    await tool("reconcile_todo").handler({
      slug: "director-repo-ci",
      itemId: "repo-ci-main",
      title: "Restore repository CI",
      status: "resolved",
      reportSlug: "director-repo-ci",
      evidence: "CI recovered",
    })

    const closed = backend.saveRepoDoc.mock.calls[0]![2]
    expect(closed.items).toEqual([expect.objectContaining({ id: "repo-ci-main", completed: true })])

    backend.saveRepoDoc.mockClear()
    await tool("reconcile_todo").handler({
      slug: "director-repo-ci",
      itemId: "repo-ci-main",
      title: "Restore repository CI",
      status: "open",
      reportSlug: "director-repo-ci",
      evidence: "CI failed again",
    })

    const reopened = backend.saveRepoDoc.mock.calls[0]![2]
    expect(reopened.items).toEqual([
      expect.objectContaining({ id: "repo-ci-main", completed: false, completedAt: null }),
    ])
  })
})
