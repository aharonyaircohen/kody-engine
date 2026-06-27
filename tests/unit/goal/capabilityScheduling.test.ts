import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../../src/executables/types.js"
import type { ManagedGoal } from "../../../src/goal/manager.js"
import type { GoalState } from "../../../src/goal/state.js"
import { advanceManagedGoal } from "../../../src/scripts/advanceManagedGoal.js"
import {
  type GoalCapabilityScheduleState,
  planTargetLoopSchedule,
} from "../../../src/scripts/goalCapabilityScheduling.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-capability-schedule-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeCapability(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(tmp, ".kody", "capabilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "capability.md"), `# ${slug}\n\nKeep ${slug} healthy.\n`)
}

function writeExecutable(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(tmp, ".kody", "executables", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
}

function writeCapabilityState(slug: string, lastFiredAt: string): void {
  const file = path.join(tmp, ".kody", "capabilities", slug, "state.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, rev: 1, cursor: "seed", done: false, data: { lastFiredAt } }, null, 2),
  )
}

function goalState(capabilities: string[] = ["ci-health"]): GoalState {
  return {
    state: "active",
    extra: {
      type: "standing",
      scheduleMode: "agentLoop",
      destination: {
        outcome: "PRs stay mergeable",
        evidence: [],
      },
      capabilities,
      route: [],
      stage: "watching",
      facts: {},
      blockers: [],
    },
  }
}

function goalTargetLoop(): ManagedGoal {
  return {
    type: "agentLoop",
    destination: { outcome: "daily web release loop", evidence: [] },
    capabilities: [],
    route: [],
    facts: {},
    blockers: [],
    loopTarget: { type: "goal", id: "web-release" },
    preferredRunTime: { time: "10:00", timezone: "Asia/Jerusalem" },
  }
}

function workflowTargetLoop(): ManagedGoal {
  return {
    type: "agentLoop",
    destination: { outcome: "daily release hygiene", evidence: [] },
    capabilities: [],
    route: [],
    facts: {},
    blockers: [],
    loopTarget: { type: "workflow", id: "release-hygiene" },
    preferredRunTime: { time: "10:00", timezone: "Asia/Jerusalem" },
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

describe("standing goal capability scheduling", () => {
  it("waits before a goal target loop preferred time", () => {
    const decision = planTargetLoopSchedule({
      goal: goalTargetLoop(),
      now: new Date("2026-06-24T06:59:00Z"),
    })

    expect(decision.kind).toBe("idle")
    expect(decision.dispatch).toBeUndefined()
    expect(decision.reason).toBe("waiting preferred time 10:00 Asia/Jerusalem")
  })

  it("dispatches a goal target loop after preferred time once per local day", () => {
    const decision = planTargetLoopSchedule({
      goal: goalTargetLoop(),
      now: new Date("2026-06-24T07:01:00Z"),
    })

    expect(decision).toMatchObject({
      kind: "dispatch",
      dispatch: {
        action: "goal-manager",
        executable: "goal-manager",
        cliArgs: { goal: "web-release" },
      },
      scheduleState: {
        lastDecision: {
          kind: "dispatch",
          targetType: "goal",
          targetId: "web-release",
          executable: "goal-manager",
        },
      },
    })

    const secondDecision = planTargetLoopSchedule({
      goal: goalTargetLoop(),
      now: new Date("2026-06-24T07:15:00Z"),
      previousScheduleState: decision.scheduleState,
    })

    expect(secondDecision.kind).toBe("idle")
    expect(secondDecision.reason).toBe("already dispatched today at preferred time 10:00 Asia/Jerusalem")
  })

  it("dispatches a workflow target loop after preferred time", () => {
    const decision = planTargetLoopSchedule({
      goal: workflowTargetLoop(),
      now: new Date("2026-06-24T07:01:00Z"),
    })

    expect(decision).toMatchObject({
      kind: "dispatch",
      dispatch: {
        workflow: "release-hygiene",
        cliArgs: {},
      },
      scheduleState: {
        lastDecision: {
          kind: "dispatch",
          targetType: "workflow",
          targetId: "release-hygiene",
          workflow: "release-hygiene",
        },
      },
    })
  })

  it("hands goal target loops to goal-manager", async () => {
    // Pin the clock past the preferred run time in Asia/Jerusalem so the
    // time-gate inside planGoalTargetLoopSchedule opens deterministically.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-24T07:01:00Z"))
    try {
      const raw = goalState([])
      raw.extra.type = "agentLoop"
      raw.extra.loopTarget = { type: "goal", id: "web-release" }
      raw.extra.preferredRunTime = { time: "10:00", timezone: "Asia/Jerusalem" }
      const ctx = fakeCtx(raw)

      await advanceManagedGoal(ctx, {} as unknown as Profile, {})

      expect(ctx.output.nextDispatch).toEqual({
        action: "goal-manager",
        executable: "goal-manager",
        cliArgs: { goal: "web-release" },
      })
      const updatedGoal = ctx.data.goal as GoalCtx
      expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
        mode: "agentLoop",
        lastDecision: {
          kind: "dispatch",
          targetType: "goal",
          targetId: "web-release",
          executable: "goal-manager",
        },
        capabilities: {},
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("hands workflow target loops to workflow capability chain", async () => {
    const raw = goalState([])
    raw.extra.type = "agentLoop"
    raw.extra.loopTarget = { type: "workflow", id: "release-hygiene" }
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.nextDispatch).toEqual({
      workflow: "release-hygiene",
      cliArgs: {},
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "agentLoop",
      lastDecision: {
        kind: "dispatch",
        targetType: "workflow",
        targetId: "release-hygiene",
        workflow: "release-hygiene",
      },
      capabilities: {},
    })
  })

  it("dispatches runnable capability and records goal scheduling decision", async () => {
    writeCapability("ci-health", { agent: "kody", executable: "ci-check" })
    const raw = goalState()
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.nextDispatch).toEqual({
      capability: "ci-health",
      executable: "ci-check",
      cliArgs: {},
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw).toBeDefined()
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "agentLoop",
      lastDecision: {
        kind: "dispatch",
        capability: "ci-health",
        executable: "ci-check",
        reason: "ready for loop tick",
      },
      capabilities: { "ci-health": { state: "due", reason: "ready for loop tick" } },
    })
    const scheduleState = updatedGoal.raw!.extra.scheduleState as GoalCapabilityScheduleState
    const status = scheduleState.capabilities["ci-health"]!
    expect(typeof status.lastFiredAt).toBe("string")
    expect(status).not.toHaveProperty("nextEligibleAt")
  })

  it("keeps route-free agentLoops on agentLoop loop", async () => {
    writeCapability("ci-health", { agent: "kody", executable: "ci-check" })
    const raw = goalState(["ci-health"])
    raw.extra.type = "agentLoop"
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.reason).toBe("dispatch ci-health: ready for loop tick")
    expect(ctx.output.nextDispatch).toEqual({
      capability: "ci-health",
      executable: "ci-check",
      cliArgs: {},
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.state).toBe("active")
    expect(updatedGoal.raw!.extra.stage).toBe("watching")
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "agentLoop",
      lastDecision: { kind: "dispatch", capability: "ci-health" },
    })
  })

  it("passes capability slug when executable inputs declare capability", async () => {
    writeCapability("auto-fix-ci", { agent: "kody", executable: "auto-fix-ci" })
    writeExecutable("auto-fix-ci", {
      inputs: [{ name: "capability", flag: "--capability", type: "string", required: true }],
    })
    const raw = goalState(["auto-fix-ci"])
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.nextDispatch).toEqual({
      capability: "auto-fix-ci",
      executable: "auto-fix-ci",
      cliArgs: { capability: "auto-fix-ci" },
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      lastDecision: { kind: "dispatch", capability: "auto-fix-ci", executable: "auto-fix-ci" },
    })
  })

  it("selects the oldest runnable capability on each loop tick", async () => {
    writeCapability("ci-health", { agent: "kody", executable: "ci-check" })
    writeCapability("stale-prs", { agent: "kody", executable: "pr-check" })
    writeCapabilityState("ci-health", "2026-01-02T00:00:00.000Z")
    writeCapabilityState("stale-prs", "2026-01-01T00:00:00.000Z")
    const raw = goalState(["ci-health", "stale-prs"])
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as unknown as Profile, {})

    expect(ctx.output.nextDispatch).toEqual({
      capability: "stale-prs",
      executable: "pr-check",
      cliArgs: {},
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "agentLoop",
      lastDecision: { kind: "dispatch", capability: "stale-prs" },
      capabilities: {
        "ci-health": { state: "due", lastFiredAt: "2026-01-02T00:00:00.000Z" },
        "stale-prs": { state: "due" },
      },
    })
  })
})
