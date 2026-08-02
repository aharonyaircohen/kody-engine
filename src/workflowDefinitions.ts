import * as fs from "node:fs"
import * as path from "node:path"
import type { CapabilityFolder, CapabilityWorkflowConfig, CapabilityWorkflowStepConfig } from "./capabilityFolders.js"
import { parseCapabilityWorkflow } from "./capabilityFolders.js"
import { definitionsRoot } from "./definition-paths.js"
import type { ReportPublicationConfig } from "./implementations/types.js"
import { validateWorkflow } from "./workflowValidation.js"

export interface WorkflowDefinition {
  name: string
  agent: string
  capabilities: string[]
  runWithoutApproval?: boolean
  steps?: CapabilityWorkflowStepConfig[]
  startAt?: string
  report?: ReportPublicationConfig
  createdAt?: string
  updatedAt?: string
}

const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/

export function isWorkflowDefinitionId(value: string): boolean {
  return WORKFLOW_ID_PATTERN.test(value)
}

export function workflowDefinitionPath(id: string): string {
  if (!isWorkflowDefinitionId(id)) {
    throw new Error(`Invalid workflow id "${id}"`)
  }
  return `workflows/${id}/workflow.json`
}

export function normalizeWorkflowDefinition(value: unknown): WorkflowDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  const requestedAgent = typeof raw.agent === "string" ? raw.agent.trim() : ""
  const agent = /^[a-z][a-z0-9-]*$/.test(requestedAgent) ? requestedAgent : "kody"
  if (Array.isArray(raw.steps)) {
    if (
      validateWorkflow({ steps: raw.steps, ...(raw.startAt !== undefined ? { startAt: raw.startAt } : {}) }).length > 0
    ) {
      return null
    }
  }
  const workflow = parseCapabilityWorkflow({
    steps: raw.steps,
    startAt: raw.startAt,
    report: raw.report,
  })
  const steps = workflow?.steps
  const capabilities = steps ? steps.map((step) => step.capability) : normalizeWorkflowCapabilities(raw.capabilities)
  if (!name || capabilities.length === 0) return null
  return {
    name,
    agent,
    capabilities,
    ...(raw.runWithoutApproval === true ? { runWithoutApproval: true } : {}),
    ...(steps ? { steps } : {}),
    ...(workflow?.startAt ? { startAt: workflow.startAt } : {}),
    ...(workflow?.report ? { report: workflow.report } : {}),
    ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
  }
}

export function readWorkflowDefinition(
  _config: unknown,
  cwd: string | undefined,
  id: string,
): WorkflowDefinition | null {
  const root = cwd ?? process.cwd()
  const relativePath = workflowDefinitionPath(id)
  const candidates = [
    path.join(root, ".kody-engine", "runtime", relativePath),
    path.join(definitionsRoot(root), relativePath),
  ]
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue
    const workflow = parseWorkflowDefinition(fs.readFileSync(filePath, "utf8"))
    if (workflow) return workflow
  }
  return null
}

export function workflowDefinitionToCapabilityFolder(
  id: string,
  workflow: WorkflowDefinition,
  source = workflowDefinitionPath(id),
): CapabilityFolder {
  return {
    slug: id,
    dir: path.dirname(source),
    profilePath: source,
    bodyPath: source,
    title: workflow.name,
    body: "",
    rawBody: "",
    rawProfile: { name: id, workflow },
    config: {
      action: id,
      workflow: workflowDefinitionToConfig(workflow),
      describe: workflow.name,
      agent: workflow.agent,
    },
  }
}

function normalizeWorkflowCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const capabilities: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const slug = item.trim()
    if (!CAPABILITY_ID_PATTERN.test(slug) || seen.has(slug)) continue
    seen.add(slug)
    capabilities.push(slug)
  }
  return capabilities
}

function workflowDefinitionToConfig(workflow: WorkflowDefinition): CapabilityWorkflowConfig {
  return {
    steps: workflow.steps ?? workflow.capabilities.map((capability) => ({ capability })),
    ...(workflow.startAt ? { startAt: workflow.startAt } : {}),
    ...(workflow.report ? { report: workflow.report } : {}),
  }
}

function parseWorkflowDefinition(content: string): WorkflowDefinition | null {
  try {
    return normalizeWorkflowDefinition(JSON.parse(content))
  } catch {
    return null
  }
}
