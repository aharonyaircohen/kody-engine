import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseArgs } from "../../../src/entry.js"

describe("entry: resolve args", () => {
  let tmp: string
  let prevCwd: string

  beforeEach(() => {
    // `resolve` ships in kody-store, not the engine root. CI clones the store
    // alongside the repo; locally that clone may be missing, so set up a
    // stub `.kody/agent-responsibilities/resolve/` in a temp dir and chdir
    // there so the registry picks it up regardless of whether the store is
    // present.
    prevCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-resolve-cmd-"))
    const dir = path.join(tmp, ".kody", "capabilities", "resolve")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "profile.json"),
      JSON.stringify(
        {
          name: "resolve",
          action: "resolve",
          agentAction: "resolve",
          capabilityKind: "act",
          describe: "Merge base into PR and resolve conflicts.",
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(path.join(dir, "capability.md"), "# Resolve\n\nMerge base into PR.\n")
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("parses --pr into cliArgs", () => {
    const a = parseArgs(["resolve", "--pr", "42"])
    expect(a.command).toBe("__capability__")
    expect(a.actionName).toBe("resolve")
    expect(a.cliArgs).toEqual({ pr: "42" })
    expect(a.errors).toEqual([])
  })

  it("parses --pr and --prefer into cliArgs", () => {
    const a = parseArgs(["resolve", "--pr", "42", "--prefer", "theirs"])
    expect(a.command).toBe("__capability__")
    expect(a.actionName).toBe("resolve")
    expect(a.cliArgs).toEqual({ pr: "42", prefer: "theirs" })
    expect(a.errors).toEqual([])
  })
})
