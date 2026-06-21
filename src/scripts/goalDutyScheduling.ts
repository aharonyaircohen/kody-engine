import * as path from "node:path"

import type { KodyConfig } from "../config.js"
import type { DutyFolder } from "../dutyFolders.js"
import type { ManagedGoal } from "../goal/manager.js"
import { mintScheduledJob } from "../job.js"
import { resolveDutyFolder } from "../registry.js"
import { type ScheduleEvery, scheduleEveryToMs } from "./scheduleEvery.js"
import { resolveBackend } from "./jobState/index.js"

export interface GoalDutyScheduleStatus {
  slug: string
  title?: string
  cadence?: ScheduleEvery
  lastFiredAt?: string
  nextEligibleAt?: string
  state: "due" | "waiting" | "manual" | "disabled" | "blocked"
  reason: string
}

export interface GoalDutyScheduleState {
  mode: "duty-cadence"
  lastGoalTickAt: string
  lastDecision:
    | { kind: "dispatch"; duty: string; executable: string; reason: string; at: string }
    | { kind: "idle"; reason: string; at: string }
    | { kind: "blocked"; reason: string; at: string }
  duties: Record<string, GoalDutyScheduleStatus>
}

export interface GoalDutyScheduleDecision {
  kind: "dispatch" | "idle" | "blocked"
  reason: string
  scheduleState: GoalDutyScheduleState
  dispatch?: {
    duty: string
    executable: string
    cliArgs: Record<string, unknown>
  }
}

interface PlanGoalDutyScheduleOptions {
  goal: ManagedGoal
  cwd: string
  config: KodyConfig
  jobsDir?: string
  now?: Date
  previousScheduleState?: GoalDutyScheduleState
}

export function isDutyCadenceGoal(goal: ManagedGoal, extra: Record<string, unknown>): boolean {
  return (
    extra.scheduleMode === "duty-cadence" ||
    extra.scheduler === "duty-cadence" ||
    (goal.type === "standing" && goal.duties.length > 0)
  )
}

export async function planGoalDutySchedule(opts: PlanGoalDutyScheduleOptions): Promise<GoalDutyScheduleDecision> {
  const now = opts.now ?? new Date()
  const at = now.toISOString()
  const jobsDir = opts.jobsDir ?? ".kody/duties"
  const jobsRoot = path.join(opts.cwd, jobsDir)
  const backend = resolveBackend({ config: opts.config, cwd: opts.cwd, jobsDir })
  const statuses: Record<string, GoalDutyScheduleStatus> = {}
  const blockers: string[] = []

  for (const slug of opts.goal.duties) {
    const duty = resolveDutyFolder(slug, jobsRoot)
    const status = await describeDutySchedule(
      duty,
      slug,
      backend,
      now.getTime(),
      opts.previousScheduleState?.duties[slug],
    )
    statuses[slug] = status
    if (status.state === "blocked") blockers.push(`${slug}: ${status.reason}`)
  }

  const due = opts.goal.duties
    .map((slug) => statuses[slug])
    .find((status): status is GoalDutyScheduleStatus => status?.state === "due")

  if (!due) {
    const reason = blockers.length > 0 ? "no runnable due duty; blocked duties need attention" : "no duty due now"
    const kind = blockers.length > 0 ? "blocked" : "idle"
    return {
      kind,
      reason,
      scheduleState: {
        mode: "duty-cadence",
        lastGoalTickAt: at,
        lastDecision: kind === "blocked" ? { kind: "blocked", reason, at } : { kind: "idle", reason, at },
        duties: statuses,
      },
    }
  }

  const duty = resolveDutyFolder(due.slug, jobsRoot)
  if (!duty) {
    const reason = `${due.slug}: duty folder missing`
    return {
      kind: "blocked",
      reason,
      scheduleState: {
        mode: "duty-cadence",
        lastGoalTickAt: at,
        lastDecision: { kind: "blocked", reason, at },
        duties: statuses,
      },
    }
  }

  const dispatch = dutyDispatch(duty)
  statuses[due.slug] = markDutySelected(statuses[due.slug]!, now)

  return {
    kind: "dispatch",
    reason: `dispatch ${due.slug}: ${due.reason}`,
    dispatch,
    scheduleState: {
      mode: "duty-cadence",
      lastGoalTickAt: at,
      lastDecision: {
        kind: "dispatch",
        duty: due.slug,
        executable: dispatch.executable,
        reason: due.reason,
        at,
      },
      duties: statuses,
    },
  }
}

async function describeDutySchedule(
  duty: DutyFolder | null,
  slug: string,
  backend: ReturnType<typeof resolveBackend>,
  now: number,
  previous?: GoalDutyScheduleStatus,
): Promise<GoalDutyScheduleStatus> {
  if (!duty) return { slug, state: "blocked", reason: "duty folder missing" }

  const { config } = duty
  if (config.disabled === true) {
    return { slug, title: duty.title, cadence: config.every, state: "disabled", reason: "disabled" }
  }
  if (config.every === "manual" || (!config.every && !config.staff && config.executable)) {
    return { slug, title: duty.title, cadence: config.every, state: "manual", reason: "manual only" }
  }
  if (!config.staff || config.staff.trim().length === 0) {
    return { slug, title: duty.title, cadence: config.every, state: "blocked", reason: "no staff assigned" }
  }
  if (config.executables && config.executables.length > 1) {
    return {
      slug,
      title: duty.title,
      cadence: config.every,
      state: "blocked",
      reason: "multi-executable duty needs task-jobs route",
    }
  }
  let lastFiredAt = validIso(previous?.lastFiredAt) ? previous?.lastFiredAt : undefined
  try {
    if (!lastFiredAt) {
      const loaded = await backend.load(slug)
      const raw = loaded.state.data?.lastFiredAt
      if (typeof raw === "string" && validIso(raw)) lastFiredAt = raw
    }
  } catch {
    return { slug, title: duty.title, cadence: config.every, state: "due", reason: "state unreadable; run to refresh" }
  }

  if (!config.every) {
    return { slug, title: duty.title, state: "due", reason: "no cadence; check every goal tick", lastFiredAt }
  }
  if (!lastFiredAt) {
    return { slug, title: duty.title, cadence: config.every, state: "due", reason: `first check for ${config.every}` }
  }

  const last = Date.parse(lastFiredAt)
  const interval = scheduleEveryToMs(config.every)
  const next = new Date(last + interval).toISOString()
  if (now - last >= interval) {
    return {
      slug,
      title: duty.title,
      cadence: config.every,
      state: "due",
      reason: `due ${config.every}`,
      lastFiredAt,
      nextEligibleAt: next,
    }
  }
  return {
    slug,
    title: duty.title,
    cadence: config.every,
    state: "waiting",
    reason: `next due ${next}`,
    lastFiredAt,
    nextEligibleAt: next,
  }
}

function dutyDispatch(duty: DutyFolder): { duty: string; executable: string; cliArgs: Record<string, unknown> } {
  const executable = duty.config.tickScript
    ? "duty-tick-scripted"
    : (duty.config.executable ?? duty.config.executables?.[0] ?? "duty-tick")
  const cliArgs = duty.config.executable || duty.config.executables?.[0] ? {} : { duty: duty.slug }
  return { duty: duty.slug, executable, cliArgs }
}

function validIso(value: string | undefined): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

function markDutySelected(status: GoalDutyScheduleStatus, now: Date): GoalDutyScheduleStatus {
  const lastFiredAt = now.toISOString()
  const nextEligibleAt =
    status.cadence && status.cadence !== "manual"
      ? new Date(now.getTime() + scheduleEveryToMs(status.cadence)).toISOString()
      : status.nextEligibleAt
  return { ...status, lastFiredAt, nextEligibleAt }
}
