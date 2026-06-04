import { describe, expect, it } from "vitest"
import { parseTarget } from "../../src/servers/serve.js"

describe("serve: parseTarget", () => {
  it("defaults to 'none' for an empty / non-array positional", () => {
    expect(parseTarget([])).toBe("none")
    expect(parseTarget(undefined)).toBe("none")
    expect(parseTarget(null)).toBe("none")
  })

  it("maps 'vscode' and the 'code' alias to vscode", () => {
    expect(parseTarget(["vscode"])).toBe("vscode")
    expect(parseTarget(["code"])).toBe("vscode")
    expect(parseTarget(["CODE"])).toBe("vscode") // case-insensitive
  })

  it("maps 'claude' to claude", () => {
    expect(parseTarget(["claude"])).toBe("claude")
  })

  it("throws on an unknown subcommand", () => {
    expect(() => parseTarget(["bogus"])).toThrow(/unknown serve subcommand/)
  })
})
