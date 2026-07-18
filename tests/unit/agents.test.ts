import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { frameAgentIdentity, loadAgentIdentity } from "../../src/agents.js"

let cwd: string

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-agent-"))
  fs.mkdirSync(path.join(cwd, ".kody-engine", "definitions", "agents"), {
    recursive: true,
  })
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

function writeAgent(slug: string, contents: string): void {
  fs.writeFileSync(path.join(cwd, ".kody-engine", "definitions", "agents", `${slug}.md`), contents)
}

describe("loadAgentIdentity", () => {
  it("returns the body with frontmatter stripped", () => {
    writeAgent("cto", "---\ntitle: CTO\nrole: exec\n---\nYou are the CTO. Guard architecture.")
    expect(loadAgentIdentity(cwd, "cto")).toBe("You are the CTO. Guard architecture.")
  })

  it("returns the whole file when there is no frontmatter", () => {
    writeAgent("planner", "You are the planner.")
    expect(loadAgentIdentity(cwd, "planner")).toBe("You are the planner.")
  })

  it("trims a slug with surrounding whitespace", () => {
    writeAgent("security", "Security agent.")
    expect(loadAgentIdentity(cwd, "  security  ")).toBe("Security agent.")
  })

  it("throws when the agent file is missing", () => {
    expect(() => loadAgentIdentity(cwd, "ghost")).toThrow(/declared but .* does not exist/)
  })

  it("throws when the agent identity body is empty", () => {
    writeAgent("hollow", "---\ntitle: x\n---\n")
    expect(() => loadAgentIdentity(cwd, "hollow")).toThrow(/agent identity body is empty/)
  })

  it("throws on an empty slug", () => {
    expect(() => loadAgentIdentity(cwd, "   ")).toThrow(/empty agent slug/)
  })

  it("does not fall through when the hydrated agent is missing", () => {
    expect(() => loadAgentIdentity(cwd, "kody")).toThrow(/does not exist/)
  })

  it("lets a consumer file override a store agent", () => {
    writeAgent("kody", "My own kody identity.")
    expect(loadAgentIdentity(cwd, "kody")).toBe("My own kody identity.")
  })

  it("throws when a consumer file for a store slug is empty", () => {
    writeAgent("kody", "---\ntitle: x\n---\n")
    expect(() => loadAgentIdentity(cwd, "kody")).toThrow(/agent identity body is empty/)
  })

  it("still throws for an unknown slug with no file (no silent default)", () => {
    expect(() => loadAgentIdentity(cwd, "reviewer")).toThrow(/declared but .* does not exist/)
  })
})

describe("frameAgentIdentity", () => {
  it("wraps the agent in authoritative-identity framing including the slug and body", () => {
    const framed = frameAgentIdentity("cto", "Guard the architecture.")
    expect(framed).toContain("agent `cto`")
    expect(framed).toContain("the agent wins")
    expect(framed).toContain("Guard the architecture.")
  })
})
