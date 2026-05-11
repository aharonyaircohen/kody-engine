import { describe, expect, it } from "vitest"
import type { RunEvent } from "../../src/events.js"
import { parseStatsArgs, rollupByExecutable, summarizeRun } from "../../src/stats.js"

function evt(partial: Partial<RunEvent> & { kind: RunEvent["kind"]; ts: string }): RunEvent {
  return {
    runId: "rid",
    executable: "run",
    ...partial,
  }
}

describe("stats: parseStatsArgs", () => {
  it("parses --since durations", () => {
    expect(parseStatsArgs(["--since", "7d"]).sinceMs).toBe(7 * 86_400_000)
    expect(parseStatsArgs(["--since", "30m"]).sinceMs).toBe(30 * 60_000)
    expect(parseStatsArgs(["--since", "1h"]).sinceMs).toBe(3_600_000)
  })
  it("parses --json, --run, --cwd", () => {
    const opts = parseStatsArgs(["--json", "--run", "abc", "--cwd", "/tmp/x"])
    expect(opts.asJson).toBe(true)
    expect(opts.runId).toBe("abc")
    expect(opts.cwd).toBe("/tmp/x")
  })
  it("ignores unknown flags", () => {
    expect(parseStatsArgs(["--unknown", "foo"]).runId).toBeUndefined()
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
    const summary = summarizeRun(events)
    expect(summary?.durationMs).toBe(30_000)
    expect(summary?.exitCode).toBe(0)
    expect(summary?.ok).toBe(true)
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
        meta: { tokens: { input: 800, output: 300, cacheRead: 1500 } },
      }),
      evt({
        kind: "stage_end",
        ts: "2026-05-11T08:00:25.000Z",
        durationMs: 25_000,
        outcome: "ok",
        meta: { exitCode: 0 },
      }),
    ]
    const summary = summarizeRun(events)
    expect(summary?.totalInputTokens).toBe(1800)
    expect(summary?.totalOutputTokens).toBe(800)
    expect(summary?.totalCacheReadTokens).toBe(1700)
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
    const summary = summarizeRun(events)
    expect(summary?.ok).toBe(false)
    expect(summary?.exitCode).toBe(2)
  })
})

describe("stats: rollupByExecutable", () => {
  it("groups stage_end events by executable", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_end", executable: "run", ts: "t1", durationMs: 100, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "run", ts: "t2", durationMs: 200, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "run", ts: "t3", durationMs: 300, outcome: "failed" }),
      evt({ kind: "stage_end", executable: "fix", ts: "t4", durationMs: 50, outcome: "ok" }),
    ]
    const rollups = rollupByExecutable(events)
    expect(rollups).toHaveLength(2)
    const run = rollups.find((r) => r.executable === "run")
    expect(run?.runs).toBe(3)
    expect(run?.ok).toBe(2)
    expect(run?.failed).toBe(1)
    const fix = rollups.find((r) => r.executable === "fix")
    expect(fix?.runs).toBe(1)
  })

  it("attributes agent_end tokens to the right executable", () => {
    const events: RunEvent[] = [
      evt({
        kind: "agent_end",
        executable: "run",
        ts: "t1",
        meta: { tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 } },
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
    const run = rollups.find((r) => r.executable === "run")
    const fix = rollups.find((r) => r.executable === "fix")
    expect(run?.totalInputTokens).toBe(100)
    expect(fix?.totalInputTokens).toBe(200)
    expect(fix?.totalCacheReadTokens).toBe(10)
  })

  it("sorts rollups by run count descending", () => {
    const events: RunEvent[] = [
      evt({ kind: "stage_end", executable: "rare", ts: "t1", durationMs: 100, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "common", ts: "t2", durationMs: 100, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "common", ts: "t3", durationMs: 100, outcome: "ok" }),
      evt({ kind: "stage_end", executable: "common", ts: "t4", durationMs: 100, outcome: "ok" }),
    ]
    const rollups = rollupByExecutable(events)
    expect(rollups[0]?.executable).toBe("common")
    expect(rollups[1]?.executable).toBe("rare")
  })
})
