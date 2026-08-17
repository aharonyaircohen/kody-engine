import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createOutputContractPostWriteHook, createOutputContractStopHook } from "../../src/outputContractHooks.js"

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "status"],
  properties: {
    version: { const: 1 },
    status: { enum: ["pass", "fail", "blocked"] },
  },
}

const dirs: string[] = []

function outputFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-output-contract-"))
  dirs.push(dir)
  return path.join(dir, "result.json")
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("output contract hooks", () => {
  it("gives the agent immediate correction instructions after an invalid output write", async () => {
    const file = outputFile()
    fs.writeFileSync(file, JSON.stringify({ actions: [] }))
    const hook = createOutputContractPostWriteHook({ path: file, schema })

    const result = await hook({ tool_input: { file_path: file } })

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("overwrite"),
      },
    })
    expect(JSON.stringify(result)).toContain("must have required property 'version'")
  })

  it("does not comment on unrelated writes or a valid output", async () => {
    const file = outputFile()
    const hook = createOutputContractPostWriteHook({ path: file, schema })
    expect(await hook({ tool_input: { file_path: `${file}.other` } })).toEqual({})

    fs.writeFileSync(file, JSON.stringify({ version: 1, status: "pass" }))
    expect(await hook({ tool_input: { file_path: file } })).toEqual({})
  })

  it("continues an unfinished journey instead of asking for an early result", async () => {
    const hook = createOutputContractStopHook({ path: outputFile(), schema })

    const result = await hook()

    expect(result).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("Continue the Journey"),
    })
    expect(JSON.stringify(result)).not.toContain("overwrite")
  })

  it("asks for correction only after an invalid result was written", async () => {
    const file = outputFile()
    fs.writeFileSync(file, "not json")
    const hook = createOutputContractStopHook({ path: file, schema })

    const result = await hook()

    expect(result).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("overwrite"),
    })
  })

  it("allows finishing after a valid result was written", async () => {
    const file = outputFile()
    fs.writeFileSync(file, JSON.stringify({ version: 1, status: "blocked" }))
    const hook = createOutputContractStopHook({ path: file, schema })

    expect(await hook()).toEqual({})
  })

  it("accepts a valid final JSON response as the authoritative output", async () => {
    const file = outputFile()
    const hook = createOutputContractStopHook({ path: file, schema })

    const result = await hook({
      last_assistant_message: JSON.stringify({ version: 1, status: "pass" }),
    })

    expect(result).toEqual({})
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, status: "pass" })
  })

  it("rejects a final JSON response that does not match the contract", async () => {
    const file = outputFile()
    const hook = createOutputContractStopHook({ path: file, schema })

    const result = await hook({ last_assistant_message: JSON.stringify({ status: "pass" }) })

    expect(result).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("required property 'version'"),
    })
    expect(fs.existsSync(file)).toBe(false)
  })
})
