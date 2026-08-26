import { beforeEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({
  listReports: vi.fn(),
  getRepoDoc: vi.fn(),
  saveRepoDoc: vi.fn(),
}))

vi.mock("../../src/state-backend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state-backend.js")>()
  return { ...actual, createStateBackendFromEnv: () => backend }
})

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
    backend.getRepoDoc.mockResolvedValue(null)
    const input = {
      slug: "director-repo-ci",
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
        items: [expect.objectContaining({ id: "finding", completed: false })],
      }),
      undefined,
    )

    const saved = backend.saveRepoDoc.mock.calls[0]![2]
    backend.getRepoDoc.mockResolvedValue({ doc: saved, updatedAt: "revision-1" })
    backend.saveRepoDoc.mockClear()

    const repeated = await tool("reconcile_todo").handler({ ...input, reportRunId: "run-2" })

    expect(JSON.parse(outputText(repeated))).toMatchObject({ changed: false })
    expect(backend.saveRepoDoc).not.toHaveBeenCalled()
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
    backend.getRepoDoc.mockResolvedValue({ doc: existing, updatedAt: "revision-1" })

    await tool("reconcile_todo").handler({
      slug: "director-repo-ci",
      title: "Restore repository CI",
      status: "resolved",
      reportSlug: "director-repo-ci",
      evidence: "CI recovered",
    })

    const closed = backend.saveRepoDoc.mock.calls[0]![2]
    expect(closed.items).toEqual([expect.objectContaining({ id: "finding", completed: true })])

    backend.getRepoDoc.mockResolvedValue({ doc: closed, updatedAt: "revision-2" })
    backend.saveRepoDoc.mockClear()
    await tool("reconcile_todo").handler({
      slug: "director-repo-ci",
      title: "Restore repository CI",
      status: "open",
      reportSlug: "director-repo-ci",
      evidence: "CI failed again",
    })

    const reopened = backend.saveRepoDoc.mock.calls[0]![2]
    expect(reopened.items).toEqual([expect.objectContaining({ id: "finding", completed: false, completedAt: null })])
  })
})
