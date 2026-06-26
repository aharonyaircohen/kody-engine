import * as fs from "node:fs"
import * as path from "node:path"
import type { CapabilityKind } from "./executables/types.js"

export const CAPABILITY_PROFILE_FILE = "profile.json"
export const CAPABILITY_BODY_FILE = "capability.md"

export interface CapabilityFolderConfig {
  action?: string
  implementation?: string
  executable?: string
  tickScript?: string
  disabled?: boolean
  agent?: string
  mentions?: string[]
  tools?: string[]
  capabilityTools?: string[]
  implementations?: string[]
  executables?: string[]
  capabilityKind?: CapabilityKind
  role?: string
  describe?: string
  stage?: string
  readsFrom?: string[]
  writesTo?: string[]
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
  const implementations = stringList(raw.implementations ?? raw.executables)
  return {
    action: stringField(raw.action),
    implementation: stringField(raw.implementation ?? raw.executable),
    executable: stringField(raw.executable),
    tickScript: stringField(raw.tickScript),
    disabled: typeof raw.disabled === "boolean" ? raw.disabled : undefined,
    agent: stringField(raw.agent),
    mentions: stringList(raw.mentions).map((m) => m.replace(/^@/, "")),
    tools,
    capabilityTools: tools,
    implementations,
    executables: stringList(raw.executables),
    capabilityKind: capabilityKindField(raw.capabilityKind),
    role: stringField(raw.role),
    describe: stringField(raw.describe),
    stage: stringField(raw.stage),
    readsFrom: stringList(raw.readsFrom ?? raw.reads_from),
    writesTo: stringList(raw.writesTo ?? raw.writes_to),
  }
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

function capabilityKindField(value: unknown): CapabilityKind | undefined {
  if (value === "observe" || value === "act" || value === "verify") return value
  return undefined
}
