import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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

function writeRepoGoal(stateRoot: string, goalId: string, state: Record<string, unknown>): void {
  const file = path.join(stateRoot, "state", "goals", "instances", goalId, "state.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
}

function readRepoGoal(stateRoot: string, goalId: string): Record<string, unknown> {
  const todoFile = path.join(stateRoot, "state", "todos", `${goalId}.md`)
  if (fs.existsSync(todoFile)) return readTodoGoal(todoFile)
  return JSON.parse(
    fs.readFileSync(path.join(stateRoot, "state", "goals", "instances", goalId, "state.json"), "utf8"),
  ) as Record<string, unknown>
}

function readTodoGoal(file: string): Record<string, unknown> {
  const raw = fs.readFileSync(file, "utf8")
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  const parsed: Record<string, unknown> = {}
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) continue
    parsed[trimmed.slice(0, colon).trim()] = parseTodoFrontmatterValue(trimmed.slice(colon + 1).trim())
  }
  return parsed
}

function parseTodoFrontmatterValue(raw: string): unknown {
  let value = raw
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  if (value.startsWith("{") || value.startsWith("[") || /^-?\d+(\.\d+)?$/.test(value)) {
    try {
      return JSON.parse(value)
    } catch {}
  }
  return value
}

function writeLocalGoalTemplate(goalId: string, state: Record<string, unknown>): void {
  const file = path.join(tmp, ".kody", "goals", "templates", goalId, "state.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
}

function installStateRepoGhStub(): string {
  const bin = path.join(tmp, "bin")
  fs.mkdirSync(bin, { recursive: true })
  const gh = path.join(bin, "gh")
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")

const root = process.env.KODY_TEST_STATE_ROOT
const args = process.argv.slice(2)

function fail(message) {
  process.stderr.write(message + "\\n")
  process.exit(1)
}

if (!root || args[0] !== "api") {
  fail("unsupported gh stub call")
}

let method = "GET"
let apiPath = ""
for (let i = 1; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === "--method") {
    method = args[i + 1] || "GET"
    i += 1
    continue
  }
  if (arg.startsWith("/repos/")) {
    apiPath = arg
  }
}

if (apiPath.endsWith("/git/ref/heads/kody-state")) {
  process.stdout.write(JSON.stringify({ object: { sha: "state-branch-sha" } }))
  process.exit(0)
}

const marker = "/contents/"
const markerIndex = apiPath.indexOf(marker)
if (markerIndex < 0) {
  fail("unsupported gh api path " + apiPath)
}

const relative = decodeURIComponent(apiPath.slice(markerIndex + marker.length).replace(/\\?.*$/, ""))
const filePath = path.join(root, relative)

if (method === "PUT") {
  let body = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    body += chunk
  })
  process.stdin.on("end", () => {
    const payload = JSON.parse(body || "{}")
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(String(payload.content || ""), "base64"))
    process.stdout.write(JSON.stringify({ content: { path: relative, sha: "stub-sha" } }))
  })
} else if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
  const entries = fs.readdirSync(filePath, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    path: path.posix.join(relative.split(path.sep).join("/"), entry.name),
    type: entry.isDirectory() ? "dir" : "file",
  }))
  process.stdout.write(JSON.stringify(entries))
} else if (fs.existsSync(filePath)) {
  const content = fs.readFileSync(filePath).toString("base64")
  process.stdout.write(JSON.stringify({ type: "file", encoding: "base64", content, sha: "stub-sha", path: relative }))
} else {
  fail("gh: Not Found (HTTP 404)")
}
`,
  )
  fs.chmodSync(gh, 0o755)
  return bin
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

function fakeCtx(raw: GoalState, id = "prs-stay-mergeable"): Context {
  return {
    args: { goal: id },
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
        id,
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
    const raw = goalState([])
    raw.extra.type = "agentLoop"
    raw.extra.loopTarget = { type: "goal", id: "web-release" }
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
  })

  it("resolves goal target loops to an active target instance", async () => {
    const stateRoot = path.join(tmp, "state-repo")
    writeRepoGoal(stateRoot, "web-release", {
      state: "done",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T01:00:00.000Z",
      type: "web-release",
      facts: {},
      blockers: [],
    })
    writeRepoGoal(stateRoot, "web-release-2026-06-26", {
      state: "active",
      createdAt: "2026-06-26T05:00:00.000Z",
      updatedAt: "2026-06-26T05:00:00.000Z",
      kind: "instance",
      template: "web-release",
      sourceTemplate: "web-release",
      templateId: "web-release",
      type: "web-release",
      facts: {},
      blockers: [],
    })
    const oldPath = process.env.PATH
    const oldStateRoot = process.env.KODY_TEST_STATE_ROOT
    process.env.PATH = `${installStateRepoGhStub()}${path.delimiter}${oldPath || ""}`
    process.env.KODY_TEST_STATE_ROOT = stateRoot

    try {
      const raw = goalState([])
      raw.extra.type = "agentLoop"
      raw.extra.loopTarget = { type: "goal", id: "web-release" }
      const ctx = fakeCtx(raw, "daily-web-release-loop")
      ;(ctx.config as unknown as Record<string, unknown>).state = { repo: "o/r", path: "state" }

      await advanceManagedGoal(ctx, {} as unknown as Profile, {})

      expect(ctx.output.nextDispatch).toEqual({
        action: "goal-manager",
        executable: "goal-manager",
        cliArgs: { goal: "web-release-2026-06-26" },
      })
      const updatedGoal = ctx.data.goal as GoalCtx
      expect(updatedGoal.raw!.extra.scheduleState).toMatchObject({
        lastDecision: {
          kind: "dispatch",
          targetType: "goal",
          targetId: "web-release-2026-06-26",
          executable: "goal-manager",
        },
      })
    } finally {
      process.env.PATH = oldPath
      if (oldStateRoot === undefined) {
        delete process.env.KODY_TEST_STATE_ROOT
      } else {
        process.env.KODY_TEST_STATE_ROOT = oldStateRoot
      }
    }
  })

  it("creates a new goal target instance when no active instance exists", async () => {
    const stateRoot = path.join(tmp, "state-repo")
    writeRepoGoal(stateRoot, "web-release", {
      state: "done",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T01:00:00.000Z",
      type: "web-release",
      facts: { version: "v0.1.0" },
      blockers: [],
    })
    writeLocalGoalTemplate("web-release", {
      state: "template",
      kind: "template",
      templateId: "web-release",
      type: "web-release",
      destination: { outcome: "Ship a production release", evidence: [] },
      capabilities: ["release-flow"],
      route: [],
      facts: {},
      blockers: [],
    })
    const oldPath = process.env.PATH
    const oldStateRoot = process.env.KODY_TEST_STATE_ROOT
    const oldNow = process.env.KODY_GOAL_LOOP_NOW
    process.env.PATH = `${installStateRepoGhStub()}${path.delimiter}${oldPath || ""}`
    process.env.KODY_TEST_STATE_ROOT = stateRoot
    process.env.KODY_GOAL_LOOP_NOW = "2026-06-27T09:30:00.000Z"

    try {
      const raw = goalState([])
      raw.extra.type = "agentLoop"
      raw.extra.loopTarget = { type: "goal", id: "web-release" }
      raw.extra.preferredRunTime = { time: "08:30", timezone: "Asia/Jerusalem" }
      const ctx = fakeCtx(raw, "daily-web-release-loop")
      ;(ctx.config as unknown as Record<string, unknown>).state = { repo: "o/r", path: "state" }

      await advanceManagedGoal(ctx, {} as unknown as Profile, {})

      expect(ctx.output.nextDispatch).toEqual({
        action: "goal-manager",
        executable: "goal-manager",
        cliArgs: { goal: "web-release-2026-06-27" },
      })
      expect(readRepoGoal(stateRoot, "web-release-2026-06-27")).toMatchObject({
        state: "active",
        kind: "instance",
        template: "web-release",
        sourceTemplate: "web-release",
        templateId: "web-release",
        type: "web-release",
        facts: {},
        blockers: [],
      })
    } finally {
      process.env.PATH = oldPath
      if (oldStateRoot === undefined) {
        delete process.env.KODY_TEST_STATE_ROOT
      } else {
        process.env.KODY_TEST_STATE_ROOT = oldStateRoot
      }
      if (oldNow === undefined) {
        delete process.env.KODY_GOAL_LOOP_NOW
      } else {
        process.env.KODY_GOAL_LOOP_NOW = oldNow
      }
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
