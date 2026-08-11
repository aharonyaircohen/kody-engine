import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createMissingParentWriteGuard } from "../../src/fileEditGuards.js"

describe("createMissingParentWriteGuard", () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-write-guard-"))
    fs.mkdirSync(path.join(cwd, "src"))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it("allows a new file in an existing source directory", async () => {
    const guard = createMissingParentWriteGuard(cwd)

    await expect(
      guard({ tool_input: { file_path: path.join(cwd, "src", "new-module.ts") } }),
    ).resolves.toEqual({})
  })

  it("blocks a write into a made-up directory tree", async () => {
    const guard = createMissingParentWriteGuard(cwd)
    const filePath = path.join(cwd, "apps", "dashboard", "lib", "defaults.ts")

    await expect(guard({ tool_input: { file_path: filePath } })).resolves.toEqual({
      decision: "block",
      reason: expect.stringContaining("parent directory does not exist"),
    })
  })

  it("ignores malformed tool input", async () => {
    const guard = createMissingParentWriteGuard(cwd)

    await expect(guard({ tool_input: {} })).resolves.toEqual({})
    await expect(guard({})).resolves.toEqual({})
  })
})
