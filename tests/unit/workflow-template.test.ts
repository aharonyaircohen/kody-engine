import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(resolve("templates/kody.yml"), "utf8")

describe("consumer workflow template", () => {
  it("forwards the canonical generic run request to the engine", () => {
    expect(workflow).toContain("runRequest:")
    expect(workflow).toContain("KODY_RUN_REQUEST_JSON: ${{ inputs.runRequest }}")
    expect(workflow).toContain("npx -y -p @kody-ade/kody-engine@latest kody-engine")
    expect(workflow).not.toContain("kody-engine ci")
  })

  it("uses portable YAML quoting accepted by strict consumer formatters", () => {
    expect(workflow).toContain("cron: '7/15 * * * *'")
    expect(workflow).not.toMatch(/(?:description|default|cron): "/)
  })

  it("never exposes the repository-wide secret collection", () => {
    expect(workflow).not.toContain("toJSON(secrets)")
    expect(workflow).not.toContain("ALL_SECRETS:")
    expect(workflow).toContain("KODY_TOKEN: ${{ secrets.KODY_TOKEN }}")
  })
})
