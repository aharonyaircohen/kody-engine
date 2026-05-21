/**
 * Load a profile's declared subagents into the SDK's `agents` query-option
 * shape (Record<name, { description, prompt, tools? }>).
 *
 * Why this exists: the synthetic-plugin manifest route (agents listed as
 * plugin files) does NOT register subagents for the Agent/Task tool — the
 * model can't see them and falls back to doing the work itself. Passing
 * them directly via the SDK `agents` option is the reliable path.
 *
 * Resolution mirrors buildSyntheticPlugin: the executable's own
 * `<profile.dir>/agents/<name>.md` wins, then the shared catalog at
 * `src/plugins/agents/<name>.md`.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { Profile } from "./executables/types.js"
import { getPluginsCatalogRoot } from "./scripts/buildSyntheticPlugin.js"

export interface LoadedAgent {
  description: string
  prompt: string
  tools?: string[]
  /** Model alias ('sonnet'|'opus'|'haiku') or full ID; omitted = inherit. */
  model?: string
}

/** Split `---\n<frontmatter>\n---\n<body>` into [frontmatter, body]. */
function splitFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
  if (!match) return { fm: {}, body: raw.trim() }
  const fm: Record<string, string> = {}
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { fm, body: (match[2] ?? "").trim() }
}

function resolveAgentFile(profileDir: string, name: string): string {
  const local = path.join(profileDir, "agents", `${name}.md`)
  if (fs.existsSync(local)) return local
  const central = path.join(getPluginsCatalogRoot(), "agents", `${name}.md`)
  if (fs.existsSync(central)) return central
  throw new Error(
    `loadSubagents: agent '${name}' not found in ${profileDir}/agents/ or shared catalog`,
  )
}

/**
 * Build the SDK `agents` record from `profile.claudeCode.subagents`.
 * Returns undefined when the profile declares none, so callers can skip the
 * query option entirely.
 */
export function loadSubagents(profile: Profile): Record<string, LoadedAgent> | undefined {
  const names = profile.claudeCode.subagents
  if (!names || names.length === 0) return undefined
  const agents: Record<string, LoadedAgent> = {}
  for (const name of names) {
    const { fm, body } = splitFrontmatter(fs.readFileSync(resolveAgentFile(profile.dir, name), "utf-8"))
    if (!body) throw new Error(`loadSubagents: agent '${name}' has an empty prompt body`)
    const def: LoadedAgent = {
      description: fm.description ?? `Subagent ${name}`,
      prompt: body,
    }
    if (fm.tools) {
      const tools = fm.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      if (tools.length > 0) def.tools = tools
    }
    // A declared `model` lets a subagent run on a cheaper/faster model than the
    // lead (e.g. review-* scouts on haiku). Dropped silently before this.
    if (fm.model) def.model = fm.model
    // Key by the frontmatter `name` when present so the invocable type
    // matches the file's declared identity, else fall back to the filename.
    agents[fm.name || name] = def
  }
  return agents
}
