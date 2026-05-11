/**
 * `kody stats` — rollup of structured run events for measuring stability
 * and velocity. Reads `.kody/runs/<runId>/events.jsonl` files written by
 * the executor (see src/events.ts) and prints per-executable success
 * rate, latency distribution, and token usage.
 *
 * Usage:
 *   kody stats              # all runs in .kody/runs/
 *   kody stats --since 7d   # rolling window
 *   kody stats --json       # machine-readable output
 *   kody stats --run <id>   # detail one run
 */

import { listRuns, readEvents, type RunEvent } from "./events.js"

interface StatsOptions {
  cwd: string
  sinceMs?: number
  asJson?: boolean
  runId?: string
}

interface ExecutableRollup {
  executable: string
  runs: number
  ok: number
  failed: number
  p50Ms: number
  p95Ms: number
  meanMs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreateTokens: number
}

interface RunSummary {
  runId: string
  startedAt: string
  endedAt: string
  durationMs: number
  executables: string[]
  exitCode: number | null
  ok: boolean
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
}

export function parseStatsArgs(argv: string[]): StatsOptions {
  const out: StatsOptions = { cwd: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") out.asJson = true
    else if (a === "--cwd" && argv[i + 1]) {
      out.cwd = argv[++i]!
    } else if (a === "--since" && argv[i + 1]) {
      out.sinceMs = parseDuration(argv[++i]!)
    } else if (a === "--run" && argv[i + 1]) {
      out.runId = argv[++i]
    }
  }
  return out
}

/** Parse "7d", "12h", "30m" into milliseconds. Returns undefined on bad input. */
function parseDuration(s: string): number | undefined {
  const m = /^(\d+)\s*([smhd])$/i.exec(s.trim())
  if (!m) return undefined
  const n = Number.parseInt(m[1]!, 10)
  const unit = m[2]!.toLowerCase()
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  return n * mult
}

/** Compute a percentile from a sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[idx]!
}

export function summarizeRun(events: RunEvent[]): RunSummary | null {
  if (events.length === 0) return null
  // Use the top-level (first) stage_start / final stage_end. Container
  // children emit their own stage events but the outer container's
  // stage_end is the last "stage_end" in the stream.
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts))
  const start = sorted.find((e) => e.kind === "stage_start")
  const ends = sorted.filter((e) => e.kind === "stage_end")
  const lastEnd = ends.length > 0 ? ends[ends.length - 1]! : undefined
  const startedAt = start?.ts ?? sorted[0]!.ts
  const endedAt = lastEnd?.ts ?? sorted[sorted.length - 1]!.ts
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  const exitCodeRaw = lastEnd?.meta?.exitCode
  const exitCode = typeof exitCodeRaw === "number" ? exitCodeRaw : null
  const executables = Array.from(new Set(sorted.map((e) => e.executable)))
  let tIn = 0
  let tOut = 0
  let tCacheR = 0
  for (const ev of sorted) {
    if (ev.kind !== "agent_end") continue
    const tokens = ev.meta?.tokens as { input?: number; output?: number; cacheRead?: number } | undefined
    if (tokens) {
      tIn += Number(tokens.input ?? 0)
      tOut += Number(tokens.output ?? 0)
      tCacheR += Number(tokens.cacheRead ?? 0)
    }
  }
  return {
    runId: sorted[0]!.runId,
    startedAt,
    endedAt,
    durationMs,
    executables,
    exitCode,
    ok: exitCode === 0,
    totalInputTokens: tIn,
    totalOutputTokens: tOut,
    totalCacheReadTokens: tCacheR,
  }
}

export function rollupByExecutable(events: RunEvent[]): ExecutableRollup[] {
  const byExec = new Map<string, RunEvent[]>()
  for (const ev of events) {
    if (ev.kind !== "stage_end") continue
    if (!byExec.has(ev.executable)) byExec.set(ev.executable, [])
    byExec.get(ev.executable)!.push(ev)
  }
  const rollups: ExecutableRollup[] = []
  for (const [executable, stageEnds] of byExec) {
    const durations = stageEnds
      .map((e) => e.durationMs ?? 0)
      .filter((d) => d > 0)
      .sort((a, b) => a - b)
    const ok = stageEnds.filter((e) => e.outcome === "ok").length
    const failed = stageEnds.filter((e) => e.outcome === "failed").length
    let tIn = 0
    let tOut = 0
    let tCacheR = 0
    let tCacheC = 0
    for (const ev of events) {
      if (ev.kind !== "agent_end") continue
      if (ev.executable !== executable) continue
      const tokens = ev.meta?.tokens as
        | { input?: number; output?: number; cacheRead?: number; cacheCreate?: number }
        | undefined
      if (tokens) {
        tIn += Number(tokens.input ?? 0)
        tOut += Number(tokens.output ?? 0)
        tCacheR += Number(tokens.cacheRead ?? 0)
        tCacheC += Number(tokens.cacheCreate ?? 0)
      }
    }
    const mean = durations.length > 0 ? durations.reduce((s, n) => s + n, 0) / durations.length : 0
    rollups.push({
      executable,
      runs: stageEnds.length,
      ok,
      failed,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      meanMs: Math.round(mean),
      totalInputTokens: tIn,
      totalOutputTokens: tOut,
      totalCacheReadTokens: tCacheR,
      totalCacheCreateTokens: tCacheC,
    })
  }
  rollups.sort((a, b) => b.runs - a.runs)
  return rollups
}

export async function runStats(argv: string[]): Promise<number> {
  const opts = parseStatsArgs(argv)
  const runIds = opts.runId ? [opts.runId] : listRuns(opts.cwd)
  if (runIds.length === 0) {
    process.stdout.write(`no runs found under ${opts.cwd}/.kody/runs/\n`)
    return 0
  }
  const cutoff = opts.sinceMs ? Date.now() - opts.sinceMs : null
  const allEvents: RunEvent[] = []
  const runSummaries: RunSummary[] = []
  for (const id of runIds) {
    const events = readEvents(opts.cwd, id)
    if (events.length === 0) continue
    const summary = summarizeRun(events)
    if (!summary) continue
    if (cutoff && new Date(summary.startedAt).getTime() < cutoff) continue
    allEvents.push(...events)
    runSummaries.push(summary)
  }
  if (runSummaries.length === 0) {
    process.stdout.write("no runs in the requested window\n")
    return 0
  }
  const byExec = rollupByExecutable(allEvents)
  if (opts.asJson) {
    process.stdout.write(`${JSON.stringify({ runs: runSummaries, byExecutable: byExec }, null, 2)}\n`)
    return 0
  }
  printReport(runSummaries, byExec)
  return 0
}

function printReport(runs: RunSummary[], rollups: ExecutableRollup[]): void {
  const totalRuns = runs.length
  const okRuns = runs.filter((r) => r.ok).length
  const okPct = totalRuns > 0 ? ((okRuns / totalRuns) * 100).toFixed(1) : "—"
  const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b)
  const meanMs = durations.length > 0 ? durations.reduce((s, n) => s + n, 0) / durations.length : 0
  process.stdout.write(`\nKody run statistics — ${totalRuns} runs\n`)
  process.stdout.write(`  success rate     : ${okRuns}/${totalRuns} (${okPct}%)\n`)
  process.stdout.write(`  mean wall-clock  : ${formatMs(meanMs)}\n`)
  process.stdout.write(`  p50 wall-clock   : ${formatMs(percentile(durations, 50))}\n`)
  process.stdout.write(`  p95 wall-clock   : ${formatMs(percentile(durations, 95))}\n`)
  const totalIn = runs.reduce((s, r) => s + r.totalInputTokens, 0)
  const totalOut = runs.reduce((s, r) => s + r.totalOutputTokens, 0)
  const totalCacheR = runs.reduce((s, r) => s + r.totalCacheReadTokens, 0)
  process.stdout.write(`  total tokens     : ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out / ${totalCacheR.toLocaleString()} cache-read\n`)

  process.stdout.write(`\nPer-executable (stage_end events)\n`)
  const headers = ["executable", "runs", "ok", "failed", "p50", "p95", "mean", "tok-in", "tok-out", "cache-r"]
  const widths = [22, 6, 6, 7, 9, 9, 9, 10, 10, 10]
  process.stdout.write(headers.map((h, i) => h.padEnd(widths[i]!)).join("") + "\n")
  process.stdout.write(widths.map((w) => "-".repeat(w - 1) + " ").join("") + "\n")
  for (const r of rollups) {
    const row = [
      r.executable,
      String(r.runs),
      String(r.ok),
      String(r.failed),
      formatMs(r.p50Ms),
      formatMs(r.p95Ms),
      formatMs(r.meanMs),
      r.totalInputTokens.toLocaleString(),
      r.totalOutputTokens.toLocaleString(),
      r.totalCacheReadTokens.toLocaleString(),
    ]
    process.stdout.write(row.map((c, i) => c.padEnd(widths[i]!)).join("") + "\n")
  }
  process.stdout.write("\n")
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  return `${(minutes / 60).toFixed(2)}h`
}
