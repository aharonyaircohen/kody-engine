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
    const scripts = (
      profile as typeof profile & {
        scripts: {
          preflight: Array<{ script: string; runWhen?: Record<string, unknown> }>
          postflight: Array<{ script: string }>
        }
      }
    ).scripts
    expect(scripts.preflight).toContainEqual({
      script: "runSimpleCapabilityScript",
      runWhen: { "data.capabilityExecution": "script" },
    })
    expect(scripts.preflight).toContainEqual({
      script: "prepareSimpleCapabilityRuntime",
      runWhen: { "data.capabilityExecution": "agent" },
    })
    expect(scripts.postflight.map(({ script }) => script)).toEqual(["parseSimpleCapabilityOutput", "publishReport"])
  })

  it("keeps pull-request delivery in a separate internal runtime", () => {
    const profile = JSON.parse(
      fs.readFileSync(new URL("../../src/runtime-services/capability-delivery/profile.json", import.meta.url), "utf8"),
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
      "runSimpleCapabilityScript",
    ])
    expect(profile.scripts.postflight.map(({ script }) => script)).toEqual(["parseSimpleCapabilityOutput"])
  })

  it("owns the pull-request delivery protocol around the capability prompt", () => {
    const template = fs.readFileSync(
      new URL("../../src/runtime-services/capability-delivery/prompt.md", import.meta.url),
      "utf8",
    )

    expect(template).toContain("{{prompt}}")
    expect(template).toContain("The delivery wrapper owns git commits, pushes, and pull requests.")
    expect(template).toContain("COMMIT_MSG:")
    expect(template.indexOf("{{prompt}}")).toBeLessThan(template.indexOf("## Delivery"))
  })
})
