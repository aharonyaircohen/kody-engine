import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { resolveQaUrl } from "../../src/scripts/resolveQaUrl.js"

function makeCtx(overrides: Partial<Context["args"]> = {}, cwd = "/tmp"): Context {
  return {
    args: { ...overrides },
    cwd,
    config: {
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "owner", repo: "repo" },
      agent: { model: "anthropic/claude-sonnet-4-5" },
    },
    data: {},
    output: { exitCode: 0 },
  }
}

/** Write the hydrated local variables cache with the given variables under `cwd`. */
function writeVariables(cwd: string, vars: Record<string, string>): void {
  const variables: Record<string, { value: string }> = {}
  for (const [k, v] of Object.entries(vars)) variables[k] = { value: v }
  const dir = path.join(cwd, ".kody-engine", "runtime")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "variables.json"), JSON.stringify({ version: 1, variables }))
}

const stubProfile = { name: "qa-engineer", dir: "" } as unknown as Profile

describe("resolveQaUrl", () => {
  let originalPreviewUrl: string | undefined
  let tmp: string

  beforeEach(() => {
    originalPreviewUrl = process.env.PREVIEW_URL
    delete process.env.PREVIEW_URL
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-qaurl-"))
  })

  afterEach(() => {
    if (originalPreviewUrl === undefined) delete process.env.PREVIEW_URL
    else process.env.PREVIEW_URL = originalPreviewUrl
    fs.rmSync(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("uses --url when provided, ignoring everything else", async () => {
    process.env.PREVIEW_URL = "https://env.example.com"
    writeVariables(tmp, { QA_URL: "https://fallback.example.com" })
    const ctx = makeCtx({ url: "https://explicit.example.com", goal: "some-goal" }, tmp)
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://explicit.example.com")
    expect(ctx.data.previewUrlSource).toBe("--url flag")
  })

  it("falls back to $PREVIEW_URL when neither --url nor --goal yields", async () => {
    process.env.PREVIEW_URL = "https://env.example.com"
    const ctx = makeCtx({})
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example.com")
    expect(ctx.data.previewUrlSource).toBe("$PREVIEW_URL env var")
  })

  it("falls back to the QA_URL variable when env is empty", async () => {
    writeVariables(tmp, { QA_URL: "https://dev.example.com" })
    const ctx = makeCtx({}, tmp)
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://dev.example.com")
    expect(ctx.data.previewUrlSource).toBe("QA_URL variable (backend variables.json)")
  })

  it("trims whitespace on every source", async () => {
    process.env.PREVIEW_URL = "  https://env.example.com  "
    const ctx = makeCtx({})
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example.com")
  })

  it("throws when no URL resolves anywhere", async () => {
    const ctx = makeCtx({}, tmp)
    await expect(resolveQaUrl(ctx, stubProfile)).rejects.toThrow(/no URL resolved/i)
  })

  it("ignores empty --url and continues to the next source", async () => {
    process.env.PREVIEW_URL = "https://env.example.com"
    const ctx = makeCtx({ url: "   " })
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example.com")
  })

  it("when --goal is set but no deployment is found, falls back to env/config", async () => {
    process.env.PREVIEW_URL = "https://env.example.com"
    // Without mocking gh, the deployment lookup yields null in this environment
    // (no real GitHub API access). We assert the preflight degrades gracefully
    // rather than crashing.
    const ctx = makeCtx({ goal: "nonexistent-goal-id-for-test" })
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example.com")
    expect(ctx.data.previewUrlSource).toBe("$PREVIEW_URL env var")
  })
})
