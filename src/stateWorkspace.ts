/**
 * Hydrate read-only runtime prompt documents from the backend into the
 * engine-owned scratch workspace used by synchronous prompt loaders.
 *
 * Persistent authority remains in the backend. This cache is disposable,
 * never lives under consumer `.kody`, and is never written back to GitHub.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { KodyConfig } from "./config.js"
import {
  createStateBackendFromEnv,
  hasStateBackendConfig,
  type StateBackend,
  type TaskDocument,
} from "./state-backend.js"

const RUNTIME_ROOT = path.join(".kody-engine", "runtime")
const hydratedWorkspaces = new Set<string>()

function tenantId(config: KodyConfig): string | null {
  const owner = config.github?.owner?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[0]?.trim()
  const repo = config.github?.repo?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[1]?.trim()
  return owner && repo ? `${owner}/${repo}` : null
}

function writeRuntimeFile(cwd: string, relativePath: string, content: string): void {
  const target = path.join(cwd, RUNTIME_ROOT, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, "utf8")
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringField(value: unknown, key: string): string | null {
  const candidate = record(value)?.[key]
  return typeof candidate === "string" ? candidate : null
}

function memoryIndex(docs: TaskDocument[]): string {
  const lines = docs
    .map((doc) => {
      const meta = record(record(doc.doc)?.meta)
      const id = doc.kind.slice("memory:".length)
      const name = typeof meta?.name === "string" && meta.name.trim() ? meta.name.trim() : id
      const description = typeof meta?.description === "string" ? meta.description.trim() : ""
      const type = typeof meta?.type === "string" ? meta.type : "lesson"
      return `- [${name}](${id}.md) — ${description} (type: ${type})`
    })
    .sort()
  if (lines.length === 0) return ""
  return ["# Kody memory index", "", "One line per backend memory document.", "", ...lines, ""].join("\n")
}

async function hydratePrefix(
  backend: Pick<StateBackend, "listRepoDocs">,
  tenant: string,
  cwd: string,
  prefix: "context:" | "memory:",
): Promise<void> {
  const docs = await backend.listRepoDocs(tenant, prefix)
  for (const doc of docs) {
    const slug = doc.kind.slice(prefix.length)
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) continue
    const body = stringField(doc.doc, "body")
    if (body === null) continue
    writeRuntimeFile(cwd, `${prefix === "context:" ? "context" : "memory"}/${slug}.md`, body)
  }
  if (prefix === "memory:") {
    const index = memoryIndex(docs)
    if (index) writeRuntimeFile(cwd, "memory/INDEX.md", index)
  }
}

async function hydrateSingleton(
  backend: Pick<StateBackend, "getRepoDoc">,
  tenant: string,
  cwd: string,
  kind: string,
  relativePath: string,
): Promise<void> {
  const doc = await backend.getRepoDoc(tenant, kind)
  if (!doc) return
  const body = stringField(doc.doc, "body")
  if (body !== null) {
    writeRuntimeFile(cwd, relativePath, body)
    return
  }
  writeRuntimeFile(cwd, relativePath, `${JSON.stringify(doc.doc, null, 2)}\n`)
}

async function hydrateWorkflows(
  backend: Pick<StateBackend, "listWorkflows">,
  tenant: string,
  cwd: string,
): Promise<void> {
  for (const workflow of await backend.listWorkflows(tenant)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(workflow.workflowId)) continue
    writeRuntimeFile(
      cwd,
      `workflows/${workflow.workflowId}/workflow.json`,
      `${JSON.stringify(workflow.definition, null, 2)}\n`,
    )
  }
}

export async function hydrateStateWorkspace(
  config: KodyConfig,
  cwd: string,
  backendOverride?: StateBackend,
): Promise<void> {
  const tenant = tenantId(config)
  const configured = hasStateBackendConfig()
  if (!tenant || !configured) {
    if (process.env.GITHUB_ACTIONS === "true")
      throw new Error("Kody backend access is required for runtime workspace documents")
    return
  }
  const key = `${path.resolve(cwd)}|${tenant}`
  if (hydratedWorkspaces.has(key)) return
  const backend = backendOverride ?? createStateBackendFromEnv()
  const root = path.join(cwd, RUNTIME_ROOT)
  fs.rmSync(root, { recursive: true, force: true })
  await Promise.all([
    hydratePrefix(backend, tenant, cwd, "context:"),
    hydratePrefix(backend, tenant, cwd, "memory:"),
    hydrateSingleton(backend, tenant, cwd, "instructions", "instructions.md"),
    hydrateSingleton(backend, tenant, cwd, "system-prompt", "system-prompt.md"),
    hydrateSingleton(backend, tenant, cwd, "variables", "variables.json"),
    hydrateWorkflows(backend, tenant, cwd),
  ])
  hydratedWorkspaces.add(key)
}

export function resetStateWorkspaceHydrationCacheForTests(): void {
  hydratedWorkspaces.clear()
}
