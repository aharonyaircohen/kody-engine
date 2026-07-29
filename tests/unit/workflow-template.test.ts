import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(resolve("templates/kody.yml"), "utf8")

describe("consumer workflow template", () => {
  it("forwards the canonical generic run request to the engine", () => {
    expect(workflow).toContain("runRequest:")
    expect(workflow).toContain("KODY_RUN_REQUEST_JSON: ${{ inputs.runRequest }}")
    expect(workflow).toContain(
      "npx -y -p @kody-ade/kody-engine@latest kody-engine",
    )
    expect(workflow).not.toContain("kody-engine ci")
  })
})
