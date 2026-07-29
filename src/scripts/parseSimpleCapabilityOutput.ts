import { validateCapabilityContractValue } from "../agency/capability-contract-validation.js"
import { parseCapabilityResult } from "../capabilityResult.js"
import type { PostflightScript } from "../implementations/types.js"

export const parseSimpleCapabilityOutput: PostflightScript = async (ctx, _profile, agentResult) => {
  const output = Object.hasOwn(ctx.data, "capabilityScriptOutput")
    ? ctx.data.capabilityScriptOutput
    : parseOutput(agentResult?.finalText)
  if (output === undefined) {
    const reason =
      agentResult?.outcomeKind === "out_of_turns"
        ? "Capability execution limit reached"
        : "Capability execution ended before returning a result"
    const blocked = {
      status: "blocked",
      reason,
      summary: reason,
    }
    ctx.output.reason = reason
    ctx.data.capabilityOutput = blocked
    ctx.data.capabilityResults = [
      {
        version: 1,
        status: "blocked",
        summary: reason,
        facts: blocked,
        artifacts: [],
        missingEvidence: [],
        blockers: [reason],
      },
    ]
    return
  }
  const outputSchema = isObject(ctx.data.capabilityOutputSchema) ? ctx.data.capabilityOutputSchema : undefined
  if (outputSchema) {
    try {
      validateCapabilityContractValue("output", outputSchema, output)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      ctx.output.exitCode = 64
      ctx.output.reason = reason
      ctx.data.capabilityOutput = output
      ctx.data.capabilityResults = [
        {
          version: 1,
          status: "blocked",
          summary: reason,
          facts: {},
          artifacts: [],
          missingEvidence: [],
          blockers: [reason],
        },
      ]
      return
    }
  }
  ctx.data.capabilityOutput = output
  const structuredResult = parseCapabilityResult(output)
  if (structuredResult) {
    ctx.output.reason = structuredResult.summary
    ctx.data.capabilityResults = [structuredResult]
    return
  }
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
  try {
    return JSON.parse(text)
  } catch {
    // Continue with fenced output.
  }

  const fences = [...text.matchAll(/```([a-z0-9_-]+)?\s*([\s\S]*?)\s*```/gi)]
  const jsonFences = fences.filter((match) => match[1]?.toLowerCase() === "json")
  const labelledOutput = parseSingleJsonCandidate(jsonFences.map((match) => match[2]))
  if (labelledOutput.found) return labelledOutput.value

  const plainOutput = parseSingleJsonCandidate(fences.filter((match) => !match[1]).map((match) => match[2]))
  if (plainOutput.found) return plainOutput.value

  // Older capabilities return useful prose (for example DONE/PR_SUMMARY)
  // instead of the newer JSON envelope. Preserve that result at the engine
  // boundary so one legacy capability cannot abort an entire workflow.
  const legacyText = text.trim()
  return legacyText ? { summary: legacyText, output: legacyText } : undefined
}

function parseSingleJsonCandidate(candidates: Array<string | undefined>): { found: boolean; value?: unknown } {
  const parsed: unknown[] = []
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      parsed.push(JSON.parse(candidate))
    } catch {
      // Non-JSON fences may explain the result; they are not capability output.
    }
  }
  return parsed.length === 1 ? { found: true, value: parsed[0] } : { found: false }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
