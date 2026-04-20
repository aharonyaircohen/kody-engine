import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../src/entry.js"

describe("entry: fix-ci args", () => {
  it("parses --pr into cliArgs", () => {
    const a = parseArgs(["fix-ci", "--pr", "42"])
    expect(a.command).toBe("__executable__")
    expect(a.executableName).toBe("fix-ci")
    expect(a.cliArgs).toEqual({ pr: "42" })
    expect(a.errors).toEqual([])
  })

  it("parses --run-id into cliArgs", () => {
    const a = parseArgs(["fix-ci", "--pr", "1", "--run-id", "123456789"])
    expect(a.cliArgs?.["run-id"]).toBe("123456789")
  })
})
