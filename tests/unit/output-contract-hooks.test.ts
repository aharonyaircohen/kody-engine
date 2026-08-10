import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createOutputContractPostWriteHook,
} from "../../src/outputContractHooks.js"

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

})
