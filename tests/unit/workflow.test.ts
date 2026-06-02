import { beforeEach, describe, expect, it, vi } from "vitest"

const execFileSyncMock = vi.fn()
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

import { getRecentFailedRunsForPr, isKodyDispatchWorkflow, pickFailedRunForFixCi } from "../../src/workflow.js"

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

describe("isKodyDispatchWorkflow", () => {
  it("matches the template workflow name case-insensitively", () => {
    expect(isKodyDispatchWorkflow("kody")).toBe(true)
    expect(isKodyDispatchWorkflow("KODY")).toBe(true)
    expect(isKodyDispatchWorkflow(" kody ")).toBe(true)
  })

  it("does not match other workflows", () => {
    expect(isKodyDispatchWorkflow("CI")).toBe(false)
    expect(isKodyDispatchWorkflow(".github/workflows/codeql.yml")).toBe(false)
    expect(isKodyDispatchWorkflow("")).toBe(false)
  })
})

describe("getRecentFailedRunsForPr", () => {
  it("returns empty array when the branch cannot be resolved", () => {
    stubGh([() => new Error("boom")])
    expect(getRecentFailedRunsForPr(42, 10)).toEqual([])
  })

  it("maps gh run list output into FailedRun objects for the head SHA", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature", headRefOid: "sha-head" }),
      () =>
        JSON.stringify([
          {
            databaseId: 111,
            workflowName: "CI",
            headBranch: "feature",
            headSha: "sha-head",
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
        headSha: "sha-head",
        conclusion: "failure",
        url: "https://example.com/runs/111",
        createdAt: "2026-04-20T00:00:00Z",
      },
    ])
  })

  it("sorts head-SHA failures first but keeps earlier-commit failures as a fallback", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature", headRefOid: "sha-head" }),
      () =>
        JSON.stringify([
          // gh returns most-recent-first: the newest commit's run is listed
          // before the older commit's. The newest may still be in-flight, so
          // the older real failure must survive (just sorted after head).
          { databaseId: 1, workflowName: "CI", headSha: "sha-old", conclusion: "failure", url: "u1", createdAt: "t1" },
          { databaseId: 2, workflowName: "CI", headSha: "sha-head", conclusion: "failure", url: "u2", createdAt: "t2" },
        ]),
    ])
    const runs = getRecentFailedRunsForPr(42, 10)
    expect(runs.map((r) => r.id)).toEqual(["2", "1"])
  })

  it("falls back to branch failures when the head SHA cannot be resolved", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature" }),
      () =>
        JSON.stringify([
          { databaseId: 9, workflowName: "CI", headSha: "sha-x", conclusion: "failure", url: "u9", createdAt: "t9" },
        ]),
    ])
    expect(getRecentFailedRunsForPr(42, 10).map((r) => r.id)).toEqual(["9"])
  })
})

describe("pickFailedRunForFixCi", () => {
  it("skips kody dispatch workflow runs", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature", headRefOid: "sha-head" }),
      () =>
        JSON.stringify([
          {
            databaseId: 1,
            workflowName: "kody",
            headBranch: "feature",
            headSha: "sha-head",
            conclusion: "failure",
            url: "u1",
            createdAt: "t1",
          },
          {
            databaseId: 2,
            workflowName: "CI",
            headBranch: "feature",
            headSha: "sha-head",
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
      () => JSON.stringify({ headRefName: "feature", headRefOid: "sha-head" }),
      () =>
        JSON.stringify([
          {
            databaseId: 10,
            workflowName: ".github/workflows/codeql.yml",
            headBranch: "feature",
            headSha: "sha-head",
            conclusion: "failure",
            url: "u10",
            createdAt: "t10",
          },
          {
            databaseId: 20,
            workflowName: "CI",
            headBranch: "feature",
            headSha: "sha-head",
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
      () => JSON.stringify({ headRefName: "feature", headRefOid: "sha-head" }),
      () =>
        JSON.stringify([
          { databaseId: 1, workflowName: "A", headSha: "sha-head", conclusion: "failure", url: "u1", createdAt: "t1" },
          { databaseId: 2, workflowName: "B", headSha: "sha-head", conclusion: "failure", url: "u2", createdAt: "t2" },
        ]),
      () => "",
      () => "real log",
    ])
    const picked = pickFailedRunForFixCi(42, 1_000, 10)
    expect(picked?.run.id).toBe("2")
  })

  it("falls back to an earlier commit's failure when the head commit's run isn't usable yet", () => {
    // The race that stranded fix-ci: a new commit landed, its CI run is still
    // in-flight (no failed-log yet), while the previous commit has a real,
    // fixable CI failure. fix-ci must act on the older failure, not give up.
    stubGh([
      () => JSON.stringify({ headRefName: "feature", headRefOid: "sha-new" }),
      () =>
        JSON.stringify([
          { databaseId: 5, workflowName: "CI", headSha: "sha-new", conclusion: "failure", url: "u5", createdAt: "t5" },
          { databaseId: 4, workflowName: "CI", headSha: "sha-old", conclusion: "failure", url: "u4", createdAt: "t4" },
        ]),
      // head-commit run (5) has no failed-step log yet → skipped
      () => "",
      // previous commit run (4) has a real failure log → picked
      () => "prettier check failed",
    ])
    const picked = pickFailedRunForFixCi(42, 1_000, 10)
    expect(picked?.run.id).toBe("4")
    expect(picked?.logTail).toBe("prettier check failed")
  })

  it("returns null when no runs are usable", () => {
    stubGh([
      () => JSON.stringify({ headRefName: "feature", headRefOid: "sha-head" }),
      () =>
        JSON.stringify([
          {
            databaseId: 1,
            workflowName: "kody",
            headSha: "sha-head",
            conclusion: "failure",
            url: "u1",
            createdAt: "t1",
          },
        ]),
    ])
    expect(pickFailedRunForFixCi(42, 1_000, 10)).toBeNull()
  })
})
