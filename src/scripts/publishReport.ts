import type { AgentResult } from "../agent.js"
import { type CapabilityResult, parseCapabilityResult, parseCapabilityResultsFromText } from "../capabilityResult.js"
import type { PostflightScript, ReportPublicationConfig } from "../implementations/types.js"
import { createStateBackendFromEnv } from "../state-backend.js"

const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/

interface RuntimeReportInput {
  generatedAt: string
  reportType: string
  reportTypeVersion: number
  owner: string
  capability: string
  title: string
  summary: string
  data: Record<string, unknown>
  reviewStatus?: string
  reviewArea?: string
}

export function buildRuntimeReportMarkdown(input: RuntimeReportInput): string {
  return [
    "---",
    `generatedAt: ${yamlString(input.generatedAt)}`,
    `reportType: ${input.reportType}`,
    `reportTypeVersion: ${input.reportTypeVersion}`,
    "producer:",
    `  model: ${input.owner}`,
    `  capability: ${input.capability}`,
    ...(input.reviewStatus ? [`reviewStatus: ${input.reviewStatus}`] : []),
    ...(input.reviewArea ? [`reviewArea: ${input.reviewArea}`] : []),
    "---",
    `# ${input.title}`,
    "",
    input.summary,
    "",
    "## Report data",
    "```json",
    JSON.stringify(input.data, null, 2),
    "```",
    "",
  ].join("\n")
}

export const publishReport: PostflightScript = async (ctx, _profile, agentResult) => {
  const publication = parsePublication(ctx.data.reportPublication)
  if (!publication) return
  const result = latestResult(ctx.data.capabilityResults, agentResult)
  const stateData = recordField(recordField(ctx.data.nextJobState)?.data) ?? {}
  const data = { ...stateData, ...(result?.facts ?? {}) }
  if (publication.publishWhenFact && resolveDotted(data, publication.publishWhenFact) === undefined) return

  const slug = publication.slug ?? stringValue(resolveDotted(data, publication.slugFact))
  if (!slug || !SAFE_SLUG.test(slug)) return
  const title = publication.title ?? stringValue(resolveDotted(data, publication.titleFact)) ?? humanize(slug)
  const generatedAt = new Date().toISOString()
  const markdown = buildRuntimeReportMarkdown({
    generatedAt,
    reportType: publication.type,
    reportTypeVersion: publication.version ?? 1,
    owner: publication.owner,
    capability: stringValue(ctx.data.jobCapability) ?? stringValue(ctx.data.capabilitySlug) ?? "unknown",
    title,
    summary: result?.summary ?? title,
    data,
    ...(publication.reviewStatus ? { reviewStatus: publication.reviewStatus } : {}),
    ...(publication.reviewArea ? { reviewArea: publication.reviewArea } : {}),
  })
  const runId = generatedAt.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")
  const tenantId =
    ctx.config.github?.owner && ctx.config.github.repo
      ? `${ctx.config.github.owner}/${ctx.config.github.repo}`
      : process.env.GITHUB_REPOSITORY
  if (process.env.CONVEX_URL?.trim() && process.env.KODY_SERVICE_KEY?.trim() && tenantId) {
    await createStateBackendFromEnv().saveReport(
      tenantId,
      slug,
      runId,
      title,
      markdown,
      {
        reportType: publication.type,
        reportTypeVersion: publication.version ?? 1,
        owner: publication.owner,
        capability: stringValue(ctx.data.jobCapability) ?? stringValue(ctx.data.capabilitySlug) ?? "unknown",
      },
      generatedAt,
    )
  } else if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("Convex backend is required for reports in GitHub Actions")
  }
}

function parsePublication(value: unknown): ReportPublicationConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.type !== "string" || !SAFE_SLUG.test(raw.type)) return null
  if (typeof raw.owner !== "string" || !SAFE_SLUG.test(raw.owner)) return null
  return raw as unknown as ReportPublicationConfig
}

function latestResult(raw: unknown, agentResult: AgentResult | null): CapabilityResult | null {
  const results: CapabilityResult[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseCapabilityResult(item)
      if (parsed) results.push(parsed)
    }
  }
  if (agentResult?.finalText) results.push(...parseCapabilityResultsFromText(agentResult.finalText))
  return results.at(-1) ?? null
}

function recordField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function resolveDotted(root: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined
  return path.split(".").reduce<unknown>((value, key) => recordField(value)?.[key], root)
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function humanize(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}
