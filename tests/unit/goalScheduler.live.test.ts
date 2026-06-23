/**
 * Live wiring test for the goal-scheduler shell preflight.
 *
 * Runs the real goal-scheduler/scheduler.sh against fixture
 * goal instance state files, with a stub engine binary on PATH.
 * Proves the scheduler:
 * - ticks every active managed goal exactly once via `goal-manager --goal <id>`
 * - skips paused, done, missing-state, and legacy-shaped goal files
 * - keeps going when one managed tick fails
 * - invokes the published bin name `kody-engine`, never bare `kody`
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveAgentAction } from "../../src/registry.js"

function schedulerPath(): string {
  const resolved = resolveAgentAction("goal-scheduler")
  if (!resolved) throw new Error("goal-scheduler agentAction not found")
  return path.join(path.dirname(resolved), "scheduler.sh")
}

let tmp: string
let logFile: string
let ghLogFile: string

function managedGoalExtra(): Record<string, unknown> {
  return {
    type: "release",
    destination: { outcome: "publish", evidence: ["releasePrExists"] },
    agentResponsibilities: ["release-prepare"],
    route: [{ evidence: "releasePrExists", stage: "prepare", agentResponsibility: "release-prepare" }],
    stage: "prepare",
    facts: {},
    blockers: [],
  }
}

function writeGoal(id: string, state: string | null, extra: Record<string, unknown> = {}): void {
  const dir = path.join(tmp, ".kody", "goals", "instances", id)
  fs.mkdirSync(dir, { recursive: true })
  if (state !== null) {
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, state, ...extra }, null, 2))
  }
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmp, "kody.config.json"), `${JSON.stringify(config, null, 2)}\n`)
}

function writeTemplate(slug: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(tmp, ".kody", "goals", "templates", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ version: 1, kind: "template", templateId: slug, state: "inactive", ...extra }, null, 2),
  )
}

function activateGoals(...items: unknown[]): void {
  fs.writeFileSync(path.join(tmp, "kody.config.json"), JSON.stringify({ company: { activeGoals: items } }, null, 2))
}

function installEngineStub(): string {
  const binDir = path.join(tmp, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  const stub = path.join(binDir, "kody-engine")
  fs.writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'echo "kody-engine $*" >> "$KODY_LOG"',
      'for a in "$@"; do',
      '  if [ "$a" = "fail-goal" ]; then exit 7; fi',
      "done",
      "exit 0",
      "",
    ].join("\n"),
  )
  fs.chmodSync(stub, 0o755)
  return binDir
}

function installGhStub(binDir: string): void {
  const stub = path.join(binDir, "gh")
  fs.writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'echo "gh $*" >> "$KODY_GH_LOG"',
      'if [ "$1" = "api" ] && [ "$2" = "/repos/A-Guy-educ/kody-state/contents/A-Guy-Web/goals/instances" ]; then',
      '  printf \'[{"name":"web-release","type":"dir"}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "api" ] && [ "$2" = "/repos/A-Guy-educ/kody-state/contents/A-Guy-Web/goals/instances/web-release/state.json" ]; then',
      '  printf \'{"type":"file","encoding":"base64","content":"%s"}\\n\' "$(printf \'%s\' "$KODY_REMOTE_GOAL_JSON" | base64 | tr -d \'\\n\')"',
      "  exit 0",
      "fi",
      'echo "unexpected gh call: $*" >&2',
      "exit 9",
      "",
    ].join("\n"),
  )
  fs.chmodSync(stub, 0o755)
}

function runScheduler(options: { remote?: boolean } = {}): {
  status: number
  stdout: string
  stderr: string
  calls: string[]
  ghCalls: string[]
} {
  const binDir = installEngineStub()
  if (options.remote) installGhStub(binDir)
  const res = spawnSync("bash", [schedulerPath()], {
    cwd: tmp,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      KODY_LOG: logFile,
      KODY_GH_LOG: ghLogFile,
      KODY_GOAL_SCHEDULER_NOW: "2026-06-20T12:00:00Z",
      ...(options.remote
        ? { KODY_REMOTE_GOAL_JSON: JSON.stringify({ version: 1, state: "active", ...managedGoalExtra() }) }
        : { KODY_GOAL_SCHEDULER_SKIP_PERSIST: "1" }),
    },
    encoding: "utf-8",
  })
  const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean) : []
  const ghCalls = fs.existsSync(ghLogFile) ? fs.readFileSync(ghLogFile, "utf-8").trim().split("\n").filter(Boolean) : []
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", calls, ghCalls }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-sched-"))
  logFile = path.join(tmp, "calls.log")
  ghLogFile = path.join(tmp, "gh-calls.log")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("goal-scheduler live wiring", () => {
  it("ticks an active managed goal once via real kody-engine bin", () => {
    writeGoal("release-v1-2-3", "active", managedGoalExtra())
    activateGoals("release-v1-2-3")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine exec goal-manager --goal release-v1-2-3"])
    expect(stdout).toContain("-> tick release-v1-2-3 (goal-manager)")
    expect(stdout).toContain("scanned 1 goal instance(s), active=1, managed=1")
    expect(stdout).toContain("KODY_SKIP_AGENT=true")
  })

  it("skips active legacy-shaped goals", () => {
    writeGoal("legacy", "active")
    writeGoal("managed", "active", managedGoalExtra())
    activateGoals("legacy", "managed")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine exec goal-manager --goal managed"])
    expect(stdout).toContain("skip legacy: legacy goal files are not managed-goal instances")
    expect(stdout).toContain("-> tick managed (goal-manager)")
  })

  it("invokes kody-engine, never bare kody", () => {
    writeGoal("g1", "active", managedGoalExtra())
    activateGoals("g1")

    const { status, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls.every((c) => c.startsWith("kody-engine "))).toBe(true)
    expect(calls.some((c) => c.startsWith("kody "))).toBe(false)
  })

  it("normalizes URL-form state.repo before using GitHub contents API", () => {
    writeConfig({
      github: { owner: "A-Guy-educ", repo: "A-Guy-Web" },
      state: { repo: "https://github.com/A-Guy-educ/kody-state", path: "A-Guy-Web" },
      company: { activeGoals: ["web-release"] },
    })

    const { status, stderr, calls, ghCalls } = runScheduler({ remote: true })

    expect(status, stderr).toBe(0)
    expect(ghCalls).toContain("gh api /repos/A-Guy-educ/kody-state/contents/A-Guy-Web/goals/instances")
    expect(ghCalls).toContain("gh api /repos/A-Guy-educ/kody-state/contents/A-Guy-Web/goals/instances/web-release/state.json")
    expect(ghCalls.some((call) => call.includes("/repos/https://github.com"))).toBe(false)
    expect(calls).toEqual(["kody-engine exec goal-manager --goal web-release"])
  })

  it("skips paused and done goals", () => {
    writeGoal("a", "active", managedGoalExtra())
    writeGoal("p", "paused", managedGoalExtra())
    writeGoal("d", "done", managedGoalExtra())
    activateGoals("a", "p", "d")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine exec goal-manager --goal a"])
    expect(stdout).toContain("scanned 3 goal instance(s), active=1, managed=1")
  })

  it("continues after failed tick so one stuck goal cannot starve the rest", () => {
    writeGoal("ok-1", "active", managedGoalExtra())
    writeGoal("fail-goal", "active", managedGoalExtra())
    writeGoal("ok-2", "active", managedGoalExtra())
    activateGoals("ok-1", "fail-goal", "ok-2")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toContain("kody-engine exec goal-manager --goal ok-1")
    expect(calls).toContain("kody-engine exec goal-manager --goal fail-goal")
    expect(calls).toContain("kody-engine exec goal-manager --goal ok-2")
    expect(stdout).toContain("tick fail-goal failed (continuing)")
    expect(stdout).toContain("scanned 3 goal instance(s), active=3, managed=3")
  })

  it("creates and ticks a scheduled goal instance from a template", () => {
    writeTemplate("weekly-release", managedGoalExtra())
    activateGoals({ template: "weekly-release", every: "1w", facts: { issue: 123 } })

    const { status, stdout, calls } = runScheduler()

    const instanceFile = path.join(tmp, ".kody", "goals", "instances", "weekly-release-2026-W25", "state.json")
    const instance = JSON.parse(fs.readFileSync(instanceFile, "utf-8"))
    expect(status).toBe(0)
    expect(instance).toMatchObject({
      kind: "instance",
      template: "weekly-release",
      sourceTemplate: "weekly-release",
      state: "active",
      facts: { issue: 123 },
    })
    expect(calls).toEqual(["kody-engine exec goal-manager --goal weekly-release-2026-W25"])
    expect(stdout).toContain("created goal instance weekly-release-2026-W25")
    expect(stdout).toContain("-> tick weekly-release-2026-W25 (goal-manager)")
  })

  it("no active goals configured skips cleanly without calling engine", () => {
    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual([])
    expect(stdout).toContain("no company.activeGoals configured")
  })
})
