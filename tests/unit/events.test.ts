import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __resetRunIdCache, emitEvent, listRuns, readEvents, resolveRunId } from "../../src/events.js"
import { runtimeStatePath } from "../../src/runtimePaths.js"

describe("events: resolveRunId", () => {
  beforeEach(() => {
    __resetRunIdCache()
    delete process.env.KODY_RUN_ID
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
  })
  afterEach(() => {
    __resetRunIdCache()
    delete process.env.KODY_RUN_ID
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
  })

  it("honours KODY_RUN_ID when set", () => {
    process.env.KODY_RUN_ID = "explicit-id"
    expect(resolveRunId()).toBe("explicit-id")
  })

  it("derives an id from GitHub Actions env vars when KODY_RUN_ID is absent", () => {
    process.env.GITHUB_RUN_ID = "12345"
    process.env.GITHUB_RUN_ATTEMPT = "2"
    expect(resolveRunId()).toBe("gh-12345-2")
  })

  it("falls back to a generated id otherwise", () => {
    const id = resolveRunId()
    expect(id).toMatch(/^[a-z0-9]+-[a-f0-9]{8}$/)
  })

  it("propagates the resolved id to process.env for child inheritance", () => {
    process.env.GITHUB_RUN_ID = "999"
    const id = resolveRunId()
    expect(process.env.KODY_RUN_ID).toBe(id)
  })

  it("caches the resolved id across calls", () => {
    const first = resolveRunId()
    const second = resolveRunId()
    expect(first).toBe(second)
  })
})

describe("events: emitEvent + readEvents", () => {
  let tmpDir: string
  beforeEach(() => {
    __resetRunIdCache()
    delete process.env.KODY_RUN_ID
    delete process.env.GITHUB_RUN_ID
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-events-"))
    process.env.KODY_RUNTIME_DIR = path.join(tmpDir, "runtime")
  })
  afterEach(() => {
    __resetRunIdCache()
    delete process.env.KODY_RUN_ID
    delete process.env.KODY_RUNTIME_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.KODY_EVENTS
  })

  it("appends one JSON line per emit", () => {
    process.env.KODY_RUN_ID = "test-run"
    emitEvent(tmpDir, { agentAction: "run", kind: "stage_start" })
    emitEvent(tmpDir, { agentAction: "run", kind: "preflight", name: "loadIssueContext", durationMs: 12 })
    emitEvent(tmpDir, { agentAction: "run", kind: "stage_end", durationMs: 1500, outcome: "ok" })
    const events = readEvents(tmpDir, "test-run")
    expect(events).toHaveLength(3)
    expect(events[0]?.kind).toBe("stage_start")
    expect(events[1]?.name).toBe("loadIssueContext")
    expect(events[2]?.outcome).toBe("ok")
  })

  it("attaches an ISO timestamp and the resolved run id to every event", () => {
    process.env.KODY_RUN_ID = "rid"
    emitEvent(tmpDir, { agentAction: "fix", kind: "stage_start" })
    const events = readEvents(tmpDir, "rid")
    expect(events[0]?.runId).toBe("rid")
    expect(events[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it("is a no-op when KODY_EVENTS=0", () => {
    process.env.KODY_RUN_ID = "off"
    process.env.KODY_EVENTS = "0"
    emitEvent(tmpDir, { agentAction: "run", kind: "stage_start" })
    expect(readEvents(tmpDir, "off")).toEqual([])
  })

  it("returns [] for unknown run ids", () => {
    expect(readEvents(tmpDir, "nonexistent")).toEqual([])
  })

  it("skips malformed lines gracefully", () => {
    process.env.KODY_RUN_ID = "rid"
    const runDir = runtimeStatePath(tmpDir, "agent-runs", "rid")
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({ ts: "x", runId: "rid", agentAction: "run", kind: "stage_start" })}\n` +
        "this is not json\n" +
        `${JSON.stringify({ ts: "y", runId: "rid", agentAction: "run", kind: "stage_end" })}\n`,
    )
    const events = readEvents(tmpDir, "rid")
    expect(events).toHaveLength(2)
    expect(events[0]?.kind).toBe("stage_start")
    expect(events[1]?.kind).toBe("stage_end")
  })

  it("listRuns enumerates run directories", () => {
    process.env.KODY_RUN_ID = "alpha"
    emitEvent(tmpDir, { agentAction: "run", kind: "stage_start" })
    __resetRunIdCache()
    process.env.KODY_RUN_ID = "beta"
    emitEvent(tmpDir, { agentAction: "fix", kind: "stage_start" })
    expect(listRuns(tmpDir)).toEqual(["alpha", "beta"])
  })

  it("listRuns returns [] when runtime run directory does not exist", () => {
    expect(listRuns(tmpDir)).toEqual([])
  })
})
