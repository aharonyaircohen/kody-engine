/**
 * Preflight: assemble a temp "synthetic plugin" from profile-declared
 * skills/commands/hooks/subagents and stash its absolute path on
 * ctx.data.syntheticPluginPath. The agent runner then passes it to the
 * SDK's `plugins` option alongside any profile.claudeCode.plugins entries.
 *
 * Why: Claude Code's SDK only accepts plugins as `{ type: 'local', path }`.
 * Individual skills/commands/hooks/subagents are NOT top-level options —
 * they must live inside a plugin directory on disk. This script builds one
 * on the fly per run, sourced from the engine's built-in catalog at
 * src/plugins/{skills,commands,hooks,agents}.
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

  // Skills: copy each src/plugins/skills/<name>/ directory verbatim.
  if (cc.skills.length > 0) {
    const dst = path.join(root, "skills")
    fs.mkdirSync(dst, { recursive: true })
    for (const name of cc.skills) {
      const src = path.join(catalog, "skills", name)
      if (!fs.existsSync(src)) throw new Error(`buildSyntheticPlugin: skill not found in catalog: ${name}`)
      copyDir(src, path.join(dst, name))
    }
  }

  // Commands: copy src/plugins/commands/<name>.md.
  if (cc.commands.length > 0) {
    const dst = path.join(root, "commands")
    fs.mkdirSync(dst, { recursive: true })
    for (const name of cc.commands) {
      const src = path.join(catalog, "commands", `${name}.md`)
      if (!fs.existsSync(src)) throw new Error(`buildSyntheticPlugin: command not found in catalog: ${name}`)
      fs.copyFileSync(src, path.join(dst, `${name}.md`))
    }
  }

  // Subagents: copy src/plugins/agents/<name>.md.
  if (cc.subagents.length > 0) {
    const dst = path.join(root, "agents")
    fs.mkdirSync(dst, { recursive: true })
    for (const name of cc.subagents) {
      const src = path.join(catalog, "agents", `${name}.md`)
      if (!fs.existsSync(src)) throw new Error(`buildSyntheticPlugin: subagent not found in catalog: ${name}`)
      fs.copyFileSync(src, path.join(dst, `${name}.md`))
    }
  }

  // Hooks: merge all declared src/plugins/hooks/<name>.json into one hooks/hooks.json.
  if (cc.hooks.length > 0) {
    const dst = path.join(root, "hooks")
    fs.mkdirSync(dst, { recursive: true })
    const merged: { hooks: Record<string, unknown[]> } = { hooks: {} }
    for (const name of cc.hooks) {
      const src = path.join(catalog, "hooks", `${name}.json`)
      if (!fs.existsSync(src)) throw new Error(`buildSyntheticPlugin: hook not found in catalog: ${name}`)
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
