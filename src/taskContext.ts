/**
 * TaskContext — typed handoff payload for cross-stage context (Phase 2/B3b).
 *
 * Each stage of a multi-step task (research → plan → run → review → fix)
 * currently re-runs the same context-loading preflights independently:
 * loadIssueContext, loadConventions, loadPriorArt, loadMemoryContext,
 * loadCoverageRules. The data they produce is largely identical
 * across stages, but each stage pays the cost again and the agent has
 * no guarantee that "plan" and "run" saw the same issue body or memory
 * snapshot.
 *
 * TaskContext is the typed schema that captures that shared context.
 * The loadTaskContext preflight assembles it from the existing loaders'
 * ctx.data fields and persists it to `.kody/agent-runs/<runId>/task-context.json`
 * so:
 *   1. Future scripts have a typed read surface for context
 *      (vs. duck-typing ctx.data.* fields).
 *   2. The post-mortem includes a frozen snapshot of what every stage
 *      should have observed, so divergence between stages becomes
 *      debuggable.
 *   3. Phase 5 (single-process task run) can use this as the in-process
 *      handoff payload to skip redundant loaders.
 *
 * This file defines the schema only. The loadTaskContext preflight is
 * in src/scripts/loadTaskContext.ts. Profile migration is opt-in and
 * lands in follow-up PRs.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { TestRequirement } from "./config.js"
import type { IssueData } from "./issue.js"
import type { LoadedConvention } from "./prompt.js"

/** Bump when the schema changes incompatibly. Readers reject mismatched versions. */
export const TASK_CONTEXT_SCHEMA_VERSION = 1 as const

export interface TaskContext {
  schemaVersion: typeof TASK_CONTEXT_SCHEMA_VERSION
  /** ISO timestamp when this context was assembled. */
  builtAt: string
  /** runId from src/events.ts — ties this context to a specific task run. */
  runId: string
  /** Optional issue snapshot. Present for run/fix-type agentActions. */
  issue?: IssueData & {
    /** Pre-formatted comment block used by composePrompt. */
    commentsFormatted: string
    /** Pre-formatted labels block. */
    labelsFormatted: string
  }
  /** CLAUDE.md / AGENTS.md content, in load order. */
  conventions: LoadedConvention[]
  /** Markdown block of prior-art PR diffs + reviews; empty string if none. */
  priorArt: string
  /** Memory wiki excerpt; empty string if no .kody/memory/ in repo. */
  memoryContext: string
  /** Test coverage rules from kody.config.json testRequirements. */
  coverageRules: TestRequirement[]
}

/**
 * Build a TaskContext from existing ctx.data fields. Tolerant of missing
 * fields — each stage opts in to whatever loaders it needs, and this
 * function just captures whatever is present.
 */
export function buildTaskContext(args: {
  runId: string
  issue?: TaskContext["issue"]
  conventions?: LoadedConvention[]
  priorArt?: string
  memoryContext?: string
  coverageRules?: TestRequirement[]
}): TaskContext {
  return {
    schemaVersion: TASK_CONTEXT_SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    runId: args.runId,
    issue: args.issue,
    conventions: args.conventions ?? [],
    priorArt: args.priorArt ?? "",
    memoryContext: args.memoryContext ?? "",
    coverageRules: args.coverageRules ?? [],
  }
}

/**
 * Persist a TaskContext to `.kody/agent-runs/<runId>/task-context.json`. Best
 * effort: failures are logged to stderr but never throw so the
 * preflight does not block the agent.
 */
export function persistTaskContext(cwd: string, ctx: TaskContext): string | null {
  try {
    const dir = path.join(cwd, ".kody", "agent-runs", ctx.runId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "task-context.json")
    fs.writeFileSync(file, `${JSON.stringify(ctx, null, 2)}\n`)
    return file
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody taskContext] persist failed: ${msg}\n`)
    return null
  }
}

/**
 * Read a previously persisted TaskContext. Returns null on missing or
 * schema mismatch — callers should fall back to fresh loaders.
 */
export function readTaskContext(cwd: string, runId: string): TaskContext | null {
  const file = path.join(cwd, ".kody", "agent-runs", runId, "task-context.json")
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as TaskContext
    if (parsed.schemaVersion !== TASK_CONTEXT_SCHEMA_VERSION) return null
    return parsed
  } catch {
    return null
  }
}
