/**
 * Live wiring test for the goal-scheduler shell preflight.
 *
 * Runs the real goal-scheduler/scheduler.sh against fixture
 * goal todo JSON files, with a stub engine binary on PATH.
 * Proves the scheduler:
 * - ticks every active managed goal exactly once via `goal-manager --goal <id>`
 * - skips paused, done, missing-state, and unmanaged todo files
 * - keeps going when one managed tick fails
 * - invokes the published bin name `kody-engine`, never bare `kody`
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveImplementation } from "../../src/registry.js"

function schedulerPath(): string {
  const resolved = resolveImplementation("goal-scheduler")
  if (!resolved) throw new Error("goal-scheduler implementation not found")
  return path.join(path.dirname(resolved), "scheduler.sh")
}

let tmp: string
let logFile: string
let ghLogFile: string

function managedGoalExtra(): Record<string, unknown> {
  return {
    type: "release",
    destination: { outcome: "publish", evidence: ["releasePrExists"] },
    capabilities: ["release-prepare"],
    route: [{ evidence: "releasePrExists", stage: "prepare", capability: "release-prepare" }],
    stage: "prepare",
    facts: {},
    blockers: [],
  }
}

function managedGoalTodo(id: string): string {
  const extra = managedGoalExtra()
  return `${JSON.stringify(
    {
      version: 1,
      title: id,
      id,
      description: String((extra.destination as { outcome: string }).outcome),
      managed: true,
      managedModel: "agentGoal",
      state: "active",
      ...extra,
      evidence: ["releasePrExists"],
      items: [
        {
          id: "releasePrExists",
          title: "prepare",
          body: "",
          assignee: null,
          completed: false,
          createdAt: "2026-06-20T12:00:00.000Z",
          completedAt: null,
          meta: {
            evidence: "releasePrExists",
            stage: "prepare",
            capability: "release-prepare",
          },
        },
      ],
    },
    null,
    2,
  )}\n`
}

function regularTodoList(): string {
  return `${JSON.stringify(
    {
      version: 1,
      title: "Regular todo",
      description: "",
      createdAt: "2026-06-28T00:00:00.000Z",
      items: [
        {
          id: "item-1",
          title: "Should not tick",
          body: "",
          assignee: null,
          completed: false,
          createdAt: "2026-06-28T00:00:00.000Z",
          completedAt: null,
        },
      ],
    },
    null,
    2,
  )}\n`
}

function writeGoal(id: string, state: string | null, extra: Record<string, unknown> = {}): void {
  const file = path.join(tmp, ".kody", "todos", `${id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (state !== null) {
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: 1,
          title: id,
          description:
            typeof (extra.destination as { outcome?: unknown } | undefined)?.outcome === "string"
              ? (extra.destination as { outcome: string }).outcome
              : "",
          managed: true,
          managedModel: extra.scheduleMode === "agentLoop" || extra.type === "agentLoop" ? "agentLoop" : "agentGoal",
          items: [],
          state,
          ...extra,
        },
        null,
        2,
      ),
    )
  }
}

function writeRegularTodo(id: string): void {
  const file = path.join(tmp, ".kody", "todos", `${id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: 1,
        title: id,
        description: "",
        items: [],
        state: "active",
      },
      null,
      2,
    ),
  )
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
      'if [ "$1" = "api" ] && [ "$2" = "/repos/A-Guy-educ/kody-state/contents/A-Guy-Web/todos" ]; then',
      '  printf \'[{"name":"web-release.json","type":"file"},{"name":"todo-list-1.json","type":"file"}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "api" ] && [ "$2" = "/repos/A-Guy-educ/kody-state/contents/A-Guy-Web/todos/web-release.json" ]; then',
      '  printf \'{"type":"file","encoding":"base64","sha":"todo-sha","content":"%s"}\\n\' "$(printf \'%s\' "$KODY_REMOTE_GOAL_MD" | base64 | tr -d \'\\n\')"',
      "  exit 0",
      "fi",
      'if [ "$1" = "api" ] && [ "$2" = "/repos/A-Guy-educ/kody-state/contents/A-Guy-Web/todos/todo-list-1.json" ]; then',
      '  printf \'{"type":"file","encoding":"base64","sha":"regular-todo-sha","content":"%s"}\\n\' "$(printf \'%s\' "$KODY_REMOTE_REGULAR_TODO_MD" | base64 | tr -d \'\\n\')"',
      "  exit 0",
      "fi",
      'echo "unexpected gh call: $*" >&2',
      "exit 9",
      "",
    ].join("\n"),
  )
  fs.chmodSync(stub, 0o755)
}

function runScheduler(options: { remote?: boolean; now?: string } = {}): {
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
      KODY_GOAL_SCHEDULER_NOW: options.now ?? "2026-06-20T12:00:00Z",
      ...(options.remote
        ? {
            KODY_REMOTE_GOAL_MD: managedGoalTodo("web-release"),
            KODY_REMOTE_REGULAR_TODO_MD: regularTodoList(),
          }
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
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal release-v1-2-3"])
    expect(stdout).toContain("-> tick release-v1-2-3 (goal-manager)")
    expect(stdout).toContain("scanned 1 goal instance(s), active=1, managed=1")
    expect(stdout).toContain("KODY_SKIP_AGENT=true")
  })

  it("ignores active unmanaged todo files", () => {
    writeRegularTodo("regular")
    writeGoal("managed", "active", managedGoalExtra())
    activateGoals("regular", "managed")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal managed"])
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
    expect(ghCalls.join("\n")).toContain("/contents/A-Guy-Web/todos")
    expect(ghCalls.join("\n")).toContain("/contents/A-Guy-Web/todos/web-release.json")
    expect(ghCalls.join("\n")).toContain("/contents/A-Guy-Web/todos/todo-list-1.json")
    expect(ghCalls.some((call) => call.includes("/repos/https://github.com"))).toBe(false)
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal web-release"])
  })

  it("skips paused and done goals", () => {
    writeGoal("a", "active", managedGoalExtra())
    writeGoal("p", "paused", managedGoalExtra())
    writeGoal("d", "done", managedGoalExtra())
    activateGoals("a", "p", "d")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal a"])
    expect(stdout).toContain("scanned 3 goal instance(s), active=1, managed=1")
  })

  it("continues after failed tick so one stuck goal cannot starve the rest", () => {
    writeGoal("ok-1", "active", managedGoalExtra())
    writeGoal("fail-goal", "active", managedGoalExtra())
    writeGoal("ok-2", "active", managedGoalExtra())
    activateGoals("ok-1", "fail-goal", "ok-2")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toContain("kody-engine implementation goal-manager --goal ok-1")
    expect(calls).toContain("kody-engine implementation goal-manager --goal fail-goal")
    expect(calls).toContain("kody-engine implementation goal-manager --goal ok-2")
    expect(stdout).toContain("tick fail-goal failed (continuing)")
    expect(stdout).toContain("scanned 3 goal instance(s), active=3, managed=3")
  })

  it("creates and ticks a scheduled goal instance from a template", () => {
    writeTemplate("weekly-release", managedGoalExtra())
    activateGoals({ template: "weekly-release", every: "1w", facts: { issue: 123 } })

    const { status, stdout, calls } = runScheduler()

    const instanceFile = path.join(tmp, ".kody", "todos", "weekly-release-2026-W25.json")
    const instance = JSON.parse(fs.readFileSync(instanceFile, "utf-8"))
    expect(status).toBe(0)
    expect(instance).toMatchObject({
      kind: "instance",
      template: "weekly-release",
      sourceTemplate: "weekly-release",
      state: "active",
      facts: { issue: 123 },
    })
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal weekly-release-2026-W25"])
    expect(stdout).toContain("created goal instance weekly-release-2026-W25")
    expect(stdout).toContain("-> tick weekly-release-2026-W25 (goal-manager)")
  })

  it("waits until scheduled goal preferred runtime in local timezone", () => {
    writeTemplate("web-release", managedGoalExtra())
    activateGoals({
      template: "web-release",
      every: "1d",
      idPrefix: "web-release",
      preferredRunTime: { time: "10:00", timezone: "Asia/Jerusalem" },
    })

    const before = runScheduler({ now: "2026-06-24T06:59:00Z" })
    expect(before.status).toBe(0)
    expect(before.calls).toEqual([])
    expect(before.stdout).toContain("skip web-release: waiting preferred time 10:00 Asia/Jerusalem")
    expect(fs.existsSync(path.join(tmp, ".kody", "todos", "web-release-2026-06-24.json"))).toBe(false)

    const after = runScheduler({ now: "2026-06-24T07:01:00Z" })
    expect(after.status).toBe(0)
    expect(after.calls).toEqual(["kody-engine implementation goal-manager --goal web-release-2026-06-24"])
    expect(after.stdout).toContain("created goal instance web-release-2026-06-24")
  })

  it("continues ticking unfinished scheduled instances from earlier buckets", () => {
    writeTemplate("web-release", managedGoalExtra())
    writeGoal("web-release-2026-06-24", "active", {
      ...managedGoalExtra(),
      kind: "instance",
      template: "web-release",
      sourceTemplate: "web-release",
      stage: "publish",
      facts: {
        issue: 521,
        releasePr: 522,
        releasePrExists: true,
        mainMerged: true,
        pendingEvidence: "productionDeployed",
      },
    })
    activateGoals({
      template: "web-release",
      every: "1d",
      idPrefix: "web-release",
      preferredRunTime: { time: "10:00", timezone: "Asia/Jerusalem" },
    })

    const { status, calls, stdout } = runScheduler({ now: "2026-06-25T06:59:00Z" })

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal web-release-2026-06-24"])
    expect(stdout).toContain("skip web-release: waiting preferred time 10:00 Asia/Jerusalem")
    expect(stdout).toContain("-> tick web-release-2026-06-24 (goal-manager)")
  })

  it("does not create the next scheduled bucket while an earlier bucket is still active", () => {
    writeTemplate("web-release", managedGoalExtra())
    writeGoal("web-release-2026-06-24", "active", {
      ...managedGoalExtra(),
      kind: "instance",
      template: "web-release",
      sourceTemplate: "web-release",
      stage: "publish",
      facts: {
        issue: 521,
        releasePr: 522,
        releasePrExists: true,
        mainMerged: true,
        pendingEvidence: "productionDeployed",
      },
    })
    activateGoals({
      template: "web-release",
      every: "1d",
      idPrefix: "web-release",
      preferredRunTime: { time: "10:00", timezone: "Asia/Jerusalem" },
    })

    const { status, calls, stdout } = runScheduler({ now: "2026-06-25T07:01:00Z" })

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal web-release-2026-06-24"])
    expect(fs.existsSync(path.join(tmp, ".kody", "todos", "web-release-2026-06-25.json"))).toBe(false)
    expect(stdout).toContain("skip web-release: active scheduled instance already running (web-release-2026-06-24)")
  })

  it("ticks only the oldest active scheduled instance when duplicate buckets exist", () => {
    writeTemplate("web-release", managedGoalExtra())
    writeGoal("web-release-2026-06-24", "active", {
      ...managedGoalExtra(),
      kind: "instance",
      template: "web-release",
      sourceTemplate: "web-release",
      createdAt: "2026-06-24T10:48:43Z",
      stage: "publish",
      facts: {
        issue: 521,
        releasePr: 522,
        releasePrExists: true,
        mainMerged: true,
        pendingEvidence: "productionDeployed",
      },
    })
    writeGoal("web-release-2026-06-25", "active", {
      ...managedGoalExtra(),
      kind: "instance",
      template: "web-release",
      sourceTemplate: "web-release",
      createdAt: "2026-06-25T08:14:18Z",
      stage: "release",
      facts: {},
    })
    activateGoals({
      template: "web-release",
      every: "1d",
      idPrefix: "web-release",
      preferredRunTime: { time: "10:00", timezone: "Asia/Jerusalem" },
    })

    const { status, calls, stdout } = runScheduler({ now: "2026-06-25T07:01:00Z" })

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal web-release-2026-06-24"])
    expect(stdout).toContain("skip web-release: active scheduled instance already running (web-release-2026-06-24)")
    expect(stdout).not.toContain("-> tick web-release-2026-06-25 (goal-manager)")
  })

  it("scheduled goal activation does not tick stale singleton instances from the same template", () => {
    writeTemplate("web-release", managedGoalExtra())
    writeGoal("web-release", "active", {
      ...managedGoalExtra(),
      template: "web-release",
      sourceTemplate: "web-release",
      stage: "merge",
      facts: { issue: 294, releasePr: 295, releasePrExists: true, pendingEvidence: "mainMerged" },
    })
    activateGoals({ template: "web-release", every: "1d", idPrefix: "web-release" })

    const { status, calls, stdout } = runScheduler({ now: "2026-06-24T07:01:00Z" })

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine implementation goal-manager --goal web-release-2026-06-24"])
    expect(stdout).toContain("created goal instance web-release-2026-06-24")
    expect(stdout).not.toContain("-> tick web-release (goal-manager)")
  })

  it("no active goals configured skips cleanly without calling engine", () => {
    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual([])
    expect(stdout).toContain("no company.activeGoals configured")
  })
})
