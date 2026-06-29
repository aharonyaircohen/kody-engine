import * as fs from "node:fs"
import * as path from "node:path"
import { getCompanyStoreAssetRoot } from "../companyStore.js"
import { type StateRepoConfig } from "../stateRepo.js"
import type { ManagedGoal } from "./manager.js"
import type { GoalState } from "./state.js"
import { fetchGoalState, listGoalStateIds, putGoalState } from "./stateStore.js"

export interface GoalLoopTargetResolution {
  targetId: string
  templateId: string
  reason: string
  created?: boolean
}

export function resolveGoalLoopTarget(
  config: StateRepoConfig,
  cwd: string,
  loopGoalId: string,
  loopGoal: ManagedGoal,
  now: Date,
): GoalLoopTargetResolution {
  const targetId = loopGoal.loopTarget?.id.trim() ?? ""
  assertSafeGoalId(targetId, "loop target")
  if (!hasExplicitStateRepo(config)) {
    return { targetId, templateId: targetId, reason: "literal target; state repo not configured" }
  }

  const activeInstance = findActiveTargetInstance(config, cwd, loopGoalId, targetId)
  if (activeInstance) {
    return {
      targetId: activeInstance.id,
      templateId: targetId,
      reason: "active target instance",
    }
  }

  const directTarget = fetchGoalState(config, targetId, cwd)
  if (directTarget?.state === "active") {
    return { targetId, templateId: targetId, reason: "active target goal" }
  }

  const template = loadGoalTemplate(cwd, targetId)
  if (!template) {
    if (directTarget) {
      throw new Error(`goal target ${targetId} is ${directTarget.state}; no active instance or template found`)
    }
    return { targetId, templateId: targetId, reason: "literal target; no target state or template found" }
  }

  const instanceId = chooseTargetInstanceId(config, cwd, targetId, loopGoal.preferredRunTime?.timezone, now)
  const instance = buildGoalTargetInstance(template, targetId, now)
  putGoalState(config, instanceId, instance, `chore(goals): create ${instanceId}`, cwd)
  return {
    targetId: instanceId,
    templateId: targetId,
    reason: "created target instance from template",
    created: true,
  }
}

export function goalLoopNow(): Date {
  const value = process.env.KODY_GOAL_LOOP_NOW?.trim()
  if (value) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }
  return new Date()
}

function hasExplicitStateRepo(config: StateRepoConfig): boolean {
  const state = config.state
  return (
    !!state &&
    typeof state.repo === "string" &&
    state.repo.trim().length > 0 &&
    typeof state.path === "string" &&
    state.path.trim().length > 0
  )
}

function findActiveTargetInstance(
  config: StateRepoConfig,
  cwd: string,
  loopGoalId: string,
  targetId: string,
): { id: string; state: GoalState } | null {
  const candidates: Array<{ id: string; state: GoalState }> = []

  for (const entryId of listGoalStateIds(config, cwd)) {
    const id = entryId.trim()
    if (!id || id === loopGoalId || id === targetId || !id.startsWith(`${targetId}-`)) continue
    assertSafeGoalId(id, "goal instance")
    const state = fetchGoalState(config, id, cwd)
    if (!state || state.state !== "active") continue
    if (!isTargetInstanceState(id, state, targetId)) continue
    candidates.push({ id, state })
  }

  candidates.sort(compareGoalInstanceAge)
  return candidates[0] ?? null
}

function isTargetInstanceState(id: string, state: GoalState, targetId: string): boolean {
  if (id.startsWith(`${targetId}-`)) return true
  return ["template", "sourceTemplate", "templateId", "type"].some((key) => state.extra[key] === targetId)
}

function compareGoalInstanceAge(a: { id: string; state: GoalState }, b: { id: string; state: GoalState }): number {
  const byTime = goalInstanceTime(a.state) - goalInstanceTime(b.state)
  return byTime === 0 ? a.id.localeCompare(b.id) : byTime
}

function goalInstanceTime(state: GoalState): number {
  const value = state.createdAt ?? state.startedAt ?? state.updatedAt
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function loadGoalTemplate(cwd: string, targetId: string): Record<string, unknown> | null {
  const local = path.join(cwd, ".kody", "goals", "templates", targetId, "state.json")
  const localTemplate = readJsonObject(local)
  if (localTemplate) return localTemplate

  const storeGoalRoot = getCompanyStoreAssetRoot("goals")
  if (!storeGoalRoot) return null
  return readJsonObject(path.join(storeGoalRoot, "templates", targetId, "state.json"))
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`goal template ${filePath} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function chooseTargetInstanceId(
  config: StateRepoConfig,
  cwd: string,
  targetId: string,
  timezone: string | undefined,
  now: Date,
): string {
  const base = `${targetId}-${zonedDate(now, timezone ?? "UTC")}`
  for (let index = 1; index <= 20; index += 1) {
    const id = index === 1 ? base : `${base}-${index}`
    assertSafeGoalId(id, "goal instance")
    const existing = fetchGoalState(config, id, cwd)
    if (!existing || existing.state === "active") return id
  }
  throw new Error(`could not allocate goal target instance id for ${targetId}`)
}

function buildGoalTargetInstance(template: Record<string, unknown>, targetId: string, now: Date): GoalState {
  const extra: Record<string, unknown> = { ...template }
  for (const key of ["state", "createdAt", "updatedAt", "startedAt"]) {
    delete extra[key]
  }
  extra.kind = "instance"
  extra.template = targetId
  extra.sourceTemplate = targetId
  extra.templateId = targetId
  if (!isPlainObject(extra.facts)) extra.facts = {}
  if (!Array.isArray(extra.blockers)) extra.blockers = []

  const at = isoNoMs(now)
  return {
    state: "active",
    createdAt: at,
    updatedAt: at,
    extra,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function assertSafeGoalId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${label} id must contain only letters, numbers, dot, underscore, or dash: ${value}`)
  }
}

function zonedDate(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date)
    const get = (type: string) => parts.find((part) => part.type === type)?.value
    const year = get("year")
    const month = get("month")
    const day = get("day")
    if (year && month && day) return `${year}-${month}-${day}`
  } catch {}
  return date.toISOString().slice(0, 10)
}

function isoNoMs(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}
