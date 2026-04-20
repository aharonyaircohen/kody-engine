import { beforeEach, describe, expect, it, vi } from "vitest"

const execFileSyncMock = vi.fn()
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

import { isKody2DispatchWorkflow, pickFailedRunForFixCi, getRecentFailedRunsForPr } from "../../src/workflow.js"

type GhCall = { cmd: string; args: string[] }

function stubGh(responders: Array<(args: string[]) => string | Error>): GhCall[] {
  const calls: GhCall[] = []
  let i = 0
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    const responder = responders[i++]
    if (!responder) throw new Error(`unexpected gh call #${i}: ${args.join(" ")}`)
    const out = responder(args)
    if (out instanceof Error) throw out
    return out
  })
  return calls
}

beforeEach(() => {
  execFileSyncMock.mockReset()
})

describe("isKody2DispatchWorkflow", () => {
  it("matches the template workflow name case-insensitively", () => {
    expect(isKody2DispatchWorkflow("kody2")).toBe(true)
    expect(isKody2DispatchWorkflow("KODY2")).toBe(true)
    expect(isKody2DispatchWorkflow(" kody2 ")).toBe(true)
  })

  it("does not match other workflows", () => {
    expect(isKody2DispatchWorkflow("CI")).toBe(false)
    expect(isKody2DispatchWorkflow(".github/workflows/codeql.yml")).toBe(false)
    expect(isKody2DispatchWorkflow("")).toBe(false)
  })
})

describe("getRecentFailedRunsForPr", () => {
  it("returns empty array when the branch cannot be resolved", () => {
    stubGh([() => new Error("boom")])
    expect(getRecentFailedRunsForPr(42, 10)).toEqual([])
  })

  it("maps gh run list output into FailedRun objects", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature" }),
      () =>
        JSON.stringify([
          {
            databaseId: 111,
            workflowName: "CI",
            headBranch: "feature",
            conclusion: "failure",
            url: "https://example.com/runs/111",
            createdAt: "2026-04-20T00:00:00Z",
          },
        ]),
    ])
    const runs = getRecentFailedRunsForPr(42, 10)
    expect(runs).toEqual([
      {
        id: "111",
        workflowName: "CI",
        headBranch: "feature",
        conclusion: "failure",
        url: "https://example.com/runs/111",
        createdAt: "2026-04-20T00:00:00Z",
      },
    ])
  })
})

describe("pickFailedRunForFixCi", () => {
  it("skips kody2 dispatch workflow runs", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature" }),
      () =>
        JSON.stringify([
          {
            databaseId: 1,
            workflowName: "kody2",
            headBranch: "feature",
            conclusion: "failure",
            url: "u1",
            createdAt: "t1",
          },
          {
            databaseId: 2,
            workflowName: "CI",
            headBranch: "feature",
            conclusion: "failure",
            url: "u2",
            createdAt: "t2",
          },
        ]),
      // log-tail fetch for run 2 succeeds
      () => "some failing log",
    ])
    const picked = pickFailedRunForFixCi(42, 1_000, 10)
    expect(picked?.run.id).toBe("2")
    expect(picked?.logTail).toBe("some failing log")
  })

  it("skips runs whose --log-failed fetch fails (e.g. CodeQL logs not available)", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature" }),
      () =>
        JSON.stringify([
          {
            databaseId: 10,
            workflowName: ".github/workflows/codeql.yml",
            headBranch: "feature",
            conclusion: "failure",
            url: "u10",
            createdAt: "t10",
          },
          {
            databaseId: 20,
            workflowName: "CI",
            headBranch: "feature",
            conclusion: "failure",
            url: "u20",
            createdAt: "t20",
          },
        ]),
      // first run — log fetch throws (simulates `log not found`)
      () => new Error("log not found"),
      // second run — log fetch succeeds
      () => "ci failure log",
    ])
    const picked = pickFailedRunForFixCi(42, 1_000, 10)
    expect(picked?.run.id).toBe("20")
    expect(picked?.logTail).toBe("ci failure log")
  })

  it("skips runs whose log tail is empty (log exists but no failed-step output)", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature" }),
      () =>
        JSON.stringify([
          { databaseId: 1, workflowName: "A", conclusion: "failure", url: "u1", createdAt: "t1" },
          { databaseId: 2, workflowName: "B", conclusion: "failure", url: "u2", createdAt: "t2" },
        ]),
      () => "",
      () => "real log",
    ])
    const picked = pickFailedRunForFixCi(42, 1_000, 10)
    expect(picked?.run.id).toBe("2")
  })

  it("returns null when no runs are usable", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature" }),
      () =>
        JSON.stringify([
          { databaseId: 1, workflowName: "kody2", conclusion: "failure", url: "u1", createdAt: "t1" },
        ]),
    ])
    expect(pickFailedRunForFixCi(42, 1_000, 10)).toBeNull()
  })
})
