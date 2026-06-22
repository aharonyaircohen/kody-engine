import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../src/entry.js"

describe("entry: resolve args", () => {
  it("parses --pr into cliArgs", () => {
    const a = parseArgs(["resolve", "--pr", "42"])
    expect(a.command).toBe("__agent_responsibility__")
    expect(a.actionName).toBe("resolve")
    expect(a.cliArgs).toEqual({ pr: "42" })
    expect(a.errors).toEqual([])
  })

  it("parses --pr and --prefer into cliArgs", () => {
    const a = parseArgs(["resolve", "--pr", "42", "--prefer", "theirs"])
    expect(a.command).toBe("__agent_responsibility__")
    expect(a.actionName).toBe("resolve")
    expect(a.cliArgs).toEqual({ pr: "42", prefer: "theirs" })
    expect(a.errors).toEqual([])
  })
})
