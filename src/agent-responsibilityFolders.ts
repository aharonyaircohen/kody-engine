import * as fs from "node:fs"
import * as path from "node:path"
import { isScheduleEvery, type ScheduleEvery } from "./scripts/scheduleEvery.js"

export const AGENT_RESPONSIBILITY_PROFILE_FILE = "profile.json"
export const AGENT_RESPONSIBILITY_BODY_FILE = "agent-responsibility.md"

export interface AgentResponsibilityFolderConfig {
  action?: string
  agentAction?: string
  every?: ScheduleEvery
  tickScript?: string
  disabled?: boolean
  agent?: string
  mentions?: string[]
  tools?: string[]
  agentActions?: string[]
  describe?: string
  stage?: string
  readsFrom?: string[]
  writesTo?: string[]
}

export interface AgentResponsibilityFolder {
  slug: string
  dir: string
  profilePath: string
  bodyPath: string
  title: string
  body: string
  rawBody: string
  config: AgentResponsibilityFolderConfig
  rawProfile: Record<string, unknown>
}

export function listAgentResponsibilityFolderSlugs(absDir: string): string[] {
  if (!fs.existsSync(absDir)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .filter((e) => isAgentResponsibilityFolder(path.join(absDir, e.name)))
    .map((e) => e.name)
    .sort()
}

export function isAgentResponsibilityFolder(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, AGENT_RESPONSIBILITY_PROFILE_FILE)) &&
    fs.existsSync(path.join(dir, AGENT_RESPONSIBILITY_BODY_FILE))
  )
}

export function readAgentResponsibilityFolder(root: string, slug: string): AgentResponsibilityFolder | null {
  const dir = path.join(root, slug)
  const profilePath = path.join(dir, AGENT_RESPONSIBILITY_PROFILE_FILE)
  const bodyPath = path.join(dir, AGENT_RESPONSIBILITY_BODY_FILE)
  if (!fs.existsSync(profilePath) || !fs.statSync(profilePath).isFile()) return null
  if (!fs.existsSync(bodyPath) || !fs.statSync(bodyPath).isFile()) return null
  try {
    const rawProfile = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>
    const rawBody = fs.readFileSync(bodyPath, "utf-8")
    const { title, body } = parseAgentResponsibilityBody(rawBody, slug)
    return {
      slug,
      dir,
      profilePath,
      bodyPath,
      title,
      body,
      rawBody,
      config: parseAgentResponsibilityConfig(rawProfile),
      rawProfile,
    }
  } catch {
    return null
  }
}

export function parseAgentResponsibilityConfig(raw: Record<string, unknown>): AgentResponsibilityFolderConfig {
  const tools = stringList(raw.tools ?? raw.agentResponsibilityTools)
  return {
    action: stringField(raw.action),
    agentAction: stringField(raw.agentAction),
    every: isScheduleEvery(raw.every) ? raw.every : undefined,
    tickScript: stringField(raw.tickScript),
    disabled: typeof raw.disabled === "boolean" ? raw.disabled : undefined,
    agent: stringField(raw.agent),
    mentions: stringList(raw.mentions).map((m) => m.replace(/^@/, "")),
    tools,
    agentActions: stringList(raw.agentActions),
    describe: stringField(raw.describe),
    stage: stringField(raw.stage),
    readsFrom: stringList(raw.readsFrom ?? raw.reads_from),
    writesTo: stringList(raw.writesTo ?? raw.writes_to),
  }
}

export function parseAgentResponsibilityBody(raw: string, slug: string): { title: string; body: string } {
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
