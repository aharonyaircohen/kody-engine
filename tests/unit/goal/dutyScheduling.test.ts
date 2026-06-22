import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { advanceManagedGoal } from "../../../src/scripts/advanceManagedGoal.js"
import type { GoalDutyScheduleState } from "../../../src/scripts/goalDutyScheduling.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"
import type { GoalState } from "../../../src/goal/state.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-duty-schedule-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeDuty(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(tmp, ".kody", "duties", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "duty.md"), `# ${slug}\n\nKeep ${slug} healthy.\n`)
}

function writeExecutable(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(tmp, ".kody", "executables", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
}

function writeDutyState(slug: string, lastFiredAt: string): void {
  const file = path.join(tmp, ".kody", "duties", slug, "state.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, rev: 1, cursor: "seed", done: false, data: { lastFiredAt } }, null, 2),
  )
}

function goalState(duties: string[] = ["ci-health"]): GoalState {
  return {
    state: "active",
    extra: {
      type: "standing",
      scheduleMode: "duty-cadence",
      destination: {
        outcome: "PRs stay mergeable",
        evidence: [],
      },
      duties,
      route: [],
      stage: "watching",
      facts: {},
      blockers: [],
    },
  }
}

function fakeCtx(raw: GoalState) {
  return {
    args: { goal: "prs-stay-mergeable" },
    cwd: tmp,
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "anthropic/claude-haiku-4-5-20251001" },
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
  } as any
}

describe("standing goal duty scheduling", () => {
  it("dispatches a due duty and records the goal scheduling decision", async () => {
    writeDuty("ci-health", { every: "15m", staff: "kody" })
    const raw = goalState()
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as any, {})

    expect(ctx.output.nextDispatch).toEqual({
      duty: "ci-health",
      executable: "duty-tick",
      cliArgs: { duty: "ci-health" },
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw).toBeDefined()
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "duty-cadence",
      lastDecision: { kind: "dispatch", duty: "ci-health", executable: "duty-tick" },
      duties: { "ci-health": { state: "due" } },
    })
    const scheduleState = updatedGoal.raw!.extra.scheduleState as GoalDutyScheduleState
    const status = scheduleState.duties["ci-health"]!
    expect(typeof status.lastFiredAt).toBe("string")
    expect(typeof status.nextEligibleAt).toBe("string")
  })

  it("keeps route-free routines on the duty-cadence loop", async () => {
    writeDuty("ci-health", { every: "15m", staff: "kody" })
    const raw = goalState(["ci-health"])
    raw.extra.type = "routine"
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as any, {})

    expect(ctx.output.reason).toBe("dispatch ci-health: first check for 15m")
    expect(ctx.output.nextDispatch).toEqual({
      duty: "ci-health",
      executable: "duty-tick",
      cliArgs: { duty: "ci-health" },
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.state).toBe("active")
    expect(updatedGoal.raw!.extra.stage).toBe("watching")
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "duty-cadence",
      lastDecision: { kind: "dispatch", duty: "ci-health" },
    })
  })

  it("passes duty slug to due executable duties that declare a duty input", async () => {
    writeDuty("auto-fix-ci", { every: "15m", staff: "kody", executable: "auto-fix-ci" })
    writeExecutable("auto-fix-ci", {
      inputs: [{ name: "duty", flag: "--duty", type: "string", required: true }],
    })
    const raw = goalState(["auto-fix-ci"])
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as any, {})

    expect(ctx.output.nextDispatch).toEqual({
      duty: "auto-fix-ci",
      executable: "auto-fix-ci",
      cliArgs: { duty: "auto-fix-ci" },
    })
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      lastDecision: { kind: "dispatch", duty: "auto-fix-ci", executable: "auto-fix-ci" },
    })
  })

  it("waits when no duty is due", async () => {
    writeDuty("ci-health", { every: "15m", staff: "kody" })
    writeDutyState("ci-health", new Date().toISOString())
    const raw = goalState()
    const ctx = fakeCtx(raw)

    await advanceManagedGoal(ctx, {} as any, {})

    expect(ctx.output.nextDispatch).toBeUndefined()
    expect(ctx.output.reason).toBe("no duty due now")
    const updatedGoal = ctx.data.goal as GoalCtx
    expect(updatedGoal.raw).toBeDefined()
    expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
      mode: "duty-cadence",
      lastDecision: { kind: "idle" },
      duties: { "ci-health": { state: "waiting" } },
    })
  })
})
