import type { AgentResult } from "../agent.js"
import { type CapabilityResult, parseCapabilityResult, parseCapabilityResultsFromText } from "../capabilityResult.js"
import type { KodyConfig } from "../config.js"
import type { PostflightScript, ReportPublicationConfig, WorkflowRunState } from "../implementations/types.js"
import { createStateBackendFromEnv, hasStateBackendConfig } from "../state-backend.js"

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

interface WorkflowReportInput {
  config: KodyConfig
  publication: ReportPublicationConfig
  workflowId: string
  workflowTitle: string
  state: WorkflowRunState
}

export function buildRuntimeReportMarkdown(input: RuntimeReportInput): string {
  const lines = [
    `# ${input.title}`,
    "",
    input.summary,
    "",
    "## About",
    markdownField("Type", input.reportType),
    markdownField("Version", input.reportTypeVersion),
    markdownField("Generated", input.generatedAt),
    markdownField("Owner", input.owner),
    markdownField("Capability", input.capability),
    ...(input.reviewStatus ? [markdownField("Review status", input.reviewStatus)] : []),
    ...(input.reviewArea ? [markdownField("Review area", input.reviewArea)] : []),
    "",
    ...renderReportData(input.data),
  ]
  return `${lines.join("\n").trimEnd()}\n`
}

function renderReportData(data: Record<string, unknown>): string[] {
  const lines: string[] = []
  const workflow = recordField(data.workflow)
  const finding = recordField(data.finding)
  const observation = recordField(data.observation)
  const learning = recordField(data.learning)

  if (workflow) lines.push(...renderWorkflow(workflow))
  if (finding) lines.push(...renderFinding(finding))
  if (observation) lines.push(...renderObservation(observation))
  if (learning) lines.push(...renderLearning(learning))

  const rest = omitKeys(data, ["workflow", "finding", "observation", "learning"])
  if (Object.keys(rest).length > 0) {
    lines.push("## Results", ...renderObjectFields(rest, 3), "")
  }
  return lines
}

function renderWorkflow(workflow: Record<string, unknown>): string[] {
  const lines = ["## Run"]
  pushField(lines, "Status", workflow.status)
  pushField(lines, "Blocker", workflow.blocker)

  const completed = stringArray(workflow.completedStepIds)
  if (completed.length > 0) {
    lines.push("", "## Completed checks", ...completed.map((step) => `- ${humanize(step)}`))
  }

  const facts = recordField(workflow.facts) ?? {}
  const finding = recordField(facts.finding)
  const observation = recordField(facts.observation)
  if (finding) lines.push("", ...renderFinding(finding))
  if (observation) lines.push("", ...renderObservation(observation))

  const remainingFacts = omitKeys(facts, ["finding", "observation"])
  if (Object.keys(remainingFacts).length > 0) {
    lines.push("", "## Results", ...renderObjectFields(remainingFacts, 3))
  }

  const artifacts = Array.isArray(workflow.artifacts) ? workflow.artifacts : []
  const evidence = renderEvidence(artifacts)
  if (evidence.length > 0) lines.push("", "## Evidence", ...evidence)
  lines.push("")
  return lines
}

function renderFinding(finding: Record<string, unknown>): string[] {
  const lines = ["## Finding"]
  for (const [label, key] of [
    ["ID", "id"],
    ["Status", "status"],
    ["Severity", "severity"],
    ["Observer", "observerId"],
    ["Subject", "subject"],
    ["Expected", "expectation"],
    ["Actual", "actual"],
    ["Observation ID", "observationId"],
    ["Observed", "observedAt"],
    ["Operator activity", "operatorActivityAt"],
  ] as const) {
    pushField(lines, label, finding[key])
  }
  lines.push("")
  return lines
}

function renderObservation(observation: Record<string, unknown>): string[] {
  const lines = ["## Observation"]
  for (const [label, key] of [
    ["ID", "id"],
    ["Status", "status"],
    ["Summary", "summary"],
    ["Observer", "observerId"],
    ["Capability", "capability"],
    ["Subject", "subject"],
    ["Observed", "observedAt"],
  ] as const) {
    pushField(lines, label, observation[key])
  }
  const evidence = renderEvidence(Array.isArray(observation.evidence) ? observation.evidence : [])
  if (evidence.length > 0) lines.push("", "### Evidence", ...evidence)
  lines.push("")
  return lines
}

function renderLearning(learning: Record<string, unknown>): string[] {
  const lines = ["## Learning"]
  for (const [label, key] of [
    ["ID", "id"],
    ["Finding ID", "findingId"],
    ["Summary", "summary"],
    ["Change", "change"],
    ["Evidence", "evidence"],
  ] as const) {
    pushField(lines, label, learning[key])
  }
  lines.push("")
  return lines
}

function renderObjectFields(value: Record<string, unknown>, headingLevel: number): string[] {
  const lines: string[] = []
  for (const [key, item] of Object.entries(value)) {
    const label = humanize(key)
    if (isScalar(item)) {
      lines.push(markdownField(label, item))
      continue
    }
    if (Array.isArray(item)) {
      if (item.length === 0) continue
      lines.push(`${"#".repeat(Math.min(headingLevel, 6))} ${label}`)
      for (const entry of item) {
        if (isScalar(entry)) lines.push(`- ${markdownValue(entry)}`)
        else if (recordField(entry)) lines.push(...renderObjectFields(recordField(entry)!, headingLevel + 1))
      }
      continue
    }
    const record = recordField(item)
    if (!record || Object.keys(record).length === 0) continue
    lines.push(`${"#".repeat(Math.min(headingLevel, 6))} ${label}`, ...renderObjectFields(record, headingLevel + 1))
  }
  return lines
}

function renderEvidence(items: unknown[]): string[] {
  return items.flatMap((item) => {
    const record = recordField(item)
    if (!record) return []
    const label = stringValue(record.label) ?? stringValue(record.kind) ?? "Evidence"
    const url = stringValue(record.url)
    const status = stringValue(record.status)
    const suffix = status ? ` — ${humanize(status)}` : ""
    return [`- ${url ? `[${label}](${url})` : label}${suffix}`]
  })
}

function omitKeys(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const omitted = new Set(keys)
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)))
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function isScalar(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value)
}

function pushField(lines: string[], label: string, value: unknown): void {
  if (isScalar(value) && value !== undefined && value !== null && value !== "") {
    lines.push(markdownField(label, value))
  }
}

function markdownField(label: string, value: string | number | boolean | null | undefined): string {
  return `- **${label}:** ${markdownValue(value)}`
}

function markdownValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "None"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return String(value).replace(/\r?\n/g, " ").trim()
}

export const publishReport: PostflightScript = async (ctx, _profile, agentResult) => {
  const publication = parsePublication(ctx.data.reportPublication)
  if (!publication) return
  const result = latestResult(ctx.data.capabilityResults, agentResult)
  const stateData = recordField(recordField(ctx.data.nextJobState)?.data) ?? {}
  const resultFacts = { ...(result?.facts ?? {}) }
  const nestedResultFacts = recordField(resultFacts.facts) ?? {}
  if (Object.keys(nestedResultFacts).length > 0) delete resultFacts.facts
  const capabilityFacts = recordField(recordField(ctx.data.capabilityOutput)?.facts) ?? {}
  const data = { ...stateData, ...resultFacts, ...nestedResultFacts, ...capabilityFacts }
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
  if (hasStateBackendConfig() && tenantId) {
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
    throw new Error("Kody backend access is required for reports in GitHub Actions")
  }
}

export async function publishWorkflowReport(input: WorkflowReportInput): Promise<void> {
  const slug = input.publication.slug
  if (!slug || !SAFE_SLUG.test(slug)) return
  const tenantId =
    input.config.github?.owner && input.config.github.repo
      ? `${input.config.github.owner}/${input.config.github.repo}`
      : process.env.GITHUB_REPOSITORY
  if (!tenantId) return

  const generatedAt = new Date().toISOString()
  const title = input.publication.title ?? input.workflowTitle
  const summary =
    input.state.status === "done"
      ? `${input.workflowTitle} completed`
      : `${input.workflowTitle} ${input.state.status}${input.state.blocker ? `: ${input.state.blocker}` : ""}`
  const markdown = buildRuntimeReportMarkdown({
    generatedAt,
    reportType: input.publication.type,
    reportTypeVersion: input.publication.version ?? 1,
    owner: input.publication.owner,
    capability: input.workflowId,
    title,
    summary,
    data: {
      workflow: {
        id: input.workflowId,
        status: input.state.status,
        completedStepIds: input.state.completedStepIds,
        transitionCounts: input.state.transitionCounts,
        facts: input.state.facts,
        evidence: input.state.evidence,
        artifacts: input.state.artifacts,
        ...(input.state.blocker ? { blocker: input.state.blocker } : {}),
      },
    },
    ...(input.publication.reviewStatus ? { reviewStatus: input.publication.reviewStatus } : {}),
    ...(input.publication.reviewArea ? { reviewArea: input.publication.reviewArea } : {}),
  })
  const runId = generatedAt.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")
  if (hasStateBackendConfig()) {
    await createStateBackendFromEnv().saveReport(
      tenantId,
      slug,
      runId,
      title,
      markdown,
      {
        reportType: input.publication.type,
        reportTypeVersion: input.publication.version ?? 1,
        owner: input.publication.owner,
        capability: input.workflowId,
      },
      generatedAt,
    )
  } else if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("Kody backend access is required for reports in GitHub Actions")
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
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}
