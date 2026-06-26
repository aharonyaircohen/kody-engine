import type { PostflightScript } from "../executables/types.js"
import {
  buildAgentLoopState,
  buildManagedGoalState,
  type CompanyManagerAction,
  type CompanyManagerDecision,
} from "../companyManagerDecision.js"
import {
  appendCompanyIntentDecision,
  readCompanyIntent,
  writeCompanyGoalState,
  writeCompanyIntent,
} from "../companyIntent.js"
import { fetchGoalState } from "../goal/stateStore.js"
import { nowIso } from "../goal/state.js"

export interface AppliedCompanyManagerAction {
  kind: string
  intentId?: string
  resource?: string
  changed: boolean
  reason: string
}

export const applyCompanyManagerDecision: PostflightScript = async (ctx) => {
  const decision = ctx.data.companyManagerDecision as CompanyManagerDecision | undefined
  if (!decision || !Array.isArray(decision.actions)) return
  if (ctx.output.exitCode !== 0) return

  const applied: AppliedCompanyManagerAction[] = []
  for (const action of decision.actions) {
    applied.push(applyAction(ctx.config, ctx.cwd, action))
  }
  ctx.data.companyManagerApplied = applied
  ctx.data.companyManagerApplySummary = `company-manager applied ${applied.filter((item) => item.changed).length}/${applied.length} action(s)`
}

function applyAction(config: Parameters<PostflightScript>[0]["config"], cwd: string, action: CompanyManagerAction): AppliedCompanyManagerAction {
  if (action.kind === "createManagedGoal") {
    const existing = fetchGoalState(config, action.id, cwd)
    if (existing) return applied(action, false, "goal already exists")
    writeCompanyGoalState(config, cwd, action.id, buildManagedGoalState(action), `chore(goals): create ${action.id} from intent ${action.intentId}`)
    return applied(action, true, action.reason, action.id)
  }

  if (action.kind === "createAgentLoop") {
    const existing = fetchGoalState(config, action.id, cwd)
    if (existing) return applied(action, false, "loop already exists")
    writeCompanyGoalState(config, cwd, action.id, buildAgentLoopState(action), `chore(goals): create loop ${action.id} from intent ${action.intentId}`)
    return applied(action, true, action.reason, action.id)
  }

  if (action.kind === "setGoalLifecycle") {
    const state = fetchGoalState(config, action.id, cwd)
    if (!state) return applied(action, false, "goal/loop missing", action.id)
    const before = state.state
    if (before === action.state) return applied(action, false, "state already set", action.id)
    const next = {
      ...state,
      state: action.state,
      updatedAt: nowIso(),
      extra: {
        ...state.extra,
        lifecycleChangedByIntent: action.intentId,
        lifecycleChangeReason: action.reason,
      },
    }
    writeCompanyGoalState(config, cwd, action.id, next, `chore(goals): ${action.state} ${action.id} from intent ${action.intentId}`)
    return applied(action, true, action.reason, action.id)
  }

  if (action.kind === "updateIntentPortfolio") {
    const record = readCompanyIntent(config, cwd, action.intentId)
    if (!record) return applied(action, false, "intent missing")
    const intent = {
      ...record.intent,
      portfolio: {
        goals: mergeUnique(record.intent.portfolio.goals, action.goals ?? []),
        loops: mergeUnique(record.intent.portfolio.loops, action.loops ?? []),
        capabilities: mergeUnique(record.intent.portfolio.capabilities, action.capabilities ?? []),
      },
      updatedAt: nowIso(),
    }
    writeCompanyIntent(config, cwd, intent, `chore(intents): update ${action.intentId} portfolio`)
    return applied(action, true, action.reason)
  }

  if (action.kind === "note") {
    return {
      kind: action.kind,
      intentId: action.intentId,
      changed: false,
      reason: action.message,
    }
  }

  return { kind: "unknown", changed: false, reason: "unsupported action" }
}

function applied(
  action: CompanyManagerAction,
  changed: boolean,
  reason: string,
  resource?: string,
): AppliedCompanyManagerAction {
  return {
    kind: action.kind,
    intentId: "intentId" in action ? action.intentId : undefined,
    resource,
    changed,
    reason,
  }
}

function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])].sort()
}

export function logAppliedCompanyManagerActions(
  config: Parameters<PostflightScript>[0]["config"],
  cwd: string | undefined,
  appliedActions: AppliedCompanyManagerAction[],
): void {
  const at = nowIso()
  for (const action of appliedActions) {
    if (!action.intentId) continue
    appendCompanyIntentDecision(config, cwd, action.intentId, {
      at,
      agent: "cto",
      intentId: action.intentId,
      action: action.kind,
      reason: action.reason,
      after: { changed: action.changed },
      resources: action.resource ? [action.resource] : [],
    })
  }
}
