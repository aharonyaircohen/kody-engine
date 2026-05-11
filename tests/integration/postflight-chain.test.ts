/**
 * Postflight chain smoke test for the `run` profile.
 *
 * Constructs a synthetic agent result and runs the entire run/profile.json
 * postflight chain in order, with external dependencies (gh, verify, git)
 * mocked. Asserts that the chain's data flow lands the expected
 * ctx.data.action and exit code.
 *
 * Why this test catches what unit tests don't: every individual postflight
 * has unit coverage, but the composition (parseAgentResult → verify →
 * ensurePr → postIssueComment → ...) is the place regressions actually
 * surface in production. A single rename in one script's ctx.data key
 * silently breaks every downstream consumer; this test fails immediately.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

// vi.mock is hoisted above all top-level code, so the mock factories can't
// reference module-level variables. vi.hoisted lets us share the spies.
const mocks = vi.hoisted(() => ({
  gh: vi.fn(),
  ghPr: vi.fn(),
  setKodyLabel: vi.fn(),
  removeLabel: vi.fn(),
  verifyAll: vi.fn(async () => ({ ok: true, failed: [], details: {}, recovered: [] })),
  doEnsurePr: vi.fn(() => ({
    url: "https://github.com/o/r/pull/42",
    number: 42,
    draft: false,
    action: "created" as const,
  })),
  doCommitAndPush: vi.fn(() => ({ committed: true, pushed: true })),
  hasCommitsAhead: vi.fn(() => true),
  listChangedFiles: vi.fn(() => ["src/foo.ts"]),
  listFilesInCommit: vi.fn(() => ["src/foo.ts"]),
  isForbiddenPath: vi.fn(() => false),
  abortUnfinishedGitOps: vi.fn(() => [] as string[]),
}))

vi.mock("../../src/issue.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/issue.js")
  return {
    ...actual,
    postIssueComment: mocks.gh,
    postPrReviewComment: mocks.ghPr,
  }
})

vi.mock("../../src/lifecycleLabels.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/lifecycleLabels.js")
  return { ...actual, setKodyLabel: mocks.setKodyLabel, removeLabel: mocks.removeLabel }
})

vi.mock("../../src/verify.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/verify.js")
  return {
    ...actual,
    verifyAllWithRetry: mocks.verifyAll,
    summarizeFailure: actual.summarizeFailure,
  }
})

vi.mock("../../src/pr.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/pr.js")
  return { ...actual, ensurePr: mocks.doEnsurePr }
})

vi.mock("../../src/commit.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/commit.js")
  return {
    ...actual,
    commitAndPush: mocks.doCommitAndPush,
    hasCommitsAhead: mocks.hasCommitsAhead,
    listChangedFiles: mocks.listChangedFiles,
    listFilesInCommit: mocks.listFilesInCommit,
    isForbiddenPath: mocks.isForbiddenPath,
    abortUnfinishedGitOps: mocks.abortUnfinishedGitOps,
  }
})

import { loadProfile } from "../../src/profile.js"
import { listExecutables } from "../../src/registry.js"
import { postflightScripts } from "../../src/scripts/index.js"
import type { Context } from "../../src/executables/types.js"
import type { AgentResult } from "../../src/agent.js"

function makeAgentResult(finalText: string, outcome: "completed" | "failed" = "completed"): AgentResult {
  return { outcome, finalText }
}

function makeCtx(): Context {
  return {
    args: { issue: 42, mode: "run" },
    cwd: "/tmp/fake-repo",
    config: {
      github: { owner: "o", repo: "r" },
      git: { defaultBranch: "main" },
      quality: { typecheck: "tsc", testUnit: "vitest", lint: "eslint", format: "prettier" },
      agent: { model: "anthropic/claude-haiku-4-5-20251001" },
    } as never,
    verbose: false,
    quiet: true,
    data: {
      // Simulate state that earlier preflights would have set.
      commentTargetType: "issue",
      commentTargetNumber: 42,
      commitResult: { committed: true, pushed: true },
      hasCommitsAhead: true,
      branch: "kody/test-feature",
      changedFiles: ["src/foo.ts"],
      issue: { title: "Add foo" },
    },
    output: { exitCode: 0 },
  } as Context
}

async function runPostflights(ctx: Context, agentResult: AgentResult, profileName: string): Promise<void> {
  const exe = listExecutables().find((e) => e.name === profileName)
  if (!exe) throw new Error(`profile ${profileName} not found`)
  const profile = loadProfile(exe.profilePath)
  for (const entry of profile.scripts.postflight) {
    if (!entry.script) continue // shell entries skipped in this smoke
    const fn = postflightScripts[entry.script]
    if (!fn) throw new Error(`script ${entry.script} not registered`)
    // Honor runWhen the same way the real executor would.
    let shouldRun = true
    if (entry.runWhen) {
      for (const [key, want] of Object.entries(entry.runWhen)) {
        const parts = key.split(".")
        let actual: unknown = ctx
        for (const p of parts) actual = (actual as Record<string, unknown>)?.[p]
        const wanted = Array.isArray(want) ? want : [want]
        if (!wanted.map(String).includes(String(actual))) {
          shouldRun = false
          break
        }
      }
    }
    if (!shouldRun) continue
    try {
      await fn(ctx, profile, agentResult, entry.with)
    } catch (err) {
      // Real executor catches and surfaces; we re-throw so test failures
      // are obvious rather than silent.
      throw new Error(`postflight ${entry.script} crashed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

describe("postflight chain: run profile, success path", () => {
  beforeEach(() => {
    mocks.gh.mockClear()
    mocks.ghPr.mockClear()
    mocks.verifyAll.mockClear()
    mocks.doEnsurePr.mockClear()
  })

  it("agent returns DONE+COMMIT_MSG → action is RUN_COMPLETED + comment posted", async () => {
    const ctx = makeCtx()
    const agent = makeAgentResult(["DONE", "COMMIT_MSG: feat: add foo", "PR_SUMMARY:", "- adds foo"].join("\n"))
    await runPostflights(ctx, agent, "run")
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.commitMessage).toBe("feat: add foo")
    expect(ctx.data.verifyOk).toBe(true)
    expect(mocks.doEnsurePr).toHaveBeenCalledTimes(1)
    expect(ctx.data.prResult).toMatchObject({ kind: "created", url: "https://github.com/o/r/pull/42" })
    expect(mocks.gh).toHaveBeenCalled()
    const lastBody = String(mocks.gh.mock.calls.at(-1)?.[1] ?? "")
    expect(lastBody).toContain("PR opened")
    expect(lastBody).toContain("https://github.com/o/r/pull/42")
    expect(ctx.output.exitCode).toBe(0)
  })

  it("agent missing DONE marker but produced text → still success (markerMissing flag set)", async () => {
    // Locks in the 0.4.30 architectural fix: verify/tests are the real
    // shipability gate, not a five-letter sentinel in the wrap-up.
    const ctx = makeCtx()
    const agent = makeAgentResult("All tests pass and lint is clean. Ready for review.")
    await runPostflights(ctx, agent, "run")
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.agentMarkerMissing).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
  })

  it("verify fails → ensurePr is skipped with a typed PrSkipped outcome", async () => {
    // Locks in the 0.4.32+0.4.36 fixes: ensurePr always sets a typed
    // prResult, postIssueComment never templates undefined.
    mocks.verifyAll.mockResolvedValueOnce({
      ok: false,
      failed: ["typecheck"],
      details: { typecheck: { exitCode: 2, durationMs: 100, tail: "TS errors" } },
      recovered: [],
    })
    const ctx = makeCtx()
    const agent = makeAgentResult("DONE\nCOMMIT_MSG: feat: x")
    await runPostflights(ctx, agent, "run")
    expect(ctx.data.verifyOk).toBe(false)
    expect(mocks.doEnsurePr).not.toHaveBeenCalled()
    expect(ctx.data.prResult).toMatchObject({ kind: "skipped" })
    const lastBody = String(mocks.gh.mock.calls.at(-1)?.[1] ?? "")
    expect(lastBody).not.toContain("undefined")
    expect(lastBody).toContain("FAILED")
  })

  it("agent says FAILED → action is RUN_FAILED, ensurePr opens a draft PR for inspection", async () => {
    mocks.doEnsurePr.mockReturnValueOnce({
      url: "https://github.com/o/r/pull/43",
      number: 43,
      draft: true,
      action: "created",
    })
    const ctx = makeCtx()
    const agent = makeAgentResult("FAILED: I could not figure out how to add the field")
    await runPostflights(ctx, agent, "run")
    expect(ctx.data.agentDone).toBe(false)
    expect(ctx.data.agentFailureReason).toContain("could not figure out")
    // FAILED path still goes to ensurePr (with draft=true) so the user
    // has a one-click path to inspect what the agent did.
    expect(mocks.doEnsurePr).toHaveBeenCalledTimes(1)
    const args = mocks.doEnsurePr.mock.calls[0]?.[0] as { draft?: boolean } | undefined
    expect(args?.draft).toBe(true)
    expect(ctx.data.prResult).toMatchObject({ kind: "created", draft: true })
  })

  it("no commits + agent failed → reason is the agent's failure, not generic 'no changes'", async () => {
    // Locks in the diagnostic-clarity fix: previously this branch always
    // said "no changes to commit" even when the agent had a real failure.
    // Override the default mocks to simulate "branch has no commits" so
    // the no-commits branch in postIssueComment fires (commitAndPush sets
    // hasCommitsAhead from the mock).
    mocks.hasCommitsAhead.mockReturnValueOnce(false)
    const ctx = makeCtx()
    const agent = makeAgentResult("FAILED: schema mismatch on output field")
    await runPostflights(ctx, agent, "run")
    const lastBody = String(mocks.gh.mock.calls.at(-1)?.[1] ?? "")
    expect(lastBody).toContain("schema mismatch")
    expect(lastBody).not.toContain("no changes to commit")
    expect(ctx.output.exitCode).toBe(3)
  })
})
