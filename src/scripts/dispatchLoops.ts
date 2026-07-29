import { randomUUID } from "node:crypto"
import type { KodyConfig } from "../config.js"
import type { Job, PreflightScript } from "../implementations/types.js"
import { runJob } from "../job.js"
import { type LoopDefinition, listLoopDefinitions } from "../loopDefinitions.js"
import { createStateBackendFromEnv, type StateBackend } from "../state-backend.js"

export interface LoopDispatchResult {
  loopId: string
  status: "skipped" | "dispatched" | "failed"
  reason: string
}

type LoopDispatchBackend = Pick<
  StateBackend,
  "createAgencyRun" | "finishAgencyRun" | "finishLoopDispatch" | "reserveLoopDispatch"
>

const LOOP_DISPATCH_LEASE_MS = 6 * 60 * 60 * 1_000

export const dispatchLoops: PreflightScript = async (ctx) => {
  const tenantId = repositoryTenant(ctx.config)
  if (!tenantId) throw new Error("Repository identity is required for Loop dispatch")
  const now = new Date()
  const force = ctx.data.jobForce === true
  const requestedLoopId = typeof ctx.args.loop === "string" ? ctx.args.loop.trim() : ""
  const due = selectRunnableLoops(listLoopDefinitions(ctx.cwd), now, {
    force,
    ...(requestedLoopId ? { loopId: requestedLoopId } : {}),
  })
  process.stdout.write(`→ kody: Loop scheduler found ${due.length} runnable Loop(s)${force ? " (manual)" : ""}\n`)
  const backend = createStateBackendFromEnv()
  const results = await dispatchLoopsWith({
    loops: due,
    tenantId,
    backend,
    now,
    force,
    nonce: randomUUID,
    run: (job, parentRunId) =>
      runJob(job, {
        cwd: ctx.cwd,
        config: ctx.config,
        verbose: ctx.verbose,
        quiet: ctx.quiet,
        chain: false,
        preloadedData: { parentRunId },
      }),
  })
  for (const result of results) {
    process.stdout.write(`→ kody: Loop ${result.loopId} ${result.status}: ${result.reason}\n`)
  }
  ctx.data.loopDispatchResults = results
  assertLoopDispatchesSucceeded(results)
}

export function assertLoopDispatchesSucceeded(results: readonly LoopDispatchResult[]): void {
  const failed = results.filter((result) => result.status === "failed")
  if (failed.length === 0) return
  throw new Error(
    `Loop dispatch failed: ${failed.map((result) => `${result.loopId}: ${result.reason}`).join("; ")}`,
  )
}

export async function dispatchLoopsWith(input: {
  loops: readonly LoopDefinition[]
  tenantId: string
  backend: LoopDispatchBackend
  now: Date
  force: boolean
  run: (job: Job, parentRunId: string) => Promise<{ exitCode: number; reason?: string }>
  nonce: () => string
}): Promise<LoopDispatchResult[]> {
  const results: LoopDispatchResult[] = []
  for (const loop of input.loops) {
    const slot = loopDispatchSlot(loop, input.now, input.force, input.nonce())
    if (!slot) continue
    const reservationId = `reservation-${input.nonce()}`
    const idempotencyKey = `${loop.id}:${slot}`
    const claimed = await input.backend.reserveLoopDispatch(input.tenantId, {
      idempotencyKey,
      loopId: loop.id,
      decision: {
        kind: "fire",
        reason: input.force ? "manual Loop run requested" : "local Loop schedule is due",
        scheduledAt: slot,
      },
      leaseUntil: new Date(input.now.getTime() + LOOP_DISPATCH_LEASE_MS).toISOString(),
      reservationId,
      correlationId: `corr-${input.nonce()}`,
      policyHash: `loop:${loop.id}`,
      effectivePolicy: { source: "repository" },
      definitionRefs: [{ kind: "loop", id: loop.id }],
      maxConcurrentRuns: 1,
      requiresApproval: false,
      approvalScopeKind: "loop",
      approvalScopeId: loop.id,
      approvalAction: `${loop.target.kind}:${loop.target.id}`,
      now: input.now.toISOString(),
    })
    if (!claimed.acquired) {
      results.push({ loopId: loop.id, status: "skipped", reason: claimed.reason ?? "already claimed" })
      continue
    }

    const runId = `loop-${loop.id}-${input.nonce()}`
    const startedAt = input.now.toISOString()
    const running = {
      id: runId,
      status: "running" as const,
      target: loop.target,
      agent: "kody",
      startedAt,
    }
    await input.backend.createAgencyRun(input.tenantId, "loop", loop.id, running, startedAt)

    let exitCode: number
    let reason: string
    try {
      const result = await input.run(loopJob(loop), runId)
      exitCode = result.exitCode
      reason = result.reason ?? (exitCode === 0 ? "dispatched" : "target failed")
    } catch (error) {
      exitCode = 1
      reason = error instanceof Error ? error.message : String(error)
    }

    const finishedAt = new Date().toISOString()
    const succeeded = exitCode === 0
    await input.backend.finishAgencyRun(
      input.tenantId,
      {
        ...running,
        status: succeeded ? "succeeded" : "failed",
        finishedAt,
        ...(succeeded ? { output: { summary: reason } } : { error: reason }),
      },
      finishedAt,
    )
    const status = succeeded ? "dispatched" : "failed"
    await input.backend.finishLoopDispatch(input.tenantId, idempotencyKey, reservationId, status, finishedAt, runId)
    results.push({ loopId: loop.id, status, reason })
  }
  return results
}

export function selectRunnableLoops(
  loops: readonly LoopDefinition[],
  now: Date,
  options: { force: boolean; loopId?: string },
): LoopDefinition[] {
  return loops.filter(
    (loop) =>
      loop.enabled &&
      (!options.loopId || loop.id === options.loopId) &&
      (options.force || (loop.trigger.type === "schedule" && dueSlot(loop, now) !== null)),
  )
}

export function loopDispatchSlot(loop: LoopDefinition, now: Date, force: boolean, nonce: string): string | null {
  return force ? `manual:${now.toISOString()}:${nonce}` : dueSlot(loop, now)
}

export function dueSlot(loop: LoopDefinition, now: Date): string | null {
  if (!loop.enabled || loop.trigger.type !== "schedule") return null
  const match = /^(\d+)([mhd])$/.exec(loop.trigger.every)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2]
  const milliseconds = amount * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000)
  const slot = Math.floor(now.getTime() / milliseconds) * milliseconds
  if (!loop.trigger.at) return new Date(slot).toISOString()

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: loop.trigger.at.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const hour = parts.find((part) => part.type === "hour")?.value
  const minute = parts.find((part) => part.type === "minute")?.value
  const [targetHour, targetMinute] = loop.trigger.at.time.split(":").map(Number)
  const localMinute = Number(hour) * 60 + Number(minute)
  const targetLocalMinute = Number(targetHour) * 60 + Number(targetMinute)
  const windowMinutes = Math.max(1, Math.ceil(Number(process.env.KODY_SCHEDULE_WINDOW_SEC || 300) / 60))
  if (localMinute < targetLocalMinute || localMinute >= targetLocalMinute + windowMinutes) return null
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value
  return `${year}-${month}-${day}T${loop.trigger.at.time}[${loop.trigger.at.timezone}]`
}

function loopJob(loop: LoopDefinition): Job {
  const cliArgs = Object.fromEntries(
    Object.entries(loop.input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
  )
  return loop.target.kind === "workflow"
    ? { workflow: loop.target.id, cliArgs, flavor: "scheduled" }
    : { capability: loop.target.id, cliArgs, flavor: "scheduled" }
}

function repositoryTenant(config: KodyConfig): string | null {
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY ?? "").split("/")
  const owner = config.github?.owner?.trim() || envOwner?.trim()
  const repo = config.github?.repo?.trim() || envRepo?.trim()
  return owner && repo ? `${owner}/${repo}` : null
}
