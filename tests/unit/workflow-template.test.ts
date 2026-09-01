import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(resolve("templates/kody.yml"), "utf8")

describe("consumer workflow template", () => {
  it("directs fixes to their owning Kody source instead of this generated workflow", () => {
    expect(workflow).toContain("Do not edit this workflow.")
    expect(workflow).toContain("Fix behavior in Kody Engine or the Store definition that owns it")
  })

  it("forwards the canonical generic run request to the engine", () => {
    expect(workflow).toContain("runRequest:")
    expect(workflow).toContain("runRequestBase64:")
    expect(workflow).toContain("KODY_RUN_REQUEST_BASE64: $" + "{{ inputs.runRequestBase64 }}")
    expect(workflow).toContain('base64 --decode')
    expect(workflow).toContain('export KODY_RUN_REQUEST_JSON')
    expect(workflow).toContain("npx -y -p @kody-ade/kody-engine@latest kody-engine")
    expect(workflow).not.toContain("kody-engine ci")
  })

  it("uses the generic request id to keep independent runs separate", () => {
    expect(workflow).toContain("requestId:")
    expect(workflow).toContain("inputs.requestId || inputs.sessionId || inputs.issue_number")
  })

  it("leaves automatic scheduling to Convex", () => {
    expect(workflow).not.toMatch(/^\s*schedule:/m)
    expect(workflow).not.toContain("cron:")
    expect(workflow).not.toMatch(/(?:description|default|cron): "/)
  })

  it("never exposes the repository-wide secret collection", () => {
    expect(workflow).not.toContain("toJSON(secrets)")
    expect(workflow).not.toContain("ALL_SECRETS:")
    expect(workflow).toContain("KODY_TOKEN: $" + "{{ secrets.KODY_TOKEN }}")
    expect(workflow).not.toContain("E2E_GITHUB_TOKEN")
  })

  it("uploads Quality Run evidence even when the exact test fails", () => {
    expect(workflow).toContain("uses: actions/upload-artifact@v4")
    expect(workflow).toContain("if: $" + "{{ always() }}")
    expect(workflow).toContain("test-results/quality-runs/")
    expect(workflow).toContain("if-no-files-found: ignore")
  })
})
