import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../../src/companyStore.js"
import { parseArgs } from "../../../src/entry.js"
import { type CompanyStoreFixture, setupCompanyStoreFixture } from "../_helpers/companyStoreFixture.js"

describe("entry: fix-ci args", () => {
  let fixture: CompanyStoreFixture

  beforeEach(() => {
    fixture = setupCompanyStoreFixture({ capabilities: ["fix-ci"] })
    resetCompanyStoreCacheForTests()
  })

  afterEach(() => {
    fixture.cleanup()
    resetCompanyStoreCacheForTests()
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
