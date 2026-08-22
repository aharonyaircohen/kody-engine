import * as fs from "node:fs"
import { describe, expect, it } from "vitest"

const release = fs.readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")
const retry = fs.readFileSync(new URL("../../.github/workflows/live-release-gate.yml", import.meta.url), "utf8")

describe("Engine release workflow", () => {
  it("publishes before running the shared live release gate", () => {
    const publishAt = release.indexOf("pnpm publish --access public --no-git-checks")
    const gateAt = release.indexOf("pnpm verify:live-release")
    const repeatabilityAt = release.indexOf("ci-repair-live-gate.mjs")

    expect(release).toContain("workflow_dispatch:")
    expect(release).toContain("concurrency:")
    expect(release).toContain("id-token: write")
    expect(release).toContain("secrets.NPM_TOKEN")
    expect(release).toContain("secrets.KODY_TOKEN")
    expect(publishAt).toBeGreaterThan(0)
    expect(gateAt).toBeGreaterThan(publishAt)
    expect(repeatabilityAt).toBeGreaterThan(gateAt)
    expect(release).toContain("aharonyaircohen/kody-ai-agency-catalog")
    expect(release).not.toMatch(/quality/i)
  })

  it("uses the same existing token for a gate-only retry", () => {
    expect(retry).toContain("pnpm verify:live-release")
    expect(retry).toContain("ci-repair-live-gate.mjs")
    expect(retry).toContain("aharonyaircohen/kody-ai-agency-catalog")
    expect(retry).toContain("secrets.KODY_TOKEN")
    expect(retry).not.toContain("KODY_RELEASE_GATE_TOKEN }}")
  })
})
