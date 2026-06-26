import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseArgs } from "../../../src/entry.js"

describe("entry: fix-ci args", () => {
  let tmp: string
  let prevCwd: string

  beforeEach(() => {
    // `fix-ci` ships in kody-store, not the engine root. CI clones the store
    // alongside the repo; locally that clone may be missing, so set up a
    // stub `.kody/agent-responsibilities/fix-ci/` in a temp dir and chdir there
    // so the registry picks it up regardless of whether the store is present.
    prevCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-fix-ci-cmd-"))
    const dir = path.join(tmp, ".kody", "capabilities", "fix-ci")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "profile.json"),
      JSON.stringify(
        {
          name: "fix-ci",
          action: "fix-ci",
          agentAction: "fix-ci",
          capabilityKind: "act",
          describe: "Fix latest failing CI on PR.",
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(path.join(dir, "capability.md"), "# Fix CI\n\nFix latest failing CI on PR.\n")
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("parses --pr into cliArgs", () => {
    const a = parseArgs(["fix-ci", "--pr", "42"])
    expect(a.command).toBe("__capability__")
    expect(a.actionName).toBe("fix-ci")
    expect(a.cliArgs).toEqual({ pr: "42" })
    expect(a.errors).toEqual([])
  })

  it("parses --run-id into cliArgs", () => {
    const a = parseArgs(["fix-ci", "--pr", "1", "--run-id", "123456"])
    expect(a.cliArgs?.runId).toBe("123456")
  })
})
