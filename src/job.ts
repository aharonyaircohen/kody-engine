/**
 * Job — the unified execution unit (Phase 1: additive seam, no caller yet).
 *
 * `runJob` lowers a validated Job onto the existing implementation runner
 * (`runImplementationChain`). This is the single entry point every trigger path
 * (comment, cron, manual) will funnel through in later phases. It deliberately
 * does NOT touch executor.ts — a Job maps to a (profileName, ExecutorInput) pair.
 *
 * Validation is hand-rolled: the project keeps runtime deps minimal (no zod)
 * and validates at boundaries the same way config.ts does.
 */

import { evaluateAgencyBoundaries } from "./agencyBoundaryEval.js"
import type {
  CapabilityFolder,
  CapabilityWorkflowConfig,
  CapabilityWorkflowStepConfig,
  CapabilityWorkflowTransitionConfig,
} from "./capabilityFolders.js"
import { capabilityOutputConditionPaths } from "./capabilityFolders.js"
import type { CapabilityResult } from "./capabilityResult.js"
import { type KodyConfig, loadConfig } from "./config.js"
import { capabilitiesRoot } from "./definition-paths.js"
import type { DispatchResult } from "./dispatch.js"
import type { ExecutorInput, ExecutorOutput } from "./executor.js"
import { runImplementation, runImplementationChain } from "./executor.js"
import type {
  CapabilityResultTarget,
  Job,
  JobFlavor,
  ReportPublicationConfig,
  WorkflowRunState,
} from "./implementations/types.js"
import {
  type DiscoveredCapabilityAction,
  getCapabilityActionInputs,
  resolveCapabilityAction,
  resolveCapabilityFolder,
} from "./registry.js"
import { type RunIndexRow, upsertRunIndexRowBestEffortAsync } from "./runIndex.js"
import { publishWorkflowReport } from "./scripts/publishReport.js"
import { resolveSimpleCapabilityRuntime, simpleCapabilityRuntimeArgs } from "./simpleCapabilityRuntime.js"
import type { Action } from "./state.js"
import { hasStateBackendConfig } from "./state-backend.js"
import {
  isWorkflowDefinitionId,
  readWorkflowDefinition,
  workflowDefinitionToCapabilityFolder,
} from "./workflowDefinitions.js"
import { parseWorkflowRunState, readWorkflowRunState, writeWorkflowRunState } from "./workflowRunState.js"
import { formatWorkflowValidationIssues, validateWorkflow } from "./workflowValidation.js"

export { stableJobKey } from "./jobIdentity.js"

import { stableJobKey, targetFromCliArgs } from "./jobIdentity.js"

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
 * Validate a minted Job at the boundary. A Job must name a capability/action, a
 * known `flavor`, and (if present) an object `cliArgs`. `implementation` is
 * selected under that capability; it is never valid by itself.
 * `why` is untrusted free text and is NOT content-checked here — fencing
 * happens where it enters a prompt.
 */
export function validateJob(input: unknown): Job {
  if (!input || typeof input !== "object") {
    throw new InvalidJobError("job must be an object")
  }
  const j = input as Record<string, unknown>
  if (typeof j.capability !== "string" && typeof j.action !== "string" && typeof j.workflow !== "string") {
    throw new InvalidJobError("job must reference a capability action, capability, or workflow")
  }
  if (j.flavor !== "instant" && j.flavor !== "scheduled") {
    throw new InvalidJobError(`job.flavor must be "instant" or "scheduled" (got ${String(j.flavor)})`)
  }
  if (j.cliArgs !== undefined && (typeof j.cliArgs !== "object" || j.cliArgs === null)) {
    throw new InvalidJobError("job.cliArgs must be an object when present")
  }
  if (j.delivery !== undefined && j.delivery !== "pull-request") {
    throw new InvalidJobError(`job.delivery must be "pull-request" (got ${String(j.delivery)})`)
  }
  return {
    action: typeof j.action === "string" ? j.action : undefined,
    implementation: typeof j.implementation === "string" ? j.implementation : undefined,
    capability: typeof j.capability === "string" ? j.capability : undefined,
    workflow: typeof j.workflow === "string" ? j.workflow : undefined,
    why: typeof j.why === "string" ? j.why : undefined,
    agent: typeof j.agent === "string" ? j.agent : undefined,
    schedule: typeof j.schedule === "string" ? j.schedule : undefined,
    target: typeof j.target === "number" ? j.target : undefined,
    delivery: j.delivery === "pull-request" ? j.delivery : undefined,
    cliArgs: (j.cliArgs as Record<string, unknown> | undefined) ?? {},
    workflowFacts:
      j.workflowFacts && typeof j.workflowFacts === "object" && !Array.isArray(j.workflowFacts)
        ? (j.workflowFacts as Record<string, unknown>)
        : undefined,
    workflowState: parseWorkflowRunState(j.workflowState) ?? undefined,
    workflowRunId: typeof j.workflowRunId === "string" && j.workflowRunId.trim() ? j.workflowRunId.trim() : undefined,
    evidence: parseJobEvidence(j),
    flavor: j.flavor,
    force: j.force === true,
    saveReport: j.saveReport === true,
    report: parseReportPublication(j.report),
    resultTarget: parseCapabilityResultTarget(j.resultTarget),
  }
}

function parseReportPublication(raw: unknown): ReportPublicationConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const report = raw as Record<string, unknown>
  if (typeof report.type !== "string" || typeof report.owner !== "string") return undefined
  return raw as ReportPublicationConfig
}

function parseCapabilityResultTarget(raw: unknown): CapabilityResultTarget | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const target = raw as Record<string, unknown>
  if (target.type !== "goal") return undefined
  if (typeof target.id !== "string" || target.id.trim().length === 0) return undefined
  return {
    type: "goal",
    id: target.id.trim(),
  }
}

function parseJobEvidence(job: Record<string, unknown>): string | undefined {
  if (typeof job.evidence === "string" && job.evidence.trim().length > 0) return job.evidence.trim()
  const target = job.resultTarget
  if (!target || typeof target !== "object" || Array.isArray(target)) return undefined
  const evidence = (target as Record<string, unknown>).evidence
  return typeof evidence === "string" && evidence.trim().length > 0 ? evidence.trim() : undefined
}

/** Ambient inputs the executor needs that don't belong to the Job itself. */
export interface RunJobBase {
  cwd: string
  config?: KodyConfig
  skipConfig?: boolean
  verbose?: boolean
  quiet?: boolean
  /** Cancels every nested implementation in this Job. */
  abortController?: AbortController
  preloadedData?: Record<string, unknown>
  /**
   * Follow in-process stage hand-offs (`runImplementationChain`) by default,
   * matching the comment/manual route. Scheduled watch fan-out can set `false`
   * for one-shot ticks that must not follow a returned nextDispatch.
   */
  chain?: boolean
}

/**
 * Execute a Job by lowering it onto the existing executor.
 *
 * Mapping:
 *   - capability/action resolves first             (the public capability contract)
 *   - profile = job.implementation ?? capability implementation
 *   - cliArgs = job.cliArgs                   (target already bound by the minter)
 *   - capability/implementation → preloadedData      (seeded so the executor can
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
  const action = valid.action ?? valid.capability
  const projectCapabilitiesRoot = hydratedCapabilitiesRoot(base.cwd)
  const resolvedCapability = !valid.workflow && action ? resolveCapabilityAction(action, projectCapabilitiesRoot) : null
  const capabilityIdentity = valid.capability ?? resolvedCapability?.capability
  const capabilityContext = valid.workflow ? null : loadCapabilityContext(capabilityIdentity, base.cwd)
  const workflowContext = valid.workflow
    ? loadWorkflowContext(valid.workflow, base)
    : !capabilityContext && !resolvedCapability
      ? loadWorkflowContext(capabilityIdentity ?? action, base)
      : null
  const explicitImplementation = valid.implementation
  const explicitImplementationOnly =
    explicitImplementation !== undefined &&
    (valid.action === undefined || valid.action === explicitImplementation) &&
    (valid.capability === undefined || valid.capability === explicitImplementation)
  if (!resolvedCapability && !capabilityContext && !workflowContext && !explicitImplementationOnly) {
    throw new InvalidJobError(
      `job capability/workflow not found: ${valid.workflow ?? action ?? valid.capability ?? "<none>"}`,
    )
  }

  const workflow = capabilityContext?.config.workflow ?? workflowContext?.config.workflow
  const workflowIdentity = valid.workflow ?? capabilityIdentity ?? workflowContext?.slug
  const simpleCapabilityRuntime = resolveSimpleCapabilityRuntime(resolvedCapability?.implementation, valid.delivery)
  const capabilitySelectedImplementation =
    simpleCapabilityRuntime?.implementation ??
    resolvedCapability?.implementation ??
    capabilityContext?.config.implementation ??
    capabilityContext?.config.implementations?.[0] ??
    (capabilityContext?.config.role ? capabilityContext.slug : undefined) ??
    (capabilityContext?.config.tickScript ? "capability-tick-scripted" : undefined)
  const profileName = explicitImplementation ?? capabilitySelectedImplementation
  if (
    workflow &&
    shouldRunCapabilityWorkflow(valid, workflow, workflowIdentity, capabilitySelectedImplementation, base)
  ) {
    const workflowCapability = capabilityContext ?? workflowContext!
    const persistedState =
      valid.workflowRunId && workflowIdentity && base.config
        ? await readWorkflowRunState(base.config, base.cwd, workflowIdentity, valid.workflowRunId)
        : null
    const workflowJob = {
      ...(workflowContext && !valid.why ? { ...valid, why: workflowContext.body } : valid),
      ...(workflowCapability.config.agent ? { agent: workflowCapability.config.agent } : {}),
      ...((valid.workflowState ?? persistedState)
        ? { workflowState: valid.workflowState ?? persistedState ?? undefined }
        : {}),
    }
    const checkpoint =
      valid.workflowRunId && workflowIdentity && base.config
        ? (state: WorkflowRunState) =>
            writeWorkflowRunState(base.config!, base.cwd, workflowIdentity, valid.workflowRunId!, state)
        : undefined
    const parentRunId = `workflow:${workflowIdentity}:${valid.workflowRunId ?? newJobId(valid.flavor)}`
    const startedAt = new Date().toISOString()
    const parentRow: RunIndexRow = {
      version: 1,
      id: parentRunId,
      subjectType: "workflow",
      subjectId: workflowIdentity!,
      subjectLabel: workflowCapability.title,
      status: "running",
      title: workflowCapability.title,
      startedAt,
      updatedAt: startedAt,
      workflow: workflowIdentity,
      kodyRunId: valid.workflowRunId,
      parentRunId: typeof base.preloadedData?.parentRunId === "string" ? base.preloadedData.parentRunId : undefined,
      sourceType: "job",
    }
    const persistRun = Boolean(base.config && !base.skipConfig && hasStateBackendConfig())
    if (base.config && persistRun) {
      await upsertRunIndexRowBestEffortAsync(base.config, base.cwd, parentRow)
    }
    const workflowBase: RunJobBase = {
      ...base,
      preloadedData: { ...(base.preloadedData ?? {}), parentRunId },
    }
    let result: ExecutorOutput
    try {
      result = await runCapabilityWorkflow(workflowJob, workflow, workflowCapability, workflowBase, checkpoint)
    } catch (error) {
      if (base.config && persistRun) {
        await upsertRunIndexRowBestEffortAsync(base.config, base.cwd, {
          ...parentRow,
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        })
      }
      throw error
    }
    if (base.config && persistRun) {
      await upsertRunIndexRowBestEffortAsync(base.config, base.cwd, {
        ...parentRow,
        status: result.exitCode === 0 ? "success" : "failed",
        summary: result.reason,
        updatedAt: new Date().toISOString(),
      })
    }
    if (valid.workflowRunId && workflowIdentity && base.config && result.workflowState) {
      await writeWorkflowRunState(base.config, base.cwd, workflowIdentity, valid.workflowRunId, result.workflowState)
    }
    return result
  }

  if (!profileName) {
    throw new InvalidJobError(`job capability resolves to no implementation: ${capabilityIdentity ?? action}`)
  }

  return runDefaultCapabilityWorkflow(
    valid,
    profileName,
    capabilityIdentity,
    capabilityContext,
    resolvedCapability,
    base,
  )
}

async function runDefaultCapabilityWorkflow(
  job: Job,
  profileName: string,
  capabilityIdentity: string | undefined,
  capabilityContext: CapabilityFolder | null,
  resolvedCapability: DiscoveredCapabilityAction | null,
  base: RunJobBase,
): Promise<ExecutorOutput> {
  return runCapabilityImplementationStep(
    job,
    profileName,
    capabilityIdentity,
    capabilityContext,
    resolvedCapability,
    base,
  )
}

async function runCapabilityImplementationStep(
  valid: Job,
  profileName: string,
  capabilityIdentity: string | undefined,
  capabilityContext: CapabilityFolder | null,
  resolvedCapability: DiscoveredCapabilityAction | null,
  base: RunJobBase,
): Promise<ExecutorOutput> {
  const simpleCapabilityRuntime = resolveSimpleCapabilityRuntime(resolvedCapability?.implementation, valid.delivery)
  const preloadedData: Record<string, unknown> = { ...(base.preloadedData ?? {}) }
  // Stamp both identities: jobKey is stable required work on the task; jobId is
  // this execution attempt.
  preloadedData.jobId = newJobId(valid.flavor)
  preloadedData.jobKey = stableJobKey(valid)
  preloadedData.jobFlavor = valid.flavor
  if (valid.target !== undefined) preloadedData.jobTarget = valid.target
  if (valid.delivery !== undefined) preloadedData.jobDelivery = valid.delivery
  if (valid.action !== undefined && valid.action.length > 0) preloadedData.jobAction = valid.action
  if (capabilityIdentity !== undefined && capabilityIdentity.length > 0)
    preloadedData.jobCapability = capabilityIdentity
  preloadedData.selectedImplementation = profileName
  // The job carries *when*: a scheduled job's cadence, recorded in the ledger.
  if (valid.schedule !== undefined && valid.schedule.length > 0) preloadedData.jobSchedule = valid.schedule
  if (valid.saveReport === true) preloadedData.jobSaveReport = true
  if (valid.report) preloadedData.reportPublication = valid.report
  if (valid.force === true) preloadedData.jobForce = true
  if (valid.evidence) preloadedData.capabilityEvidence = { evidence: valid.evidence }
  if (valid.resultTarget) preloadedData.capabilityResultTarget = valid.resultTarget
  if (capabilityContext) {
    preloadedData.capabilitySlug = capabilityContext.slug
    preloadedData.capabilityTitle = capabilityContext.title
    if (capabilityContext.config.capabilityKind)
      preloadedData.jobCapabilityKind = capabilityContext.config.capabilityKind
    preloadedData.capabilityIntent = capabilityContext.body
    preloadedData.jobIntent = capabilityContext.body
    if (preloadedData.jobCapability === undefined) preloadedData.jobCapability = capabilityContext.slug
    if (capabilityContext.config.agent && preloadedData.jobAgent === undefined) {
      preloadedData.jobAgent = capabilityContext.config.agent
    }
    if (capabilityContext.config.mentions && capabilityContext.config.mentions.length > 0) {
      preloadedData.mentions = capabilityContext.config.mentions.map((login: string) => `@${login}`).join(" ")
    }
  }
  // Inline why → ctx.data.jobWhy (NOT jobIntent — that token is the scheduled
  // capability BODY, consumed via {{jobIntent}} by capability-tick; reusing it would
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
    abortController: base.abortController,
    preloadedData: Object.keys(preloadedData).length > 0 ? preloadedData : undefined,
  }
  const shouldApplyResolvedCapabilityArgs =
    valid.implementation === undefined && resolvedCapability && profileName === resolvedCapability.implementation
  input.cliArgs = shouldApplyResolvedCapabilityArgs
    ? { ...resolvedCapability.cliArgs, ...input.cliArgs }
    : input.cliArgs
  if (simpleCapabilityRuntime && profileName === simpleCapabilityRuntime.implementation && capabilityIdentity) {
    const businessArgs = { ...valid.cliArgs }
    if (businessArgs.capability === capabilityIdentity) {
      delete businessArgs.capability
    }
    const capabilityInput = Object.keys(businessArgs).length > 0 ? genericInputFromArgs(businessArgs) : undefined
    input.cliArgs = simpleCapabilityRuntimeArgs(simpleCapabilityRuntime, capabilityIdentity, capabilityInput)
  }

  const run = base.chain === false ? runImplementation : runImplementationChain
  return run(profileName, input)
}

function shouldRunCapabilityWorkflow(
  job: Job,
  workflow: CapabilityWorkflowConfig,
  capabilityIdentity: string | undefined,
  selectedImplementation: string | undefined,
  base: RunJobBase,
): boolean {
  if (workflow.steps.length === 0) return false
  if (!capabilityIdentity) return false
  const stack = Array.isArray(base.preloadedData?.workflowStack)
    ? (base.preloadedData.workflowStack as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : []
  if (stack.includes(capabilityIdentity)) return false
  const requestedImplementation = job.implementation
  if (!requestedImplementation) return true
  return (
    requestedImplementation === selectedImplementation ||
    requestedImplementation === capabilityIdentity ||
    requestedImplementation === job.action
  )
}

async function runCapabilityWorkflow(
  parent: Job,
  workflow: CapabilityWorkflowConfig,
  capability: CapabilityFolder,
  base: RunJobBase,
  checkpoint?: (state: WorkflowRunState) => Promise<void>,
): Promise<ExecutorOutput> {
  const invalid = workflowError(workflow, base)
  if (invalid) {
    if (isGraphWorkflow(workflow)) {
      const state = initialWorkflowState(parent, workflow)
      state.status = "blocked"
      state.blocker = invalid
      await checkpoint?.(state)
      return { exitCode: 64, reason: invalid, workflowState: state }
    }
    return { exitCode: 64, reason: invalid }
  }
  if (isGraphWorkflow(workflow)) {
    const result = await runGraphCapabilityWorkflow(parent, workflow, capability, base, checkpoint)
    if (workflow.report && result.workflowState) {
      await publishWorkflowReport({
        config: base.config ?? loadConfig(base.cwd),
        publication: workflow.report,
        workflowId: capability.slug,
        workflowTitle: capability.title,
        state: result.workflowState,
      })
    }
    return result
  }
  return runLinearCapabilityWorkflow(parent, workflow, capability, base)
}

async function runLinearCapabilityWorkflow(
  parent: Job,
  workflow: CapabilityWorkflowConfig,
  capability: CapabilityFolder,
  base: RunJobBase,
): Promise<ExecutorOutput> {
  let chainData: Record<string, unknown> = {
    ...(base.preloadedData ?? {}),
    runSubjectType: "workflow",
    runSubjectId: capability.slug,
    runSubjectLabel: capability.title,
    runSubjectWorkflow: capability.slug,
    workflowCapability: capability.slug,
    workflowTitle: capability.title,
    workflowStepCount: workflow.steps.length,
    workflowIssueNumber: workflowIssueNumber(parent),
    workflowContext: workflowInputContext(parent.cliArgs),
    workflowFacts: parent.workflowFacts ?? {},
    workflowStack: [
      ...(Array.isArray(base.preloadedData?.workflowStack)
        ? (base.preloadedData.workflowStack as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : []),
      capability.slug,
    ],
  }
  let result: ExecutorOutput = { exitCode: 0 }
  const startIndex = workflowResumeStartIndex(workflow.steps, parent.evidence)

  for (let index = startIndex; index < workflow.steps.length; index++) {
    const step = workflow.steps[index]!
    const label = step.action ?? step.capability
    if (!shouldRunWorkflowStep(step, chainData)) {
      process.stdout.write(
        `→ kody: workflow ${capability.slug} step ${index + 1}/${workflow.steps.length} → ${label} (skipped)\n\n`,
      )
      continue
    }
    const child = workflowStepToJob(step, parent, chainData, base.cwd)
    process.stdout.write(
      `→ kody: workflow ${capability.slug} step ${index + 1}/${workflow.steps.length} → ${label}\n\n`,
    )
    result = await runJob(child, {
      ...base,
      preloadedData: {
        ...chainData,
        runSubjectType: "capability",
        runSubjectId: step.capability,
        runSubjectLabel: label,
        workflowStep: label,
        workflowStepIndex: index + 1,
        workflowExecutionKey: [capability.slug, label, index + 1].join(":"),
        workflowStepReason: step.reason,
        workflowContinueOn: step.continueOn ?? [],
      },
    })
    const outcome = workflowOutcome(result)
    const prUrl =
      result.prUrl ??
      result.taskState?.core.prUrl ??
      (typeof chainData.workflowPrUrl === "string" ? chainData.workflowPrUrl : undefined)
    chainData = {
      ...chainData,
      ...(result.taskState ? { taskState: result.taskState } : {}),
      ...(outcome ? { workflowLastOutcome: outcome } : {}),
      ...(result.capabilityOutput !== undefined
        ? {
            workflowLastOutput: result.capabilityOutput,
            workflowContext: mergeWorkflowContext(chainData.workflowContext, result.capabilityOutput),
          }
        : {}),
      ...(prUrl ? { workflowPrUrl: prUrl } : {}),
      ...(parsePrNumber(prUrl) ? { workflowPrNumber: parsePrNumber(prUrl) } : {}),
    }
    if (result.exitCode !== 0 && !canContinueWorkflow(step, outcome)) {
      return withWorkflowBoundaryEval(capability, {
        ...result,
        reason:
          result.reason ??
          `workflow ${capability.slug} stopped at step ${index + 1}/${workflow.steps.length}: ${label}`,
      })
    }
  }

  return withWorkflowBoundaryEval(capability, result)
}

function isGraphWorkflow(workflow: CapabilityWorkflowConfig): boolean {
  return (
    workflow.startAt !== undefined || workflow.steps.some((step) => step.id !== undefined || step.next !== undefined)
  )
}

function workflowError(workflow: CapabilityWorkflowConfig, base: RunJobBase): string | null {
  const projectCapabilitiesRoot = hydratedCapabilitiesRoot(base.cwd)
  const knownCapabilities = new Set<string>()
  const capabilityOutputs = new Map<string, Set<string>>()
  for (const step of workflow.steps) {
    const action = step.action ?? step.capability
    const resolvedAction = resolveCapabilityAction(action, projectCapabilitiesRoot)
    const resolvedFolder = resolveCapabilityFolder(step.capability, projectCapabilitiesRoot)
    if (!resolvedAction && !resolvedFolder) continue
    knownCapabilities.add(step.capability)
    const outputPaths = resolvedFolder ? capabilityOutputConditionPaths(resolvedFolder.config) : new Set<string>()
    if (outputPaths.size > 0) capabilityOutputs.set(step.capability, outputPaths)
  }
  return formatWorkflowValidationIssues(validateWorkflow(workflow, { knownCapabilities, capabilityOutputs }))[0] ?? null
}

function initialWorkflowState(parent: Job, workflow: CapabilityWorkflowConfig): WorkflowRunState {
  const prior = parent.workflowState
  if (prior?.status === "done") {
    return {
      ...prior,
      status: "done",
      completedStepIds: [...prior.completedStepIds],
      transitionCounts: { ...prior.transitionCounts },
      facts: { ...prior.facts },
      evidence: { ...prior.evidence },
      artifacts: prior.artifacts.map((artifact) => ({ ...artifact })),
    }
  }
  const firstStepId = workflow.startAt ?? workflow.steps[0]?.id
  const currentStepId = prior?.currentStepId ?? firstStepId
  return {
    status: "running",
    ...(currentStepId ? { currentStepId } : {}),
    completedStepIds: [...(prior?.completedStepIds ?? [])],
    transitionCounts: { ...(prior?.transitionCounts ?? {}) },
    facts: { ...(parent.workflowFacts ?? {}), ...(prior?.facts ?? {}) },
    evidence: { ...(prior?.evidence ?? {}) },
    artifacts: (prior?.artifacts ?? []).map((artifact) => ({ ...artifact })),
  }
}

function workflowChainData(
  parent: Job,
  capability: CapabilityFolder,
  base: RunJobBase,
  state: WorkflowRunState,
): Record<string, unknown> {
  return {
    ...(base.preloadedData ?? {}),
    runSubjectType: "workflow",
    runSubjectId: capability.slug,
    runSubjectLabel: capability.title,
    runSubjectWorkflow: capability.slug,
    workflowCapability: capability.slug,
    workflowTitle: capability.title,
    workflowStepCount: capability.config.workflow?.steps.length ?? 0,
    workflowIssueNumber: workflowIssueNumber(parent),
    workflowContext: base.preloadedData?.workflowContext ?? workflowInputContext(parent.cliArgs),
    workflowFacts: state.facts,
    workflowEvidence: state.evidence,
    workflowArtifacts: state.artifacts,
    workflowStack: [
      ...(Array.isArray(base.preloadedData?.workflowStack)
        ? (base.preloadedData.workflowStack as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : []),
      capability.slug,
    ],
  }
}

async function runGraphCapabilityWorkflow(
  parent: Job,
  workflow: CapabilityWorkflowConfig,
  capability: CapabilityFolder,
  base: RunJobBase,
  checkpoint?: (state: WorkflowRunState) => Promise<void>,
): Promise<ExecutorOutput> {
  const state = initialWorkflowState(parent, workflow)

  let chainData = workflowChainData(parent, capability, base, state)
  let result: ExecutorOutput = { exitCode: 0 }
  let executedSteps = 0
  const maxExecutedSteps = 1_000

  while (state.currentStepId) {
    executedSteps += 1
    if (executedSteps > maxExecutedSteps) {
      const reason = `workflow ${capability.slug} exceeded ${maxExecutedSteps} executed steps`
      state.status = "blocked"
      state.blocker = reason
      await checkpoint?.(state)
      return { ...result, exitCode: 64, reason, workflowState: state }
    }

    const index = workflow.steps.findIndex((step) => step.id === state.currentStepId)
    const step = workflow.steps[index]
    if (!step) {
      const reason = `workflow ${capability.slug} current step ${state.currentStepId} is missing`
      state.status = "blocked"
      state.blocker = reason
      await checkpoint?.(state)
      return { ...result, exitCode: 64, reason, workflowState: state }
    }

    const label = step.action ?? step.capability
    await checkpoint?.(state)
    let child: Job
    try {
      child = workflowStepToJob(step, parent, chainData, base.cwd)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      state.status = "blocked"
      state.blocker = reason
      await checkpoint?.(state)
      return { exitCode: 64, reason, workflowState: state }
    }

    process.stdout.write(
      `→ kody: workflow ${capability.slug} step ${index + 1}/${workflow.steps.length} → ${label}\n\n`,
    )
    result = await runJob(child, {
      ...base,
      preloadedData: {
        ...chainData,
        runSubjectType: "capability",
        runSubjectId: step.capability,
        runSubjectLabel: step.id,
        workflowStep: step.id,
        workflowStepIndex: index + 1,
        workflowExecutionKey: graphWorkflowExecutionKey(
          base.preloadedData?.workflowExecutionKey,
          capability.slug,
          step.id!,
          state.transitionCounts,
        ),
        workflowStepReason: step.reason,
        workflowContinueOn: step.continueOn ?? [],
      },
    })

    mergeWorkflowResults(state, result.capabilityResults)
    const outcome = workflowOutcome(result)
    const prUrl =
      result.prUrl ??
      result.taskState?.core.prUrl ??
      (typeof chainData.workflowPrUrl === "string" ? chainData.workflowPrUrl : undefined)
    chainData = {
      ...workflowChainData(parent, capability, base, state),
      ...(result.taskState ? { taskState: result.taskState } : {}),
      ...(outcome ? { workflowLastOutcome: outcome } : {}),
      ...(result.capabilityResults?.at(-1) ? { workflowLastResult: result.capabilityResults.at(-1) } : {}),
      ...(result.capabilityOutput !== undefined
        ? {
            workflowLastOutput: result.capabilityOutput,
            workflowContext: mergeWorkflowContext(chainData.workflowContext, result.capabilityOutput),
          }
        : {}),
      ...(prUrl ? { workflowPrUrl: prUrl } : {}),
      ...(parsePrNumber(prUrl) ? { workflowPrNumber: parsePrNumber(prUrl) } : {}),
    }

    if (!state.completedStepIds.includes(step.id!)) state.completedStepIds.push(step.id!)
    if (result.exitCode !== 0 && !canContinueWorkflow(step, outcome)) {
      state.status = "failed"
      state.blocker = result.reason ?? `workflow step ${step.id} failed`
      await checkpoint?.(state)
      return withWorkflowBoundaryEval(capability, { ...result, workflowState: state })
    }

    if (!step.next || step.next.length === 0) {
      return completeWorkflowAtTerminal(capability, state, result, checkpoint)
    }

    const resultConditionPaths = workflowResultConditionPaths(step.next)
    if (resultConditionPaths.length > 0 && !result.capabilityResults?.at(-1)) {
      const reason = `workflow step ${step.id} did not emit the structured result required by its conditions: ${resultConditionPaths.join(", ")}`
      state.status = "blocked"
      state.blocker = reason
      await checkpoint?.(state)
      return { ...result, exitCode: 64, reason, workflowState: state }
    }

    const transition = selectWorkflowTransition(step, chainData, state.transitionCounts)
    if (!transition) {
      const exhausted = exhaustedWorkflowTransitions(step, chainData, state.transitionCounts)
      const reason =
        exhausted.length > 0
          ? `workflow step ${step.id} reached iteration limit: ${exhausted.join(", ")}`
          : `workflow step ${step.id} has no available connection`
      state.status = "blocked"
      state.blocker = reason
      await checkpoint?.(state)
      return { ...result, exitCode: 64, reason, workflowState: state }
    }
    if (transition.maxIterations !== undefined) {
      const key = `${step.id}->${transition.to}`
      state.transitionCounts[key] = (state.transitionCounts[key] ?? 0) + 1
    }
    if (transition.to === "$end") {
      return completeWorkflowAtTerminal(capability, state, result, checkpoint)
    }
    state.currentStepId = transition.to
    state.status = "running"
    delete state.blocker
    await checkpoint?.(state)
  }

  state.status = "done"
  await checkpoint?.(state)
  return withWorkflowBoundaryEval(capability, { ...result, workflowState: state })
}

async function completeWorkflowAtTerminal(
  capability: CapabilityFolder,
  state: WorkflowRunState,
  output: ExecutorOutput,
  checkpoint?: (state: WorkflowRunState) => Promise<void>,
): Promise<ExecutorOutput> {
  const result = output.capabilityResults?.at(-1)
  if (result?.status === "fail" || result?.status === "blocked") {
    state.status = result.status === "fail" ? "failed" : "blocked"
    state.blocker = result.summary
    await checkpoint?.(state)
    return withWorkflowBoundaryEval(capability, {
      ...output,
      exitCode: result.status === "fail" ? 1 : 64,
      reason: result.summary,
      workflowState: state,
    })
  }
  state.status = "done"
  delete state.currentStepId
  delete state.blocker
  await checkpoint?.(state)
  return withWorkflowBoundaryEval(capability, { ...output, workflowState: state })
}

function graphWorkflowExecutionKey(
  parentExecutionKey: unknown,
  workflowSlug: string,
  stepId: string,
  transitionCounts: Record<string, number>,
): string {
  const transitionHistory = Object.entries(transitionCounts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([transition, count]) => `${transition}=${count}`)
    .join(",")
  return [
    typeof parentExecutionKey === "string" && parentExecutionKey.length > 0 ? parentExecutionKey : undefined,
    workflowSlug,
    stepId,
    transitionHistory || "initial",
  ]
    .filter((part): part is string => part !== undefined)
    .join(":")
}

function mergeWorkflowResults(state: WorkflowRunState, results: CapabilityResult[] | undefined): void {
  for (const result of results ?? []) {
    Object.assign(state.facts, result.facts)
    Object.assign(state.evidence, result.evidence ?? {})
    for (const artifact of result.artifacts) {
      if (
        !state.artifacts.some(
          (existing) =>
            existing.label === artifact.label && existing.url === artifact.url && existing.path === artifact.path,
        )
      ) {
        state.artifacts.push({ ...artifact })
      }
    }
  }
}

function selectWorkflowTransition(
  step: CapabilityWorkflowStepConfig,
  data: Record<string, unknown>,
  counts: Record<string, number>,
): CapabilityWorkflowTransitionConfig | null {
  let fallback: CapabilityWorkflowTransitionConfig | null = null
  for (const transition of step.next ?? []) {
    const key = `${step.id}->${transition.to}`
    if (transition.maxIterations !== undefined && (counts[key] ?? 0) >= transition.maxIterations) continue
    if (transition.default === true) {
      fallback ??= transition
      continue
    }
    if (!transition.when || conditionMatches(transition.when, workflowConditionContext(data))) return transition
  }
  return fallback
}

function exhaustedWorkflowTransitions(
  step: CapabilityWorkflowStepConfig,
  data: Record<string, unknown>,
  counts: Record<string, number>,
): string[] {
  return (step.next ?? []).flatMap((transition) => {
    if (transition.maxIterations === undefined) return []
    const key = `${step.id}->${transition.to}`
    if ((counts[key] ?? 0) < transition.maxIterations) return []
    const matches =
      transition.default === true ||
      !transition.when ||
      conditionMatches(transition.when, workflowConditionContext(data))
    return matches ? [`${key} (${transition.maxIterations})`] : []
  })
}

function workflowResultConditionPaths(transitions: CapabilityWorkflowTransitionConfig[]): string[] {
  return transitions.flatMap((transition) =>
    Object.keys(transition.when ?? {}).filter((path) => path.startsWith("result.")),
  )
}

function conditionMatches(condition: Record<string, unknown>, context: Record<string, unknown>): boolean {
  return Object.entries(condition).every(([path, expected]) => valueMatches(resolveDottedPath(context, path), expected))
}

function withWorkflowBoundaryEval(capability: CapabilityFolder, result: ExecutorOutput): ExecutorOutput {
  const capabilityKind = capability.config.capabilityKind
  if (!capabilityKind) return result
  const evalResult = evaluateAgencyBoundaries({
    capability: capability.slug,
    capabilityKind,
    results: [],
  })
  process.stdout.write(`KODY_AGENCY_BOUNDARY_EVAL=${JSON.stringify(evalResult)}\n`)
  if (evalResult.status !== "fail" || result.exitCode !== 0) return result
  const failed = evalResult.findings.filter((finding) => finding.status === "fail").map((finding) => finding.rule)
  return {
    ...result,
    exitCode: 99,
    reason: result.reason
      ? `${result.reason}; agency boundary eval failed: ${failed.join(", ")}`
      : `agency boundary eval failed: ${failed.join(", ")}`,
  }
}

function workflowStepToJob(
  step: CapabilityWorkflowStepConfig,
  parent: Job,
  chainData: Record<string, unknown>,
  cwd: string,
): Job {
  const action = step.action ?? step.capability
  const targetNumber = workflowStepTargetNumber(step, parent, chainData)
  const rawArgs = {
    ...parent.cliArgs,
  }
  if (step.target === "pr") {
    if (typeof targetNumber !== "number") {
      throw new InvalidJobError(`workflow step ${action} needs a PR target but no prior PR URL is available`)
    }
    rawArgs.pr = targetNumber
  } else if (step.target === "issue" && typeof targetNumber === "number") {
    rawArgs.issue = targetNumber
  }
  const genericInput = capabilityStepInput(
    step.input ?? chainData.workflowContext ?? chainData.workflowLastOutput ?? genericInputFromArgs(rawArgs),
    step.target,
    targetNumber,
  )
  const cliArgs = usesGenericCapabilityInput(action, cwd)
    ? genericInput === undefined
      ? {}
      : { input: JSON.stringify(genericInput) }
    : filterCliArgsForStep(action, rawArgs)
  const target =
    typeof targetNumber === "number"
      ? targetNumber
      : typeof parent.target === "number"
        ? parent.target
        : targetFromCliArgs(cliArgs)
  return {
    action,
    capability: step.capability,
    ...(composeStepWhy(parent.why, step) ? { why: composeStepWhy(parent.why, step) } : {}),
    ...(parent.agent ? { agent: parent.agent } : {}),
    ...(parent.schedule ? { schedule: parent.schedule } : {}),
    ...(typeof target === "number" ? { target } : {}),
    ...(step.delivery ? { delivery: step.delivery } : {}),
    cliArgs,
    ...(step.evidence ? { evidence: step.evidence } : parent.evidence ? { evidence: parent.evidence } : {}),
    flavor: parent.flavor,
    force: parent.force,
    saveReport: step.saveReport === true || parent.saveReport === true,
    ...(step.report ? { report: step.report } : {}),
    ...(parent.resultTarget ? { resultTarget: parent.resultTarget } : {}),
  }
}

function usesGenericCapabilityInput(action: string, cwd: string): boolean {
  const inputs = getCapabilityActionInputs(action, hydratedCapabilitiesRoot(cwd))
  return Boolean(inputs?.length === 1 && inputs[0]?.name === "input" && inputs[0]?.flag === "--input")
}

function genericInputFromArgs(args: Record<string, unknown>): unknown {
  if (Object.hasOwn(args, "input")) {
    const { input, ...routing } = args
    const parsed = parseGenericInput(input)
    if (Object.keys(routing).length === 0) return parsed
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>), ...routing }
    }
    return { request: parsed, ...routing }
  }
  return args
}

function workflowInputContext(args: Record<string, unknown>): Record<string, unknown> {
  const input = genericInputFromArgs(args)
  if (input && typeof input === "object" && !Array.isArray(input)) return { ...(input as Record<string, unknown>) }
  return input === undefined ? {} : { request: input }
}

function mergeWorkflowContext(current: unknown, output: unknown): Record<string, unknown> {
  const context =
    current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
  if (!output || typeof output !== "object" || Array.isArray(output)) return { ...context }
  return { ...context, ...(output as Record<string, unknown>) }
}

function parseGenericInput(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function capabilityStepInput(
  input: unknown,
  target: CapabilityWorkflowStepConfig["target"],
  targetNumber: number | undefined,
): unknown {
  if (!target || targetNumber === undefined) return input
  const routing = { [target]: targetNumber }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const context = { ...(input as Record<string, unknown>) }
    delete context[target === "pr" ? "issue" : "pr"]
    return { ...context, ...routing }
  }
  return input === undefined ? routing : { request: input, ...routing }
}

function shouldRunWorkflowStep(step: CapabilityWorkflowStepConfig, data: Record<string, unknown>): boolean {
  if (!step.runWhen) return true
  const context = workflowConditionContext(data)
  return conditionMatches(step.runWhen, context)
}

function canContinueWorkflow(step: CapabilityWorkflowStepConfig, outcome: Action | null): boolean {
  if (!outcome || !step.continueOn || step.continueOn.length === 0) return false
  return step.continueOn.includes(outcome.type)
}

function workflowOutcome(result: ExecutorOutput): Action | null {
  return result.taskState?.core.lastOutcome ?? null
}

function workflowConditionContext(data: Record<string, unknown>): Record<string, unknown> {
  const lastOutcome = data.workflowLastOutcome
  const lastResult = data.workflowLastResult
  const lastOutput = data.workflowLastOutput
  return {
    ...data,
    facts: data.workflowFacts ?? {},
    evidence: data.workflowEvidence ?? {},
    artifacts: data.workflowArtifacts ?? [],
    result: lastOutput === undefined ? lastResult : lastOutput,
    workflow: {
      lastOutcome,
      lastResult,
      lastOutput,
      issueNumber: data.workflowIssueNumber,
      prNumber: data.workflowPrNumber,
      prUrl: data.workflowPrUrl,
    },
    lastOutcome,
  }
}

function resolveDottedPath(root: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((cur, part) => {
    if (!cur || typeof cur !== "object") return undefined
    return (cur as Record<string, unknown>)[part]
  }, root)
}

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((entry) => valueMatches(actual, entry))
  return actual === expected
}

function workflowStepTargetNumber(
  step: CapabilityWorkflowStepConfig,
  parent: Job,
  chainData: Record<string, unknown>,
): number | undefined {
  if (step.target === "pr") return workflowTargetFactNumber(step, chainData) ?? workflowPrNumber(chainData)
  if (step.target === "issue") return workflowIssueNumber(parent) ?? workflowTargetFactNumber(step, chainData)
  return typeof parent.target === "number" ? parent.target : targetFromCliArgs(parent.cliArgs)
}

function workflowResumeStartIndex(steps: CapabilityWorkflowStepConfig[], evidence: string | undefined): number {
  if (!evidence) return 0
  const index = steps.findIndex((step) => step.evidence === evidence)
  return index >= 0 ? index : 0
}

function workflowTargetFactNumber(
  step: CapabilityWorkflowStepConfig,
  data: Record<string, unknown>,
): number | undefined {
  if (!step.targetFact) return undefined
  const facts = data.workflowFacts
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return undefined
  const value = (facts as Record<string, unknown>)[step.targetFact]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function workflowIssueNumber(parent: Job): number | undefined {
  return typeof parent.target === "number" ? parent.target : targetFromCliArgs(parent.cliArgs)
}

function workflowPrNumber(data: Record<string, unknown>): number | undefined {
  if (typeof data.workflowPrNumber === "number" && Number.isFinite(data.workflowPrNumber)) return data.workflowPrNumber
  const workflowContext =
    data.workflowContext && typeof data.workflowContext === "object" && !Array.isArray(data.workflowContext)
      ? (data.workflowContext as Record<string, unknown>)
      : undefined
  if (typeof workflowContext?.pr === "number" && Number.isFinite(workflowContext.pr)) return workflowContext.pr
  const prUrl =
    typeof data.workflowPrUrl === "string"
      ? data.workflowPrUrl
      : typeof (data.taskState as { core?: { prUrl?: unknown } } | undefined)?.core?.prUrl === "string"
        ? (data.taskState as { core: { prUrl: string } }).core.prUrl
        : undefined
  return parsePrNumber(prUrl) ?? undefined
}

function parsePrNumber(url: string | undefined): number | null {
  if (!url) return null
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

function filterCliArgsForStep(action: string, raw: Record<string, unknown>): Record<string, unknown> {
  const inputs = getCapabilityActionInputs(action)
  if (!inputs) return raw
  const allowed = new Set<string>(["_", "cwd", "verbose", "quiet"])
  for (const input of inputs) {
    const flagKey = input.flag.replace(/^--/, "")
    allowed.add(input.name)
    allowed.add(flagKey)
    if (flagKey.includes("-")) allowed.add(flagKey.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()))
  }
  return Object.fromEntries(Object.entries(raw).filter(([key]) => allowed.has(key)))
}

function composeStepWhy(parentWhy: string | undefined, step: CapabilityWorkflowStepConfig): string {
  return [parentWhy?.trim(), step.reason ? `Workflow step: ${step.reason}` : ""]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
}

function loadCapabilityContext(slug: string | undefined, cwd: string): ReturnType<typeof resolveCapabilityFolder> {
  if (!slug) return null
  return resolveCapabilityFolder(slug, hydratedCapabilitiesRoot(cwd))
}

function hydratedCapabilitiesRoot(cwd: string): string {
  return capabilitiesRoot(cwd)
}

function loadWorkflowContext(slug: string | undefined, base: RunJobBase): CapabilityFolder | null {
  if (!slug || !isWorkflowDefinitionId(slug)) return null
  const workflow = readWorkflowDefinition(base.config, base.cwd, slug)
  return workflow ? workflowDefinitionToCapabilityFolder(slug, workflow) : null
}

// ────────────────────────────────────────────────────────────────────────────
// Minters (phase 2): event → Job. Pure mappers, no caller yet — the comment
// and cron paths funnel through these in a later phase, then `runJob` runs the
// result.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mint an INSTANT job from a comment / manual-dispatch route. The trigger
 * resolves to a DispatchResult (implementation + cliArgs + target); this turns it
 * into a Job. `why` is the operator's free-text request after `@kody <command>`
 * (carried on the DispatchResult); `agent` defaults to "kody" — instant verbs
 * ran agent-less before, and the default is the agreed starting point.
 * Both are overridable per call via `opts`.
 */
export function mintInstantJob(dispatch: DispatchResult, opts?: { why?: string; agent?: string }): Job {
  return {
    action: dispatch.action,
    implementation: dispatch.implementation,
    capability: dispatch.capability,
    why: opts?.why ?? dispatch.why,
    agent: opts?.agent ?? DEFAULT_INSTANT_AGENT,
    target: dispatch.target,
    cliArgs: dispatch.cliArgs,
    flavor: "instant",
  }
}

/** Inputs the cron tick path resolves per due capability slug. */
export interface ScheduledJobInput {
  /** Public action for this scheduled capability, when distinct from the slug. */
  action?: string
  /** The capability slug (its capability contract body lives in `.kody-engine/definitions/capabilities/<slug>/capability.md`). */
  capability: string
  /** The implementation that ticks it (capability-tick / capability-tick-scripted, or a folder-capability slug). */
  implementation: string
  /** Cron cadence the capability fired on. */
  schedule?: string
  /** Agent identity that runs it (from the capability's profile.json). */
  agent?: string
  /** Args handed to the tick implementation (e.g. `{ job: slug }` for `.md` capabilities). */
  cliArgs?: Record<string, unknown>
  /** Ask the owning goal/loop to write a report run after its persisted decision. */
  saveReport?: boolean
  /** Bypass cadence deduplication for an explicit manual "Run now". */
  force?: boolean
}

/**
 * Mint a SCHEDULED job from a due capability slug. The cron path enumerates due
 * capabilities; each becomes a scheduled Job whose `implementation` is the ticker and
 * whose `capability` carries the intent. No caller yet — wired in a later phase.
 */
export function mintScheduledJob(input: ScheduledJobInput): Job {
  return {
    action: input.action,
    capability: input.capability,
    implementation: input.implementation,
    schedule: input.schedule,
    agent: input.agent,
    cliArgs: input.cliArgs ?? {},
    flavor: "scheduled",
    force: input.force === true,
    saveReport: input.saveReport === true,
  }
}
