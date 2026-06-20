import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { framePersona, loadStaffPersona } from "../../src/staff.js"

let cwd: string

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-staff-"))
  fs.mkdirSync(path.join(cwd, ".kody", "staff"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

function writeStaff(slug: string, contents: string): void {
  fs.writeFileSync(path.join(cwd, ".kody", "staff", `${slug}.md`), contents)
}

describe("loadStaffPersona", () => {
  it("returns the body with frontmatter stripped", () => {
    writeStaff("cto", "---\ntitle: CTO\nrole: exec\n---\nYou are the CTO. Guard architecture.")
    expect(loadStaffPersona(cwd, "cto")).toBe("You are the CTO. Guard architecture.")
  })

  it("returns the whole file when there is no frontmatter", () => {
    writeStaff("planner", "You are the planner.")
    expect(loadStaffPersona(cwd, "planner")).toBe("You are the planner.")
  })

  it("trims a slug with surrounding whitespace", () => {
    writeStaff("security", "Security persona.")
    expect(loadStaffPersona(cwd, "  security  ")).toBe("Security persona.")
  })

  it("throws when the staff file is missing", () => {
    expect(() => loadStaffPersona(cwd, "ghost")).toThrow(/declared but .* does not exist/)
  })

  it("throws when the persona body is empty", () => {
    writeStaff("hollow", "---\ntitle: x\n---\n")
    expect(() => loadStaffPersona(cwd, "hollow")).toThrow(/persona body is empty/)
  })

  it("throws on an empty slug", () => {
    expect(() => loadStaffPersona(cwd, "   ")).toThrow(/empty staff slug/)
  })

  it("resolves kody from the configured company store when no consumer file exists", () => {
    expect(loadStaffPersona(cwd, "kody")).toContain("Kody")
  })

  it("lets a consumer file override a store persona", () => {
    writeStaff("kody", "My own kody identity.")
    expect(loadStaffPersona(cwd, "kody")).toBe("My own kody identity.")
  })

  it("throws when a consumer file for a store slug is empty", () => {
    writeStaff("kody", "---\ntitle: x\n---\n")
    expect(() => loadStaffPersona(cwd, "kody")).toThrow(/persona body is empty/)
  })

  it("still throws for an unknown slug with no file (no silent default)", () => {
    expect(() => loadStaffPersona(cwd, "reviewer")).toThrow(/declared but .* does not exist/)
  })
})

describe("framePersona", () => {
  it("wraps the persona in authoritative-identity framing including the slug and body", () => {
    const framed = framePersona("cto", "Guard the architecture.")
    expect(framed).toContain("staff member `cto`")
    expect(framed).toContain("the persona wins")
    expect(framed).toContain("Guard the architecture.")
  })
})
