/**
 * Preflight: assemble a temp "synthetic plugin" from profile-declared
 * skills/commands/hooks/subagents and stash its absolute path on
 * ctx.data.syntheticPluginPath. The agent runner then passes it to the
 * SDK's `plugins` option alongside any profile.claudeCode.plugins entries.
 *
 * Why: Claude Code's SDK only accepts plugins as `{ type: 'local', path }`.
 * Individual skills/commands/hooks/subagents are NOT top-level options —
 * they must live inside a plugin directory on disk. This script builds one
 * on the fly per run.
 *
 * Resolution order for each declared name:
 *   1. The executable's own directory:
 *      src/executables/<name>/{skills,commands,agents,hooks}/<entry>
 *      — for parts that are specific to one executable.
 *   2. The engine's shared catalog:
 *      src/plugins/{skills,commands,agents,hooks}/<entry>
 *      — for parts reused across multiple executables.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"

/** Resolve the engine's bundled plugin-parts catalog (dev + built layouts). */
export function getPluginsCatalogRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "..", "plugins"), // dev: src/scripts → src/plugins
    path.join(here, "..", "..", "plugins"), // built: dist/scripts → dist/plugins
    path.join(here, "..", "..", "src", "plugins"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return candidates[0]!
}

export const buildSyntheticPlugin: PreflightScript = async (ctx, profile) => {
  const cc = profile.claudeCode
  const needsSynthetic =
    cc.skills.length > 0 || cc.commands.length > 0 || cc.hooks.length > 0 || cc.subagents.length > 0
  if (!needsSynthetic) return

  const catalog = getPluginsCatalogRoot()
  const runId = `${profile.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const root = path.join(os.tmpdir(), `kody-synth-${runId}`)
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true })

  // Resolve plugin parts from the executable's own directory first, then fall
  // back to the engine's central catalog. Lets an executable ship local
  // skills/commands/subagents/hooks under
  //   src/executables/<name>/{skills,commands,agents,hooks}/
  // without polluting the shared catalog.
  const resolvePart = (bucket: "skills" | "commands" | "agents" | "hooks", entry: string): string => {
    const local = path.join(profile.dir, bucket, entry)
    if (fs.existsSync(local)) return local
    const central = path.join(catalog, bucket, entry)
    if (fs.existsSync(central)) return central
    throw new Error(
      `buildSyntheticPlugin: ${bucket} entry '${entry}' not found in executable dir (${profile.dir}/${bucket}/) or catalog (${catalog}/${bucket}/)`,
    )
  }

  // Skills: copy each declared <name>/ directory verbatim.
  if (cc.skills.length > 0) {
    const dst = path.join(root, "skills")
    fs.mkdirSync(dst, { recursive: true })
    for (const name of cc.skills) {
      copyDir(resolvePart("skills", name), path.join(dst, name))
    }
  }

  // Commands: copy each declared <name>.md.
  if (cc.commands.length > 0) {
    const dst = path.join(root, "commands")
    fs.mkdirSync(dst, { recursive: true })
    for (const name of cc.commands) {
      fs.copyFileSync(resolvePart("commands", `${name}.md`), path.join(dst, `${name}.md`))
    }
  }

  // Subagents: copy each declared <name>.md.
  if (cc.subagents.length > 0) {
    const dst = path.join(root, "agents")
    fs.mkdirSync(dst, { recursive: true })
    for (const name of cc.subagents) {
      fs.copyFileSync(resolvePart("agents", `${name}.md`), path.join(dst, `${name}.md`))
    }
  }

  // Hooks: merge all declared <name>.json into one hooks/hooks.json.
  if (cc.hooks.length > 0) {
    const dst = path.join(root, "hooks")
    fs.mkdirSync(dst, { recursive: true })
    const merged: { hooks: Record<string, unknown[]> } = { hooks: {} }
    for (const name of cc.hooks) {
      const src = resolvePart("hooks", `${name}.json`)
      const parsed = JSON.parse(fs.readFileSync(src, "utf-8")) as { hooks?: Record<string, unknown[]> }
      for (const [event, entries] of Object.entries(parsed.hooks ?? {})) {
        if (!Array.isArray(entries)) continue
        if (!merged.hooks[event]) merged.hooks[event] = []
        merged.hooks[event].push(...entries)
      }
    }
    fs.writeFileSync(path.join(dst, "hooks.json"), `${JSON.stringify(merged, null, 2)}\n`)
  }

  const manifest: Record<string, unknown> = {
    name: `kody-synth-${profile.name}`,
    version: "1.0.0",
    description: `Synthetic plugin assembled by Kody for profile '${profile.name}' at runtime.`,
  }
  if (cc.skills.length > 0) manifest.skills = ["./skills/"]
  if (cc.commands.length > 0) manifest.commands = ["./commands/"]
  if (cc.subagents.length > 0) manifest.agents = cc.subagents.map((n) => `./agents/${n}.md`)
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  ctx.data.syntheticPluginPath = root
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dst, ent.name)
    if (ent.isDirectory()) copyDir(s, d)
    else if (ent.isFile()) fs.copyFileSync(s, d)
  }
}
