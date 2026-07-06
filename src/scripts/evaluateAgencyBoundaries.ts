import { evaluateAgencyBoundaries } from "../agencyBoundaryEval.js"
import type { AgentResult } from "../agent.js"
import { type CapabilityResult, parseCapabilityResult, parseCapabilityResultsFromText } from "../capabilityResult.js"
import type { PostflightScript, Profile } from "../implementations/types.js"

export const evaluateAgencyBoundariesScript: PostflightScript = async (ctx, profile, agentResult) => {
  const results = collectResults(ctx.data.capabilityResults, agentResult)
  const capabilityKind = agencyBoundaryCapabilityKind(ctx.data, profile)
  const capability = agencyBoundaryCapability(ctx.data, profile)
  const evalResult = evaluateAgencyBoundaries({
    capability,
    capabilityKind,
    results,
  })
  ctx.data.agencyBoundaryEval = evalResult
  process.stdout.write(`KODY_AGENCY_BOUNDARY_EVAL=${JSON.stringify(evalResult)}\n`)
  if (evalResult.status === "fail") {
    const failed = evalResult.findings.filter((finding) => finding.status === "fail").map((finding) => finding.rule)
    ctx.output.exitCode = ctx.output.exitCode === 0 ? 99 : ctx.output.exitCode
    ctx.output.reason = ctx.output.reason
      ? `${ctx.output.reason}; agency boundary eval failed: ${failed.join(", ")}`
      : `agency boundary eval failed: ${failed.join(", ")}`
  }
}

export function shouldEvaluateAgencyBoundaries(data: Record<string, unknown>, profile: Profile): boolean {
  return Boolean(agencyBoundaryCapabilityKind(data, profile))
}

function agencyBoundaryCapability(data: Record<string, unknown>, profile: Profile): string {
  if (typeof data.jobCapability === "string" && data.jobCapability.length > 0) return data.jobCapability
  if (typeof data.capabilitySlug === "string" && data.capabilitySlug.length > 0) return data.capabilitySlug
  return profile.name
}

function agencyBoundaryCapabilityKind(
  data: Record<string, unknown>,
  profile: Profile,
): Profile["capabilityKind"] | undefined {
  const fromJob = data.jobCapabilityKind
  if (fromJob === "observe" || fromJob === "act" || fromJob === "verify") return fromJob
  return profile.capabilityKind
}

function collectResults(raw: unknown, agentResult: AgentResult | null): CapabilityResult[] {
  const out: CapabilityResult[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseCapabilityResult(item)
      if (parsed) out.push(parsed)
    }
  }
  if (agentResult?.finalText) out.push(...parseCapabilityResultsFromText(agentResult.finalText))
  return out
}
