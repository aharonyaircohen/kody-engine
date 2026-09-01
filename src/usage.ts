import * as fs from "node:fs"

export interface TokenBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  total: number
}

export type UsageMeasurement = "reported" | "partial" | "unknown"

export interface ModelRunUsage {
  tokens: TokenBreakdown
  costUsd: number
  agentRuns: number
  turns: number
  measurement: UsageMeasurement
}

/** Provider-neutral usage returned by one capability, workflow, or container run. */
export interface RunUsage extends ModelRunUsage {
  version: 1
  byModel: Record<string, ModelRunUsage>
}

interface RawTokenUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreate?: number
}

interface RawModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function tokenBreakdown(tokens: RawTokenUsage | undefined): TokenBreakdown {
  const input = safeNumber(tokens?.input)
  const output = safeNumber(tokens?.output)
  const cacheRead = safeNumber(tokens?.cacheRead)
  const cacheCreate = safeNumber(tokens?.cacheCreate)
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate }
}

function addTokenBreakdown(left: TokenBreakdown, right: TokenBreakdown): TokenBreakdown {
  const input = left.input + right.input
  const output = left.output + right.output
  const cacheRead = left.cacheRead + right.cacheRead
  const cacheCreate = left.cacheCreate + right.cacheCreate
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate }
}

export function createRunUsage(
  tokens: RawTokenUsage | undefined,
  costUsd: number | undefined,
  details: {
    model?: string
    turns?: number
    modelUsage?: Record<string, RawModelUsage>
    outcome?: "completed" | "failed"
  } = {},
): RunUsage | undefined {
  if (!tokens && costUsd === undefined && details.turns === undefined) return undefined
  const normalizedTokens = tokenBreakdown(tokens)
  const hasBillableUsage = normalizedTokens.total > 0 || safeNumber(costUsd) > 0
  const measurement: UsageMeasurement = details.outcome === "failed" && !hasBillableUsage ? "unknown" : "reported"
  const modelUsage: ModelRunUsage = {
    tokens: normalizedTokens,
    costUsd: safeNumber(costUsd),
    agentRuns: 1,
    turns: safeNumber(details.turns),
    measurement,
  }
  const reportedModels = Object.entries(details.modelUsage ?? {})
  const byModel =
    reportedModels.length > 0
      ? Object.fromEntries(
          reportedModels.map(([model, usage]) => {
            const modelTokens = tokenBreakdown({
              input: usage.inputTokens,
              output: usage.outputTokens,
              cacheRead: usage.cacheReadInputTokens,
              cacheCreate: usage.cacheCreationInputTokens,
            })
            return [
              model,
              {
                tokens: modelTokens,
                costUsd: safeNumber(usage.costUSD),
                agentRuns: 1,
                turns: reportedModels.length === 1 ? safeNumber(details.turns) : 0,
                measurement,
              },
            ]
          }),
        )
      : details.model
        ? { [details.model]: modelUsage }
        : {}
  return {
    version: 1,
    ...modelUsage,
    byModel,
  }
}

function isModelRunUsage(value: unknown): value is ModelRunUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const usage = value as ModelRunUsage
  if (!usage.tokens || typeof usage.tokens !== "object" || Array.isArray(usage.tokens)) return false
  return [
    usage.tokens.input,
    usage.tokens.output,
    usage.tokens.cacheRead,
    usage.tokens.cacheCreate,
    usage.tokens.total,
    usage.costUsd,
    usage.agentRuns,
    usage.turns,
  ].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0)
}

function isUsageMeasurement(value: unknown): value is UsageMeasurement {
  return value === "reported" || value === "partial" || value === "unknown"
}

function mergeMeasurement(left?: UsageMeasurement, right?: UsageMeasurement): UsageMeasurement {
  const normalizedLeft = left ?? "reported"
  const normalizedRight = right ?? "reported"
  if (normalizedLeft === normalizedRight) return normalizedLeft
  return "partial"
}

export function parseRunUsage(value: unknown): RunUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const usage = value as RunUsage
  if (usage.version !== 1 || !isModelRunUsage(usage)) return undefined
  if (!usage.byModel || typeof usage.byModel !== "object" || Array.isArray(usage.byModel)) return undefined
  if (!Object.values(usage.byModel).every(isModelRunUsage)) return undefined
  const normalized = structuredClone(usage)
  normalized.measurement = isUsageMeasurement(usage.measurement) ? usage.measurement : "reported"
  for (const [model, modelUsage] of Object.entries(normalized.byModel)) {
    modelUsage.measurement = isUsageMeasurement(usage.byModel[model]?.measurement)
      ? usage.byModel[model]!.measurement
      : "reported"
  }
  return normalized
}

export function mergeRunUsage(left: RunUsage | undefined, right: RunUsage | undefined): RunUsage | undefined {
  if (!left) return right ? structuredClone(right) : undefined
  if (!right) return structuredClone(left)
  const byModel: Record<string, ModelRunUsage> = {}
  for (const model of new Set([...Object.keys(left.byModel), ...Object.keys(right.byModel)])) {
    const first = left.byModel[model]
    const second = right.byModel[model]
    if (!first) {
      byModel[model] = structuredClone(second!)
    } else if (!second) {
      byModel[model] = structuredClone(first)
    } else {
      byModel[model] = {
        tokens: addTokenBreakdown(first.tokens, second.tokens),
        costUsd: first.costUsd + second.costUsd,
        agentRuns: first.agentRuns + second.agentRuns,
        turns: first.turns + second.turns,
        measurement: mergeMeasurement(first.measurement, second.measurement),
      }
    }
  }
  return {
    version: 1,
    tokens: addTokenBreakdown(left.tokens, right.tokens),
    costUsd: left.costUsd + right.costUsd,
    agentRuns: left.agentRuns + right.agentRuns,
    turns: left.turns + right.turns,
    measurement: mergeMeasurement(left.measurement, right.measurement),
    byModel,
  }
}

export function formatRunUsageMarker(subject: string, usage: RunUsage): string {
  return `KODY_USAGE=${JSON.stringify({ subject, ...usage })}`
}

/** Best-effort durable summary for GitHub Actions; callers still keep usage in their typed result. */
export function appendRunUsageSummary(summaryPath: string | undefined, subject: string, usage: RunUsage): void {
  if (!summaryPath) return
  const tokens = usage.tokens
  const tokenLine =
    usage.measurement === "unknown"
      ? "- **Tokens:** usage unknown (provider did not report billable usage)"
      : `- **${usage.measurement === "partial" ? "Known tokens" : "Tokens"}:** ${tokens.input.toLocaleString()} input / ${tokens.cacheRead.toLocaleString()} cache-read / ${tokens.cacheCreate.toLocaleString()} cache-create / ${tokens.output.toLocaleString()} output / ${tokens.total.toLocaleString()} total${usage.measurement === "partial" ? "; some child usage is unknown" : ""}`
  const costLine =
    usage.measurement === "unknown"
      ? "- **Provider-reported cost:** unknown"
      : `- **Provider-reported cost:** $${usage.costUsd.toFixed(4)}${usage.measurement === "partial" ? " known; some child cost is unknown" : ""}`
  const lines = [
    `### Kody usage - ${subject}`,
    "",
    tokenLine,
    `- **Agent work:** ${usage.agentRuns.toLocaleString()} runs / ${usage.turns.toLocaleString()} turns`,
    costLine,
    "",
  ]
  try {
    fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`)
  } catch {
    // Usage evidence must never break the requested work.
  }
}

export function publishRunUsage(subject: string, usage: RunUsage | undefined): void {
  if (!usage) return
  process.stdout.write(`${formatRunUsageMarker(subject, usage)}\n`)
  appendRunUsageSummary(process.env.GITHUB_STEP_SUMMARY, subject, usage)
}
