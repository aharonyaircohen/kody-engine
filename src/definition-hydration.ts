import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { createStateBackendFromEnv, type DefinitionDocument, hasStateBackendConfig } from "./state-backend.js"

export interface DefinitionBundle {
  schemaVersion: 1
  files: Record<string, string>
}

export interface DefinitionSource {
  listDefinitions(tenantId: string, kind: "agent" | "capability" | "goal"): Promise<DefinitionDocument[]>
}

export interface HydratedDefinitions {
  root: string
  tenantId: string
  versions: Record<string, string>
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function assertSafeDefinitionPath(filePath: string): void {
  const segments = filePath.split("/")
  if (
    !filePath ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe definition path: ${filePath}`)
  }
}

export function normalizeDefinitionBundle(bundle: DefinitionBundle): DefinitionBundle {
  if (bundle.schemaVersion !== 1) throw new Error("unsupported definition bundle schema")
  const files = Object.fromEntries(
    Object.entries(bundle.files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, content]) => {
        assertSafeDefinitionPath(filePath)
        return [filePath, content.replace(/\r\n?/g, "\n")]
      }),
  )
  return { schemaVersion: 1, files }
}

export function definitionVersion(bundle: DefinitionBundle): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalizeDefinitionBundle(bundle)))
    .digest("hex")}`
}

function verifyDefinition(definition: DefinitionDocument): DefinitionBundle {
  if (!SLUG_RE.test(definition.slug)) throw new Error(`invalid definition slug: ${definition.slug}`)
  const bundle = normalizeDefinitionBundle(definition.bundle)
  if (definitionVersion(bundle) !== definition.version) {
    throw new Error(`definition version mismatch for ${definition.slug}: ${definition.version}`)
  }
  return bundle
}

function writeDefinition(root: string, kind: "agent" | "capability" | "goal", definition: DefinitionDocument): void {
  const bundle = verifyDefinition(definition)
  if (kind === "agent") {
    const raw = bundle.files["agent.md"]
    if (typeof raw !== "string") throw new Error(`agent definition ${definition.slug} is missing agent.md`)
    fs.writeFileSync(path.join(root, "agents", `${definition.slug}.md`), raw, "utf8")
    return
  }
  if (kind === "goal") {
    const goalRoot = path.join(root, "goals", definition.slug)
    for (const [filePath, contents] of Object.entries(bundle.files)) {
      const target = path.join(goalRoot, filePath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents, "utf8")
    }
    return
  }
  const capabilityRoot = path.join(root, "capabilities", definition.slug)
  for (const [filePath, contents] of Object.entries(bundle.files)) {
    const target = path.join(capabilityRoot, filePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents, "utf8")
  }
}

export async function hydrateDefinitions(options: {
  cwd: string
  tenantId: string
  backend: DefinitionSource
}): Promise<HydratedDefinitions> {
  const root = path.join(options.cwd, ".kody-engine", "definitions")
  const staging = `${root}.tmp-${process.pid}-${Date.now()}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(path.join(staging, "agents"), { recursive: true })
  fs.mkdirSync(path.join(staging, "capabilities"), { recursive: true })
  fs.mkdirSync(path.join(staging, "goals"), { recursive: true })

  try {
    const [capabilities, agents, goals] = await Promise.all([
      options.backend.listDefinitions(options.tenantId, "capability"),
      options.backend.listDefinitions(options.tenantId, "agent"),
      options.backend.listDefinitions(options.tenantId, "goal"),
    ])
    const versions: Record<string, string> = {}
    for (const definition of capabilities) {
      writeDefinition(staging, "capability", definition)
      versions[`capability:${definition.slug}`] = definition.version
    }
    for (const definition of agents) {
      writeDefinition(staging, "agent", definition)
      versions[`agent:${definition.slug}`] = definition.version
    }
    for (const definition of goals) {
      writeDefinition(staging, "goal", definition)
      versions[`goal:${definition.slug}`] = definition.version
    }
    const manifest = {
      schemaVersion: 1,
      tenantId: options.tenantId,
      hydratedAt: new Date().toISOString(),
      versions: Object.fromEntries(Object.entries(versions).sort(([left], [right]) => left.localeCompare(right))),
    }
    fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    fs.rmSync(root, { recursive: true, force: true })
    fs.renameSync(staging, root)
    return { root, tenantId: options.tenantId, versions: manifest.versions }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export async function hydrateDefinitionsFromEnv(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<HydratedDefinitions | null> {
  const tenantId = env.GITHUB_REPOSITORY?.trim()
  if (!hasStateBackendConfig(env)) {
    if (env.GITHUB_ACTIONS === "true") {
      throw new Error("GitHub Actions workflow identity is required for backend definitions")
    }
    return null
  }
  if (!tenantId) throw new Error("GITHUB_REPOSITORY is required for backend definitions")
  return hydrateDefinitions({
    cwd,
    tenantId,
    backend: createStateBackendFromEnv(env),
  })
}
