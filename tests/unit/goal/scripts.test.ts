/**
 * Script-level tests covering wiring of the new goal-tick chain.
 * Operations are mocked at module boundary; we assert that each script
 * mutates `ctx.data.goal` correctly and dispatches the right gh calls.
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
    fetchOrigin: vi.fn(),
    remoteBranchExists: vi.fn().mockReturnValue(true),
    createBranchFrom: vi.fn(() => ({ ok: true })),
    listGoalIssues: vi.fn(),
    findUmbrellaByTitle: vi.fn(),
    createIssue: vi.fn(),
    listPrsByHead: vi.fn(),
    listPrsByBase: vi.fn(),
    createPr: vi.fn(),
    editPrBody: vi.fn(() => ({ ok: true })),
    markPrReady: vi.fn(() => ({ ok: true })),
    mergePrSquash: vi.fn(() => ({ ok: true })),
    closePr: vi.fn(() => ({ ok: true })),
    closeIssue: vi.fn(() => ({ ok: true })),
    commentOnIssue: vi.fn(() => ({ ok: true })),
    addLabel: vi.fn(() => ({ ok: true })),
    ensureLabel: vi.fn(() => ({ ok: true })),
    getIssueState: vi.fn(),
    inferLinkedIssue: actual.inferLinkedIssue,
  }
})

import * as ops from "../../../src/goal/operations.js"
import { writeGoalState } from "../../../src/goal/state.js"
import { closeMergedTaskIssues } from "../../../src/scripts/closeMergedTaskIssues.js"
import { deriveGoalPhase } from "../../../src/scripts/deriveGoalPhase.js"
import { dispatchNextTask } from "../../../src/scripts/dispatchNextTask.js"
import { ensureGoalPr } from "../../../src/scripts/ensureGoalPr.js"
import { ensureUmbrellaIssue } from "../../../src/scripts/ensureUmbrellaIssue.js"
import { finalizeGoal } from "../../../src/scripts/finalizeGoal.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"
import { handleAbandonedGoal } from "../../../src/scripts/handleAbandonedGoal.js"
import { loadGoalState } from "../../../src/scripts/loadGoalState.js"
import { mergeReadyTaskPRs } from "../../../src/scripts/mergeReadyTaskPRs.js"
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

  it("populates ctx.data.goal from a valid state file", async () => {
    writeGoalState(tmp, "g", { state: "active", goalIssueNumber: 42, extra: { title: "t" } })
    const ctx = fakeCtx({ args: { goal: "g" }, cwd: tmp })
    await loadGoalState(ctx, fakeProfile())
    const goal = ctx.data.goal as GoalCtx
    expect(goal.state).toBe("active")
    expect(goal.goalIssueNumber).toBe(42)
    expect(goal.goalBranch).toBe("goal-g")
    expect(goal.defaultBranch).toBe("main")
  })

  it("exits cleanly when state file missing (no exit code 1)", async () => {
    const ctx = fakeCtx({ args: { goal: "g" }, cwd: tmp })
    await loadGoalState(ctx, fakeProfile())
    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
  })
})

describe("saveGoalState", () => {
  it("writes the mutated goal state back to disk", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "save-goal-"))
    writeGoalState(tmp, "g", { state: "active", extra: {} })
    const ctx = fakeCtx({
      cwd: tmp,
      data: {
        goal: {
          id: "g",
          state: "done",
          goalIssueNumber: 5,
          goalBranch: "goal-g",
          defaultBranch: "main",
          completedAt: "2026-05-10T12:00:00Z",
          raw: { state: "active", extra: { title: "t" } },
        } satisfies GoalCtx,
      },
    })
    await saveGoalState(ctx, fakeProfile())
    expect(ctx.skipAgent).toBe(true)
    const round = JSON.parse(fs.readFileSync(path.join(tmp, ".kody", "goals", "g", "state.json"), "utf-8"))
    expect(round.state).toBe("done")
    expect(round.goalIssueNumber).toBe(5)
    expect(round.completedAt).toBe("2026-05-10T12:00:00Z")
    expect(round.title).toBe("t") // round-tripped from extra
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe("ensureUmbrellaIssue", () => {
  beforeEach(() => {
    vi.mocked(ops.findUmbrellaByTitle).mockReset()
    vi.mocked(ops.createIssue).mockReset()
  })

  it("no-ops when goalIssueNumber already set", async () => {
    const ctx = fakeCtx({
      data: { goal: baseGoal({ goalIssueNumber: 7 }) },
    })
    await ensureUmbrellaIssue(ctx, fakeProfile())
    expect(ops.findUmbrellaByTitle).not.toHaveBeenCalled()
    expect(ops.createIssue).not.toHaveBeenCalled()
  })

  it("adopts existing issue found by title", async () => {
    vi.mocked(ops.findUmbrellaByTitle).mockReturnValue({ ok: true, value: 42 })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await ensureUmbrellaIssue(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).goalIssueNumber).toBe(42)
    expect(ops.createIssue).not.toHaveBeenCalled()
  })

  it("creates a new umbrella when none found", async () => {
    vi.mocked(ops.findUmbrellaByTitle).mockReturnValue({ ok: true, value: null })
    vi.mocked(ops.createIssue).mockReturnValue({ ok: true, value: 99 })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await ensureUmbrellaIssue(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).goalIssueNumber).toBe(99)
  })

  it("logs but doesn't throw when create fails", async () => {
    vi.mocked(ops.findUmbrellaByTitle).mockReturnValue({ ok: true, value: null })
    vi.mocked(ops.createIssue).mockReturnValue({ ok: false, error: "rate limit" })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await ensureUmbrellaIssue(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).goalIssueNumber).toBeUndefined()
  })
})

describe("ensureGoalPr", () => {
  beforeEach(() => {
    vi.mocked(ops.remoteBranchExists).mockReset().mockReturnValue(true)
    vi.mocked(ops.listPrsByHead).mockReset()
    vi.mocked(ops.createPr).mockReset()
  })

  it("no-ops when goalPrUrl already set", async () => {
    const ctx = fakeCtx({ data: { goal: baseGoal({ goalPrUrl: "u" }) } })
    await ensureGoalPr(ctx, fakeProfile())
    expect(ops.listPrsByHead).not.toHaveBeenCalled()
  })

  it("recovers existing draft PR by head ref", async () => {
    vi.mocked(ops.listPrsByHead).mockReturnValue({
      ok: true,
      value: [
        {
          number: 1,
          isDraft: true,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          url: "u",
        },
      ],
    })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await ensureGoalPr(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).goalPrUrl).toBe("u")
    expect(ops.createPr).not.toHaveBeenCalled()
  })

  it("creates a draft PR when branch exists but no PR", async () => {
    vi.mocked(ops.listPrsByHead).mockReturnValue({ ok: true, value: [] })
    vi.mocked(ops.createPr).mockReturnValue({ ok: true, value: "https://github.com/o/r/pull/9" })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await ensureGoalPr(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).goalPrUrl).toBe("https://github.com/o/r/pull/9")
    expect(ops.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true, head: "goal-g", base: "main" }),
      expect.anything(),
    )
  })

  it("skips when remote branch missing", async () => {
    vi.mocked(ops.remoteBranchExists).mockReturnValue(false)
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await ensureGoalPr(ctx, fakeProfile())
    expect(ops.listPrsByHead).not.toHaveBeenCalled()
  })

  it("logs but doesn't bail when create fails (eg 0 commits ahead)", async () => {
    vi.mocked(ops.listPrsByHead).mockReturnValue({ ok: true, value: [] })
    vi.mocked(ops.createPr).mockReturnValue({ ok: false, error: "no commits between main and goal-g" })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await ensureGoalPr(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).goalPrUrl).toBeUndefined()
  })
})

describe("mergeReadyTaskPRs", () => {
  beforeEach(() => {
    vi.mocked(ops.listPrsByBase).mockReset()
    vi.mocked(ops.mergePrSquash).mockReset().mockReturnValue({ ok: true })
  })

  it("merges only MERGEABLE+CLEAN non-draft PRs", async () => {
    vi.mocked(ops.listPrsByBase).mockReturnValue({
      ok: true,
      value: [
        { number: 1, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", url: "" },
        { number: 2, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", url: "" },
        { number: 3, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", url: "" },
        { number: 4, isDraft: false, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", url: "" },
      ],
    })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await mergeReadyTaskPRs(ctx, fakeProfile())
    expect(ops.mergePrSquash).toHaveBeenCalledTimes(1)
    expect(ops.mergePrSquash).toHaveBeenCalledWith(1, expect.anything())
  })
})

describe("closeMergedTaskIssues", () => {
  beforeEach(() => {
    vi.mocked(ops.listPrsByBase).mockReset()
    vi.mocked(ops.getIssueState).mockReset()
    vi.mocked(ops.closeIssue).mockReset().mockReturnValue({ ok: true })
  })

  it("closes only OPEN linked issues, dedupes by issue number", async () => {
    vi.mocked(ops.listPrsByBase).mockReturnValue({
      ok: true,
      value: [
        { number: 100, isDraft: false, mergeable: "", mergeStateStatus: "", url: "", body: "Closes #42" },
        { number: 101, isDraft: false, mergeable: "", mergeStateStatus: "", url: "", body: "fixes #42" },
        {
          number: 102,
          isDraft: false,
          mergeable: "",
          mergeStateStatus: "",
          url: "",
          headRefName: "7-x",
        },
      ],
    })
    vi.mocked(ops.getIssueState).mockImplementation((n) => ({
      ok: true,
      value: n === 42 ? "OPEN" : "CLOSED",
    }))
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await closeMergedTaskIssues(ctx, fakeProfile())
    expect(ops.closeIssue).toHaveBeenCalledTimes(1)
    expect(ops.closeIssue).toHaveBeenCalledWith(42, expect.anything(), expect.anything())
  })
})

describe("deriveGoalPhase", () => {
  beforeEach(() => {
    vi.mocked(ops.listGoalIssues).mockReset()
  })

  it("classifies ready-to-dispatch", async () => {
    vi.mocked(ops.listGoalIssues).mockReturnValue({
      ok: true,
      value: [{ number: 5, state: "OPEN", labels: [] }],
    })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await deriveGoalPhase(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).phase).toBe("ready-to-dispatch")
    expect((ctx.data.goal as GoalCtx).childTasks).toHaveLength(1)
  })

  it("falls back to idle on list failure", async () => {
    vi.mocked(ops.listGoalIssues).mockReturnValue({ ok: false, error: "boom" })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await deriveGoalPhase(ctx, fakeProfile())
    expect((ctx.data.goal as GoalCtx).phase).toBe("idle")
  })
})

describe("dispatchNextTask", () => {
  beforeEach(() => {
    vi.mocked(ops.commentOnIssue).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.addLabel).mockReset().mockReturnValue({ ok: true })
  })

  it("posts @kody comment + adds label + records lastDispatchedIssue", async () => {
    const ctx = fakeCtx({
      data: {
        goal: baseGoal({
          childTasks: [
            { number: 7, state: "OPEN", labels: [] },
            { number: 5, state: "OPEN", labels: [] },
          ],
        }),
      },
    })
    await dispatchNextTask(ctx, fakeProfile())
    // pickNextDispatchable picks lowest-numbered → 5
    expect(ops.commentOnIssue).toHaveBeenCalledWith(5, "@kody --base goal-g", expect.anything())
    expect(ops.addLabel).toHaveBeenCalledWith(5, "goal-runner:dispatched", expect.anything())
    expect((ctx.data.goal as GoalCtx).lastDispatchedIssue).toBe(5)
  })

  it("does nothing when no task is dispatchable", async () => {
    const ctx = fakeCtx({
      data: {
        goal: baseGoal({
          childTasks: [{ number: 7, state: "OPEN", labels: ["goal-runner:dispatched"] }],
        }),
      },
    })
    await dispatchNextTask(ctx, fakeProfile())
    expect(ops.commentOnIssue).not.toHaveBeenCalled()
  })
})

describe("finalizeGoal", () => {
  beforeEach(() => {
    vi.mocked(ops.remoteBranchExists).mockReset().mockReturnValue(true)
    vi.mocked(ops.listPrsByHead).mockReset()
    vi.mocked(ops.markPrReady).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.editPrBody).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.createPr).mockReset()
  })

  it("promotes existing draft PR to ready-for-review", async () => {
    vi.mocked(ops.listPrsByHead).mockReturnValue({
      ok: true,
      value: [
        {
          number: 5,
          isDraft: true,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          url: "u",
        },
      ],
    })
    const ctx = fakeCtx({ data: { goal: baseGoal({ goalIssueNumber: 1 }) } })
    await finalizeGoal(ctx, fakeProfile())
    expect(ops.markPrReady).toHaveBeenCalledWith(5, expect.anything())
    expect(ops.editPrBody).toHaveBeenCalled()
    const goal = ctx.data.goal as GoalCtx
    expect(goal.state).toBe("done")
    expect(goal.completedAt).toBeDefined()
    expect(goal.goalPrUrl).toBe("u")
  })

  it("creates a non-draft PR if none exists yet (legacy fallback)", async () => {
    vi.mocked(ops.listPrsByHead).mockReturnValue({ ok: true, value: [] })
    vi.mocked(ops.createPr).mockReturnValue({ ok: true, value: "https://github.com/o/r/pull/9" })
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await finalizeGoal(ctx, fakeProfile())
    expect(ops.createPr).toHaveBeenCalledWith(expect.objectContaining({ draft: false }), expect.anything())
    const goal = ctx.data.goal as GoalCtx
    expect(goal.state).toBe("done")
  })

  it("still transitions state when goal branch missing", async () => {
    vi.mocked(ops.remoteBranchExists).mockReturnValue(false)
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await finalizeGoal(ctx, fakeProfile())
    expect(ops.listPrsByHead).not.toHaveBeenCalled()
    const goal = ctx.data.goal as GoalCtx
    expect(goal.state).toBe("done")
  })
})

describe("handleAbandonedGoal", () => {
  beforeEach(() => {
    vi.mocked(ops.listGoalIssues).mockReset()
    vi.mocked(ops.listPrsByHead).mockReset()
    vi.mocked(ops.closeIssue).mockReset().mockReturnValue({ ok: true })
    vi.mocked(ops.closePr).mockReset().mockReturnValue({ ok: true })
  })

  it("closes open task issues + open goal PR + transitions state", async () => {
    vi.mocked(ops.listGoalIssues).mockReturnValue({
      ok: true,
      value: [
        { number: 11, state: "OPEN", labels: [] },
        { number: 12, state: "CLOSED", labels: [] },
      ],
    })
    vi.mocked(ops.listPrsByHead).mockReturnValue({
      ok: true,
      value: [{ number: 99, isDraft: false, mergeable: "", mergeStateStatus: "", url: "u" }],
    })
    const ctx = fakeCtx({
      data: { goal: baseGoal({ state: "abandoned" }) },
    })
    await handleAbandonedGoal(ctx, fakeProfile())
    expect(ops.closeIssue).toHaveBeenCalledTimes(1)
    expect(ops.closeIssue).toHaveBeenCalledWith(11, expect.anything(), expect.anything())
    expect(ops.closePr).toHaveBeenCalledWith(99, expect.anything(), expect.anything())
    expect((ctx.data.goal as GoalCtx).state).toBe("closed")
  })

  it("no-ops when state is not abandoned", async () => {
    const ctx = fakeCtx({ data: { goal: baseGoal() } })
    await handleAbandonedGoal(ctx, fakeProfile())
    expect(ops.listGoalIssues).not.toHaveBeenCalled()
  })
})

function baseGoal(overrides: Partial<GoalCtx> = {}): GoalCtx {
  return {
    id: "g",
    state: "active",
    goalBranch: "goal-g",
    defaultBranch: "main",
    ...overrides,
  }
}
