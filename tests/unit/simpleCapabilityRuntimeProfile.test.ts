import * as fs from "node:fs"
import { describe, expect, it } from "vitest"

describe("simple Capability runtime profile", () => {
  it("allows the normal file tools instead of forcing edits through Bash", () => {
    const profile = JSON.parse(
      fs.readFileSync(new URL("../../src/runtime-services/capability-run/profile.json", import.meta.url), "utf8"),
    ) as {
      claudeCode: {
        permissionMode: string
        tools: string[]
      }
    }

    expect(profile.claudeCode.permissionMode).toBe("acceptEdits")
    expect(profile.claudeCode.tools).toEqual(["Read", "Bash", "Edit", "Write", "Glob", "Grep"])
  })
})
