/**
 * Integration: run the ui-review preflight chain (minus the real PR-fetching
 * reviewFlow) against a temp repo and verify composePrompt renders a prompt
 * that contains the qa-context, qa-guide, and preview-url tokens.
 *
 * This proves the wiring: that the three new preflights populate ctx.data
 * with the keys the prompt template expects.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context } from "../../src/executables/types.js"
import { loadProfile } from "../../src/profile.js"
import { composePrompt } from "../../src/scripts/composePrompt.js"
import { discoverQaContext } from "../../src/scripts/discoverQaContext.js"
import { loadQaGuide } from "../../src/scripts/loadQaGuide.js"
import { resolvePreviewUrl } from "../../src/scripts/resolvePreviewUrl.js"

const PROFILE_PATH = path.resolve(__dirname, "../../src/executables/ui-review/profile.json")

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-uir-int-"))
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function makeCtx(cwd: string, args: Record<string, unknown> = {}): Context {
  return {
    args,
    cwd,
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/haiku" },
    },
    data: {
      // Simulate what reviewFlow would have populated in a real run.
      pr: {
        number: 42,
        title: "Add greeting banner",
        baseRefName: "main",
        headRefName: "feat/greeting",
        body: "Adds a banner above the lessons list.",
      },
      prDiff: "+ <div>Hello LearnHub</div>",
      branch: "feat/greeting",
    },
    output: { exitCode: 0 },
  }
}

describe("ui-review: preflight + composePrompt end-to-end", () => {
  let tmp: string
  let prevEnv: string | undefined

  beforeEach(() => {
    tmp = mktmp()
    prevEnv = process.env.PREVIEW_URL
    delete process.env.PREVIEW_URL
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.PREVIEW_URL
    else process.env.PREVIEW_URL = prevEnv
  })

  it("renders a prompt containing discovered QA context, loaded QA guide, and the preview URL", async () => {
    // Set up a Next.js-like repo
    writeFile(
      tmp,
      "package.json",
      JSON.stringify({ dependencies: { next: "16.0.0" }, scripts: { dev: "next dev" } }),
    )
    writeFile(tmp, "src/app/page.tsx", "export default () => null")
    writeFile(tmp, "src/app/login/page.tsx", "export default () => null")
    writeFile(tmp, "src/app/lessons/page.tsx", "export default () => null")

    // Commit a qa-guide with real creds the agent will see
    writeFile(
      tmp,
      ".kody/qa-guide.md",
      `# QA guide

## Test accounts
| Role | Email | Password |
|------|-------|----------|
| admin | admin@learnhub.test | Admin123! |
`,
    )

    const profile = loadProfile(PROFILE_PATH)
    const ctx = makeCtx(tmp, { pr: 42, previewUrl: "https://preview-42.example" })

    await discoverQaContext(ctx, profile)
    await loadQaGuide(ctx, profile)
    await resolvePreviewUrl(ctx, profile)
    await composePrompt(ctx, profile)

    const prompt = ctx.data.prompt as string
    expect(prompt).toBeTruthy()

    // Preview URL was honored from the flag and appears in the prompt
    expect(ctx.data.previewUrl).toBe("https://preview-42.example")
    expect(ctx.data.previewUrlSource).toBe("flag")
    expect(prompt).toContain("https://preview-42.example")

    // QA context made it in
    expect(prompt).toContain("Login page: /login")
    expect(prompt).toContain("[frontend] /lessons")

    // QA guide credentials made it in
    expect(prompt).toContain("admin@learnhub.test")
    expect(prompt).toContain("Admin123!")

    // PR metadata from reviewFlow survived into the prompt
    expect(prompt).toContain("Add greeting banner")
    expect(prompt).toContain("feat/greeting")

    // Playwright tool guidance appears in the tools section
    expect(prompt).toContain("playwright")
    expect(prompt).toContain("UI_REVIEW_BASE_URL")

    // Final-message contract reminder is present
    expect(prompt).toContain("## Verdict:")
    expect(prompt).toContain("UI review by kody")
  })

  it("falls back to default preview URL and reports an empty QA guide when absent", async () => {
    writeFile(tmp, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }))
    writeFile(tmp, "src/app/page.tsx", "export default () => null")

    const profile = loadProfile(PROFILE_PATH)
    const ctx = makeCtx(tmp, { pr: 42 })

    await discoverQaContext(ctx, profile)
    await loadQaGuide(ctx, profile)
    await resolvePreviewUrl(ctx, profile)
    await composePrompt(ctx, profile)

    expect(ctx.data.previewUrl).toBe("http://localhost:3000")
    expect(ctx.data.previewUrlSource).toBe("default")
    expect(ctx.data.qaGuide).toBe("")
    // Prompt still renders; empty qaGuide token leaves a clean section
    expect(ctx.data.prompt).toContain("http://localhost:3000")
  })
})
