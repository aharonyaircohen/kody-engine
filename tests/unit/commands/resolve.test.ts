import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../src/entry.js"

describe("entry: resolve args", () => {
  it("parses --pr into cliArgs", () => {
    const a = parseArgs(["resolve", "--pr", "42"])
    expect(a.command).toBe("__executable__")
    expect(a.executableName).toBe("resolve")
    expect(a.cliArgs).toEqual({ pr: "42" })
    expect(a.errors).toEqual([])
  })
})
