import type { Job, JobFlavor, PreflightScript } from "../implementations/types.js"
import { stableJobKey, targetFromCliArgs } from "../jobIdentity.js"
import {
  emptyState,
  type PlannedTaskJob,
  type TaskState,
  type TaskTarget,
  upsertTaskJobs,
  writeTaskState,
} from "../state.js"

export const TASK_JOBS_MARKER = "kody:task-jobs:v1"

export interface TaskJobSpec {
  implementation: string
  capability?: string
  reason?: string
  agent?: string
  cliArgs?: Record<string, unknown>
  target?: number
  flavor?: JobFlavor
  schedule?: string
}

export function parseTaskJobSpecs(body: string): TaskJobSpec[] {
  const match = body.match(new RegExp(`<!--\\s*${TASK_JOBS_MARKER}\\s*([\\s\\S]*?)-->`))
  if (!match) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1]!.trim())
  } catch (err) {
    throw new Error(`task job plan is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!Array.isArray(parsed)) throw new Error("task job plan must be a JSON array")

  return parsed.map((entry, index) => normalizeSpec(entry, index))
}

export function taskJobSpecToJob(spec: TaskJobSpec, issueNumber: number): Job {
  const cliArgs = spec.cliArgs ?? { issue: issueNumber }
  const target = typeof spec.target === "number" ? spec.target : (targetFromCliArgs(cliArgs) ?? issueNumber)
  return {
    capability: spec.capability ?? spec.implementation,
    implementation: spec.implementation,
    why: spec.reason,
    agent: spec.agent,
    schedule: spec.schedule,
    target,
    cliArgs,
    flavor: spec.flavor ?? "instant",
  }
}

export const planTaskJobs: PreflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) {
    ctx.skipAgent = true
    ctx.output.exitCode = 64
    ctx.output.reason = "planTaskJobs requires --issue"
    return
  }

  const issue = ctx.data.issue as { body?: string } | undefined
  const specs = parseTaskJobSpecs(issue?.body ?? "")
  if (specs.length === 0) {
    ctx.skipAgent = true
    ctx.output.exitCode = 64
    ctx.output.reason = `no ${TASK_JOBS_MARKER} block found on issue #${issueNumber}`
    return
  }

  const jobs = specs.map((spec) => taskJobSpecToJob(spec, issueNumber))
  const planned = jobs.map(jobToPlannedTaskJob)
  assertUniqueJobIds(planned)

  const prior = (ctx.data.taskState as TaskState | undefined) ?? emptyState()
  const next = upsertTaskJobs(prior, planned, new Date().toISOString())
  ctx.data.taskState = next
  ctx.data.plannedTaskJobs = jobs
  ctx.data.plannedTaskJobIds = planned.map((job) => job.id)

  const target = ctx.data.commentTargetType as TaskTarget | undefined
  const number = ctx.data.commentTargetNumber as number | undefined
  if (target && number) writeTaskState(target, number, next, ctx.cwd, ctx.config)
}

function normalizeSpec(input: unknown, index: number): TaskJobSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`task job plan entry ${index} must be an object`)
  }
  const raw = input as Record<string, unknown>
  const implementation =
    typeof raw.implementation === "string" ? raw.implementation.trim() : ""
  if (!/^[a-z][a-z0-9-]*$/.test(implementation)) {
    throw new Error(`task job plan entry ${index} must have a valid implementation`)
  }
  const cliArgs = raw.cliArgs
  if (cliArgs !== undefined && (!cliArgs || typeof cliArgs !== "object" || Array.isArray(cliArgs))) {
    throw new Error(`task job plan entry ${index} cliArgs must be an object`)
  }
  const flavor = raw.flavor
  if (flavor !== undefined && flavor !== "instant" && flavor !== "scheduled") {
    throw new Error(`task job plan entry ${index} flavor must be "instant" or "scheduled"`)
  }
  return {
    implementation,
    ...(typeof raw.capability === "string" && raw.capability.trim() ? { capability: raw.capability.trim() } : {}),
    ...(typeof raw.reason === "string" && raw.reason.trim() ? { reason: raw.reason.trim() } : {}),
    ...(typeof raw.agent === "string" && raw.agent.trim() ? { agent: raw.agent.trim() } : {}),
    ...(typeof raw.agent === "string" && raw.agent.trim() ? { agent: raw.agent.trim() } : {}),
    ...(cliArgs ? { cliArgs: cliArgs as Record<string, unknown> } : {}),
    ...(typeof raw.target === "number" && Number.isFinite(raw.target) ? { target: raw.target } : {}),
    ...(flavor === "instant" || flavor === "scheduled" ? { flavor } : {}),
    ...(typeof raw.schedule === "string" && raw.schedule.trim() ? { schedule: raw.schedule.trim() } : {}),
  }
}

function jobToPlannedTaskJob(job: Job): PlannedTaskJob {
  const implementation = job.implementation ?? job.capability ?? "unknown"
  return {
    id: stableJobKey(job),
    implementation,
    capability: job.capability ?? job.action ?? "unknown",
    ...(job.agent ? { agent: job.agent } : {}),
    ...(job.flavor ? { flavor: job.flavor } : {}),
    ...(job.schedule ? { schedule: job.schedule } : {}),
    ...(typeof job.target === "number" ? { target: job.target } : {}),
    ...(job.why ? { reason: job.why } : {}),
  }
}

function assertUniqueJobIds(planned: PlannedTaskJob[]): void {
  const seen = new Set<string>()
  for (const job of planned) {
    if (seen.has(job.id)) throw new Error(`duplicate planned task job id: ${job.id}`)
    seen.add(job.id)
  }
}
