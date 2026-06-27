/**
 * Smoke (system wiring): in-process, offline checks that the engine is
 * fundamentally assembled — every shipped executable profile parses, every
 * script it names exists, and the script registries are self-consistent. A
 * broken profile.json or a profile naming a deleted script fails here in
 * milliseconds, before any heavier tier runs.
 *
 * Relocated from tests/int/wiring-invariants.test.ts: this is a "does the
 * system hang together" check, which is smoke's job, not integration's.
 */

import { describe, expect, it } from "vitest"
import { loadProfile, validateScriptReferences } from "../../src/profile.js"
import { getExecutablesRoot, listExecutables } from "../../src/registry.js"
import { allScriptNames, postflightScripts, preflightScripts } from "../../src/scripts/index.js"

// Engine root only — independent of cwd, so a stray .kody/executables can't
// pollute the set.
const executables = listExecutables(getExecutablesRoot())

const FLAG_RE = /^--[a-z][a-z0-9-]*$/
const INPUT_TYPES = new Set(["string", "int", "bool", "enum"])

describe("smoke: system wiring", () => {
  it("every shipped executable profile loads and validates with well-formed inputs", () => {
    // Keep this list explicit so newly bundled executables are reviewed.
    expect(executables.map((exe) => exe.name)).toEqual(["agent-factory", "run", "task-job-fail-once", "task-jobs"])
    const failures: string[] = []
    for (const exe of executables) {
      try {
        const profile = loadProfile(exe.profilePath)
        for (const input of profile.inputs) {
          if (!FLAG_RE.test(input.flag)) failures.push(`${exe.name}: bad flag "${input.flag}"`)
          if (!INPUT_TYPES.has(input.type)) failures.push(`${exe.name}: bad input type "${input.type}"`)
          if (input.type === "enum" && (!input.values || input.values.length === 0)) {
            failures.push(`${exe.name}: enum input "${input.name}" has no values`)
          }
        }
      } catch (err) {
        failures.push(`${exe.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    expect(failures).toEqual([])
  })

  it("every script referenced by a profile resolves in the registry", () => {
    const failures: string[] = []
    for (const exe of executables) {
      const profile = loadProfile(exe.profilePath)
      const missing = validateScriptReferences(profile, allScriptNames)
      if (missing.length > 0) failures.push(`${exe.name}: unregistered script(s) ${missing.join(", ")}`)
    }
    expect(failures).toEqual([])
  })

  it("the script registries are internally consistent", () => {
    for (const [name, fn] of Object.entries(preflightScripts)) {
      expect(typeof fn, `preflight ${name}`).toBe("function")
    }
    for (const [name, fn] of Object.entries(postflightScripts)) {
      expect(typeof fn, `postflight ${name}`).toBe("function")
    }
    const union = new Set([...Object.keys(preflightScripts), ...Object.keys(postflightScripts)])
    expect(allScriptNames).toEqual(union)
  })
})
