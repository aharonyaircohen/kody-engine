/**
 * Structured run event log (Phase 0 instrumentation).
 *
 * Each top-level `runAgentAction` invocation emits a stream of events to
 * `.kody/agent-runs/<runId>/events.jsonl`, capturing stage durations, preflight
 * and postflight timings, and agent invocation details. Children of a
 * container inherit the run ID via the `KODY_RUN_ID` env var, so one
 * task produces one events file regardless of how many child agentActions
 * fire.
 *
 * The emitter is best-effort: any IO failure is swallowed. The reader is
 * used by `kody stats` to produce success-rate and latency rollups.
 *
 * Set `KODY_EVENTS=0` to disable emission entirely.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export type EventKind =
  | "stage_start"
  | "stage_end"
  | "preflight"
  | "postflight"
  | "agent_start"
  | "agent_end"
  | "container_child"
  | "error"

export interface RunEvent {
  ts: string
  runId: string
  agentAction: string
  kind: EventKind
  /** Script name for preflight/postflight, child name for container_child. */
  name?: string
  /** Wall-clock duration of the event window, in milliseconds. */
  durationMs?: number
  /** Coarse outcome for events that have one. */
  outcome?: "ok" | "failed" | "skipped"
  /** Free-form, JSON-serialisable. Used for tokens, exit codes, reasons. */
  meta?: Record<string, unknown>
}

let cachedRunId: string | null = null

/**
 * Resolve a stable run ID. Containers set `KODY_RUN_ID` before invoking
 * children so every child of one task shares the same ID. If not set,
 * fall back to the GitHub Actions run identifier (so consumer-repo runs
 * are correlatable across workflow re-runs) and finally to a random ID.
 */
export function resolveRunId(): string {
  if (cachedRunId) return cachedRunId
  if (process.env.KODY_RUN_ID) {
    cachedRunId = process.env.KODY_RUN_ID
    return cachedRunId
  }
  if (process.env.GITHUB_RUN_ID) {
    const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1"
    cachedRunId = `gh-${process.env.GITHUB_RUN_ID}-${attempt}`
  } else {
    cachedRunId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`
  }
  // Propagate to children spawned via env-inheriting subprocesses (shell
  // entries) and to in-process container children that re-call resolveRunId.
  process.env.KODY_RUN_ID = cachedRunId
  return cachedRunId
}

/** Test seam: reset the module-level cache between runs. */
export function __resetRunIdCache(): void {
  cachedRunId = null
  delete process.env.KODY_RUN_ID
}

/**
 * Append one structured event to the per-run NDJSON log. Best-effort:
 * failures never propagate. No-op when `KODY_EVENTS=0`.
 */
export function emitEvent(cwd: string, ev: Omit<RunEvent, "ts" | "runId">): void {
  if (process.env.KODY_EVENTS === "0") return
  try {
    const runId = resolveRunId()
    const fullEvent: RunEvent = {
      ts: new Date().toISOString(),
      runId,
      ...ev,
    }
    const eventsPath = path.join(cwd, ".kody", "agent-runs", runId, "events.jsonl")
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true })
    fs.appendFileSync(eventsPath, `${JSON.stringify(fullEvent)}\n`)
  } catch {
    /* best effort — instrumentation must never break a run */
  }
}

/** Read all events for one run ID. Returns [] if the log does not exist. */
export function readEvents(cwd: string, runId: string): RunEvent[] {
  const eventsPath = path.join(cwd, ".kody", "agent-runs", runId, "events.jsonl")
  if (!fs.existsSync(eventsPath)) return []
  const lines = fs.readFileSync(eventsPath, "utf-8").split("\n")
  const out: RunEvent[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as RunEvent)
    } catch {
      /* skip malformed lines */
    }
  }
  return out
}

/** List every run ID present under `.kody/agent-runs/`, sorted lexicographically. */
export function listRuns(cwd: string): string[] {
  const runsDir = path.join(cwd, ".kody", "agent-runs")
  if (!fs.existsSync(runsDir)) return []
  return fs
    .readdirSync(runsDir)
    .filter((name) => {
      try {
        return fs.statSync(path.join(runsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}
