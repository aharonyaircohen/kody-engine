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

import * as path from "node:path"
import type { KodyConfig } from "./config.js"
import type { DispatchResult } from "./dispatch.js"
import type { Job, JobFlavor } from "./executables/types.js"
import type { ExecutorInput, ExecutorOutput } from "./executor.js"
import { runExecutable, runExecutableChain } from "./executor.js"
import { resolveDutyAction, resolveDutyFolder } from "./registry.js"

export { stableJobKey } from "./jobIdentity.js"

import { stableJobKey } from "./jobIdentity.js"

/** Default agent identity for instant `@kody` jobs (the agreed starting point). */
export const DEFAULT_INSTANT_AGENT = "kody"
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
 * Validate a minted Job at the boundary. A Job must name a duty/action, a
 * known `flavor`, and (if present) an object `cliArgs`. `executable` is only
 * an implementation selected under that duty; it is never valid by itself.
 * `why` is untrusted free text and is NOT content-checked here — fencing
 * happens where it enters a prompt.
 */
export function validateJob(input: unknown): Job {
  if (!input || typeof input !== "object") {
    throw new InvalidJobError("job must be an object")
  }
  const j = input as Record<string, unknown>
  if (typeof j.duty !== "string" && typeof j.action !== "string") {
    throw new InvalidJobError("job must reference a duty action or duty")
  }
  if (j.flavor !== "instant" && j.flavor !== "scheduled") {
    throw new InvalidJobError(`job.flavor must be "instant" or "scheduled" (got ${String(j.flavor)})`)
  }
  if (j.cliArgs !== undefined && (typeof j.cliArgs !== "object" || j.cliArgs === null)) {
    throw new InvalidJobError("job.cliArgs must be an object when present")
  }
  return {
    action: typeof j.action === "string" ? j.action : undefined,
    executable: typeof j.executable === "string" ? j.executable : undefined,
    duty: typeof j.duty === "string" ? j.duty : undefined,
    why: typeof j.why === "string" ? j.why : undefined,
    agent: typeof j.agent === "string" ? j.agent : undefined,
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
  skipConfig?: boolean
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
 *   - duty/action resolves first             (the public work unit / "why")
 *   - profile = job.executable ?? duty.executable (the implementation / "how")
 *   - cliArgs = job.cliArgs                   (target already bound by the minter)
 *   - duty/executable → preloadedData          (seeded so the executor can
 *                                              expose the job references to
 *                                              the model generically)
 *   - inline why → preloadedData.jobWhy        (seeded into ctx.data before
 *                                              preflights; the executor injects
 *                                              it as a fenced operator-request
 *                                              block in the system prompt)
 *   - agent  → preloadedData.jobAgent
 *
 * No caller mints Jobs yet — this is the seam later phases wire the comment and
 * cron paths into.
 */
export async function runJob(job: Job, base: RunJobBase): Promise<ExecutorOutput> {
  const valid = validateJob(job)
  const action = valid.action ?? valid.duty
  const projectDutiesRoot = path.join(base.cwd, ".kody", "duties")
  const resolvedDuty = action ? resolveDutyAction(action, projectDutiesRoot) : null
  const dutyIdentity = valid.duty ?? resolvedDuty?.duty
  const dutyContext = loadDutyContext(dutyIdentity, base.cwd)
  const explicitExecutableOnly =
    valid.executable !== undefined &&
    (valid.action === undefined || valid.action === valid.executable) &&
    (valid.duty === undefined || valid.duty === valid.executable)
  if (!resolvedDuty && !dutyContext && !explicitExecutableOnly) {
    throw new InvalidJobError(`job duty not found: ${action ?? valid.duty ?? "<none>"}`)
  }
  const dutySelectedExecutable =
    resolvedDuty?.executable ??
    dutyContext?.config.executable ??
    dutyContext?.config.executables?.[0] ??
    (dutyContext?.config.tickScript ? "duty-tick-scripted" : undefined)
  const profileName = valid.executable ?? dutySelectedExecutable
  if (!profileName) {
    throw new InvalidJobError(`job duty resolves to no executable: ${dutyIdentity ?? action}`)
  }

  const preloadedData: Record<string, unknown> = { ...(base.preloadedData ?? {}) }
  // Stamp both identities: jobKey is stable required work on the task; jobId is
  // this execution attempt.
  preloadedData.jobId = newJobId(valid.flavor)
  preloadedData.jobKey = stableJobKey(valid)
  preloadedData.jobFlavor = valid.flavor
  if (valid.target !== undefined) preloadedData.jobTarget = valid.target
  if (valid.action !== undefined && valid.action.length > 0) preloadedData.jobAction = valid.action
  if (dutyIdentity !== undefined && dutyIdentity.length > 0) preloadedData.jobDuty = dutyIdentity
  const executableIdentity = profileName
  if (executableIdentity !== undefined && executableIdentity.length > 0)
    preloadedData.jobExecutable = executableIdentity
  // The job carries *when*: a scheduled job's cadence, recorded in the ledger.
  if (valid.schedule !== undefined && valid.schedule.length > 0) preloadedData.jobSchedule = valid.schedule
  if (dutyContext) {
    preloadedData.dutySlug = dutyContext.slug
    preloadedData.dutyTitle = dutyContext.title
    preloadedData.dutyIntent = dutyContext.body
    preloadedData.jobIntent = dutyContext.body
    if (preloadedData.jobDuty === undefined) preloadedData.jobDuty = dutyContext.slug
    if (dutyContext.config.agent && preloadedData.jobAgent === undefined) {
      preloadedData.jobAgent = dutyContext.config.agent
    }
    if (dutyContext.config.every && preloadedData.jobSchedule === undefined) {
      preloadedData.jobSchedule = dutyContext.config.every
    }
    if (dutyContext.config.mentions && dutyContext.config.mentions.length > 0) {
      preloadedData.mentions = dutyContext.config.mentions.map((login) => `@${login}`).join(" ")
    }
  }
  // Inline why → ctx.data.jobWhy (NOT jobIntent — that token is the scheduled
  // duty BODY, consumed via {{jobIntent}} by duty-tick; reusing it would
  // double-inject). The executor surfaces jobWhy to the agent as a fenced
  // "operator request" block, so the comment's wording shapes any instant run.
  if (valid.why !== undefined && valid.why.length > 0) preloadedData.jobWhy = valid.why
  if (valid.agent !== undefined) preloadedData.jobAgent = valid.agent

  const input: ExecutorInput = {
    cliArgs: { ...valid.cliArgs },
    cwd: base.cwd,
    config: base.config,
    skipConfig: base.skipConfig,
    verbose: base.verbose,
    quiet: base.quiet,
    preloadedData: Object.keys(preloadedData).length > 0 ? preloadedData : undefined,
  }
  const shouldApplyResolvedDutyArgs =
    valid.executable === undefined && resolvedDuty && profileName === resolvedDuty.executable
  input.cliArgs = shouldApplyResolvedDutyArgs ? { ...resolvedDuty.cliArgs, ...input.cliArgs } : input.cliArgs

  const run = base.chain === false ? runExecutable : runExecutableChain
  return run(profileName, input)
}

function loadDutyContext(slug: string | undefined, cwd: string): ReturnType<typeof resolveDutyFolder> {
  if (!slug) return null
  return resolveDutyFolder(slug, path.join(cwd, ".kody", "duties"))
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
 * (carried on the DispatchResult); `agent` defaults to "kody" — instant verbs
 * ran agent-less before, and the default is the agreed starting point.
 * Both are overridable per call via `opts`.
 */
export function mintInstantJob(dispatch: DispatchResult, opts?: { why?: string; agent?: string }): Job {
  return {
    action: dispatch.action,
    executable: dispatch.executable,
    duty: dispatch.duty,
    why: opts?.why ?? dispatch.why,
    agent: opts?.agent ?? DEFAULT_INSTANT_AGENT,
    target: dispatch.target,
    cliArgs: dispatch.cliArgs,
    flavor: "instant",
  }
}

/** Inputs the cron tick path resolves per due duty slug. */
export interface ScheduledJobInput {
  /** Public action for this scheduled duty, when distinct from the slug. */
  action?: string
  /** The duty slug (its "why" lives in `.kody/duties/<slug>/duty.md`). */
  duty: string
  /** The executable that ticks it (duty-tick / duty-tick-scripted, or a folder-duty slug). */
  executable: string
  /** Cron cadence the duty fired on. */
  schedule?: string
  /** Agent identity that runs it (from the duty's profile.json). */
  agent?: string
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
    action: input.action,
    duty: input.duty,
    executable: input.executable,
    schedule: input.schedule,
    agent: input.agent,
    cliArgs: input.cliArgs ?? {},
    flavor: "scheduled",
  }
}
