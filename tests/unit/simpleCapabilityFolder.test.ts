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
  fs.writeFileSync(
    path.join(dir, "contract.json"),
    JSON.stringify({
      input: { name: "request", schema: { type: "object" } },
      output: { name: "result", schema: { type: "object" } },
    }),
  )
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), content)
  return { root, dir }
}

describe("simple Capability folder", () => {
  it("loads instructions and one input/output contract", () => {
    const { root, dir } = capability()
    const loaded = readCapabilityFolder(root, "inspect")
    expect(isCapabilityFolder(dir)).toBe(true)
    expect(loaded?.bodyPath).toBe(path.join(dir, "instructions.md"))
    expect(loaded?.rawProfile.contract).toMatchObject({
      input: { name: "request" },
      output: { name: "result" },
    })
    expect(resolveCapabilityExecution(loaded!, root)).toEqual({
      implementation: "capability-run",
      cliArgs: { capability: "inspect" },
    })
  })

  it("rejects hidden runtime and orchestration files", () => {
    const { dir } = capability({ "profile.json": "{}" })
    expect(isCapabilityFolder(dir)).toBe(false)
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
    fs.writeFileSync(
      path.join(dir, "contract.json"),
      JSON.stringify({
        input: { name: "request", schema: { type: "object" } },
        output: { name: "result", schema: { type: "object" } },
      }),
    )
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
    expect(prompt).toContain("Check the evidence carefully.")
    expect(prompt).toContain(path.join(dir, "tools", "check.sh"))
    expect(prompt).not.toContain("unsafe-link")
  })
})
