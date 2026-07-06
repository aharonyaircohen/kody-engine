import type { PostflightScript } from "../executables/types.js"
import { parseAgentFactoryBundle } from "./openAgentFactoryStatePr.js"

type ModelKind = "agent" | "capability" | "goal" | "agentLoop" | "workflow"

interface ModelBundle {
  model?: unknown
  models?: unknown
  modelCreatorContractsUsed?: unknown
}

const CREATOR_CONTRACTS = [
  "agent-creator",
  "goal-creator",
  "loop-creator",
  "workflow-creator",
  "capability-creator",
] as const

const FACTORY_PRODUCER = "agent-factory"

const REQUIRED_DOCS: Record<ModelKind, string[]> = {
  agent: ["docs/agents.md"],
  capability: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/executables.md"],
  goal: ["docs/goals.md", "docs/jobs-model.md", "docs/capabilities.md"],
  agentLoop: ["docs/jobs-model.md", "docs/engine-company.md", "docs/ledgers.md"],
  workflow: ["docs/jobs-model.md", "docs/capabilities.md"],
}

const CREATOR_KIND: Record<string, ModelKind> = {
  "agent-creator": "agent",
  "capability-creator": "capability",
  "goal-creator": "goal",
  "loop-creator": "agentLoop",
  "workflow-creator": "workflow",
}

export const validateAgentFactoryBundle: PostflightScript = async (ctx, profile) => {
  if (ctx.data.agentDone !== true) return

  const raw = String(ctx.data.prSummary ?? "")
  const bundle = parseAgentFactoryBundle(raw) as ReturnType<typeof parseAgentFactoryBundle> & ModelBundle
  const failures = validateModelBundle(bundle, profile.name)
  if (failures.length > 0) {
    throw new Error(`validateAgentFactoryBundle: ${failures.join("; ")}`)
  }
}

export function validateModelBundle(
  bundle: ReturnType<typeof parseAgentFactoryBundle> & ModelBundle,
  producer: string,
): string[] {
  const failures: string[] = []
  const expectedKind = CREATOR_KIND[producer]

  if (producer === FACTORY_PRODUCER) {
    const contracts = stringArray(bundle.modelCreatorContractsUsed)
    for (const contract of CREATOR_CONTRACTS) {
      if (!contracts.includes(contract)) failures.push(`modelCreatorContractsUsed missing ${contract}`)
    }
    if (!Array.isArray(bundle.models) || bundle.models.length === 0) {
      failures.push("agent-factory bundle must include non-empty models array")
      return failures
    }
    for (const [index, model] of bundle.models.entries()) {
      validateOneModel(model, bundle.files, `models[${index}]`, false, failures)
    }
    validateFactoryAssembly(bundle.models, failures)
    return failures
  }

  validateOneModel(bundle.model, bundle.files, "model", true, failures, expectedKind, producer)
  return failures
}

function validateOneModel(
  rawModel: unknown,
  files: Array<{ path: string; content: string }>,
  label: string,
  strictSingleModel: boolean,
  failures: string[],
  expectedKind?: ModelKind,
  producer?: string,
): void {
  if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
    failures.push(`${label} must be an object`)
    return
  }

  const model = rawModel as Record<string, unknown>
  const kind = stringField(model.kind) as ModelKind
  if (!isModelKind(kind)) failures.push(`${label}.kind must be agent, capability, goal, agentLoop, or workflow`)
  if (expectedKind && kind !== expectedKind && producer)
    failures.push(`${producer} must output model.kind ${expectedKind}`)

  const slug = stringField(model.slug)
  if (!isSlug(slug)) failures.push(`${label}.slug must be a lowercase slug`)

  if (isModelKind(kind)) {
    const docsUsed = stringArray(model.docsUsed)
    for (const doc of REQUIRED_DOCS[kind]) {
      if (!docsUsed.includes(doc)) failures.push(`${label} docsUsed missing ${doc}`)
    }
    validateFilesForKind(kind, slug, files, strictSingleModel, failures)
    validateModelShape(kind, model, files, slug, failures)
  }
}

function validateFilesForKind(
  kind: ModelKind,
  slug: string,
  files: Array<{ path: string; content: string }>,
  strictSingleModel: boolean,
  failures: string[],
): void {
  const paths = files.map((file) => normalizeBundlePath(file.path))
  if (paths.some((filePath) => filePath === "executables" || filePath.startsWith("executables/"))) {
    failures.push("files must not use obsolete executables storage")
  }

  if (kind === "agent") {
    requirePath(paths, `agents/${slug}.md`, "agent file", failures)
    if (strictSingleModel) rejectOtherRoots(paths, ["agents/"], "agent", failures)
  }

  if (kind === "capability") {
    requirePath(paths, `capabilities/${slug}/profile.json`, "capability profile", failures)
    requirePath(paths, `capabilities/${slug}/capability.md`, "capability body", failures)
    if (strictSingleModel) rejectOtherRoots(paths, [`capabilities/${slug}/`], "capability", failures)
    const profile = parseJsonFile(files, `capabilities/${slug}/profile.json`, failures)
    if (profile) {
      const profileSlug = stringField(profile.slug)
      const profileName = stringField(profile.name)
      if (profileSlug && profileSlug !== slug) failures.push("capability profile slug must match model.slug")
      if (!profileSlug && profileName && profileName !== slug) {
        failures.push("capability profile name must match model.slug when slug is absent")
      }
      if (profile.agent !== undefined)
        failures.push("capability profile must not set agent; agent wiring belongs outside capability creation")
      if (!["observe", "act", "verify"].includes(stringField(profile.capabilityKind))) {
        failures.push("capability profile must declare capabilityKind observe, act, or verify")
      }
    }
  }

  if (kind === "goal") {
    requirePath(paths, `goals/templates/${slug}/state.json`, "goal template state", failures)
    if (strictSingleModel) rejectOtherRoots(paths, [`goals/templates/${slug}/`], "goal", failures)
  }

  if (kind === "agentLoop") {
    if (!paths.some((filePath) => filePath.endsWith("/state.json")))
      failures.push("agentLoop must produce a state.json file")
    if (strictSingleModel) rejectOtherRoots(paths, ["goals/", "loops/", "capabilities/"], "agentLoop", failures)
  }

  if (kind === "workflow") {
    requirePath(paths, `capabilities/${slug}/profile.json`, "workflow capability profile", failures)
    const profile = parseJsonFile(files, `capabilities/${slug}/profile.json`, failures)
    if (profile) {
      const hasWorkflowObject = Boolean(profile.workflow && typeof profile.workflow === "object")
      const hasTopLevelSteps = Array.isArray(profile.steps) && profile.steps.length > 0
      if (!hasWorkflowObject && !hasTopLevelSteps) {
        failures.push("workflow profile must include workflow object or top-level steps")
      }
    }
  }
}

function validateFactoryAssembly(models: unknown[], failures: string[]): void {
  const available = new Map<string, ModelKind>()
  for (const model of models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) continue
    const input = model as Record<string, unknown>
    const kind = stringField(input.kind) as ModelKind
    const slug = stringField(input.slug)
    if (isModelKind(kind) && isSlug(slug)) available.set(`${kind}:${slug}`, kind)
  }

  for (const model of models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) continue
    const input = model as Record<string, unknown>
    const kind = stringField(input.kind)
    if (kind === "goal") {
      for (const capability of capabilityRefs(input)) {
        if (!available.has(`capability:${capability}`)) {
          failures.push(`goal ${stringField(input.slug)} references missing capability ${capability}`)
        }
      }
    }
    if (kind === "workflow") {
      for (const capability of stringArray(input.steps)) {
        if (!available.has(`capability:${capability}`)) {
          failures.push(`workflow ${stringField(input.slug)} references missing capability ${capability}`)
        }
      }
      for (const step of arrayObjects(input.steps)) {
        const capability = stringField(step.capability)
        if (capability && !available.has(`capability:${capability}`)) {
          failures.push(`workflow ${stringField(input.slug)} references missing capability ${capability}`)
        }
      }
    }
    if (kind === "agentLoop") {
      const target = wakeTarget(input)
      if (target) {
        if (!available.has(`${target.kind}:${target.slug}`)) {
          failures.push(`agentLoop ${stringField(input.slug)} references missing ${target.kind} ${target.slug}`)
        }
      } else {
        const targetSlug = stringField(input.target)
        const targetExists = ["goal", "workflow", "capability"].some((kindName) =>
          available.has(`${kindName}:${targetSlug}`),
        )
        if (targetSlug && !targetExists) {
          failures.push(`agentLoop ${stringField(input.slug)} references missing target ${targetSlug}`)
        }
      }
    }
  }
}

function validateModelShape(
  kind: ModelKind,
  model: Record<string, unknown>,
  files: Array<{ path: string; content: string }>,
  slug: string,
  failures: string[],
): void {
  if (kind === "agent") {
    const agentFile = textFile(files, `agents/${slug}.md`)
    if (!stringArray(model.owns).includes("identity") && !containsWord(agentFile, "identity")) {
      failures.push("agent owns must include identity")
    }
    requireStringArrayIncludes(model.doesNotOwn, "tasks", "agent doesNotOwn", failures)
  }
  if (kind === "capability") {
    if (!["observe", "act", "verify"].includes(stringField(model.capabilityKind))) {
      failures.push("capability model must declare capabilityKind observe, act, or verify")
    }
    if (!stringField(model.ability)) failures.push("capability model must declare ability")
    for (const field of ["inputs", "outputs", "allowedActions", "forbiddenActions"]) {
      if (!Array.isArray(model[field])) failures.push(`capability model ${field} must be an array`)
    }
    requireStringArrayIncludes(model.doesNotOwn, "agent identity", "capability doesNotOwn", failures)
    requireStringArrayIncludes(model.doesNotOwn, "goal progress", "capability doesNotOwn", failures)
  }
  if (kind === "goal") {
    const goalState = parseJsonContent(textFile(files, `goals/templates/${slug}/state.json`))
    if (!stringField(model.outcome) && !stringField(goalState?.outcome))
      failures.push("goal model must declare outcome")
    if (evidenceRefs(model).length === 0 && evidenceRefs(goalState).length === 0) {
      failures.push("goal model evidence must be non-empty")
    }
    if (capabilityRefs(model).length === 0 && capabilityRefs(goalState).length === 0) {
      failures.push("goal model capabilities must be non-empty")
    }
  }
  if (kind === "agentLoop") {
    if (!stringField(model.cadence)) failures.push("agentLoop model must declare cadence")
    const loopState = parseJsonContent(firstStateFile(files, slug))
    const hasTarget =
      Boolean(wakeTarget(model)) ||
      Boolean(stringField(model.target)) ||
      Boolean(wakeTarget(loopState)) ||
      Boolean(stringField(loopState?.target)) ||
      Boolean(loopTargetString(loopState))
    if (!hasTarget) {
      failures.push("agentLoop model must declare wakeTarget object")
    }
  }
  if (kind === "workflow") {
    if (!Array.isArray(model.steps) || model.steps.length === 0) failures.push("workflow model steps must be non-empty")
  }
}

function capabilityRefs(value: Record<string, unknown> | null | undefined): string[] {
  return [...stringArray(value?.capabilities), ...stringArray(value?.allowedCapabilities)]
}

function evidenceRefs(value: Record<string, unknown> | null | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value.evidence)) return value.evidence.map((item) => String(item).trim()).filter(Boolean)
  if (value.evidence && typeof value.evidence === "object") return Object.keys(value.evidence)
  return []
}

function wakeTarget(
  value: Record<string, unknown> | null | undefined,
): { kind: "goal" | "workflow" | "capability"; slug: string } | null {
  const raw = value?.wakeTarget
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const target = raw as Record<string, unknown>
  const type = stringField(target.type)
  const slug = stringField(target.slug)
  if ((type === "goal" || type === "workflow" || type === "capability") && slug) return { kind: type, slug }
  return null
}

function loopTargetString(value: Record<string, unknown> | null | undefined): string {
  const loop = value?.loop
  if (!loop || typeof loop !== "object" || Array.isArray(loop)) return ""
  return stringField((loop as Record<string, unknown>).target)
}

function textFile(files: Array<{ path: string; content: string }>, wantedPath: string): string {
  return files.find((item) => normalizeBundlePath(item.path) === wantedPath)?.content ?? ""
}

function firstStateFile(files: Array<{ path: string; content: string }>, slug: string): string {
  const normalizedSlug = `${slug}/state.json`
  return files.find((item) => normalizeBundlePath(item.path).endsWith(normalizedSlug))?.content ?? ""
}

function parseJsonContent(content: string): Record<string, unknown> | null {
  if (!content.trim()) return null
  try {
    const parsed = JSON.parse(content) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function containsWord(content: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(content)
}

function parseJsonFile(
  files: Array<{ path: string; content: string }>,
  wantedPath: string,
  failures: string[],
): Record<string, unknown> | null {
  const file = files.find((item) => normalizeBundlePath(item.path) === wantedPath)
  if (!file) return null
  try {
    const parsed = JSON.parse(file.content) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      failures.push(`${wantedPath} must contain a JSON object`)
      return null
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    failures.push(`${wantedPath} must contain valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function rejectOtherRoots(paths: string[], allowedPrefixes: string[], kind: string, failures: string[]): void {
  for (const filePath of paths) {
    if (!allowedPrefixes.some((prefix) => filePath.startsWith(prefix))) {
      failures.push(`${kind} bundle contains out-of-bound file ${filePath}`)
    }
  }
}

function requirePath(paths: string[], wantedPath: string, label: string, failures: string[]): void {
  if (!paths.includes(wantedPath)) failures.push(`missing ${label}: ${wantedPath}`)
}

function normalizeBundlePath(filePath: string): string {
  return filePath.replace(/^\.kody\/?/, "").replace(/^\/+/, "")
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  )
}

function requireStringArrayIncludes(value: unknown, expected: string, label: string, failures: string[]): void {
  if (!stringArray(value).includes(expected)) failures.push(`${label} must include ${expected}`)
}

function isSlug(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

function isModelKind(value: string): value is ModelKind {
  return (
    value === "agent" || value === "capability" || value === "goal" || value === "agentLoop" || value === "workflow"
  )
}
