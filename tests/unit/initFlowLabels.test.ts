import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { gh } from "../../src/issue.js"
import { collectProfileLabels } from "../../src/lifecycleLabels.js"
import { performInit } from "../../src/scripts/initFlow.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody2-init-labels-"))
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "")
  return dir
}

let dir: string

beforeEach(() => ghMock.mockReset())
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("performInit: lifecycle labels", () => {
  it("ensures every profile-declared label in the target repo", () => {
    ghMock.mockReturnValue("")
    dir = mkRepo()

    const result = performInit(dir, false)

    const expected = collectProfileLabels()
    expect(expected.length).toBeGreaterThan(0)
    expect(result.labels?.created).toHaveLength(expected.length)
    expect(result.labels?.failed).toEqual([])

    for (const spec of expected) {
      const found = ghMock.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "label" && args[1] === "create" && args[2] === spec.label,
      )
      expect(found, `gh label create was not called for ${spec.label}`).toBe(true)
    }
  })

  it("writes core files and still reports a labels result", () => {
    ghMock.mockReturnValue("")
    dir = mkRepo()

    const result = performInit(dir, false)

    expect(result.wrote).toContain("kody.config.json")
    expect(result.labels).toBeDefined()
    expect(result.labels!.created.length + result.labels!.failed.length).toBe(
      collectProfileLabels().length,
    )
  })
})
