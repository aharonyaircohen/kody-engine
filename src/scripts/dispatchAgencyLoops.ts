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
  const results = await dispatchAgencyLoopsWith({
    tenantId,
    backend,
    now: new Date(),
    run: (job) => runJob(job, { cwd: ctx.cwd, config: ctx.config, verbose: ctx.verbose, quiet: ctx.quiet, chain: false }),
  })
  ctx.data.agencyLoopDispatchResults = results
}

export async function dispatchAgencyLoopsWith(input: {
  tenantId: string
  backend: StateBackend
  now: Date
  run: (job: Job) => Promise<{ exitCode: number; reason?: string; data?: Record<string, unknown> }>
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
    const decision = decideTrigger({ definition: record.definition, state: record.state, now: input.now })
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

    const leaseUntil = new Date(input.now.getTime() + 15 * 60_000).toISOString()
    const reservation = await input.backend.reserveAgencyDispatch(
      input.tenantId,
      decision.idempotencyKey,
      record.definition.id,
      decision,
      leaseUntil,
      now,
    )
    if (!reservation.acquired) {
      results.push({ loopId: record.definition.id, decision: "duplicate", reason: "trigger firing already reserved" })
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
    const runId = `run-${randomUUID()}`
    const correlationId = `corr-${randomUUID()}`
    const activeRun = createRun({
      id: runId,
      status: "running",
      origin: { kind: "loop", id: record.definition.id, revision: record.revision },
      target: target.reference,
      trace: [policy.trace[0], ...target.intermediate, target.reference],
      effectivePolicy: policy.snapshot,
      correlationId,
      startedAt: now,
    })

    try {
      await input.backend.createAgencyModelRun(
        input.tenantId,
        target.reference.kind,
        target.reference.id,
        activeRun,
        now,
      )
      const output = await input.run(target.job)
      const succeeded = output.exitCode === 0
      const finishedAt = new Date().toISOString()
      await input.backend.finishAgencyModelRun(
        input.tenantId,
        terminalRun(activeRun, succeeded ? "succeeded" : "failed", finishedAt),
        finishedAt,
      )
      await input.backend.finishAgencyDispatch(
        input.tenantId,
        decision.idempotencyKey,
        succeeded ? "dispatched" : "failed",
        finishedAt,
        runId,
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
        reason: output.reason ?? (succeeded ? "target dispatched" : "target failed"),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const finishedAt = new Date().toISOString()
      await input.backend
        .finishAgencyModelRun(input.tenantId, terminalRun(activeRun, "failed", finishedAt), finishedAt)
        .catch(() => undefined)
      await input.backend.finishAgencyDispatch(input.tenantId, decision.idempotencyKey, "failed", finishedAt, runId)
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

function terminalRun(active: Run, status: "succeeded" | "failed", finishedAt: string): Run {
  return createRun({ ...active, status, finishedAt })
}

function repositoryTenant(config: KodyConfig): string | null {
  const owner = config.github?.owner?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[0]?.trim()
  const repo = config.github?.repo?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[1]?.trim()
  return owner && repo ? `${owner}/${repo}` : null
}
