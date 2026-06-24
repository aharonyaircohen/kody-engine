/**
 * One-shot maintenance: scan all kody:done / kody:failed issues on a target
 * repo and fix state-mirror comments whose header is frozen at an
 * intermediate phase (the bug fixed in v0.4.55). Re-renders the mirror with
 * phase=shipped/failed + status=succeeded/failed so the comment matches the
 * actual flow outcome.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-state-mirrors.ts <owner>/<repo> [--dry-run]
 *
 * Requires the gh CLI to be authenticated for the target repo.
 */

import { execFileSync } from "node:child_process"
import { readTaskState, writeTaskState } from "../src/state.js"

/**
 * Probe whether issue #N actually has a kody state-mirror comment. Returns
 * false for issues that never went through kody (or whose flow didn't write
 * a mirror). Avoids creating spurious new mirrors on terminal-labelled
 * issues that have no prior state.
 */
function hasStateComment(number: number): boolean {
  try {
    const out = execFileSync(
      "gh",
      ["issue", "view", String(number), "-R", REPO!, "--json", "comments"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    )
    const parsed = JSON.parse(out) as { comments: { body: string }[] }
    return parsed.comments.some((c) => c.body.includes("kody:state:v1:begin"))
  } catch {
    return false
  }
}

interface IssueRef {
  number: number
  labels: string[]
  state: "OPEN" | "CLOSED"
}

const REPO = process.argv[2]
const DRY_RUN = process.argv.includes("--dry-run")

if (!REPO || !REPO.includes("/")) {
  process.stderr.write("usage: backfill-state-mirrors.ts <owner>/<repo> [--dry-run]\n")
  process.exit(64)
}

// state.ts's gh helper uses `{owner}/{repo}` placeholders that gh resolves
// from the cwd's git config. Set GH_REPO so gh's CLI substitutes the target
// repo without needing a local clone of it.
process.env.GH_REPO = REPO

function listIssues(label: string): IssueRef[] {
  const json = execFileSync(
    "gh",
    ["issue", "list", "-R", REPO!, "--label", label, "--state", "all", "--limit", "300", "--json", "number,labels,state"],
    { encoding: "utf-8" },
  )
  type RawIssue = { number: number; labels: { name: string }[]; state: string }
  const parsed = JSON.parse(json) as RawIssue[]
  return parsed.map((i) => ({
    number: i.number,
    labels: i.labels.map((l) => l.name),
    state: i.state as "OPEN" | "CLOSED",
  }))
}

function expectedTerminal(labels: string[]): { phase: "shipped" | "failed"; status: "succeeded" | "failed" } | null {
  if (labels.includes("kody:done")) return { phase: "shipped", status: "succeeded" }
  if (labels.includes("kody:failed")) return { phase: "failed", status: "failed" }
  return null
}

function main(): void {
  const done = listIssues("kody:done")
  const failed = listIssues("kody:failed")
  const all = [...done, ...failed]
  // de-dupe — issues with both labels (shouldn't happen but be safe)
  const seen = new Set<number>()
  const candidates = all.filter((i) => {
    if (seen.has(i.number)) return false
    seen.add(i.number)
    return true
  })

  process.stdout.write(`Found ${candidates.length} terminal issues (${done.length} done + ${failed.length} failed).\n`)
  process.stdout.write(`Mode: ${DRY_RUN ? "DRY-RUN" : "WRITE"}\n\n`)

  let stale = 0
  let patched = 0
  let skipped = 0
  let errors = 0

  for (const issue of candidates) {
    if (!hasStateComment(issue.number)) {
      skipped++
      continue
    }
    let state: ReturnType<typeof readTaskState>
    try {
      state = readTaskState("issue", issue.number)
    } catch (err) {
      process.stderr.write(`#${issue.number}: read failed — ${err instanceof Error ? err.message : String(err)}\n`)
      errors++
      continue
    }
    // Only patch mirrors that are actually stale — `running` always is,
    // `pending` is the empty-state default so we skip it here even when a
    // comment exists (likely a flow that bailed before the first writeTaskState).
    const isStale = state.core.status === "running"
    if (!isStale) {
      skipped++
      continue
    }
    stale++
    const terminal = expectedTerminal(issue.labels)
    if (!terminal) {
      process.stderr.write(`#${issue.number}: no terminal label, skipping\n`)
      continue
    }
    const oldPhase = state.core.phase
    const oldStatus = state.core.status
    state.core.phase = terminal.phase
    state.core.status = terminal.status
    state.core.currentAgentAction = null
    process.stdout.write(
      `#${issue.number}: ${oldPhase}/${oldStatus} → ${terminal.phase}/${terminal.status}\n`,
    )
    if (DRY_RUN) continue
    try {
      writeTaskState("issue", issue.number, state)
      patched++
    } catch (err) {
      process.stderr.write(`  write failed: ${err instanceof Error ? err.message : String(err)}\n`)
      errors++
    }
  }

  process.stdout.write(`\nSummary: stale=${stale} patched=${patched} skipped=${skipped} errors=${errors}\n`)
}

main()
