import * as path from "node:path"
import { capabilityOutputConditionPaths, listCapabilityFolderSlugs, readCapabilityFolder } from "../capabilityFolders.js"
import type { PostflightScript, ScriptArgs } from "../implementations/types.js"
import { getCapabilityActionInputs, getCapabilityRoots } from "../registry.js"
import { formatWorkflowValidationIssues, validateWorkflow } from "../workflowValidation.js"
import { parseAgencyModelProposal } from "./openAgencyModelReviewPr.js"

type ModelKind = "intent" | "operation" | "agent" | "capability" | "goal" | "agentLoop" | "workflow"

interface ModelBundle {
  model?: unknown
}

const REQUIRED_DOCS: Record<ModelKind, string[]> = {
  intent: ["docs/intents.md", "docs/engine-company.md"],
  operation: ["docs/operations.md", "docs/engine-company.md"],
  agent: ["docs/agents.md"],
  capability: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/capability-implementations.md"],
  goal: ["docs/goals.md", "docs/jobs-model.md", "docs/capabilities.md"],
  agentLoop: ["docs/jobs-model.md", "docs/engine-company.md", "docs/ledgers.md"],
  workflow: ["docs/jobs-model.md", "docs/capabilities.md"],
}

export const validateAgencyModelProposal: PostflightScript = async (ctx, _profile, _agentResult, args) => {
  if (ctx.data.agentDone !== true) return

  const raw = String(ctx.data.prSummary ?? "")
  const bundle = parseAgencyModelProposal(raw) as ReturnType<typeof parseAgencyModelProposal> & ModelBundle
  const expectedKind = readExpectedModelKind(args)
  const failures = validateModelBundle(bundle, expectedKind, {
    capabilityRoot: path.join(ctx.cwd, ".kody", "capabilities"),
  })
  if (failures.length > 0) {
    throw new Error(`validateAgencyModelProposal: ${failures.join("; ")}`)
  }
}

export function validateModelBundle(
  bundle: ReturnType<typeof parseAgencyModelProposal> & ModelBundle,
  expectedKind: ModelKind,
  options: { capabilityRoot?: string } = {},
): string[] {
  const failures: string[] = []

  validateOneModel(bundle.model, bundle.files, "model", true, failures, expectedKind, options)
  return failures
}

function readExpectedModelKind(args: ScriptArgs | undefined): ModelKind {
  const value = args?.modelKind
  if (typeof value === "string" && isModelKind(value)) return value
  throw new Error(
    "validateAgencyModelProposal: with.modelKind must be intent, operation, agent, capability, goal, agentLoop, or workflow",
  )
}

function validateOneModel(
  rawModel: unknown,
  files: Array<{ path: string; content: string }>,
  label: string,
  strictSingleModel: boolean,
  failures: string[],
  expectedKind?: ModelKind,
  options: { capabilityRoot?: string } = {},
): void {
  if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
    failures.push(`${label} must be an object`)
    return
  }

  const model = rawModel as Record<string, unknown>
  const kind = stringField(model.kind) as ModelKind
  if (!isModelKind(kind)) {
    failures.push(`${label}.kind must be intent, operation, agent, capability, goal, agentLoop, or workflow`)
  }
  if (expectedKind && kind !== expectedKind) failures.push(`proposal must output model.kind ${expectedKind}`)

  const slug = stringField(model.slug)
  if (!isSlug(slug)) failures.push(`${label}.slug must be a lowercase slug`)

  if (isModelKind(kind)) {
    const docsUsed = stringArray(model.docsUsed)
    for (const doc of REQUIRED_DOCS[kind]) {
      if (!docsUsed.includes(doc)) failures.push(`${label} docsUsed missing ${doc}`)
    }
    validateFilesForKind(kind, slug, files, strictSingleModel, failures, options)
    validateModelShape(kind, model, files, slug, failures)
  }
}

function validateFilesForKind(
  kind: ModelKind,
  slug: string,
  files: Array<{ path: string; content: string }>,
  strictSingleModel: boolean,
  failures: string[],
  options: { capabilityRoot?: string },
): void {
  const paths = files.map((file) => normalizeBundlePath(file.path))
  if (paths.some((filePath) => filePath === "implementations" || filePath.startsWith("implementations/"))) {
    failures.push("files must not use obsolete implementation storage")
  }

  if (kind === "intent") {
    requirePath(paths, `intents/${slug}/intent.json`, "intent state", failures)
    if (strictSingleModel) rejectOtherRoots(paths, [`intents/${slug}/`], "intent", failures)
  }

  if (kind === "operation") {
    requirePath(paths, `operations/${slug}/operation.json`, "operation contract", failures)
    if (strictSingleModel) rejectOtherRoots(paths, [`operations/${slug}/`], "operation", failures)
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
    requirePath(paths, `capabilities/${slug}/capability.md`, "workflow capability body", failures)
    const profile = parseJsonFile(files, `capabilities/${slug}/profile.json`, failures)
    if (profile) {
      if (profile.capabilityKind !== undefined) {
        failures.push("workflow profile must not declare capabilityKind")
      }
      const hasWorkflowObject = Boolean(profile.workflow && typeof profile.workflow === "object")
      const hasTopLevelSteps = Array.isArray(profile.steps) && profile.steps.length > 0
      if (!hasWorkflowObject && !hasTopLevelSteps) {
        failures.push("workflow profile must include workflow object or top-level steps")
      } else {
        const workflow = hasWorkflowObject
          ? profile.workflow
          : { steps: profile.steps, ...(profile.startAt !== undefined ? { startAt: profile.startAt } : {}) }
        const known = options.capabilityRoot
          ? getCapabilityRoots(options.capabilityRoot).flatMap((root) => listCapabilityFolderSlugs(root))
          : []
        const uniqueKnown = [...new Set(known)]
        const capabilityInputs = new Map<string, Set<string>>()
        const capabilityOutputs = new Map<string, Set<string>>()
        if (options.capabilityRoot) {
          for (const capability of uniqueKnown) {
            const folder = getCapabilityRoots(options.capabilityRoot)
              .map((root) => readCapabilityFolder(root, capability))
              .find((entry) => entry !== null)
            capabilityOutputs.set(capability, folder ? capabilityOutputConditionPaths(folder.config) : new Set())
            const inputs = getCapabilityActionInputs(capability, options.capabilityRoot)
            if (inputs) {
              capabilityInputs.set(
                capability,
                new Set(inputs.flatMap((input) => [input.name, input.flag.replace(/^--/, "")])),
              )
            }
          }
        }
        failures.push(
          ...formatWorkflowValidationIssues(
            validateWorkflow(workflow, {
              ...(uniqueKnown.length > 0 ? { knownCapabilities: new Set(uniqueKnown) } : {}),
              ...(capabilityInputs.size > 0 ? { capabilityInputs } : {}),
              ...(capabilityOutputs.size > 0 ? { capabilityOutputs } : {}),
            }),
          ),
        )
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
  if (kind === "intent") {
    const intent = parseJsonFile(files, `intents/${slug}/intent.json`, failures)
    if (!stringField(model.direction)) failures.push("intent model must declare direction")
    if (!stringField(intent?.for)) failures.push("intent file must declare direction")
    if (!isFiniteNumber(model.priority)) failures.push("intent model must declare numeric priority")
    if (!isFiniteNumber(intent?.priority)) failures.push("intent file must declare numeric priority")
    if (!hasScope(model.scope)) failures.push("intent model scope must include a repo or area")
    if (!hasScope(intent?.scope)) failures.push("intent file scope must include a repo or area")
    if (stringArray(model.principles).length === 0) failures.push("intent model principles must be non-empty")
    if (stringArray(intent?.principles).length === 0) failures.push("intent file principles must be non-empty")
    if (stringArray(model.successMeasures).length === 0) {
      failures.push("intent model successMeasures must be non-empty")
    }
    if (stringArray(intent?.metrics).length === 0) failures.push("intent file metrics must be non-empty")
    if (!recordField(model.policy)) failures.push("intent model must declare policy")
    if (!recordField(intent?.policy)) failures.push("intent file must declare policy")
    if (stringField(model.status) !== "paused" || stringField(intent?.status) !== "paused") {
      failures.push("intent proposal status must be paused")
    }
    if (intent?.version !== 1) failures.push("intent file version must be 1")
    if (intent && stringField(intent.id) !== slug) failures.push("intent id must match model.slug")
    requireStringArrayIncludes(model.doesNotOwn, "operations", "intent doesNotOwn", failures)
    requireStringArrayIncludes(model.doesNotOwn, "capability implementation", "intent doesNotOwn", failures)
  }
  if (kind === "operation") {
    const operation = parseJsonFile(files, `operations/${slug}/operation.json`, failures)
    if (!stringField(model.responsibility)) failures.push("operation model must declare responsibility")
    if (!stringField(operation?.responsibility)) failures.push("operation file must declare responsibility")
    if (stringArray(model.intentIds).length === 0) failures.push("operation model intentIds must be non-empty")
    if (stringArray(operation?.intentIds).length === 0) failures.push("operation file intentIds must be non-empty")
    if (stringArray(model.doesNotOwn).length === 0) failures.push("operation model doesNotOwn must be non-empty")
    if (stringArray(operation?.doesNotOwn).length === 0) failures.push("operation file doesNotOwn must be non-empty")
    if (stringField(model.status) !== "proposed" || stringField(operation?.status) !== "proposed") {
      failures.push("operation proposal status must be proposed")
    }
    if (operation?.version !== 1) failures.push("operation file version must be 1")
    if (operation && stringField(operation.id) !== slug) failures.push("operation id must match model.slug")
  }
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
    if (model.capabilityKind !== undefined) {
      failures.push("workflow model must not declare capabilityKind")
    }
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

function recordField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value)
}

function hasScope(value: unknown): boolean {
  const scope = recordField(value)
  return stringArray(scope?.repos).length > 0 || stringArray(scope?.areas).length > 0
}

function requireStringArrayIncludes(value: unknown, expected: string, label: string, failures: string[]): void {
  if (!stringArray(value).includes(expected)) failures.push(`${label} must include ${expected}`)
}

function isSlug(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

function isModelKind(value: string): value is ModelKind {
  return (
    value === "intent" ||
    value === "operation" ||
    value === "agent" ||
    value === "capability" ||
    value === "goal" ||
    value === "agentLoop" ||
    value === "workflow"
  )
}
