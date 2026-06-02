/**
 * Unit tests for `kody stats` (src/stats.ts).
 *
 * Covers all exported functions:
 *   - parseStatsArgs  (pure CLI flag parsing, incl. --since duration grammar)
 *   - summarizeRun    (pure event → run summary, incl. empty / token sums)
 *   - rollupByExecutable (pure event → per-executable rollup, percentiles)
 *   - runStats        (IO orchestration; events.js mocked for listRuns/readEvents)
 *
 * The internal helpers (parseDuration, percentile, printReport, formatMs) are
 * exercised indirectly through the exported surface, so a single run lights up
 * every function in the module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunEvent } from "../../src/events.js"

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn<(cwd: string) => string[]>(() => []),
  readEvents: vi.fn<(cwd: string, runId: string) => RunEvent[]>(() => []),
}))

vi.mock("../../src/events.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/events.js")
  return { ...actual, listRuns: mocks.listRuns, readEvents: mocks.readEvents }
})

import { parseStatsArgs, rollupByExecutable, runStats, summarizeRun } from "../../src/stats.js"

function evt(partial: Partial<RunEvent> & { kind: RunEvent["kind"]; ts: string }): RunEvent {
  return {
    runId: "rid",
    executable: "run",
    ...partial,
  }
}

describe("stats: parseStatsArgs", () => {
  it("defaults cwd to process.cwd() and leaves flags unset", () => {
    const out = parseStatsArgs([])
    expect(out.cwd).toBe(process.cwd())
    expect(out.asJson).toBeUndefined()
    expect(out.sinceMs).toBeUndefined()
    expect(out.runId).toBeUndefined()
  })

  it("parses --since durations for s/m/h/d", () => {
    expect(parseStatsArgs(["--since", "30s"]).sinceMs).toBe(30_000)
    expect(parseStatsArgs(["--since", "30m"]).sinceMs).toBe(30 * 60_000)
    expect(parseStatsArgs(["--since", "1h"]).sinceMs).toBe(3_600_000)
    expect(parseStatsArgs(["--since", "7d"]).sinceMs).toBe(7 * 86_400_000)
  })

  it("tolerates whitespace and case in the --since unit", () => {
    expect(parseStatsArgs(["--since", " 2 H "]).sinceMs).toBe(7_200_000)
  })

  it("yields undefined sinceMs for malformed --since", () => {
    expect(parseStatsArgs(["--since", "soon"]).sinceMs).toBeUndefined()
    expect(parseStatsArgs(["--since", "10x"]).sinceMs).toBeUndefined()
  })

  it("parses --json, --run, --cwd", () => {
    const opts = parseStatsArgs(["--json", "--run", "abc", "--cwd", "/tmp/x"])
    expect(opts.asJson).toBe(true)
    expect(opts.runId).toBe("abc")
    expect(opts.cwd).toBe("/tmp/x")
  })

  it("ignores unknown flags and value-less trailing flags", () => {
    expect(parseStatsArgs(["--unknown", "foo"]).runId).toBeUndefined()
    expect(parseStatsArgs(["--cwd"]).cwd).toBe(process.cwd())
  })
})

describe("stats: summarizeRun", () => {
  it("returns null for empty event lists", () => {
    expect(summarizeRun([])).toBeNull()
  })

  it("computes duration from first stage_start to last stage_end", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_start", ts: "2026-05-11T08:00:00.000Z" }),
      evt({
        kind: "stage_end",
        ts: "2026-05-11T08:00:30.000Z",
        durationMs: 30_000,
        outcome: "ok",
        meta: { exitCode: 0 },
      }),
    ]
    const summary = summarizeRun(events)!
    expect(summary.runId).toBe("rid")
    expect(summary.startedAt).toBe("2026-05-11T08:00:00.000Z")
    expect(summary.endedAt).toBe("2026-05-11T08:00:30.000Z")
    expect(summary.durationMs).toBe(30_000)
    expect(summary.exitCode).toBe(0)
    expect(summary.ok).toBe(true)
    expect(summary.executables).toEqual(["run"])
  })

  it("uses the LAST stage_end (outer container) for window end and exit code", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_start", ts: "2026-05-11T08:00:00.000Z" }),
      evt({ kind: "stage_end", executable: "child", ts: "2026-05-11T08:00:02.000Z", meta: { exitCode: 0 } }),
      evt({ kind: "stage_end", executable: "run", ts: "2026-05-11T08:00:10.000Z", meta: { exitCode: 2 } }),
    ]
    const summary = summarizeRun(events)!
    expect(summary.endedAt).toBe("2026-05-11T08:00:10.000Z")
    expect(summary.exitCode).toBe(2)
    expect(summary.ok).toBe(false)
    expect(summary.executables).toEqual(["run", "child"])
  })

  it("falls back to first/last event ts when stage events are absent", () => {
    const events: RunEvent[] = [
      evt({ kind: "agent_start", ts: "2026-05-11T08:00:01.000Z" }),
      evt({ kind: "agent_end", ts: "2026-05-11T08:00:04.000Z" }),
    ]
    const summary = summarizeRun(events)!
    expect(summary.startedAt).toBe("2026-05-11T08:00:01.000Z")
    expect(summary.endedAt).toBe("2026-05-11T08:00:04.000Z")
    expect(summary.exitCode).toBeNull()
    expect(summary.ok).toBe(false)
  })

  it("sorts unsorted events by ts before summarizing", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_end", ts: "2026-05-11T08:00:09.000Z", meta: { exitCode: 0 } }),
      evt({ kind: "stage_start", ts: "2026-05-11T08:00:01.000Z" }),
    ]
    const summary = summarizeRun(events)!
    expect(summary.startedAt).toBe("2026-05-11T08:00:01.000Z")
    expect(summary.endedAt).toBe("2026-05-11T08:00:09.000Z")
    expect(summary.durationMs).toBe(8_000)
  })

  it("sums tokens across agent_end events", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_start", ts: "2026-05-11T08:00:00.000Z" }),
      evt({
        kind: "agent_end",
        ts: "2026-05-11T08:00:10.000Z",
        meta: { tokens: { input: 1000, output: 500, cacheRead: 200 } },
      }),
      evt({
        kind: "agent_end",
        ts: "2026-05-11T08:00:20.000Z",
        meta: { tokens: { input: 800, output: 300 } },
      }),
      evt({
        kind: "stage_end",
        ts: "2026-05-11T08:00:25.000Z",
        durationMs: 25_000,
        outcome: "ok",
        meta: { exitCode: 0 },
      }),
    ]
    const summary = summarizeRun(events)!
    expect(summary.totalInputTokens).toBe(1800)
    expect(summary.totalOutputTokens).toBe(800)
    expect(summary.totalCacheReadTokens).toBe(200)
  })

  it("treats agent_end without a tokens meta as zero contribution", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_start", ts: "2026-05-11T08:00:00.000Z" }),
      evt({ kind: "agent_end", ts: "2026-05-11T08:00:01.000Z", meta: {} }),
      evt({ kind: "stage_end", ts: "2026-05-11T08:00:02.000Z", meta: { exitCode: 0 } }),
    ]
    const summary = summarizeRun(events)!
    expect(summary.totalInputTokens).toBe(0)
    expect(summary.totalOutputTokens).toBe(0)
    expect(summary.totalCacheReadTokens).toBe(0)
  })

  it("marks a run as failed when the last stage_end has a non-zero exit code", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_start", ts: "2026-05-11T08:00:00.000Z" }),
      evt({
        kind: "stage_end",
        ts: "2026-05-11T08:00:05.000Z",
        durationMs: 5_000,
        outcome: "failed",
        meta: { exitCode: 2 },
      }),
    ]
    const summary = summarizeRun(events)!
    expect(summary.ok).toBe(false)
    expect(summary.exitCode).toBe(2)
  })
})

describe("stats: rollupByExecutable", () => {
  it("returns [] when there are no stage_end events", () => {
    expect(rollupByExecutable([evt({ kind: "stage_start", ts: "t1" })])).toEqual([])
  })

  it("groups stage_end events by executable with ok/failed counts", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_end", executable: "run", ts: "t1", durationMs: 100, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "run", ts: "t2", durationMs: 200, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "run", ts: "t3", durationMs: 300, outcome: "failed" }),
      evt({ kind: "stage_end", executable: "fix", ts: "t4", durationMs: 50, outcome: "ok" }),
    ]
    const rollups = rollupByExecutable(events)
    expect(rollups).toHaveLength(2)
    const run = rollups.find((r) => r.executable === "run")!
    expect(run.runs).toBe(3)
    expect(run.ok).toBe(2)
    expect(run.failed).toBe(1)
    expect(run.meanMs).toBe(200)
    expect(rollups.find((r) => r.executable === "fix")!.runs).toBe(1)
  })

  it("computes percentiles from the sorted duration set", () => {
    const events: RunEvent[] = Array.from({ length: 10 }, (_, i) =>
      evt({ kind: "stage_end", executable: "run", ts: `t${i}`, durationMs: (i + 1) * 100, outcome: "ok" }),
    )
    const [run] = rollupByExecutable(events)
    expect(run!.p50Ms).toBe(600)
    expect(run!.p95Ms).toBe(1000)
  })

  it("drops zero/negative durations and yields zero percentiles when none remain", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_end", executable: "run", ts: "t1", durationMs: 0, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "run", ts: "t2", outcome: "ok" }),
    ]
    const [run] = rollupByExecutable(events)
    expect(run!.runs).toBe(2)
    expect(run!.p50Ms).toBe(0)
    expect(run!.p95Ms).toBe(0)
    expect(run!.meanMs).toBe(0)
  })

  it("attributes agent_end tokens to the right executable", () => {
    const events: RunEvent[] = [
      evt({
        kind: "agent_end",
        executable: "run",
        ts: "t1",
        meta: { tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 5 } },
      }),
      evt({
        kind: "agent_end",
        executable: "fix",
        ts: "t2",
        meta: { tokens: { input: 200, output: 75, cacheRead: 10, cacheCreate: 0 } },
      }),
      evt({ kind: "stage_end", executable: "run", ts: "t3", durationMs: 1000, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "fix", ts: "t4", durationMs: 500, outcome: "ok" }),
    ]
    const rollups = rollupByExecutable(events)
    const run = rollups.find((r) => r.executable === "run")!
    const fix = rollups.find((r) => r.executable === "fix")!
    expect(run.totalInputTokens).toBe(100)
    expect(run.totalCacheCreateTokens).toBe(5)
    expect(fix.totalInputTokens).toBe(200)
    expect(fix.totalCacheReadTokens).toBe(10)
  })

  it("sorts rollups by run count descending", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_end", executable: "rare", ts: "t1", durationMs: 100, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "common", ts: "t2", durationMs: 100, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "common", ts: "t3", durationMs: 100, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "common", ts: "t4", durationMs: 100, outcome: "ok" }),
    ]
    const rollups = rollupByExecutable(events)
    expect(rollups.map((r) => r.executable)).toEqual(["common", "rare"])
  })
})

describe("stats: runStats", () => {
  let stdout: string
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdout = ""
    mocks.listRuns.mockReset()
    mocks.readEvents.mockReset()
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk)
      return true
    })
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  function okRunEvents(runId: string, startTs: string): RunEvent[] {
    return [
      evt({ runId, executable: "run", kind: "stage_start", ts: startTs }),
      evt({
        runId,
        executable: "run",
        kind: "agent_end",
        ts: startTs,
        meta: { tokens: { input: 1000, output: 200, cacheRead: 50 } },
      }),
      evt({
        runId,
        executable: "run",
        kind: "stage_end",
        ts: new Date(new Date(startTs).getTime() + 5000).toISOString(),
        outcome: "ok",
        durationMs: 5000,
        meta: { exitCode: 0 },
      }),
    ]
  }

  it("reports 'no runs found' and returns 0 when there are no runs", async () => {
    mocks.listRuns.mockReturnValue([])
    const code = await runStats(["--cwd", "/tmp/empty"])
    expect(code).toBe(0)
    expect(stdout).toContain("no runs found under /tmp/empty/.kody/runs/")
    expect(mocks.listRuns).toHaveBeenCalledWith("/tmp/empty")
  })

  it("prints a human report covering summary and per-executable table", async () => {
    mocks.listRuns.mockReturnValue(["r1"])
    mocks.readEvents.mockImplementation(() => okRunEvents("r1", "2026-01-01T00:00:00.000Z"))
    const code = await runStats(["--cwd", "/tmp/repo"])
    expect(code).toBe(0)
    expect(stdout).toContain("Kody run statistics — 1 runs")
    expect(stdout).toContain("success rate")
    expect(stdout).toContain("100.0%")
    expect(stdout).toContain("Per-executable")
    expect(stdout).toContain("executable")
    expect(stdout).toContain("run")
    // formatMs(5000) → "5.0s"
    expect(stdout).toContain("5.0s")
  })

  it("emits machine-readable JSON with --json", async () => {
    mocks.listRuns.mockReturnValue(["r1"])
    mocks.readEvents.mockImplementation(() => okRunEvents("r1", "2026-01-01T00:00:00.000Z"))
    const code = await runStats(["--json", "--cwd", "/tmp/repo"])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.runs).toHaveLength(1)
    expect(parsed.runs[0].runId).toBe("r1")
    expect(parsed.byExecutable[0].executable).toBe("run")
    expect(parsed.byExecutable[0].totalInputTokens).toBe(1000)
  })

  it("honors --run by reading exactly that run id and skipping listRuns", async () => {
    mocks.readEvents.mockImplementation((_cwd, id) => okRunEvents(id, "2026-01-01T00:00:00.000Z"))
    const code = await runStats(["--json", "--run", "specific-run"])
    expect(code).toBe(0)
    expect(mocks.listRuns).not.toHaveBeenCalled()
    expect(mocks.readEvents).toHaveBeenCalledWith(process.cwd(), "specific-run")
    const parsed = JSON.parse(stdout)
    expect(parsed.runs[0].runId).toBe("specific-run")
  })

  it("skips runs with no events or that fail to summarize", async () => {
    mocks.listRuns.mockReturnValue(["empty", "good"])
    mocks.readEvents.mockImplementation((_cwd, id) =>
      id === "empty" ? [] : okRunEvents(id, "2026-01-01T00:00:00.000Z"),
    )
    const code = await runStats(["--json", "--cwd", "/tmp/repo"])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.runs).toHaveLength(1)
    expect(parsed.runs[0].runId).toBe("good")
  })

  it("filters out runs older than the --since cutoff", async () => {
    mocks.listRuns.mockReturnValue(["old", "new"])
    const recent = new Date(Date.now() - 60_000).toISOString()
    const ancient = new Date(Date.now() - 30 * 86_400_000).toISOString()
    mocks.readEvents.mockImplementation((_cwd, id) =>
      id === "old" ? okRunEvents("old", ancient) : okRunEvents("new", recent),
    )
    const code = await runStats(["--json", "--since", "7d", "--cwd", "/tmp/repo"])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.runs.map((r: { runId: string }) => r.runId)).toEqual(["new"])
  })

  it("reports 'no runs in the requested window' when --since filters everything out", async () => {
    mocks.listRuns.mockReturnValue(["old"])
    const ancient = new Date(Date.now() - 30 * 86_400_000).toISOString()
    mocks.readEvents.mockImplementation(() => okRunEvents("old", ancient))
    const code = await runStats(["--since", "1d", "--cwd", "/tmp/repo"])
    expect(code).toBe(0)
    expect(stdout).toContain("no runs in the requested window")
  })
})
