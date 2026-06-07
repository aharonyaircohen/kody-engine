import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../src/entry.js"

describe("entry: fix args", () => {
  it("parses --pr into cliArgs", () => {
    const a = parseArgs(["fix", "--pr", "42"])
    expect(a.command).toBe("__executable__")
    expect(a.executableName).toBe("fix")
    expect(a.cliArgs).toEqual({ pr: "42" })
    expect(a.errors).toEqual([])
  })

  it("parses --feedback into cliArgs", () => {
    const a = parseArgs(["fix", "--pr", "1", "--feedback", "rename X to Y"])
    expect(a.cliArgs?.feedback).toBe("rename X to Y")
  })
})
