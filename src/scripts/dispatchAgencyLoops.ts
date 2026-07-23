import { randomUUID } from "node:crypto"
import {
  createLoopState,
  createRun,
  type LoopDefinition,
  type LoopState,
  type PinnedDefinitionRef,
  type Run,
} from "@kody-ade/agency-domain"
import type { KodyConfig } from "../config.js"
import type { CapabilityResult } from "../capabilityResult.js"
import { AgencyModelRepository } from "../goal/agencyModelRepository.js"
import { decideTrigger } from "../goal/triggerDispatcher.js"
import { resolveDispatchPolicy } from "../goal/policyResolver.js"
import type { Job, PreflightScript } from "../implementations/types.js"
import { runJob } from "../job.js"
import { createStateBackendFromEnv, type StateBackend } from "../state-backend.js"

interface DispatchResult {
  loopId: string
  decision: "skipped" | "duplicate" | "dispatched" | "failed"
  reason: string
}

export const dispatchAgencyLoops: PreflightScript = async (ctx) => {
  const tenantId = repositoryTenant(ctx.config)
  if (!tenantId) throw new Error("Repository identity is required for Agency Loop dispatch")
  const backend = createStateBackendFromEnv()
  const requestedLoopId =
    typeof ctx.args.loop === "string" ? ctx.args.loop.trim() : ""
  const results = await dispatchAgencyLoopsWith({
    tenantId,
    backend,
    now: new Date(),
    ...(requestedLoopId
      ? {
          manualRequest: {
            loopId: requestedLoopId,
            requestId:
              process.env.GITHUB_RUN_ID?.trim() ||
              `local-${randomUUID()}`,
          },
        }
      : {}),
    run: (job, abortController) =>
      runJob(job, {
        cwd: ctx.cwd,
        config: ctx.config,
        verbose: ctx.verbose,
        quiet: ctx.quiet,
        chain: false,
        abortController,
      }),
  })
  ctx.data.agencyLoopDispatchResults = results
}

export async function dispatchAgencyLoopsWith(input: {
  tenantId: string
  backend: StateBackend
  now: Date
  manualRequest?: { loopId: string; requestId: string }
  run: (
    job: Job,
    abortController: AbortController,
  ) => Promise<{
    exitCode: number
    reason?: string
    usage?: { tokens: number; costUsd: number }
    capabilityResults?: CapabilityResult[]
  }>
}): Promise<DispatchResult[]> {
  const repository = new AgencyModelRepository(input.backend, input.tenantId)
  const catalog = await repository.loadCatalog()
  const records = await repository.listManagedWork(catalog)
  const loops = records.flatMap((record) =>
    "trigger" in record.definition
      ? [{ ...record, definition: record.definition, state: record.state as LoopState | null }]
      : [],
  )
  const results: DispatchResult[] = []

  for (const record of loops) {
    if (
      input.manualRequest &&
      record.definition.id !== input.manualRequest.loopId
    ) {
      continue
    }
    const decision = decideTrigger({
      definition: record.definition,
      state: record.state,
      now: input.now,
      ...(input.manualRequest
        ? { manualRequestId: input.manualRequest.requestId }
        : {}),
    })
    const now = input.now.toISOString()
    if (decision.kind === "skip") {
      const key = `${record.definition.id}:skip:${now}`
      await input.backend.recordSkippedAgencyDispatch(input.tenantId, key, record.definition.id, decision, now)
      if (record.state && decision.nextEligibleAt) {
        await repository.saveState(
          createLoopState({ ...record.state, nextEligibleAt: decision.nextEligibleAt, updatedAt: now }),
          "loop",
          now,
        )
      }
      results.push({ loopId: record.definition.id, decision: "skipped", reason: decision.reason })
      continue
    }

    let target: ResolvedTarget
    let policy: ReturnType<typeof resolveDispatchPolicy>
    try {
      target = resolveTarget(record.definition, catalog)
      policy = resolveDispatchPolicy({
        catalog,
        owner: { definition: record.definition, revision: record.revision },
        target: target.reference,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await input.backend.recordSkippedAgencyDispatch(
        input.tenantId,
        decision.idempotencyKey,
        record.definition.id,
        { kind: "skip", reason, scheduledAt: decision.scheduledAt },
        now,
      )
      results.push({ loopId: record.definition.id, decision: "skipped", reason })
      continue
    }

    const failurePolicy = record.definition.reconciliationPolicy.failure
    const budget = policy.snapshot.policy.budget
    const maxAttempts = Math.min(failurePolicy.maxAttempts, budget.maxRuns)
    const timeoutSeconds = Math.min(failurePolicy.timeoutSeconds, budget.maxDurationSeconds)
    const backoffBudgetSeconds = Array.from(
      { length: Math.max(0, maxAttempts - 1) },
      (_, index) => failurePolicy.backoffSeconds * 2 ** index,
    ).reduce((sum, seconds) => sum + seconds, 0)
    const leaseSeconds = Math.min(
      budget.maxDurationSeconds,
      maxAttempts * timeoutSeconds + backoffBudgetSeconds,
    )
    const leaseUntil = new Date(input.now.getTime() + leaseSeconds * 1_000).toISOString()
    const reservationId = `reservation-${randomUUID()}`
    const correlationId = `corr-${randomUUID()}`
    const trace = [policy.trace[0], ...target.intermediate, target.reference]
    const reservation = await input.backend.reserveAgencyDispatch(input.tenantId, {
      idempotencyKey: decision.idempotencyKey,
      loopId: record.definition.id,
      decision,
      leaseUntil,
      reservationId,
      correlationId,
      policyHash: policy.snapshot.hash,
      effectivePolicy: policy.snapshot,
      definitionRefs: trace,
      maxConcurrentRuns: policy.snapshot.policy.maxConcurrentRuns,
      requiresApproval: policy.requiresApproval,
      approvalScopeKind: "loop",
      approvalScopeId: record.definition.id,
      approvalAction: `${target.reference.kind}:${target.reference.id}`,
      now,
    })
    if (!reservation.acquired) {
      const duplicate = reservation.reason === "duplicate"
      const reason =
        reservation.reason === "approval-required"
          ? "dispatch is waiting for approval"
          : reservation.reason === "concurrency-limit"
            ? "dispatch is waiting for policy capacity"
            : "trigger firing already reserved"
      results.push({
        loopId: record.definition.id,
        decision: duplicate ? "duplicate" : "skipped",
        reason,
      })
      continue
    }

    const runningState = createLoopState({
      definitionId: record.definition.id,
      lifecycle: record.state?.lifecycle ?? "active",
      health: record.state?.health ?? "unknown",
      failures: record.state?.failures ?? 0,
      lastFiredAt: decision.scheduledAt,
      updatedAt: now,
    })
    await repository.saveState(runningState, "loop", now)
    try {
      let attempts = 0
      let tokens = 0
      let costUsd = 0
      let succeeded = false
      let reason = "target failed"
      let finalRunId: string | undefined
      let finalCapabilityResults: CapabilityResult[] = []
      const budgetDeadline = Date.now() + budget.maxDurationSeconds * 1_000
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const remainingMilliseconds = budgetDeadline - Date.now()
        if (remainingMilliseconds <= 0) {
          reason = "policy duration budget exhausted"
          break
        }
        attempts = attempt
        const startedAt = new Date().toISOString()
        const runId = `run-${randomUUID()}`
        finalRunId = runId
        const activeRun = createRun({
          id: runId,
          status: "running",
          origin: { kind: "loop", id: record.definition.id, revision: record.revision },
          target: target.reference,
          trace,
          effectivePolicy: policy.snapshot,
          correlationId,
          startedAt,
        })
        await input.backend.createAgencyModelRun(
          input.tenantId,
          target.reference.kind,
          target.reference.id,
          activeRun,
          startedAt,
        )
        const attemptResult = await runAttempt(
          input.run,
          target.job,
          Math.min(timeoutSeconds, remainingMilliseconds / 1_000),
        )
        tokens += attemptResult.usage?.tokens ?? 0
        costUsd += attemptResult.usage?.costUsd ?? 0
        const finishedAt = new Date().toISOString()
        succeeded = attemptResult.exitCode === 0
        finalCapabilityResults = attemptResult.capabilityResults ?? []
        reason = attemptResult.reason ?? (succeeded ? "target dispatched" : "target failed")
        const usage = {
          tokens: attemptResult.usage?.tokens ?? 0,
          costUsd: attemptResult.usage?.costUsd ?? 0,
          durationSeconds: Math.max(0, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1_000),
        }
        if (tokens > budget.maxTokens || costUsd > budget.maxCostUsd) {
          succeeded = false
          reason = tokens > budget.maxTokens ? "policy token budget exhausted" : "policy cost budget exhausted"
        }
        await input.backend.finishAgencyModelRun(
          input.tenantId,
          terminalRun(activeRun, succeeded ? "succeeded" : "failed", finishedAt, usage),
          finishedAt,
        )
        if (tokens > budget.maxTokens || costUsd > budget.maxCostUsd) break
        if (succeeded || attempt === maxAttempts) break
        const backoffMilliseconds = failurePolicy.backoffSeconds * 2 ** (attempt - 1) * 1_000
        if (Date.now() + backoffMilliseconds >= budgetDeadline) {
          reason = "policy duration budget exhausted during retry backoff"
          break
        }
        await wait(backoffMilliseconds)
      }
      const finishedAt = new Date().toISOString()
      const goalRecord =
        record.definition.targetRef.kind === "goal"
          ? records.find(
              (candidate) =>
                "executionRef" in candidate.definition &&
                candidate.definition.id === record.definition.targetRef.id,
            )
          : undefined
      if (succeeded && finalRunId) {
        await appendCapabilityOutputs(
          repository,
          finalRunId,
          target.reference,
          goalRecord
            ? {
                kind: "goal",
                id: goalRecord.definition.id,
                revision: goalRecord.revision,
              }
            : {
                kind: "loop",
                id: record.definition.id,
                revision: record.revision,
              },
          finalCapabilityResults,
          finishedAt,
        )
      }
      if (succeeded && goalRecord) {
        await repository.refreshGoalProgress(goalRecord, finishedAt)
      }
      await input.backend.finishAgencyDispatch(
        input.tenantId,
        decision.idempotencyKey,
        reservationId,
        succeeded ? "dispatched" : "dead-letter",
        finishedAt,
        finalRunId,
      )
      await repository.saveState(
        createLoopState({
          ...runningState,
          health: succeeded ? "healthy" : "degraded",
          failures: succeeded ? 0 : runningState.failures + 1,
          updatedAt: new Date().toISOString(),
        }),
        "loop",
        new Date().toISOString(),
      )
      results.push({
        loopId: record.definition.id,
        decision: succeeded ? "dispatched" : "failed",
        reason: succeeded ? reason : `${reason}; dead-lettered after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const finishedAt = new Date().toISOString()
      await input.backend.finishAgencyDispatch(
        input.tenantId,
        decision.idempotencyKey,
        reservationId,
        "dead-letter",
        finishedAt,
      )
      results.push({ loopId: record.definition.id, decision: "failed", reason })
    }
  }
  return results
}

interface ResolvedTarget {
  reference: PinnedDefinitionRef & { kind: "workflow" | "capability" }
  intermediate: PinnedDefinitionRef[]
  job: Job
}

function resolveTarget(
  loop: LoopDefinition,
  catalog: Awaited<ReturnType<AgencyModelRepository["loadCatalog"]>>,
): ResolvedTarget {
  const goal = loop.targetRef.kind === "goal" ? catalog.goals.get(loop.targetRef.id) : undefined
  if (loop.targetRef.kind === "goal" && !goal) throw new Error(`Loop target Goal is missing: ${loop.targetRef.id}`)
  if (goal && goal.definition.operationId !== loop.operationId) {
    throw new Error(`Loop and target Goal must belong to the same Operation`)
  }
  const target = goal?.definition.executionRef ?? loop.targetRef
  if (target.kind === "goal") throw new Error("Nested Goal target is invalid")
  const record = target.kind === "workflow" ? catalog.workflows.get(target.id) : catalog.capabilities.get(target.id)
  if (!record) throw new Error(`Loop execution target is missing: ${target.kind}:${target.id}`)
  const reference = { kind: target.kind, id: target.id, revision: record.revision } as ResolvedTarget["reference"]
  return {
    reference,
    intermediate: goal ? [{ kind: "goal", id: goal.definition.id, revision: goal.revision }] : [],
    job:
      target.kind === "workflow"
        ? { workflow: target.id, cliArgs: {}, flavor: "scheduled" }
        : { capability: target.id, cliArgs: {}, flavor: "scheduled" },
  }
}

function terminalRun(
  active: Run,
  status: "succeeded" | "failed",
  finishedAt: string,
  usage: NonNullable<Run["usage"]>,
): Run {
  return createRun({ ...active, status, finishedAt, usage })
}

async function runAttempt(
  run: (
    job: Job,
    abortController: AbortController,
  ) => Promise<{
    exitCode: number
    reason?: string
    usage?: { tokens: number; costUsd: number }
    capabilityResults?: CapabilityResult[]
  }>,
  job: Job,
  timeoutSeconds: number,
): Promise<{
  exitCode: number
  reason?: string
  usage?: { tokens: number; costUsd: number }
  capabilityResults?: CapabilityResult[]
}> {
  const abortController = new AbortController()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      run(job, abortController).catch((error) => ({
        exitCode: 99,
        reason: error instanceof Error ? error.message : String(error),
      })),
      new Promise<{ exitCode: number; reason: string }>((resolve) => {
        timer = setTimeout(() => {
          abortController.abort()
          resolve({ exitCode: 124, reason: `target timed out after ${formatSeconds(timeoutSeconds)}s` })
        }, timeoutSeconds * 1_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function appendCapabilityOutputs(
  repository: AgencyModelRepository,
  runId: string,
  producer: ResolvedTarget["reference"],
  parentRef: PinnedDefinitionRef & { kind: "goal" | "loop" },
  results: readonly CapabilityResult[],
  createdAt: string,
): Promise<void> {
  for (const result of results) {
    const outputs: Array<{ kind: "fact" | "evidence" | "artifact"; key: string; value: unknown }> = [
      ...Object.entries(result.facts).map(([key, value]) => ({ kind: "fact" as const, key, value })),
      ...Object.entries(result.evidence ?? {}).map(([key, value]) => ({
        kind: "evidence" as const,
        key,
        value,
      })),
      ...result.artifacts.map((artifact, index) => ({
        kind: "artifact" as const,
        key: artifact.label || `artifact-${index + 1}`,
        value: artifact,
      })),
    ]
    for (const output of outputs) {
      await repository.appendOutput(`output-${randomUUID()}`, {
        ...output,
        runId,
        producer: { kind: producer.kind, id: producer.id },
        parentRef,
        contract: "capability-result/v1",
        createdAt,
      })
    }
  }
}

function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function repositoryTenant(config: KodyConfig): string | null {
  const owner = config.github?.owner?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[0]?.trim()
  const repo = config.github?.repo?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[1]?.trim()
  return owner && repo ? `${owner}/${repo}` : null
}
