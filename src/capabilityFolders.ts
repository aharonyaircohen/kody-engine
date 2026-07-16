import * as fs from "node:fs"
import * as path from "node:path"
import type { ReportPublicationConfig } from "./implementations/types.js"

export const CAPABILITY_PROFILE_FILE = "profile.json"
export const CAPABILITY_BODY_FILE = "capability.md"

export interface CapabilityFolderConfig {
  action?: string
  implementation?: string
  tickScript?: string
  capabilityKind?: "observe" | "act" | "verify"
  disabled?: boolean
  internal?: boolean
  public?: boolean
  agent?: string
  mentions?: string[]
  tools?: string[]
  capabilityTools?: string[]
  capabilityToolMode?: "lock" | "append"
  implementations?: string[]
  role?: string
  describe?: string
  stage?: string
  readsFrom?: string[]
  writesTo?: string[]
  output?: CapabilityOutputConfig
  workflow?: CapabilityWorkflowConfig
}

export interface CapabilityOutputConfig {
  result?: {
    facts: string[]
  }
}

export function capabilityOutputConditionPaths(config: CapabilityFolderConfig): Set<string> {
  const result = config.output?.result
  if (!result) return new Set()
  return new Set([
    "result.status",
    "result.summary",
    "result.resultClass",
    ...result.facts.map((fact) => `result.facts.${fact}`),
  ])
}

export interface CapabilityWorkflowConfig {
  steps: CapabilityWorkflowStepConfig[]
  startAt?: string
}

export interface CapabilityWorkflowInputConfig {
  from: string
}

export interface CapabilityWorkflowTransitionConfig {
  to: string
  when?: Record<string, unknown>
  default?: boolean
  maxIterations?: number
}

export interface CapabilityWorkflowStepConfig {
  id?: string
  capability: string
  action?: string
  implementation?: string
  evidence?: string
  target?: "issue" | "pr"
  targetFact?: string
  reason?: string
  agent?: string
  cliArgs?: Record<string, unknown>
  inputs?: Record<string, CapabilityWorkflowInputConfig>
  next?: CapabilityWorkflowTransitionConfig[]
  runWhen?: Record<string, unknown>
  continueOn?: string[]
  saveReport?: boolean
  report?: ReportPublicationConfig
}

export interface CapabilityFolder {
  slug: string
  dir: string
  profilePath: string
  bodyPath: string
  title: string
  body: string
  rawBody: string
  config: CapabilityFolderConfig
  rawProfile: Record<string, unknown>
}

export function listCapabilityFolderSlugs(absDir: string): string[] {
  if (!fs.existsSync(absDir)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .filter((e) => isCapabilityFolder(path.join(absDir, e.name)))
    .map((e) => e.name)
    .sort()
}

export function isCapabilityFolder(dir: string): boolean {
  return fs.existsSync(path.join(dir, CAPABILITY_PROFILE_FILE)) && fs.existsSync(path.join(dir, CAPABILITY_BODY_FILE))
}

export function readCapabilityFolder(root: string, slug: string): CapabilityFolder | null {
  const dir = path.join(root, slug)
  const profilePath = path.join(dir, CAPABILITY_PROFILE_FILE)
  const bodyPath = path.join(dir, CAPABILITY_BODY_FILE)
  if (!fs.existsSync(profilePath) || !fs.statSync(profilePath).isFile()) return null
  if (!fs.existsSync(bodyPath) || !fs.statSync(bodyPath).isFile()) return null
  try {
    const rawProfile = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>
    const rawBody = fs.readFileSync(bodyPath, "utf-8")
    const { title, body } = parseCapabilityBody(rawBody, slug)
    return {
      slug,
      dir,
      profilePath,
      bodyPath,
      title,
      body,
      rawBody,
      config: parseCapabilityConfig(rawProfile),
      rawProfile,
    }
  } catch {
    return null
  }
}

export function parseCapabilityConfig(raw: Record<string, unknown>): CapabilityFolderConfig {
  const tools = stringList(raw.tools ?? raw.capabilityTools ?? raw.capabilityTools)
  const implementations = stringList(raw.implementations)
  return {
    action: stringField(raw.action),
    implementation: stringField(raw.implementation),
    tickScript: stringField(raw.tickScript),
    capabilityKind: parseCapabilityKind(raw.capabilityKind),
    disabled: typeof raw.disabled === "boolean" ? raw.disabled : undefined,
    internal: typeof raw.internal === "boolean" ? raw.internal : undefined,
    public: typeof raw.public === "boolean" ? raw.public : undefined,
    agent: stringField(raw.agent),
    mentions: stringList(raw.mentions).map((m) => m.replace(/^@/, "")),
    tools,
    capabilityTools: tools,
    capabilityToolMode: parseCapabilityToolMode(raw.capabilityToolMode),
    implementations,
    role: stringField(raw.role),
    describe: stringField(raw.describe),
    stage: stringField(raw.stage),
    readsFrom: stringList(raw.readsFrom ?? raw.reads_from),
    writesTo: stringList(raw.writesTo ?? raw.writes_to),
    output: parseCapabilityOutput(raw.output),
    workflow: parseCapabilityWorkflow(raw.workflow),
  }
}

function parseCapabilityOutput(raw: unknown): CapabilityOutputConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const result = (raw as Record<string, unknown>).result
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined
  const facts = stringList((result as Record<string, unknown>).facts)
  return { result: { facts } }
}

function parseCapabilityKind(raw: unknown): CapabilityFolderConfig["capabilityKind"] | undefined {
  return raw === "observe" || raw === "act" || raw === "verify" ? raw : undefined
}

function parseCapabilityToolMode(raw: unknown): "lock" | "append" | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (raw === "lock" || raw === "append") return raw
  return undefined
}

export function parseCapabilityBody(raw: string, slug: string): { title: string; body: string } {
  const trimmed = raw.trim()
  const firstLine = trimmed.split("\n", 1)[0] ?? ""
  const h1 = /^#\s+(.+?)\s*$/.exec(firstLine)
  const title = h1 ? h1[1]!.trim() : humanizeSlug(slug)
  const body = stripLeadingH1(raw)
  return { title, body }
}

function stripLeadingH1(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, "").split("\n")
  let i = 0
  for (;;) {
    while (i < lines.length && lines[i]!.trim() === "") i++
    if (i < lines.length && /^#\s+.+/.test(lines[i]!)) i++
    else break
  }
  return lines.slice(i).join("\n")
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean)
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

export function parseCapabilityWorkflow(value: unknown): CapabilityWorkflowConfig | undefined {
  const stepsRaw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { steps?: unknown }).steps)
      ? (value as { steps: unknown[] }).steps
      : []
  const steps = stepsRaw.map(parseWorkflowStep).filter((step): step is CapabilityWorkflowStepConfig => step !== null)
  if (steps.length === 0) return undefined
  const startAt =
    value && typeof value === "object" && !Array.isArray(value)
      ? stringField((value as Record<string, unknown>).startAt)
      : undefined
  return {
    steps,
    ...(startAt && isSafeStepId(startAt) ? { startAt } : {}),
  }
}

function parseWorkflowStep(value: unknown): CapabilityWorkflowStepConfig | null {
  if (typeof value === "string") {
    const capability = value.trim()
    return isSafeSlug(capability) ? { capability } : null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const capability = stringField(raw.capability ?? raw.action)
  if (!capability || !isSafeSlug(capability)) return null
  const implementation = stringField(raw.implementation)
  const id = stringField(raw.id)
  const action = stringField(raw.action)
  const evidence = stringField(raw.evidence)
  const agent = stringField(raw.agent)
  const reason = stringField(raw.reason)
  const target = stringField(raw.target)
  const targetFact = stringField(raw.targetFact ?? raw.target_fact)
  const cliArgs = raw.cliArgs
  const inputs = parseWorkflowInputs(raw.inputs)
  const next = parseWorkflowTransitions(raw.next)
  const report = parseReportPublication(raw.report)
  return {
    capability,
    ...(id && isSafeStepId(id) ? { id } : {}),
    ...(action && isSafeSlug(action) ? { action } : {}),
    ...(implementation && isSafeSlug(implementation) ? { implementation } : {}),
    ...(evidence ? { evidence } : {}),
    ...(target === "issue" || target === "pr" ? { target } : {}),
    ...(targetFact ? { targetFact } : {}),
    ...(agent && isSafeSlug(agent) ? { agent } : {}),
    ...(reason ? { reason } : {}),
    ...(cliArgs && typeof cliArgs === "object" && !Array.isArray(cliArgs)
      ? { cliArgs: cliArgs as Record<string, unknown> }
      : {}),
    ...(inputs ? { inputs } : {}),
    ...(next ? { next } : {}),
    ...(isPlainObject(raw.runWhen) ? { runWhen: raw.runWhen as Record<string, unknown> } : {}),
    ...(stringList(raw.continueOn ?? raw.continue_on).length > 0
      ? { continueOn: stringList(raw.continueOn ?? raw.continue_on) }
      : {}),
    ...(raw.saveReport === true ? { saveReport: true } : {}),
    ...(report ? { report } : {}),
  }
}

function parseWorkflowInputs(value: unknown): Record<string, CapabilityWorkflowInputConfig> | undefined {
  if (!isPlainObject(value)) return undefined
  const inputs: Record<string, CapabilityWorkflowInputConfig> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!isSafeSlug(name) || !isPlainObject(raw)) continue
    const from = stringField(raw.from)
    if (!from) continue
    inputs[name] = { from }
  }
  return Object.keys(inputs).length > 0 ? inputs : undefined
}

function parseWorkflowTransitions(value: unknown): CapabilityWorkflowTransitionConfig[] | undefined {
  const rawTransitions = Array.isArray(value) ? value : value === undefined ? [] : [value]
  const transitions = rawTransitions
    .map((raw): CapabilityWorkflowTransitionConfig | null => {
      if (typeof raw === "string") {
        const to = raw.trim()
        return isSafeStepId(to) ? { to } : null
      }
      if (!isPlainObject(raw)) return null
      const to = stringField(raw.to)
      if (!to || !isSafeStepId(to)) return null
      const maxIterations =
        typeof raw.maxIterations === "number" && Number.isInteger(raw.maxIterations) && raw.maxIterations > 0
          ? raw.maxIterations
          : undefined
      return {
        to,
        ...(isPlainObject(raw.when) ? { when: raw.when as Record<string, unknown> } : {}),
        ...(raw.default === true ? { default: true } : {}),
        ...(maxIterations ? { maxIterations } : {}),
      }
    })
    .filter((transition): transition is CapabilityWorkflowTransitionConfig => transition !== null)
  return transitions.length > 0 ? transitions : undefined
}

function parseReportPublication(value: unknown): ReportPublicationConfig | undefined {
  if (!isPlainObject(value)) return undefined
  const type = stringField(value.type)
  const owner = stringField(value.owner)
  if (!type || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(type) || !owner || !isSafeSlug(owner)) return undefined
  const version =
    typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0
      ? value.version
      : undefined
  const slug = stringField(value.slug)
  const slugFact = stringField(value.slugFact)
  const title = stringField(value.title)
  const titleFact = stringField(value.titleFact)
  const publishWhenFact = stringField(value.publishWhenFact)
  const reviewStatus = stringField(value.reviewStatus)
  const reviewArea = stringField(value.reviewArea)
  if (!slug && !slugFact) return undefined
  return {
    type,
    ...(version ? { version } : {}),
    owner,
    ...(slug ? { slug } : {}),
    ...(slugFact ? { slugFact } : {}),
    ...(title ? { title } : {}),
    ...(titleFact ? { titleFact } : {}),
    ...(publishWhenFact ? { publishWhenFact } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
    ...(reviewArea ? { reviewArea } : {}),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isSafeSlug(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value) && !value.includes("..")
}

function isSafeStepId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !value.includes("..")
}
