/**
 * Job — the unified execution unit (Phase 1: additive seam, no caller yet).
 *
 * `runJob` lowers a validated Job onto the existing executor
 * (`runExecutableChain`). This is the single entry point every trigger path
 * (comment, cron, manual) will funnel through in later phases. It deliberately
 * does NOT touch executor.ts — a Job maps to a (profileName, ExecutorInput) pair.
 *
 * Validation is hand-rolled: the project keeps runtime deps minimal (no zod)
 * and validates at boundaries the same way config.ts does.
 */

import type { KodyConfig } from "./config.js"
import type { DispatchResult } from "./dispatch.js"
import type { Job, JobFlavor } from "./executables/types.js"
import type { ExecutorInput, ExecutorOutput } from "./executor.js"
import { runExecutable, runExecutableChain } from "./executor.js"

export { stableJobKey } from "./jobIdentity.js"

import { stableJobKey } from "./jobIdentity.js"

/** Default staff persona for instant `@kody` jobs (the agreed starting point). */
export const DEFAULT_INSTANT_PERSONA = "kody"
let localJobSeq = 0

/**
 * Stable id for one run attempt, recorded under the task job. In GitHub Actions
 * the workflow run (id + attempt) is the natural attempt id; a local sequence
 * keeps multiple in-process child jobs distinct inside the same workflow run.
 * Off-CI, fall back to a flavor + timestamp stamp plus the same counter.
 */
export function newJobId(flavor: JobFlavor): string {
  localJobSeq += 1
  const runId = process.env.GITHUB_RUN_ID
  if (runId) return `gh-${runId}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}-${localJobSeq}`
  return `${flavor}-${Date.now()}-${localJobSeq}`
}

/** Thrown when a minted Job fails boundary validation. */
export class InvalidJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidJobError"
  }
}

/**
 * Validate a minted Job at the boundary. A Job must name at least one of
 * `executable` or `duty` (something to run), a known `flavor`, and (if present)
 * an object `cliArgs`. `why` is untrusted free text and is NOT content-checked
 * here — fencing happens where it enters a prompt.
 */
export function validateJob(input: unknown): Job {
  if (!input || typeof input !== "object") {
    throw new InvalidJobError("job must be an object")
  }
  const j = input as Record<string, unknown>
  if (typeof j.executable !== "string" && typeof j.duty !== "string") {
    throw new InvalidJobError("job must reference an executable or a duty")
  }
  if (j.flavor !== "instant" && j.flavor !== "scheduled") {
    throw new InvalidJobError(`job.flavor must be "instant" or "scheduled" (got ${String(j.flavor)})`)
  }
  if (j.cliArgs !== undefined && (typeof j.cliArgs !== "object" || j.cliArgs === null)) {
    throw new InvalidJobError("job.cliArgs must be an object when present")
  }
  return {
    executable: typeof j.executable === "string" ? j.executable : undefined,
    duty: typeof j.duty === "string" ? j.duty : undefined,
    why: typeof j.why === "string" ? j.why : undefined,
    persona: typeof j.persona === "string" ? j.persona : undefined,
    schedule: typeof j.schedule === "string" ? j.schedule : undefined,
    target: typeof j.target === "number" ? j.target : undefined,
    cliArgs: (j.cliArgs as Record<string, unknown> | undefined) ?? {},
    flavor: j.flavor,
    force: j.force === true,
  }
}

/** Ambient inputs the executor needs that don't belong to the Job itself. */
export interface RunJobBase {
  cwd: string
  config?: KodyConfig
  verbose?: boolean
  quiet?: boolean
  preloadedData?: Record<string, unknown>
  /**
   * Follow in-process stage hand-offs (`runExecutableChain`) — the default,
   * matching the comment/manual route. Set `false` for the cron tick path,
   * which fans out one-shot ticks via `runExecutable` (no chaining), so the
   * scheduler's per-duty invocation stays byte-identical to its prior call.
   */
  chain?: boolean
}

/**
 * Execute a Job by lowering it onto the existing executor.
 *
 * Mapping:
 *   - profile = job.executable ?? job.duty   (the runner / "how")
 *   - cliArgs = job.cliArgs                   (target already bound by the minter)
 *   - duty/executable → preloadedData          (seeded so the executor can
 *                                              expose the job references to
 *                                              the model generically)
 *   - inline why → preloadedData.jobWhy        (seeded into ctx.data before
 *                                              preflights; the executor injects
 *                                              it as a fenced operator-request
 *                                              block in the system prompt)
 *   - persona  → preloadedData.jobPersona
 *
 * No caller mints Jobs yet — this is the seam later phases wire the comment and
 * cron paths into.
 */
export async function runJob(job: Job, base: RunJobBase): Promise<ExecutorOutput> {
  const valid = validateJob(job)
  const profileName = valid.executable ?? valid.duty
  if (!profileName) {
    throw new InvalidJobError("job resolves to no executable or duty")
  }

  const preloadedData: Record<string, unknown> = { ...(base.preloadedData ?? {}) }
  // Stamp both identities: jobKey is stable required work on the task; jobId is
  // this execution attempt.
  preloadedData.jobId = newJobId(valid.flavor)
  preloadedData.jobKey = stableJobKey(valid)
  preloadedData.jobFlavor = valid.flavor
  if (valid.target !== undefined) preloadedData.jobTarget = valid.target
  if (valid.duty !== undefined && valid.duty.length > 0) preloadedData.jobDuty = valid.duty
  if (valid.executable !== undefined && valid.executable.length > 0) preloadedData.jobExecutable = valid.executable
  // The job carries *when*: a scheduled job's cadence, recorded in the ledger.
  if (valid.schedule !== undefined && valid.schedule.length > 0) preloadedData.jobSchedule = valid.schedule
  // Inline why → ctx.data.jobWhy (NOT jobIntent — that token is the scheduled
  // duty BODY, consumed via {{jobIntent}} by duty-tick; reusing it would
  // double-inject). The executor surfaces jobWhy to the agent as a fenced
  // "operator request" block, so the comment's wording shapes any instant run.
  if (valid.why !== undefined && valid.why.length > 0) preloadedData.jobWhy = valid.why
  if (valid.persona !== undefined) preloadedData.jobPersona = valid.persona

  const input: ExecutorInput = {
    cliArgs: { ...valid.cliArgs },
    cwd: base.cwd,
    config: base.config,
    verbose: base.verbose,
    quiet: base.quiet,
    preloadedData: Object.keys(preloadedData).length > 0 ? preloadedData : undefined,
  }

  const run = base.chain === false ? runExecutable : runExecutableChain
  return run(profileName, input)
}

// ────────────────────────────────────────────────────────────────────────────
// Minters (phase 2): event → Job. Pure mappers, no caller yet — the comment
// and cron paths funnel through these in a later phase, then `runJob` runs the
// result.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mint an INSTANT job from a comment / manual-dispatch route. The trigger
 * resolves to a DispatchResult (executable + cliArgs + target); this turns it
 * into a Job. `why` is the operator's free-text request after `@kody <command>`
 * (carried on the DispatchResult); `persona` defaults to "kody" — instant verbs
 * ran persona-less before, and the default is the agreed starting point.
 * Both are overridable per call via `opts`.
 */
export function mintInstantJob(dispatch: DispatchResult, opts?: { why?: string; persona?: string }): Job {
  return {
    executable: dispatch.executable,
    why: opts?.why ?? dispatch.why,
    persona: opts?.persona ?? DEFAULT_INSTANT_PERSONA,
    target: dispatch.target,
    cliArgs: dispatch.cliArgs,
    flavor: "instant",
  }
}

/** Inputs the cron tick path resolves per due duty slug. */
export interface ScheduledJobInput {
  /** The duty slug (its "why" lives in `.kody/duties/<slug>.md`). */
  duty: string
  /** The executable that ticks it (duty-tick / duty-tick-scripted, or a folder-duty slug). */
  executable: string
  /** Cron cadence the duty fired on. */
  schedule?: string
  /** Staff persona that runs it (from the duty's `staff:` frontmatter). */
  persona?: string
  /** Args handed to the tick executable (e.g. `{ job: slug }` for `.md` duties). */
  cliArgs?: Record<string, unknown>
}

/**
 * Mint a SCHEDULED job from a due duty slug. The cron path enumerates due
 * duties; each becomes a scheduled Job whose `executable` is the ticker and
 * whose `duty` carries the intent. No caller yet — wired in a later phase.
 */
export function mintScheduledJob(input: ScheduledJobInput): Job {
  return {
    duty: input.duty,
    executable: input.executable,
    schedule: input.schedule,
    persona: input.persona,
    cliArgs: input.cliArgs ?? {},
    flavor: "scheduled",
  }
}
