import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { definitionsRoot, hasExplicitDefinitionsRoot } from "../../src/definition-paths.js"

describe("definition paths", () => {
  let cwd: string
  let override: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-definitions-cwd-"))
    override = fs.mkdtempSync(path.join(os.tmpdir(), "kody-definitions-override-"))
    vi.stubEnv("KODY_DEFINITIONS_ROOT", override)
    vi.stubEnv("KODY_DEFINITIONS_ROOT_CWD", cwd)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(override, { recursive: true, force: true })
  })

  it("uses the scoped override even when that workspace has a stale local cache", () => {
    fs.mkdirSync(path.join(cwd, ".kody-engine", "definitions"), { recursive: true })

    expect(definitionsRoot(cwd)).toBe(override)
  })

  it("keeps another workspace's populated local definitions isolated from the override", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "kody-definitions-other-"))
    const local = path.join(other, ".kody-engine", "definitions")
    fs.mkdirSync(local, { recursive: true })

    expect(definitionsRoot(other)).toBe(local)
    fs.rmSync(other, { recursive: true, force: true })
  })

  it("recognizes the scoped override as an explicit definition source", () => {
    expect(hasExplicitDefinitionsRoot(cwd)).toBe(true)

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "kody-definitions-other-"))
    expect(hasExplicitDefinitionsRoot(other)).toBe(false)
    fs.rmSync(other, { recursive: true, force: true })
  })
})
