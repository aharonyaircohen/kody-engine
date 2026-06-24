import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../../src/agent-actions/types.js"
import type { GoalState } from "../../../src/goal/state.js"
import { advanceManagedGoal } from "../../../src/scripts/advanceManagedGoal.js"
import {
  planGoalAgentResponsibilitySchedule,
  type GoalAgentResponsibilityScheduleState,
} from "../../../src/scripts/goalAgentResponsibilityScheduling.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-agentResponsibility-schedule-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeAgentResponsibility(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(tmp, ".kody", "agent-responsibilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "agent-responsibility.md"), `# ${slug}\n\nKeep ${slug} healthy.\n`)
}

function writeAgentAction(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(tmp, ".kody", "agent-actions", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
}

function writeAgentResponsibilityState(slug: string, lastFiredAt: string): void {
  const file = path.join(tmp, ".kody", "agent-responsibilities", slug, "state.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, rev: 1, cursor: "seed", done: false, data: { lastFiredAt } }, null, 2),
  )
}

function goalState(agentResponsibilities: string[] = ["ci-health"]): GoalState {
  return {
    state: "active",
    extra: {
      type: "standing",
      scheduleMode: "agentLoop",
      destination: {
        outcome: "PRs stay mergeable",
        evidence: [],
      },
      agentResponsibilities,
      route: [],
      stage: "watching",
      facts: {},
      blockers: [],
    },
  }
}

function fakeCtx(raw: GoalState): Context {
  return {
    args: { goal: "prs-stay-mergeable" },
    cwd: tmp,
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "anthropic/claude-haiku-4-5-20251001", cliArgs: {} },
      jobs: { stateBackend: "local-file" },
    },
    data: {
      goal: {
        id: "prs-stay-mergeable",
        state: raw.state,
        defaultBranch: "main",
        raw,
      } satisfies GoalCtx,
    },
    output: { exitCode: 0 },
  } as unknown as Context
}

describe("standing goal agentResponsibility scheduling", () => {
  it("dispatches runnable agentResponsibility and records goal scheduling decision", async () => {
    writeAgentResponsibility("ci-health", { agent: "kody", agentAction: "ci-check" })
    const raw = goalState()
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.nextDispatch).toEqual({
      agentResponsibility: "ci-health",
      agentAction: "ci-check",
      cliArgs: {},
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw).toBeDefined()
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "agentLoop",
      lastDecision: {
        kind: "dispatch",
        agentResponsibility: "ci-health",
        agentAction: "ci-check",
        reason: "ready for loop tick",
      },
      agentResponsibilities: { "ci-health": { state: "due", reason: "ready for loop tick" } },
    })
    const scheduleState = updatedGoal.raw!.extra.scheduleState as GoalAgentResponsibilityScheduleState
    const status = scheduleState.agentResponsibilities["ci-health"]!
    expect(typeof status.lastFiredAt).toBe("string")
    expect(status).not.toHaveProperty("nextEligibleAt")
  })

  it("keeps route-free agentLoops on agentLoop loop", async () => {
    writeAgentResponsibility("ci-health", { agent: "kody", agentAction: "ci-check" })
    const raw = goalState(["ci-health"])
    raw.extra.type = "agentLoop"
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.reason).toBe("dispatch ci-health: ready for loop tick")
    expect(ctx.output.nextDispatch).toEqual({
      agentResponsibility: "ci-health",
      agentAction: "ci-check",
      cliArgs: {},
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.state).toBe("active")
    expect(updatedGoal.raw!.extra.stage).toBe("watching")
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "agentLoop",
      lastDecision: { kind: "dispatch", agentResponsibility: "ci-health" },
    })
  })

  it("passes agentResponsibility slug when agentAction inputs declare agentResponsibility", async () => {
    writeAgentResponsibility("auto-fix-ci", { agent: "kody", agentAction: "auto-fix-ci" })
    writeAgentAction("auto-fix-ci", {
      inputs: [{ name: "agentResponsibility", flag: "--agentResponsibility", type: "string", required: true }],
    })
    const raw = goalState(["auto-fix-ci"])
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.nextDispatch).toEqual({
      agentResponsibility: "auto-fix-ci",
      agentAction: "auto-fix-ci",
      cliArgs: { agentResponsibility: "auto-fix-ci" },
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      lastDecision: { kind: "dispatch", agentResponsibility: "auto-fix-ci", agentAction: "auto-fix-ci" },
    })
  })

  it("selects the oldest runnable agentResponsibility on each loop tick", async () => {
    writeAgentResponsibility("ci-health", { agent: "kody", agentAction: "ci-check" })
    writeAgentResponsibility("stale-prs", { agent: "kody", agentAction: "pr-check" })
    writeAgentResponsibilityState("ci-health", "2026-01-02T00:00:00.000Z")
    writeAgentResponsibilityState("stale-prs", "2026-01-01T00:00:00.000Z")
    const raw = goalState(["ci-health", "stale-prs"])
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.nextDispatch).toEqual({
      agentResponsibility: "stale-prs",
      agentAction: "pr-check",
      cliArgs: {},
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "agentLoop",
      lastDecision: { kind: "dispatch", agentResponsibility: "stale-prs" },
      agentResponsibilities: {
        "ci-health": { state: "due", lastFiredAt: "2026-01-02T00:00:00.000Z" },
        "stale-prs": { state: "due" },
      },
    })
  })
})
