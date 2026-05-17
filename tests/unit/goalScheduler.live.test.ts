/**
 * Live wiring test for the goal-scheduler shell preflight.
 *
 * Runs the REAL `goal-scheduler/scheduler.sh` against fixture
 * `.kody/goals/<id>/state.json` files, with a stub engine binary on
 * PATH that records how it was invoked. Proves the scheduler:
 *   - ticks every `active` goal exactly once via `goal-tick --goal <id>`
 *   - skips `paused` / `done` / missing-state goals
 *   - keeps going when one tick fails (one stuck goal must not starve)
 *   - invokes the engine by its REAL published bin name `kody-engine`
 *     (regression guard: the script previously called bare `kody`,
 *     which is not the bin name → `kody: command not found`, so every
 *     goal silently failed to advance).
 *
 * The PATH deliberately contains ONLY a `kody-engine` stub and no
 * `kody` stub: if the script regresses to calling `kody`, the run
 * fails with command-not-found and these tests go red.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const SCHEDULER_SH = path.join(
  __dirname,
  "../../src/executables/goal-scheduler/scheduler.sh",
)

let tmp: string
let logFile: string

function writeGoal(id: string, state: string | null): void {
  const dir = path.join(tmp, ".kody", "goals", id)
  fs.mkdirSync(dir, { recursive: true })
  if (state !== null) {
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ version: 1, state }, null, 2),
    )
  }
}

/**
 * Stub `kody-engine` on PATH. Appends `argv0 <args...>` to $KODY_LOG.
 * Exits non-zero for the goal id "fail-goal" so we can prove the
 * scheduler keeps going after a failed tick.
 */
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

function runScheduler(): { status: number; stdout: string; calls: string[] } {
  const binDir = installEngineStub()
  const res = spawnSync("bash", [SCHEDULER_SH], {
    cwd: tmp,
    env: {
      ...process.env,
      // Stub dir FIRST so a stray real `kody-engine` can't shadow it.
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      KODY_LOG: logFile,
    },
    encoding: "utf-8",
  })
  const calls = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean)
    : []
  return { status: res.status ?? -1, stdout: res.stdout ?? "", calls }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-sched-"))
  logFile = path.join(tmp, "calls.log")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("goal-scheduler live wiring", () => {
  it("ticks an active goal once via the real kody-engine bin", () => {
    writeGoal("paymant", "active")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine goal-tick --goal paymant"])
    expect(stdout).toContain("→ tick paymant")
    expect(stdout).toContain("ticked 1 active goal(s) of 1 total")
    expect(stdout).toContain("KODY_SKIP_AGENT=true")
  })

  it("invokes kody-engine, never bare kody (regression guard)", () => {
    writeGoal("g1", "active")

    const { status, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls.every((c) => c.startsWith("kody-engine "))).toBe(true)
    expect(calls.some((c) => c.startsWith("kody "))).toBe(false)
  })

  it("skips paused and done goals", () => {
    writeGoal("a", "active")
    writeGoal("p", "paused")
    writeGoal("d", "done")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual(["kody-engine goal-tick --goal a"])
    expect(stdout).toContain("ticked 1 active goal(s) of 3 total")
  })

  it("continues after a failed tick so one stuck goal can't starve the rest", () => {
    writeGoal("ok-1", "active")
    writeGoal("fail-goal", "active")
    writeGoal("ok-2", "active")

    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toContain("kody-engine goal-tick --goal ok-1")
    expect(calls).toContain("kody-engine goal-tick --goal fail-goal")
    expect(calls).toContain("kody-engine goal-tick --goal ok-2")
    expect(stdout).toContain("tick fail-goal failed (continuing)")
    expect(stdout).toContain("ticked 3 active goal(s) of 3 total")
  })

  it("no .kody/goals dir → skips cleanly without calling the engine", () => {
    const { status, stdout, calls } = runScheduler()

    expect(status).toBe(0)
    expect(calls).toEqual([])
    expect(stdout).toContain("nothing to schedule")
    expect(stdout).toContain("KODY_SKIP_AGENT=true")
  })
})
