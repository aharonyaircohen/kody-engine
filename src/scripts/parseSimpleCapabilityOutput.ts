import type { PostflightScript } from "../implementations/types.js"

export const parseSimpleCapabilityOutput: PostflightScript = async (ctx, _profile, agentResult) => {
  const output = parseOutput(agentResult?.finalText)
  if (output === undefined) {
    ctx.output.exitCode = 64
    ctx.output.reason = "simple capability did not return one JSON value"
    return
  }
  ctx.data.capabilityOutput = output
  const result = isObject(output) ? output : {}
  const data = isObject(result.data) ? result.data : isObject(output) ? output : { output }
  const summary = typeof result.summary === "string" ? result.summary : "Capability completed"
  const reason = typeof result.reason === "string" ? result.reason : summary
  const prUrl =
    stringValue(data.pullRequestUrl) ??
    stringValue(data.prUrl) ??
    stringValue(result.pullRequestUrl) ??
    stringValue(result.prUrl)
  if (prUrl) ctx.output.prUrl = prUrl
  ctx.output.reason = reason
  ctx.data.capabilityResults = [
    {
      version: 1,
      status: "changed",
      summary,
      facts: data,
      artifacts: prUrl ? [{ label: "Pull request", url: prUrl }] : [],
      missingEvidence: [],
      blockers: [],
    },
  ]
}

function parseOutput(text: string | undefined): unknown | undefined {
  if (!text) return undefined
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? text
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
