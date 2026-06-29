import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../../src/companyStore.js"
import { parseArgs } from "../../../src/entry.js"
import { type CompanyStoreFixture, setupCompanyStoreFixture } from "../_helpers/companyStoreFixture.js"

describe("entry: resolve args", () => {
  let fixture: CompanyStoreFixture

  beforeEach(() => {
    fixture = setupCompanyStoreFixture({ capabilities: ["resolve"] })
    resetCompanyStoreCacheForTests()
  })

  afterEach(() => {
    fixture.cleanup()
    resetCompanyStoreCacheForTests()
  })

  it("parses --pr into cliArgs", () => {
    const a = parseArgs(["resolve", "--pr", "42"])
    expect(a.command).toBe("__capability__")
    expect(a.actionName).toBe("resolve")
    expect(a.cliArgs).toEqual({ pr: "42" })
    expect(a.errors).toEqual([])
  })

  it("parses --pr and --prefer into cliArgs", () => {
    const a = parseArgs(["resolve", "--pr", "42", "--prefer", "theirs"])
    expect(a.command).toBe("__capability__")
    expect(a.actionName).toBe("resolve")
    expect(a.cliArgs).toEqual({ pr: "42", prefer: "theirs" })
    expect(a.errors).toEqual([])
  })
})
