import type { CapabilityResult } from "./capabilityResult.js"
import type { Profile } from "./executables/types.js"

export type AgencyBoundaryRule =
  | "observe-does-not-act"
  | "verify-does-not-fix"
  | "capability-does-not-own-goal-progress"

export type AgencyBoundaryStatus = "pass" | "fail"

export interface AgencyBoundaryFinding {
  rule: AgencyBoundaryRule
  status: AgencyBoundaryStatus
  message: string
  evidence: Record<string, unknown>
}

export interface AgencyBoundaryEval {
  version: 1
  status: AgencyBoundaryStatus
  capability?: string
  capabilityKind?: Profile["capabilityKind"]
  findings: AgencyBoundaryFinding[]
}

const ACTION_FACT_KEYS = new Set(["changedResources", "createdResources", "actionResult"])

export function evaluateAgencyBoundaries(input: {
  capability?: string
  capabilityKind?: Profile["capabilityKind"]
  results?: CapabilityResult[]
}): AgencyBoundaryEval {
  const findings: AgencyBoundaryFinding[] = []
  const results = input.results ?? []

  findings.push(evaluateObserveBoundary(input.capabilityKind, results))
  findings.push(evaluateVerifyBoundary(input.capabilityKind, results))
  findings.push(evaluateGoalOwnershipBoundary(results))

  return {
    version: 1,
    status: findings.some((finding) => finding.status === "fail") ? "fail" : "pass",
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.capabilityKind ? { capabilityKind: input.capabilityKind } : {}),
    findings,
  }
}

function evaluateObserveBoundary(
  capabilityKind: Profile["capabilityKind"],
  results: CapabilityResult[],
): AgencyBoundaryFinding {
  if (capabilityKind !== "observe") {
    return pass("observe-does-not-act", "capability is not observe", { capabilityKind })
  }
  const actionResults = results.filter(resultLooksLikeAction)
  if (actionResults.length === 0) {
    return pass("observe-does-not-act", "observe capability reported facts without action output", {
      resultCount: results.length,
    })
  }
  return fail("observe-does-not-act", "observe capability returned action-shaped output", {
    resultCount: results.length,
    actionResults: actionResults.map(resultSummary),
  })
}

function evaluateVerifyBoundary(
  capabilityKind: Profile["capabilityKind"],
  results: CapabilityResult[],
): AgencyBoundaryFinding {
  if (capabilityKind !== "verify") {
    return pass("verify-does-not-fix", "capability is not verify", { capabilityKind })
  }
  const actionResults = results.filter(resultLooksLikeAction)
  if (actionResults.length === 0) {
    return pass("verify-does-not-fix", "verify capability returned verdict evidence without action output", {
      resultCount: results.length,
    })
  }
  return fail("verify-does-not-fix", "verify capability returned fix/change output", {
    resultCount: results.length,
    actionResults: actionResults.map(resultSummary),
  })
}

function evaluateGoalOwnershipBoundary(results: CapabilityResult[]): AgencyBoundaryFinding {
  const targetBearing = results.filter((result) => result.target?.type === "goal")
  if (targetBearing.length === 0) {
    return pass("capability-does-not-own-goal-progress", "capability output is parent-neutral", {
      resultCount: results.length,
    })
  }
  return fail("capability-does-not-own-goal-progress", "capability output names a goal target", {
    resultCount: results.length,
    targetBearingResults: targetBearing.map(resultSummary),
  })
}

function resultLooksLikeAction(result: CapabilityResult): boolean {
  if (result.status === "changed") return true
  return Object.keys(result.facts).some((key) => ACTION_FACT_KEYS.has(key))
}

function resultSummary(result: CapabilityResult): Record<string, unknown> {
  return {
    status: result.status,
    summary: result.summary,
    target: result.target,
    actionFactKeys: Object.keys(result.facts).filter((key) => ACTION_FACT_KEYS.has(key)),
  }
}

function pass(rule: AgencyBoundaryRule, message: string, evidence: Record<string, unknown>): AgencyBoundaryFinding {
  return { rule, status: "pass", message, evidence }
}

function fail(rule: AgencyBoundaryRule, message: string, evidence: Record<string, unknown>): AgencyBoundaryFinding {
  return { rule, status: "fail", message, evidence }
}
