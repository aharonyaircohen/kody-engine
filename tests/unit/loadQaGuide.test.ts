import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadQaGuide, QA_GUIDE_REL_PATH } from "../../src/scripts/loadQaGuide.js"
import type { Context, Profile } from "../../src/executables/types.js"

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-qaguide-"))
}

function makeCtx(cwd: string): Context {
  return {
    args: {},
    cwd,
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/haiku" },
    },
    data: {},
    output: { exitCode: 0 },
  }
}

const dummyProfile = {} as Profile

describe("loadQaGuide", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mktmp()
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("loads the file when present", async () => {
    const dir = path.join(tmp, ".kody")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "qa-guide.md"), "# QA\nadmin@example.com / hunter2\n")
    const ctx = makeCtx(tmp)
    await loadQaGuide(ctx, dummyProfile)
    expect(ctx.data.qaGuide).toContain("admin@example.com")
    expect(ctx.data.qaGuidePath).toBe(QA_GUIDE_REL_PATH)
  })

  it("returns empty strings when absent (no error)", async () => {
    const ctx = makeCtx(tmp)
    await loadQaGuide(ctx, dummyProfile)
    expect(ctx.data.qaGuide).toBe("")
    expect(ctx.data.qaGuidePath).toBe("")
  })
})
