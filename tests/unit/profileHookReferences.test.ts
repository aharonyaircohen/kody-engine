import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { getPluginsCatalogRoot } from "../../src/scripts/buildSyntheticPlugin.js"

const EXECUTABLES_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "src", "executables")

interface ProfileShape {
  name: string
  claudeCode?: { hooks?: string[]; skills?: string[]; commands?: string[]; subagents?: string[] }
}

function listExecutables(): { name: string; dir: string; profile: ProfileShape }[] {
  const out: { name: string; dir: string; profile: ProfileShape }[] = []
  for (const entry of fs.readdirSync(EXECUTABLES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const profilePath = path.join(EXECUTABLES_ROOT, entry.name, "profile.json")
    if (!fs.existsSync(profilePath)) continue
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as ProfileShape
    out.push({ name: entry.name, dir: path.join(EXECUTABLES_ROOT, entry.name), profile })
  }
  return out
}

function partExists(execDir: string, bucket: string, entry: string): boolean {
  const ext = bucket === "skills" ? "" : ".json".replace(".json", bucket === "hooks" ? ".json" : ".md")
  // hooks: <name>.json; skills: <name>/ (dir); commands: <name>.md; agents: <name>.md
  const localPath =
    bucket === "skills"
      ? path.join(execDir, "skills", entry)
      : bucket === "hooks"
        ? path.join(execDir, "hooks", `${entry}.json`)
        : path.join(execDir, bucket, `${entry}.md`)
  if (fs.existsSync(localPath)) return true
  const catalogPath =
    bucket === "skills"
      ? path.join(getPluginsCatalogRoot(), "skills", entry)
      : bucket === "hooks"
        ? path.join(getPluginsCatalogRoot(), "hooks", `${entry}.json`)
        : path.join(getPluginsCatalogRoot(), bucket, `${entry}.md`)
  return fs.existsSync(catalogPath)
}

describe("every executable's plugin-part references resolve", () => {
  const executables = listExecutables()

  for (const { name, dir, profile } of executables) {
    const cc = profile.claudeCode ?? {}

    if ((cc.hooks ?? []).length > 0) {
      it.each(cc.hooks!.map((h) => [name, h]))("%s: hook '%s' resolves", (_exec, hook) => {
        expect(partExists(dir, "hooks", hook)).toBe(true)
      })
    }
    if ((cc.skills ?? []).length > 0) {
      it.each(cc.skills!.map((s) => [name, s]))("%s: skill '%s' resolves", (_exec, skill) => {
        expect(partExists(dir, "skills", skill)).toBe(true)
      })
    }
    if ((cc.commands ?? []).length > 0) {
      it.each(cc.commands!.map((c) => [name, c]))("%s: command '%s' resolves", (_exec, cmd) => {
        expect(partExists(dir, "commands", cmd)).toBe(true)
      })
    }
    if ((cc.subagents ?? []).length > 0) {
      it.each(cc.subagents!.map((a) => [name, a]))("%s: subagent '%s' resolves", (_exec, sub) => {
        expect(partExists(dir, "agents", sub)).toBe(true)
      })
    }
  }

  it("found at least one executable with a hook reference (sanity)", () => {
    const totalHooks = executables.reduce((acc, e) => acc + (e.profile.claudeCode?.hooks?.length ?? 0), 0)
    expect(totalHooks).toBeGreaterThan(0)
  })
})
