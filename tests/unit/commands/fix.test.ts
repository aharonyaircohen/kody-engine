import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../../src/companyStore.js"
import { parseArgs } from "../../../src/entry.js"
import { type CompanyStoreFixture, setupCompanyStoreFixture } from "../_helpers/companyStoreFixture.js"

describe("entry: fix args", () => {
  let fixture: CompanyStoreFixture

  beforeEach(() => {
    fixture = setupCompanyStoreFixture({ capabilities: ["fix"] })
    resetCompanyStoreCacheForTests()
  })

  afterEach(() => {
    fixture.cleanup()
    resetCompanyStoreCacheForTests()
  })

  it("parses --pr into cliArgs", () => {
    const a = parseArgs(["fix", "--pr", "42"])
    expect(a.command).toBe("__capability__")
    expect(a.actionName).toBe("fix")
    expect(a.cliArgs).toEqual({ pr: "42" })
    expect(a.errors).toEqual([])
  })

  it("parses --feedback into cliArgs", () => {
    const a = parseArgs(["fix", "--pr", "1", "--feedback", "rename X to Y"])
    expect(a.cliArgs?.feedback).toBe("rename X to Y")
  })
})
