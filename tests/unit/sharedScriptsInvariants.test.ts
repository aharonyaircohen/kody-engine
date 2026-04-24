/**
 * Architecture test — encodes the "shared scripts stay generic" invariant:
 *
 *   1. No file under src/scripts/ may compare profile.name as a branch
 *      condition (===, !==, ==, !=, switch, in/includes on literal name).
 *      Using profile.name as an opaque label (state keys, logs, producedBy
 *      tags, action-type prefixes) is allowed.
 *
 *   2. No file under src/scripts/ may import from src/executables/ —
 *      shared code cannot reach into executable-specific code, structurally
 *      preventing the per-executable branching pattern from ever creeping
 *      back in.
 *
 * When this test fails, the fix is to move the offending logic into the
 * specific executable's directory (see AGENTS.md § "clean executor layer").
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const SCRIPTS_DIR = path.resolve(__dirname, "../../src/scripts")
const EXECUTABLES_DIR = path.resolve(__dirname, "../../src/executables")

function listScriptFiles(): string[] {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => path.join(SCRIPTS_DIR, f))
}

function listExecutableNames(): string[] {
  return fs
    .readdirSync(EXECUTABLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

describe("shared scripts: invariant — no executable-name branching", () => {
  it("does not compare profile.name as a branch condition", () => {
    const offenders: { file: string; line: number; text: string }[] = []
    // Matches: profile.name === / !== / == / != / switch(profile.name)
    const patterns = [/\bprofile(?:\?\.?|\.)name\s*[!=]==?/, /switch\s*\(\s*profile(?:\?\.?|\.)name\s*\)/]
    for (const file of listScriptFiles()) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((text, i) => {
        if (patterns.some((p) => p.test(text))) {
          offenders.push({ file: path.relative(SCRIPTS_DIR, file), line: i + 1, text: text.trim() })
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it("does not compare against literal executable names (catches aliased comparisons)", () => {
    // Catches the evade pattern: `const kind = profile.name; if (kind === "resolve")`.
    // Builds a regex from the actual executable names on disk, so the rule
    // stays accurate as executables are added/removed.
    const names = listExecutableNames()
    expect(names.length).toBeGreaterThan(0)
    const nameGroup = names.map((n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|")
    const pattern = new RegExp(`[!=]==?\\s*["'](?:${nameGroup})["']|case\\s+["'](?:${nameGroup})["']\\s*:`)
    const offenders: { file: string; line: number; text: string }[] = []
    for (const file of listScriptFiles()) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((text, i) => {
        if (pattern.test(text)) {
          offenders.push({ file: path.relative(SCRIPTS_DIR, file), line: i + 1, text: text.trim() })
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it("does not import from src/executables/", () => {
    const offenders: { file: string; line: number; text: string }[] = []
    // Matches any import/require path that resolves into ../executables/
    const pattern = /from\s+["'][^"']*\/executables\/[^"']+["']|require\(\s*["'][^"']*\/executables\/[^"']+["']/
    for (const file of listScriptFiles()) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((text, i) => {
        if (pattern.test(text)) {
          offenders.push({ file: path.relative(SCRIPTS_DIR, file), line: i + 1, text: text.trim() })
        }
      })
    }
    // Importing types from "../executables/types.js" is allowed — it's the
    // shared contract, not an implementation. Everything else is banned.
    const real = offenders.filter((o) => !/executables\/types(\.js)?["']/.test(o.text))
    expect(real).toEqual([])
  })
})
