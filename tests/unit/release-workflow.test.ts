import * as fs from "node:fs"
import { describe, expect, it } from "vitest"

const kody = fs.readFileSync(new URL("../../.github/workflows/kody.yml", import.meta.url), "utf8")
const config = fs.readFileSync(new URL("../../kody.config.json", import.meta.url), "utf8")
const retry = fs.readFileSync(new URL("../../.github/workflows/live-release-gate.yml", import.meta.url), "utf8")

describe("Engine release workflow", () => {
  it("publishes only through the Kody workflow", () => {
    expect(fs.existsSync(new URL("../../.github/workflows/release.yml", import.meta.url))).toBe(false)
    expect(kody).toContain("workflow_dispatch:")
    expect(kody).toContain("id-token: write")
    expect(kody).toContain('description: "Capability action to run"')
    expect(config).toContain('"npm-publish"')
    expect(config).toContain('"package-release"')
  })

  it("uses the same existing token for a gate-only retry", () => {
    expect(retry).toContain("pnpm verify:live-release")
    expect(retry).toContain("ci-repair-live-gate.mjs")
    expect(retry).toContain("aharonyaircohen/kody-ai-agency-catalog")
    expect(retry).toContain("secrets.KODY_TOKEN")
    expect(retry).not.toContain("KODY_RELEASE_GATE_TOKEN }}")
  })
})
