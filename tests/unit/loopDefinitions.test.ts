import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { normalizeLoopDefinition, readLoopDefinition } from "../../src/loopDefinitions.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("simple Loop definitions", () => {
  it("accepts the five-field Loop contract", () => {
    expect(normalizeLoopDefinition({
      id: "daily-web-release-loop",
      trigger: { type: "schedule", every: "1d" },
      target: { kind: "workflow", id: "web-release" },
      input: {},
      enabled: false,
    })).toEqual({
      id: "daily-web-release-loop",
      trigger: { type: "schedule", every: "1d" },
      target: { kind: "workflow", id: "web-release" },
      input: {},
      enabled: false,
    })
  })

  it("loads a Loop from the definitions folder", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-loop-"))
    roots.push(cwd)
    const dir = path.join(cwd, ".kody-engine", "definitions", "loops", "daily")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "loop.json"), JSON.stringify({
      id: "daily",
      trigger: { type: "manual" },
      target: { kind: "capability", id: "inspect" },
      input: { request: "now" },
      enabled: true,
    }))
    expect(readLoopDefinition(cwd, "daily")?.target).toEqual({ kind: "capability", id: "inspect" })
  })
})
