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

  it("keeps pull-request delivery in a separate internal runtime", () => {
    const profile = JSON.parse(
      fs.readFileSync(
        new URL("../../src/runtime-services/capability-delivery/profile.json", import.meta.url),
        "utf8",
      ),
    ) as {
      lifecycle: string
      lifecycleConfig: { advance: boolean; sync: boolean }
      scripts: {
        preflight: Array<{ script: string }>
        postflight: Array<{ script: string }>
      }
    }

    expect(profile.lifecycle).toBe("pr-branch")
    expect(profile.lifecycleConfig).toMatchObject({
      advance: false,
      sync: false,
    })
    expect(profile.scripts.preflight.map(({ script }) => script)).toEqual([
      "loadSimpleCapability",
      "prepareCapabilityDelivery",
    ])
    expect(profile.scripts.postflight.map(({ script }) => script)).toEqual([
      "parseSimpleCapabilityOutput",
    ])
  })
})
