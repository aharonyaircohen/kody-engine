import type { PostflightScript } from "../implementations/types.js"

export const parseSimpleCapabilityOutput: PostflightScript = async (ctx, _profile, agentResult) => {
  const envelope = parseEnvelope(agentResult?.finalText)
  if (!envelope) {
    ctx.output.exitCode = 64
    ctx.output.reason = "simple capability did not return its JSON output contract"
    return
  }
  const result = envelope.result
  const data = isObject(result.data) ? result.data : {}
  const summary = typeof result.summary === "string" ? result.summary : "Capability completed"
  const reason = typeof result.reason === "string" ? result.reason : summary
  const prUrl =
    stringValue(data.pullRequestUrl) ??
    stringValue(data.prUrl) ??
    stringValue(result.pullRequestUrl) ??
    stringValue(result.prUrl)
  if (prUrl) ctx.output.prUrl = prUrl
  ctx.output.reason = reason
  ctx.data.capabilityResults = [{
    version: 1,
    status: "changed",
    summary,
    facts: data,
    artifacts: prUrl ? [{ label: "Pull request", url: prUrl }] : [],
    missingEvidence: [],
    blockers: [],
  }]
}

function parseEnvelope(text: string | undefined): { result: Record<string, unknown> } | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (!isObject(parsed) || !isObject(parsed.result)) return null
    return { result: parsed.result }
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
