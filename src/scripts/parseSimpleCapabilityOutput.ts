import * as fs from "node:fs"
import { validateCapabilityContractOutput } from "../agency/capability-contract-validation.js"
import { parseCapabilityResult } from "../capabilityResult.js"
import type { PostflightScript } from "../implementations/types.js"

export const parseSimpleCapabilityOutput: PostflightScript = async (ctx, profile, agentResult) => {
  const providerFailure = modelProviderFailureReason(agentResult)
  if (providerFailure) {
    ctx.output.exitCode = 1
    ctx.output.reason = providerFailure
    ctx.data.capabilityOutput = { status: "blocked", reason: providerFailure, summary: providerFailure }
    ctx.data.capabilityResults = [
      {
        version: 1,
        status: "blocked",
        summary: providerFailure,
        facts: {},
        artifacts: [],
        missingEvidence: [],
        blockers: [providerFailure],
      },
    ]
    return
  }
  const requiredSubagents = stringList(ctx.data.requiredSubagents)
  const invokedSubagents = new Set(agentResult?.invokedSubagents ?? [])
  const missingSubagents = requiredSubagents.filter((name) => !invokedSubagents.has(name))
  if (missingSubagents.length > 0) {
    const label = missingSubagents.length === 1 ? "specialist was" : "specialists were"
    const reason = `Required ${label} not invoked: ${missingSubagents.join(", ")}`
    ctx.output.exitCode = 64
    ctx.output.reason = reason
    ctx.data.capabilityOutput = { status: "blocked", reason, summary: reason }
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
  const outputPath = typeof ctx.data.capabilityOutputPath === "string" ? ctx.data.capabilityOutputPath : undefined
  const fileOutput = readOutputFile(outputPath)
  const hasScriptOutput = Object.hasOwn(ctx.data, "capabilityScriptOutput")
  let output = fileOutput.found
    ? fileOutput.value
    : hasScriptOutput
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
    ctx.output.exitCode = 1
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
      validateCapabilityContractOutput(outputSchema, output)
    } catch (error) {
      const unwrapped = unwrapSingleOutput(output)
      if (unwrapped !== undefined) {
        try {
          validateCapabilityContractOutput(outputSchema, unwrapped)
          output = unwrapped
        } catch {
          return blockInvalidContractOutput(ctx, output, error)
        }
      } else {
        return blockInvalidContractOutput(ctx, output, error)
      }
    }
  }
  if (fileOutput.found || hasScriptOutput) acceptAuthoritativeCapabilityOutput(ctx, profile, output)
  ctx.data.capabilityOutput = output
  const structuredResult = parseCapabilityResult(output)
  if (structuredResult) {
    if (
      (structuredResult.status === "fail" || structuredResult.status === "blocked") &&
      (ctx.output.exitCode === undefined || ctx.output.exitCode === 0)
    ) {
      ctx.output.exitCode = 1
    }
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

function acceptAuthoritativeCapabilityOutput(
  ctx: Parameters<PostflightScript>[0],
  profile: Parameters<PostflightScript>[1],
  output: unknown,
): void {
  ctx.data.agentDone = true
  delete ctx.data.agentFailureReason
  const summary = isObject(output) && typeof output.summary === "string" ? output.summary.trim() : ""
  if (summary && !ctx.data.prSummary) ctx.data.prSummary = summary
  const mode = typeof ctx.args?.mode === "string" ? ctx.args.mode : profile.name || "capability"
  ctx.data.action = {
    type: `${mode.replace(/-/g, "_").toUpperCase()}_COMPLETED`,
    payload: {},
    timestamp: new Date().toISOString(),
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function readOutputFile(outputPath: string | undefined): { found: boolean; value?: unknown } {
  if (!outputPath || !fs.existsSync(outputPath)) return { found: false }
  try {
    return { found: true, value: JSON.parse(fs.readFileSync(outputPath, "utf-8")) }
  } finally {
    fs.rmSync(outputPath, { force: true })
  }
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

  const finalStatusOutput = parseSingleJsonCandidate(
    [...text.matchAll(/<final_status>\s*([\s\S]*?)\s*<\/final_status>/gi)].map((match) => match[1]),
  )
  if (finalStatusOutput.found) return finalStatusOutput.value

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

function unwrapSingleOutput(value: unknown): unknown | undefined {
  if (!isObject(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "output")) return undefined
  const wrapped = value.output
  if (typeof wrapped !== "string") return wrapped
  return parseOutput(wrapped)
}

function modelProviderFailureReason(agentResult: Parameters<PostflightScript>[2]): string | undefined {
  if (agentResult?.outcome !== "failed") return undefined
  if (agentResult.outcomeKind === "rate_limit") {
    return "Model provider rate limit prevented the run from starting"
  }
  if (agentResult.outcomeKind !== "model_error") return undefined

  const raw = agentResult.error || agentResult.finalText
  const encodedMessage = raw.match(/"message"\s*:\s*("(?:\\.|[^"\\])*")/)?.[1]
  if (encodedMessage) {
    try {
      const message = JSON.parse(encodedMessage)
      if (typeof message === "string" && message.trim()) return `Model provider blocked the run: ${message.trim()}`
    } catch {}
  }
  return "Model provider failed before returning a result"
}

function blockInvalidContractOutput(ctx: Parameters<PostflightScript>[0], output: unknown, error: unknown): undefined {
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
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
