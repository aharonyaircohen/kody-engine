/**
 * Wiring smoke tests. The cheapest possible "did we break the engine" gate:
 * exhaustively load every executable's profile.json and assert that every
 * script reference resolves to a registered script. Catches the most common
 * regression class — a script renamed or deleted on one side of the wiring
 * (registry vs profile) without the other.
 *
 * These are CHEAP (file IO + JSON parse, no spawns, no LLM, no network) so
 * they run on every commit. The shipped engine has 29 profiles × ~10 scripts
 * each = ~290 references; a single typo can land on a code path no unit test
 * exercises and only surface in production.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile, validateScriptReferences } from "../../src/profile.js"
import { allScriptNames, postflightScripts, preflightScripts } from "../../src/scripts/index.js"
import { listExecutables } from "../../src/registry.js"

describe("wiring: every profile.json's script refs resolve to a registered script", () => {
  const executables = listExecutables()

  it("the registry discovers a non-empty set of executables", () => {
    expect(executables.length).toBeGreaterThan(20)
  })

  for (const exe of executables) {
    it(`profile '${exe.name}' references only registered scripts`, () => {
      const profile = loadProfile(exe.profilePath)
      const missing = validateScriptReferences(profile, allScriptNames)
      // Asserting an empty array gives a useful failure message: vitest
      // prints the array contents so the operator sees exactly which
      // script(s) are missing without re-running.
      expect(missing).toEqual([])
    })
  }
})

describe("wiring: every registered script can be imported and is a function", () => {
  it("preflightScripts entries are functions", () => {
    for (const [name, fn] of Object.entries(preflightScripts)) {
      expect(typeof fn, `preflight ${name}`).toBe("function")
    }
  })

  it("postflightScripts entries are functions", () => {
    for (const [name, fn] of Object.entries(postflightScripts)) {
      expect(typeof fn, `postflight ${name}`).toBe("function")
    }
  })

  it("allScriptNames is the union of preflight + postflight registries", () => {
    const expected = new Set([...Object.keys(preflightScripts), ...Object.keys(postflightScripts)])
    expect(allScriptNames).toEqual(expected)
  })
})

describe("wiring: every input declared in a profile has a flag and type", () => {
  for (const exe of listExecutables()) {
    it(`profile '${exe.name}' input specs are well-formed`, () => {
      const profile = loadProfile(exe.profilePath)
      for (const input of profile.inputs) {
        expect(typeof input.name, `${exe.name}.${input.name} name`).toBe("string")
        expect(input.name.length).toBeGreaterThan(0)
        // Flag is required for inputs the user sets via CLI; some profiles
        // declare runtime-only inputs. If flag is set it must look like a
        // CLI flag.
        if (input.flag) {
          expect(input.flag, `${exe.name}.${input.name} flag`).toMatch(/^--[a-z][a-z0-9-]*$/)
        }
        expect(["string", "int", "bool", "enum"], `${exe.name}.${input.name} type`).toContain(input.type)
        if (input.type === "enum") {
          expect(Array.isArray(input.values), `${exe.name}.${input.name} enum values`).toBe(true)
          expect(input.values?.length ?? 0).toBeGreaterThan(0)
        }
      }
    })
  }
})

describe("wiring: profile.json files are parseable as JSON before any other check", () => {
  const root = path.dirname(listExecutables()[0]!.profilePath)
  // listExecutables already returns successfully-parsed profiles, but a new
  // executable directory might be added without a profile.json. Spot-check
  // the directory listing matches what we discovered.
  it("every executables/* subdirectory has a profile.json", () => {
    const subdirs = fs.readdirSync(root).filter((n) => {
      const full = path.join(root, n)
      try {
        return fs.statSync(full).isDirectory()
      } catch {
        return false
      }
    })
    const discovered = new Set(listExecutables().map((e) => e.name))
    for (const dir of subdirs) {
      // listExecutables filters out directories without a profile.json, so
      // any subdir not in `discovered` is a missing profile.
      expect(discovered.has(dir), `executables/${dir}/profile.json missing or invalid`).toBe(true)
    }
  })
})
