import { evaluateAgencyBoundaries } from "../agencyBoundaryEval.js"
import type { AgentResult } from "../agent.js"
import { type CapabilityResult, parseCapabilityResult, parseCapabilityResultsFromText } from "../capabilityResult.js"
import type { PostflightScript } from "../executables/types.js"

export const evaluateAgencyBoundariesScript: PostflightScript = async (ctx, profile, agentResult) => {
  const results = collectResults(ctx.data.capabilityResults ?? ctx.data.dutyResults, agentResult)
  const evalResult = evaluateAgencyBoundaries({
    capability: profile.name,
    capabilityKind: profile.capabilityKind,
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
