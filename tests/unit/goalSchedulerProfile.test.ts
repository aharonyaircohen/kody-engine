/**
 * goal-scheduler depends on python3 to parse each goal's state.json. That
 * dependency must be declared in the profile so the executor verifies/installs
 * it during preflight cliTool validation — otherwise a runner without python3
 * silently reads every goal as inactive and ticks nothing.
 *
 * goal-scheduler ships in kody-store, not the engine root. Skip the test
 * gracefully when the store is unavailable (local dev without a clone) so
 * the suite still loads — a missing store is not a profile regression.
 */

import * as fs from "node:fs"
import { describe, expect, it } from "vitest"
import { resolveExecutable } from "../../src/registry.js"

const profilePath = resolveExecutable("goal-scheduler")

describe("goal-scheduler profile", () => {
  if (!profilePath) {
    it.skip("declares python3 as a required cliTool (goal-scheduler not available)", () => {})
    it.skip("does not require gh to enumerate managed goals (goal-scheduler not available)", () => {})
    return
  }

  const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as {
    cliTools: Array<{ name: string; install?: { required?: boolean } }>
  }

  it("declares python3 as a required cliTool", () => {
    const py = profile.cliTools.find((t) => t.name === "python3")
    expect(py).toBeDefined()
    expect(py?.install?.required).toBe(true)
  })

  it("does not require gh to enumerate managed goals", () => {
    expect(profile.cliTools.some((t) => t.name === "gh")).toBe(false)
  })
})
