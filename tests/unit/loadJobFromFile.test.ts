/**
 * Unit tests for `loadJobFromFile` — the preflight that loads a file-based
 * duty (body, state, staff persona) into `ctx.data`.
 *
 * Focus here: the `mentions:` frontmatter field is read alongside `staff:`
 * and exposed to the duty prompt as a ready-to-insert `ctx.data.mentions`
 * string ("@a @b"), or "" when absent. Uses the local-file state backend so
 * the test never touches GitHub.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadJobFromFile } from "../../src/scripts/loadJobFromFile.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "load-job-"))
  fs.mkdirSync(path.join(tmp, ".kody", "duties"), { recursive: true })
  fs.mkdirSync(path.join(tmp, ".kody", "staff"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeDuty(slug: string, frontmatter: string, body = "# Duty\nbody"): void {
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : ""
  fs.writeFileSync(path.join(tmp, ".kody", "duties", `${slug}.md`), fm + body)
}

function writeStaff(slug: string, body = "# Persona\nidentity"): void {
  fs.writeFileSync(path.join(tmp, ".kody", "staff", `${slug}.md`), body)
}

function ctxFor(slug: string): Context {
  const config: KodyConfig = {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
  return {
    args: { job: slug },
    cwd: tmp,
    config,
    data: {},
    output: { exitCode: 0 },
  } as unknown as Context
}

const PROFILE = {} as unknown as Profile

describe("loadJobFromFile mentions", () => {
  it("formats a `mentions: a, b` list into a ready-to-insert '@a @b' string", async () => {
    writeStaff("kody")
    writeDuty("changelog-verify", "staff: kody\nmentions: a, b")

    const ctx = ctxFor("changelog-verify")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.mentions).toBe("@a @b")
  })

  it("sets ctx.data.mentions to '' when the duty declares no mentions", async () => {
    writeStaff("kody")
    writeDuty("broad-sweep", "staff: kody")

    const ctx = ctxFor("broad-sweep")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.mentions).toBe("")
  })
})

describe("loadJobFromFile body {{mentions}} substitution", () => {
  it("replaces {{mentions}} inside the duty body with the resolved handles", async () => {
    writeStaff("kody")
    writeDuty(
      "docs-readme",
      "staff: kody\nmentions: a, b",
      "# Duty\n{{mentions}} please review",
    )

    const ctx = ctxFor("docs-readme")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.jobIntent).toContain("@a @b please review")
    expect(ctx.data.jobIntent).not.toContain("{{mentions}}")
  })

  it("tolerates inner whitespace and renders empty when no mentions are declared", async () => {
    writeStaff("kody")
    writeDuty("docs-code", "staff: kody", "line {{ mentions }} end")

    const ctx = ctxFor("docs-code")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.jobIntent).toBe("line  end")
    expect(ctx.data.jobIntent).not.toContain("mentions")
  })
})
