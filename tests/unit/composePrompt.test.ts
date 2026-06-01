/**
 * composePrompt reads the prompt template via read-or-fail (not
 * existsSync-then-read) and, on failure, throws a self-diagnosing error that
 * names the cwd, the per-candidate errno, and the actual directory contents.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { composePrompt } from "../../src/scripts/composePrompt.js"

function makeProfile(dir: string): Profile {
  return {
    name: "bug",
    dir,
    claudeCode: { systemPromptAppend: null },
    cliTools: [],
  } as unknown as Profile
}

function makeCtx(dir: string, data: Record<string, unknown> = {}): Context {
  return {
    args: {},
    cwd: dir,
    config: { github: { owner: "o", repo: "r" }, git: { defaultBranch: "main" } },
    data,
    output: { exitCode: 0 },
    skipAgent: false,
  } as unknown as Context
}

describe("composePrompt", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-composeprompt-"))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("reads prompt.md and renders mustache tokens into ctx.data.prompt", async () => {
    fs.writeFileSync(path.join(dir, "prompt.md"), "Fix {{repoOwner}}/{{repoName}} on {{defaultBranch}}.")
    const ctx = makeCtx(dir)
    await composePrompt(ctx, makeProfile(dir))
    expect(ctx.data.prompt).toBe("Fix o/r on main.")
  })

  it("throws a self-diagnosing error when no template exists (cwd + dir contents)", async () => {
    // dir exists but has no prompt.md — the diagnostic must list what IS there.
    fs.writeFileSync(path.join(dir, "profile.json"), "{}")
    const ctx = makeCtx(dir)
    await expect(composePrompt(ctx, makeProfile(dir))).rejects.toThrow(
      /no prompt template found.*cwd=.*ENOENT.*dir contents: \[.*profile\.json.*\]/s,
    )
  })

  it("reports a readdir failure when the profile dir itself is missing", async () => {
    const missing = path.join(dir, "gone")
    const ctx = makeCtx(dir)
    await expect(composePrompt(ctx, makeProfile(missing))).rejects.toThrow(/readdir\(.*gone\) failed: ENOENT/)
  })
})
