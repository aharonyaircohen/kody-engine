/**
 * Script-level tests covering wiring of the stacked-PR goal-tick chain.
 * Operations are mocked at module boundary; we assert that each script
 * mutates `ctx.data.goal` correctly and dispatches the right gh ops.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))
vi.mock("../../../src/goal/operations.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/goal/operations.js")>(
    "../../../src/goal/operations.js",
  )
  return {
    ...actual,
    listGoalIssues: vi.fn(),
    listOpenPrs: vi.fn(),
    commentOnIssue: vi.fn(() => ({ ok: true })),
    dispatchTaskRun: vi.fn(() => ({ ok: true })),
    closeIssue: vi.fn(() => ({ ok: true })),
    closePr: vi.fn(() => ({ ok: true })),
    branchContains: vi.fn(() => ({ ok: true, value: true })),
    mergePrSquash: vi.fn(() => ({ ok: true })),
    markPrReady: vi.fn(() => ({ ok: true })),
    editPrBase: vi.fn(() => ({ ok: true })),
  }
})

import { gh } from "../../../src/issue.js"
import * as ops from "../../../src/goal/operations.js"
import { type GoalState, serializeGoalState } from "../../../src/goal/state.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

/** Encode a GoalState as a GitHub Contents-API GET response (what fetchGoalState parses). */
function contentsResponse(state: GoalState): string {
  return JSON.stringify({ content: Buffer.from(serializeGoalState(state), "utf-8").toString("base64") })
}
import { deriveGoalPhase } from "../../../src/scripts/deriveGoalPhase.js"
import { dispatchNextTask } from "../../../src/scripts/dispatchNextTask.js"
import { finalizeGoal } from "../../../src/scripts/finalizeGoal.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"
import { handleAbandonedGoal } from "../../../src/scripts/handleAbandonedGoal.js"
import { loadGoalState } from "../../../src/scripts/loadGoalState.js"
import { saveGoalState } from "../../../src/scripts/saveGoalState.js"

function fakeProfile() {
  return {} as unknown as Parameters<typeof loadGoalState>[1]
}

function fakeCtx(
  overrides: Partial<{ args: Record<string, unknown>; cwd: string; data: Record<string, unknown> }> = {},
) {
  return {
    args: overrides.args ?? {},
    cwd: overrides.cwd ?? "/tmp",
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "anthropic/claude-haiku-4-5-20251001" },
    },
    data: overrides.data ?? {},
    output: { exitCode: 0 },
  } as unknown as Parameters<typeof loadGoalState>[0]
}

describe("loadGoalState", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "load-goal-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("rejects missing goal arg", async () => {
    const ctx = fakeCtx()
    await loadGoalState(ctx, fakeProfile())
    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/missing --goal/)
  })

  it("rejects path traversal", async () => {
    const ctx = fakeCtx({ args: { goal: "../etc/passwd" } })
    await loadGoalState(ctx, fakeProfile())
    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.reason).toMatch(/invalid goal id/)
  })

  it("populates ctx.data.goal from kody-state (extras round-trip)", async () => {
    // Goal state now lives on the kody-state branch; loadGoalState reads it via
    // the Contents API (gh), not the working tree.
    ghMock.mockReturnValueOnce(
      contentsResponse({ state: "active", lastDispatchedIssue: 41, extra: { title: "t" } }),
    )
    const ctx = fakeCtx({ args: { goal: "g" }, cwd: tmp })
    await loadGoalState(ctx, fakeProfile())
    const goal = ctx.data.goal as GoalCtx
    expect(goal.state).toBe("active")
    expect(goal.lastDispatchedIssue).toBe(41)
    expect(goal.defaultBranch).toBe("main")
    expect(goal.raw?.extra).toEqual({ title: "t" })
  })

  it("exits cleanly when state file missing (no exit code 1)", async () => {
    const ctx = fakeCtx({ args: { goal: "g" }, cwd: tmp })
    await loadGoalState(ctx, fakeProfile())
    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
  })
})

describe("saveGoalState", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "save-goal-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("persists only stacked-PR fields; legacy umbrella fields stay in extra", async () => {
    const ctx = fakeCtx({
      args: { goal: "g" },
      cwd: tmp,
      data: {
        goal: {
          id: "g",
          state: "active",
          lastDispatchedIssue: 17,
          defaultBranch: "main",
          raw: { state: "active", extra: { goalIssueNumber: 99 /* legacy */ } },
        } satisfies Partial<GoalCtx>,
      },
    })
    await saveGoalState(ctx, fakeProfile())
    // saveGoalState no longer writes a file — it stashes the persisted form for
    // commitGoalState (postflight) to push to kody-state.
    const written = ctx.data.goalPersistState as GoalState
    expect(written.state).toBe("active")
    expect(written.lastDispatchedIssue).toBe(17)
    expect(written.extra.goalIssueNumber).toBe(99) // legacy field preserved via extra
    expect(ctx.data.goalPersistChanged).toBe(true)
  })
})

describe("handleAbandonedGoal", () => {
  beforeEach(() => {
    vi.mocked(ops.listGoalIssues).mockReset()
    vi.mocked(ops.listOpenPrs).mockReset()
    vi.mocked(ops.closeIssue).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.closePr).mockReset().mockReturnValue({ ok: true })
  })

  it("closes every open child task issue + open stacked PR, then transitions state", async () => {
    vi.mocked(ops.listGoalIssues).mockReturnValue({
      ok: true,
      value: [
        { number: 11, state: "OPEN" },
        { number: 12, state: "CLOSED" },
      ],
    })
    vi.mocked(ops.listOpenPrs).mockReturnValue({
      ok: true,
      value: [
        {
          number: 101,
          url: "u",
          isDraft: true,
          headRefName: "11-task",
          baseRefName: "main",
          body: "",
        },
      ],
    })
    const ctx = fakeCtx({
      data: {
        goal: { id: "g", state: "abandoned", defaultBranch: "main" } satisfies Partial<GoalCtx>,
      },
    })
    await handleAbandonedGoal(ctx, fakeProfile())
    expect(ops.closeIssue).toHaveBeenCalledTimes(1)
    expect(ops.closeIssue).toHaveBeenCalledWith(11, expect.any(Object), "/tmp")
    expect(ops.closePr).toHaveBeenCalledTimes(1)
    expect(ops.closePr).toHaveBeenCalledWith(101, expect.any(String), "/tmp")
    const goal = ctx.data.goal as GoalCtx
    expect(goal.state).toBe("closed")
  })

  it("no-op when state is not abandoned", async () => {
    const ctx = fakeCtx({
      data: {
        goal: { id: "g", state: "active", defaultBranch: "main" } satisfies Partial<GoalCtx>,
      },
    })
    await handleAbandonedGoal(ctx, fakeProfile())
    expect(ops.listGoalIssues).not.toHaveBeenCalled()
    expect(ops.listOpenPrs).not.toHaveBeenCalled()
  })
})

describe("deriveGoalPhase", () => {
  beforeEach(() => {
    vi.mocked(ops.listGoalIssues).mockReset()
    vi.mocked(ops.listOpenPrs).mockReset()
  })

  it("populates childTasks, openTaskPrs, leafPr, and phase for an in-flight stack", async () => {
    vi.mocked(ops.listGoalIssues).mockReturnValue({
      ok: true,
      value: [
        { number: 11, state: "OPEN" },
        { number: 12, state: "OPEN" },
      ],
    })
    vi.mocked(ops.listOpenPrs).mockReturnValue({
      ok: true,
      value: [
        {
          number: 101,
          url: "u1",
          isDraft: false,
          headRefName: "11-x",
          baseRefName: "main",
          body: "Closes #11",
        },
        {
          number: 102,
          url: "u2",
          isDraft: true,
          headRefName: "12-x",
          baseRefName: "11-x",
          body: "Closes #12",
        },
      ],
    })
    const ctx = fakeCtx({
      data: { goal: { id: "g", state: "active", defaultBranch: "main" } satisfies Partial<GoalCtx> },
    })
    await deriveGoalPhase(ctx, fakeProfile())
    const goal = ctx.data.goal as GoalCtx
    expect(goal.phase).toBe("in-flight")
    expect(goal.openTaskPrs?.map((p) => p.number)).toEqual([101, 102])
    expect(goal.leafPr?.number).toBe(102)
  })

  it("filters out unrelated PRs not linked to child tasks", async () => {
    vi.mocked(ops.listGoalIssues).mockReturnValue({
      ok: true,
      value: [{ number: 50, state: "OPEN" }],
    })
    vi.mocked(ops.listOpenPrs).mockReturnValue({
      ok: true,
      value: [
        {
          number: 999,
          url: "u",
          isDraft: false,
          headRefName: "some-other-branch",
          baseRefName: "main",
          body: "unrelated",
        },
      ],
    })
    const ctx = fakeCtx({
      data: { goal: { id: "g", state: "active", defaultBranch: "main" } satisfies Partial<GoalCtx> },
    })
    await deriveGoalPhase(ctx, fakeProfile())
    const goal = ctx.data.goal as GoalCtx
    expect(goal.openTaskPrs).toEqual([])
    expect(goal.phase).toBe("ready-to-dispatch")
  })

  it("falls back to idle when listGoalIssues fails", async () => {
    vi.mocked(ops.listGoalIssues).mockReturnValue({ ok: false, error: "boom" })
    const ctx = fakeCtx({
      data: { goal: { id: "g", state: "active", defaultBranch: "main" } satisfies Partial<GoalCtx> },
    })
    await deriveGoalPhase(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).phase).toBe("idle")
  })
})

describe("dispatchNextTask", () => {
  beforeEach(() => {
    vi.mocked(ops.dispatchTaskRun).mockReset().mockReturnValue({ ok: true })
  })

  it("fires a workflow_dispatch run (classify, base=defaultBranch) when no leaf exists (first task)", async () => {
    const ctx = fakeCtx({
      data: {
        goal: {
          id: "g",
          state: "active",
          defaultBranch: "main",
          childTasks: [
            { number: 11, state: "OPEN", prState: "absent" },
            { number: 12, state: "OPEN", prState: "absent" },
          ],
        } satisfies Partial<GoalCtx>,
      },
    })
    await dispatchNextTask(ctx, fakeProfile())
    // Fresh run via workflow_dispatch — NOT an @kody comment (bot can't
    // self-trigger) and NOT inline (would blow the scheduler tick).
    expect(ops.dispatchTaskRun).toHaveBeenCalledWith(11, "main", "/tmp")
    expect((ctx.data.goal as GoalCtx).lastDispatchedIssue).toBe(11)
  })

  it("stacks the dispatched run on the leaf PR's head ref when one exists", async () => {
    const ctx = fakeCtx({
      data: {
        goal: {
          id: "g",
          state: "active",
          defaultBranch: "main",
          childTasks: [
            { number: 11, state: "OPEN", prState: "ready" },
            { number: 12, state: "OPEN", prState: "absent" },
          ],
          leafPr: {
            number: 101,
            url: "u",
            isDraft: false,
            headRefName: "11-x",
            baseRefName: "main",
            body: "",
          },
        } satisfies Partial<GoalCtx>,
      },
    })
    await dispatchNextTask(ctx, fakeProfile())
    expect(ops.dispatchTaskRun).toHaveBeenCalledWith(12, "11-x", "/tmp")
  })

  it("does not record lastDispatchedIssue when the dispatch fails", async () => {
    vi.mocked(ops.dispatchTaskRun).mockReturnValueOnce({ ok: false, error: "boom" })
    const ctx = fakeCtx({
      data: {
        goal: {
          id: "g",
          state: "active",
          defaultBranch: "main",
          childTasks: [{ number: 11, state: "OPEN", prState: "absent" }],
        } satisfies Partial<GoalCtx>,
      },
    })
    await dispatchNextTask(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).lastDispatchedIssue).toBeUndefined()
  })

  it("no-ops when nothing dispatchable", async () => {
    const ctx = fakeCtx({
      data: {
        goal: {
          id: "g",
          state: "active",
          defaultBranch: "main",
          childTasks: [{ number: 11, state: "OPEN", prState: "ready" }],
        } satisfies Partial<GoalCtx>,
      },
    })
    await dispatchNextTask(ctx, fakeProfile())
    expect(ops.dispatchTaskRun).not.toHaveBeenCalled()
  })
})

describe("finalizeGoal", () => {
  beforeEach(() => {
    vi.mocked(ops.mergePrSquash).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.markPrReady).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.editPrBase).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.closePr).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.closeIssue).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.commentOnIssue).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.branchContains).mockReset().mockReturnValue({ ok: true, value: true })
  })

  it("leaf-only deliverable: retargets leaf, never merges, closes intermediates + task issues", async () => {
    // Stack: PR #888 (root, base=main, head=11-x) ← PR #999 (leaf, base=11-x, head=12-x).
    // Leaf carries the cumulative diff vs main, so it becomes the single
    // open deliverable PR. The engine never auto-merges to the default branch.
    const root = {
      number: 888,
      url: "u1",
      isDraft: false,
      headRefName: "11-x",
      baseRefName: "main",
      body: "",
    }
    const leaf = {
      number: 999,
      url: "u2",
      isDraft: false,
      headRefName: "12-x",
      baseRefName: "11-x",
      body: "",
    }
    const ctx = fakeCtx({
      data: {
        goal: {
          id: "g",
          state: "active",
          defaultBranch: "main",
          openTaskPrs: [root, leaf],
          leafPr: leaf,
          childTasks: [
            { number: 11, state: "OPEN", prState: "ready" },
            { number: 12, state: "OPEN", prState: "ready" },
          ],
        } satisfies Partial<GoalCtx>,
      },
    })
    await finalizeGoal(ctx, fakeProfile())
    // Leaf retargeted to default so its open diff is the cumulative goal.
    expect(ops.editPrBase).toHaveBeenCalledWith(999, "main", "/tmp")
    // The engine never merges — the leaf stays open for a human.
    expect(ops.mergePrSquash).not.toHaveBeenCalled()
    // Root (intermediate) is closed with a courtesy comment.
    expect(ops.closePr).toHaveBeenCalledTimes(1)
    expect(ops.closePr).toHaveBeenCalledWith(888, expect.any(String), "/tmp")
    // The root task issue (#11) closes; the leaf's own task issue (#12)
    // stays OPEN as the review anchor for the deliverable PR — closing it
    // would drop the open PR off the dashboard review board.
    expect(ops.closeIssue).toHaveBeenCalledTimes(1)
    expect(ops.closeIssue).toHaveBeenCalledWith(11, expect.objectContaining({ reason: "completed" }), "/tmp")
    expect(ops.closeIssue).not.toHaveBeenCalledWith(12, expect.anything(), expect.anything())
    expect(ops.commentOnIssue).toHaveBeenCalledWith(12, expect.stringContaining("review anchor"), "/tmp")
    expect((ctx.data.goal as GoalCtx).state).toBe("done")
  })

  it("broken stack: leaf does NOT carry an intermediate PR → that PR + its issue stay open", async () => {
    // Regression for goal #1644: the leaf branch was cut fresh off the
    // default branch instead of stacked on its predecessor, so its diff
    // does NOT contain the root's commits. Closing the root here would
    // silently drop that task's work — finalize must leave it open.
    const root = {
      number: 888,
      url: "u1",
      isDraft: false,
      headRefName: "11-x",
      baseRefName: "main",
      body: "Closes #11",
    }
    const leaf = {
      number: 999,
      url: "u2",
      isDraft: false,
      headRefName: "12-x",
      baseRefName: "main",
      body: "Closes #12",
    }
    // Leaf carries #12's branch but NOT #11's (broken chain).
    vi.mocked(ops.branchContains).mockImplementation((_leafHead, candidate) =>
      candidate === "11-x" ? { ok: true, value: false } : { ok: true, value: true },
    )
    const ctx = fakeCtx({
      data: {
        goal: {
          id: "g",
          state: "active",
          defaultBranch: "main",
          openTaskPrs: [root, leaf],
          leafPr: leaf,
          childTasks: [
            { number: 11, state: "OPEN", prState: "ready" },
            { number: 12, state: "OPEN", prState: "ready" },
          ],
        } satisfies Partial<GoalCtx>,
      },
    })
    await finalizeGoal(ctx, fakeProfile())
    // Uncarried root PR is NOT closed; it gets a warning comment instead.
    expect(ops.closePr).not.toHaveBeenCalled()
    expect(ops.commentOnIssue).toHaveBeenCalledWith(888, expect.stringContaining("not"), "/tmp")
    // #11 stays open (uncarried); #12 is the leaf's own task issue and
    // stays open as the deliverable review anchor — so nothing is closed.
    expect(ops.closeIssue).not.toHaveBeenCalled()
    expect(ops.commentOnIssue).toHaveBeenCalledWith(12, expect.stringContaining("review anchor"), "/tmp")
    expect((ctx.data.goal as GoalCtx).state).toBe("done")
  })

  it("skips retarget when leaf is already at defaultBranch (single-task goal)", async () => {
    const leaf = {
      number: 200,
      url: "u",
      isDraft: false,
      headRefName: "11-x",
      baseRefName: "main",
      body: "",
    }
    const ctx = fakeCtx({
      data: {
        goal: {
          id: "g",
          state: "active",
          defaultBranch: "main",
          openTaskPrs: [leaf],
          leafPr: leaf,
        } satisfies Partial<GoalCtx>,
      },
    })
    await finalizeGoal(ctx, fakeProfile())
    expect(ops.editPrBase).not.toHaveBeenCalled()
    expect(ops.mergePrSquash).not.toHaveBeenCalled()
    expect(ops.closePr).not.toHaveBeenCalled()
  })

  it("promotes draft leaf to ready (deliverable PR must be reviewable)", async () => {
    const draftLeaf = {
      number: 200,
      url: "u",
      isDraft: true,
      headRefName: "12-x",
      baseRefName: "11-x",
      body: "",
    }
    const ctx = fakeCtx({
      data: {
        goal: {
          id: "g",
          state: "active",
          defaultBranch: "main",
          openTaskPrs: [draftLeaf],
          leafPr: draftLeaf,
        } satisfies Partial<GoalCtx>,
      },
    })
    await finalizeGoal(ctx, fakeProfile())
    expect(ops.markPrReady).toHaveBeenCalledWith(200, "/tmp")
    expect(ops.mergePrSquash).not.toHaveBeenCalled()
  })

  it("sets state=done even when there is no leaf PR (issues closed manually)", async () => {
    const ctx = fakeCtx({
      data: {
        goal: { id: "g", state: "active", defaultBranch: "main", openTaskPrs: [] } satisfies Partial<GoalCtx>,
      },
    })
    await finalizeGoal(ctx, fakeProfile())
    expect(ops.mergePrSquash).not.toHaveBeenCalled()
    expect((ctx.data.goal as GoalCtx).state).toBe("done")
  })
})
