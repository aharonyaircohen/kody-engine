import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isCapabilityFolder, readCapabilityFolder } from "../../src/capabilityFolders.js"
import { getImplementationRootsForCwd, resolveCapabilityExecution } from "../../src/registry.js"
import { loadSimpleCapability } from "../../src/scripts/loadSimpleCapability.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function capability(extra: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-capability-"))
  roots.push(root)
  const dir = path.join(root, "inspect")
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
  fs.writeFileSync(path.join(dir, "instructions.md"), "Inspect the supplied request.\n")
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), content)
  return { root, dir }
}

describe("simple Capability folder", () => {
  it("loads instructions and an optional machine-readable contract", () => {
    const contract = {
      input: {
        type: "object",
        properties: { pr: { type: "integer" } },
        required: ["pr"],
      },
      output: {
        type: "object",
        properties: { verdict: { enum: ["pass", "fix"] } },
        required: ["verdict"],
      },
    }
    const { root, dir } = capability({ "contract.json": JSON.stringify(contract) })
    const loaded = readCapabilityFolder(root, "inspect")
    expect(isCapabilityFolder(dir)).toBe(true)
    expect(loaded?.bodyPath).toBe(path.join(dir, "instructions.md"))
    expect(loaded?.contractPath).toBe(path.join(dir, "contract.json"))
    expect(loaded?.contract).toEqual(contract)
    expect(loaded?.config.inputSchema).toEqual(contract.input)
    expect(loaded?.config.outputSchema).toEqual(contract.output)
    expect(resolveCapabilityExecution(loaded!, root)).toEqual({
      implementation: "capability-run",
      cliArgs: { capability: "inspect" },
    })
  })

  it("rejects runtime files and malformed contracts", () => {
    const { dir } = capability({ "profile.json": "{}" })
    expect(isCapabilityFolder(dir)).toBe(false)

    const invalid = capability({ "contract.json": "{}" })
    expect(readCapabilityFolder(invalid.root, "inspect")).toBeNull()
  })

  it("does not discover repository Implementation definitions", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-runtime-"))
    roots.push(cwd)
    const external = path.join(cwd, ".kody-engine", "definitions", "implementations")
    fs.mkdirSync(external, { recursive: true })

    expect(getImplementationRootsForCwd(cwd)).not.toContain(external)
  })

  it("loads skill instructions and safe tool paths into the execution prompt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-runtime-"))
    roots.push(cwd)
    const root = path.join(cwd, ".kody-engine", "definitions", "capabilities")
    const dir = path.join(root, "inspect")
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
    fs.writeFileSync(path.join(dir, "instructions.md"), "Inspect the supplied request.\n")
    fs.writeFileSync(path.join(dir, "skills", "review.md"), "Check the evidence carefully.")
    fs.writeFileSync(path.join(dir, "tools", "check.sh"), "#!/bin/sh\necho checked\n")
    fs.symlinkSync(path.join(dir, "instructions.md"), path.join(dir, "tools", "unsafe-link"))

    const ctx = {
      cwd,
      args: { capability: "inspect", input: '{"subject":"change"}' },
      data: {},
    } as never
    await loadSimpleCapability(ctx, {} as never)

    const prompt = String((ctx as { data: Record<string, unknown> }).data.prompt)
    const environment = (ctx as { data: { capabilityEnvironment: Record<string, string> } }).data.capabilityEnvironment
    expect(prompt).toContain("Check the evidence carefully.")
    expect(prompt).toContain(path.join(dir, "tools", "check.sh"))
    expect(prompt).not.toContain("unsafe-link")
    expect(prompt).toContain('"subject": "change"')
    expect(prompt).toContain("Return one JSON value.")
    expect(prompt).not.toContain("Output contract")
    expect(environment).toEqual({
      KODY_CAPABILITY_INPUT: '{"subject":"change"}',
      KODY_ARG_SUBJECT: "change",
    })
  })

  it("does not mix delivery policy into capability loading", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-runtime-"))
    roots.push(cwd)
    const root = path.join(cwd, ".kody-engine", "definitions", "capabilities")
    const dir = path.join(root, "change")
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
    fs.writeFileSync(path.join(dir, "instructions.md"), "Make the requested change.\n")

    const ctx = {
      cwd,
      args: { capability: "change", input: '{"issue":7}' },
      data: { jobDelivery: "pull-request" },
    } as never
    await loadSimpleCapability(ctx, {} as never)

    const prompt = String((ctx as { data: Record<string, unknown> }).data.prompt)
    expect(prompt).not.toContain("The wrapper owns git commits, pushes, and pull requests.")
    expect(prompt).not.toContain("COMMIT_MSG:")
    expect(prompt).toContain("Return one JSON value.")
  })

  it("places the declared output contract after capability-owned skills", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-runtime-"))
    roots.push(cwd)
    const root = path.join(cwd, ".kody-engine", "definitions", "capabilities")
    const dir = path.join(root, "inspect")
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
    fs.writeFileSync(path.join(dir, "instructions.md"), "Inspect the supplied request.\n")
    fs.writeFileSync(path.join(dir, "skills", "review.md"), "Return markdown.")
    fs.writeFileSync(
      path.join(dir, "contract.json"),
      JSON.stringify({
        input: {},
        output: {
          type: "object",
          properties: { verdict: { enum: ["pass", "fix"] } },
          required: ["verdict"],
        },
      }),
    )

    const ctx = {
      cwd,
      args: { capability: "inspect", input: "{}" },
      data: {},
    } as never
    await loadSimpleCapability(ctx, {} as never)

    const prompt = String((ctx as { data: Record<string, unknown> }).data.prompt)
    expect(prompt.indexOf("Return markdown.")).toBeLessThan(prompt.indexOf("## Output contract"))
    expect(prompt).toContain('"verdict"')
  })

  it("rejects input that violates the capability contract before execution", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-runtime-"))
    roots.push(cwd)
    const root = path.join(cwd, ".kody-engine", "definitions", "capabilities")
    const dir = path.join(root, "inspect")
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
    fs.writeFileSync(path.join(dir, "instructions.md"), "Inspect a PR.\n")
    fs.writeFileSync(
      path.join(dir, "contract.json"),
      JSON.stringify({
        input: {
          type: "object",
          properties: { pr: { type: "integer" } },
          required: ["pr"],
        },
        output: {},
      }),
    )

    const ctx = {
      cwd,
      args: { capability: "inspect", input: '{"issue":7}' },
      data: {},
    } as never

    await expect(loadSimpleCapability(ctx, {} as never)).rejects.toThrow(/Capability input does not match/)
  })

  it("keeps old capability flags as fields in the one generic input", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-runtime-"))
    roots.push(cwd)
    const root = path.join(cwd, ".kody-engine", "definitions", "capabilities")
    const dir = path.join(root, "release-prepare")
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
    fs.writeFileSync(path.join(dir, "instructions.md"), "Prepare the release.\n")

    const ctx = {
      cwd,
      args: { capability: "release-prepare", input: "--bump minor --dry-run --prefer=ours" },
      data: {},
    } as never
    await loadSimpleCapability(ctx, {} as never)

    const data = (ctx as { data: Record<string, unknown> }).data
    expect(data.capabilityInput).toEqual({ bump: "minor", "dry-run": true, prefer: "ours" })
    expect(data.capabilityEnvironment).toEqual({
      KODY_CAPABILITY_INPUT: '{"bump":"minor","dry-run":true,"prefer":"ours"}',
      KODY_ARG_BUMP: "minor",
      KODY_ARG_DRY_RUN: "true",
      KODY_ARG_PREFER: "ours",
    })
  })
})
