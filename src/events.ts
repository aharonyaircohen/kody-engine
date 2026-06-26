/**
 * Structured run event log.
 *
 * Run events are local runtime scratch, not product repo state. They live under
 * KODY_RUNTIME_DIR, or the OS temp directory by default, so consumer repos do
 * not accumulate repo-local agent-run files.
 */
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { runtimeStatePath } from "./runtimePaths.js"

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
  executable: string
  kind: EventKind
  /** Script name for preflight/postflight, child name for container_child. */
  name?: string
  /** Wall-clock duration for the event window, in milliseconds. */
  durationMs?: number
  /** Coarse outcome for events that have one. */
  outcome?: "ok" | "failed" | "skipped"
  /** Free-form JSON-serialisable details. */
  meta?: Record<string, unknown>
}

let cachedRunId: string | null = null

export function resolveRunId(): string {
  if (process.env.KODY_RUN_ID) {
    cachedRunId = process.env.KODY_RUN_ID
    return cachedRunId
  }
  if (cachedRunId) return cachedRunId
  if (process.env.GITHUB_RUN_ID) {
    const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1"
    cachedRunId = `gh-${process.env.GITHUB_RUN_ID}-${attempt}`
  } else {
    cachedRunId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`
  }
  process.env.KODY_RUN_ID = cachedRunId
  return cachedRunId
}

/** Test seam: reset module-level run ID cache. */
export function __resetRunIdCache(): void {
  cachedRunId = null
  delete process.env.KODY_RUN_ID
}

function eventsPath(cwd: string, runId: string): string {
  return runtimeStatePath(cwd, "agent-runs", runId, "events.jsonl")
}

/** Append one structured event. Best-effort; failures never propagate. */
export function emitEvent(cwd: string, ev: Omit<RunEvent, "ts" | "runId">): void {
  if (process.env.KODY_EVENTS === "0") return
  try {
    const runId = resolveRunId()
    const fullEvent: RunEvent = {
      ts: new Date().toISOString(),
      runId,
      ...ev,
    }
    const file = eventsPath(cwd, runId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(fullEvent)}\n`)
  } catch {
    /* instrumentation must never break a run */
  }
}

/** Read all events for one run ID. Returns [] when the log does not exist. */
export function readEvents(cwd: string, runId: string): RunEvent[] {
  const file = eventsPath(cwd, runId)
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, "utf-8").split("\n")
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

/** List every run ID present in runtime scratch, sorted lexicographically. */
export function listRuns(cwd: string): string[] {
  const runsDir = runtimeStatePath(cwd, "agent-runs")
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
