import * as fs from "node:fs"
import * as path from "node:path"
import type { CapabilityFolder, CapabilityWorkflowConfig } from "./capabilityFolders.js"
import { getCompanyStoreAssetRoot } from "./companyStore.js"
import { readStateText, type StateRepoConfig } from "./stateRepo.js"

export interface WorkflowDefinition {
  version: 1
  name: string
  capabilities: string[]
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
  const capabilities = normalizeWorkflowCapabilities(raw.capabilities)
  if (!name || capabilities.length === 0) return null
  return {
    version: 1,
    name,
    capabilities,
    ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
  }
}

export function readWorkflowDefinition(
  config: StateRepoConfig,
  cwd: string | undefined,
  id: string,
): WorkflowDefinition | null {
  const file = readStateText(config, cwd, workflowDefinitionPath(id))
  if (!file) return readCompanyStoreWorkflowDefinition(id)
  return parseWorkflowDefinition(file.content)
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
    steps: workflow.capabilities.map((capability) => ({ capability })),
  }
}

function readCompanyStoreWorkflowDefinition(id: string): WorkflowDefinition | null {
  const root = getCompanyStoreAssetRoot("workflows")
  if (!root) return null
  const filePath = path.join(root, id, "workflow.json")
  if (!fs.existsSync(filePath)) return null
  return parseWorkflowDefinition(fs.readFileSync(filePath, "utf8"))
}

function parseWorkflowDefinition(content: string): WorkflowDefinition | null {
  try {
    return normalizeWorkflowDefinition(JSON.parse(content))
  } catch {
    return null
  }
}
