/**
 * Job — the unified execution unit (Phase 1: additive seam, no caller yet).
 *
 * `runJob` lowers a validated Job onto the existing executor
 * (`runAgentActionChain`). This is the single entry point every trigger path
 * (comment, cron, manual) will funnel through in later phases. It deliberately
 * does NOT touch executor.ts — a Job maps to a (profileName, ExecutorInput) pair.
 *
 * Validation is hand-rolled: the project keeps runtime deps minimal (no zod)
 * and validates at boundaries the same way config.ts does.
 */

import * as path from "node:path"
import type { Job, JobFlavor } from "./agent-actions/types.js"
import type { KodyConfig } from "./config.js"
import type { DispatchResult } from "./dispatch.js"
import type { ExecutorInput, ExecutorOutput } from "./executor.js"
import { runAgentAction, runAgentActionChain } from "./executor.js"
import { resolveAgentResponsibilityAction, resolveAgentResponsibilityFolder } from "./registry.js"

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
 * Validate a minted Job at the boundary. A Job must name a agentResponsibility/action, a
 * known `flavor`, and (if present) an object `cliArgs`. `agentAction` is only
 * an implementation selected under that agentResponsibility; it is never valid by itself.
 * `why` is untrusted free text and is NOT content-checked here — fencing
 * happens where it enters a prompt.
 */
export function validateJob(input: unknown): Job {
  if (!input || typeof input !== "object") {
    throw new InvalidJobError("job must be an object")
  }
  const j = input as Record<string, unknown>
  if (typeof j.agentResponsibility !== "string" && typeof j.action !== "string") {
    throw new InvalidJobError("job must reference a agentResponsibility action or agentResponsibility")
  }
  if (j.flavor !== "instant" && j.flavor !== "scheduled") {
    throw new InvalidJobError(`job.flavor must be "instant" or "scheduled" (got ${String(j.flavor)})`)
  }
  if (j.cliArgs !== undefined && (typeof j.cliArgs !== "object" || j.cliArgs === null)) {
    throw new InvalidJobError("job.cliArgs must be an object when present")
  }
  return {
    action: typeof j.action === "string" ? j.action : undefined,
    agentAction: typeof j.agentAction === "string" ? j.agentAction : undefined,
    agentResponsibility: typeof j.agentResponsibility === "string" ? j.agentResponsibility : undefined,
    why: typeof j.why === "string" ? j.why : undefined,
    agent: typeof j.agent === "string" ? j.agent : undefined,
    schedule: typeof j.schedule === "string" ? j.schedule : undefined,
    target: typeof j.target === "number" ? j.target : undefined,
    cliArgs: (j.cliArgs as Record<string, unknown> | undefined) ?? {},
    flavor: j.flavor,
    force: j.force === true,
    saveReport: j.saveReport === true,
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
   * Follow in-process stage hand-offs (`runAgentActionChain`) — the default,
   * matching the comment/manual route. Set `false` for the cron tick path,
   * which fans out one-shot ticks via `runAgentAction` (no chaining), so the
   * scheduler's per-agentResponsibility invocation stays byte-identical to its prior call.
   */
  chain?: boolean
}

/**
 * Execute a Job by lowering it onto the existing executor.
 *
 * Mapping:
 *   - agentResponsibility/action resolves first             (the public work unit / "why")
 *   - profile = job.agentAction ?? agentResponsibility.agentAction (the implementation / "how")
 *   - cliArgs = job.cliArgs                   (target already bound by the minter)
 *   - agentResponsibility/agentAction → preloadedData          (seeded so the executor can
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
  const action = valid.action ?? valid.agentResponsibility
  const projectAgentResponsibilitiesRoot = path.join(base.cwd, ".kody", "agent-responsibilities")
  const resolvedAgentResponsibility = action
    ? resolveAgentResponsibilityAction(action, projectAgentResponsibilitiesRoot)
    : null
  const agentResponsibilityIdentity = valid.agentResponsibility ?? resolvedAgentResponsibility?.agentResponsibility
  const agentResponsibilityContext = loadAgentResponsibilityContext(agentResponsibilityIdentity, base.cwd)
  const explicitAgentActionOnly =
    valid.agentAction !== undefined &&
    (valid.action === undefined || valid.action === valid.agentAction) &&
    (valid.agentResponsibility === undefined || valid.agentResponsibility === valid.agentAction)
  if (!resolvedAgentResponsibility && !agentResponsibilityContext && !explicitAgentActionOnly) {
    throw new InvalidJobError(`job agentResponsibility not found: ${action ?? valid.agentResponsibility ?? "<none>"}`)
  }
  const agentResponsibilitySelectedAgentAction =
    resolvedAgentResponsibility?.agentAction ??
    agentResponsibilityContext?.config.agentAction ??
    agentResponsibilityContext?.config.agentActions?.[0] ??
    (agentResponsibilityContext?.config.tickScript ? "agent-responsibility-tick-scripted" : undefined)
  const profileName = valid.agentAction ?? agentResponsibilitySelectedAgentAction
  if (!profileName) {
    throw new InvalidJobError(
      `job agentResponsibility resolves to no agentAction: ${agentResponsibilityIdentity ?? action}`,
    )
  }

  const preloadedData: Record<string, unknown> = { ...(base.preloadedData ?? {}) }
  // Stamp both identities: jobKey is stable required work on the task; jobId is
  // this execution attempt.
  preloadedData.jobId = newJobId(valid.flavor)
  preloadedData.jobKey = stableJobKey(valid)
  preloadedData.jobFlavor = valid.flavor
  if (valid.target !== undefined) preloadedData.jobTarget = valid.target
  if (valid.action !== undefined && valid.action.length > 0) preloadedData.jobAction = valid.action
  if (agentResponsibilityIdentity !== undefined && agentResponsibilityIdentity.length > 0)
    preloadedData.jobAgentResponsibility = agentResponsibilityIdentity
  const executableIdentity = profileName
  if (executableIdentity !== undefined && executableIdentity.length > 0)
    preloadedData.jobAgentAction = executableIdentity
  // The job carries *when*: a scheduled job's cadence, recorded in the ledger.
  if (valid.schedule !== undefined && valid.schedule.length > 0) preloadedData.jobSchedule = valid.schedule
  if (valid.saveReport === true) preloadedData.jobSaveReport = true
  if (agentResponsibilityContext) {
    preloadedData.agentResponsibilitySlug = agentResponsibilityContext.slug
    preloadedData.agentResponsibilityTitle = agentResponsibilityContext.title
    preloadedData.dutyIntent = agentResponsibilityContext.body
    preloadedData.jobIntent = agentResponsibilityContext.body
    if (preloadedData.jobAgentResponsibility === undefined)
      preloadedData.jobAgentResponsibility = agentResponsibilityContext.slug
    if (agentResponsibilityContext.config.agent && preloadedData.jobAgent === undefined) {
      preloadedData.jobAgent = agentResponsibilityContext.config.agent
    }
    if (agentResponsibilityContext.config.mentions && agentResponsibilityContext.config.mentions.length > 0) {
      preloadedData.mentions = agentResponsibilityContext.config.mentions.map((login: string) => `@${login}`).join(" ")
    }
  }
  // Inline why → ctx.data.jobWhy (NOT jobIntent — that token is the scheduled
  // agentResponsibility BODY, consumed via {{jobIntent}} by agent-responsibility-tick; reusing it would
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
  const shouldApplyResolvedAgentResponsibilityArgs =
    valid.agentAction === undefined &&
    resolvedAgentResponsibility &&
    profileName === resolvedAgentResponsibility.agentAction
  input.cliArgs = shouldApplyResolvedAgentResponsibilityArgs
    ? { ...resolvedAgentResponsibility.cliArgs, ...input.cliArgs }
    : input.cliArgs

  const run = base.chain === false ? runAgentAction : runAgentActionChain
  return run(profileName, input)
}

function loadAgentResponsibilityContext(
  slug: string | undefined,
  cwd: string,
): ReturnType<typeof resolveAgentResponsibilityFolder> {
  if (!slug) return null
  return resolveAgentResponsibilityFolder(slug, path.join(cwd, ".kody", "agent-responsibilities"))
}

// ────────────────────────────────────────────────────────────────────────────
// Minters (phase 2): event → Job. Pure mappers, no caller yet — the comment
// and cron paths funnel through these in a later phase, then `runJob` runs the
// result.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mint an INSTANT job from a comment / manual-dispatch route. The trigger
 * resolves to a DispatchResult (agentAction + cliArgs + target); this turns it
 * into a Job. `why` is the operator's free-text request after `@kody <command>`
 * (carried on the DispatchResult); `agent` defaults to "kody" — instant verbs
 * ran agent-less before, and the default is the agreed starting point.
 * Both are overridable per call via `opts`.
 */
export function mintInstantJob(dispatch: DispatchResult, opts?: { why?: string; agent?: string }): Job {
  return {
    action: dispatch.action,
    agentAction: dispatch.agentAction,
    agentResponsibility: dispatch.agentResponsibility,
    why: opts?.why ?? dispatch.why,
    agent: opts?.agent ?? DEFAULT_INSTANT_AGENT,
    target: dispatch.target,
    cliArgs: dispatch.cliArgs,
    flavor: "instant",
  }
}

/** Inputs the cron tick path resolves per due agentResponsibility slug. */
export interface ScheduledJobInput {
  /** Public action for this scheduled agentResponsibility, when distinct from the slug. */
  action?: string
  /** The agentResponsibility slug (its "why" lives in `.kody/agent-responsibilities/<slug>/agent-responsibility.md`). */
  agentResponsibility: string
  /** The agentAction that ticks it (agent-responsibility-tick / agent-responsibility-tick-scripted, or a folder-agentResponsibility slug). */
  agentAction: string
  /** Cron cadence the agentResponsibility fired on. */
  schedule?: string
  /** Agent identity that runs it (from the agentResponsibility's profile.json). */
  agent?: string
  /** Args handed to the tick agentAction (e.g. `{ job: slug }` for `.md` agentResponsibilities). */
  cliArgs?: Record<string, unknown>
  /** Save this run's final output as reports/<agentResponsibility>.md. */
  saveReport?: boolean
}

/**
 * Mint a SCHEDULED job from a due agentResponsibility slug. The cron path enumerates due
 * agentResponsibilities; each becomes a scheduled Job whose `agentAction` is the ticker and
 * whose `agentResponsibility` carries the intent. No caller yet — wired in a later phase.
 */
export function mintScheduledJob(input: ScheduledJobInput): Job {
  return {
    action: input.action,
    agentResponsibility: input.agentResponsibility,
    agentAction: input.agentAction,
    schedule: input.schedule,
    agent: input.agent,
    cliArgs: input.cliArgs ?? {},
    flavor: "scheduled",
    saveReport: input.saveReport === true,
  }
}
