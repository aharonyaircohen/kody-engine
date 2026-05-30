/**
 * goal-scheduler depends on python3 to parse each goal's state.json. That
 * dependency must be declared in the profile so the executor verifies/installs
 * it during preflight cliTool validation — otherwise a runner without python3
 * silently reads every goal as inactive and ticks nothing.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const profilePath = path.join(__dirname, "../../src/executables/goal-scheduler/profile.json")

describe("goal-scheduler profile", () => {
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as {
    cliTools: Array<{ name: string; install?: { required?: boolean } }>
  }

  it("declares python3 as a required cliTool", () => {
    const py = profile.cliTools.find((t) => t.name === "python3")
    expect(py).toBeDefined()
    expect(py?.install?.required).toBe(true)
  })

  it("still declares gh", () => {
    expect(profile.cliTools.some((t) => t.name === "gh")).toBe(true)
  })
})
