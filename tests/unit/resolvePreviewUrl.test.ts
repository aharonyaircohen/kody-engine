import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const execFileSyncMock = vi.fn()
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

import type { Context, Profile } from "../../src/executables/types.js"
import { DEFAULT_PREVIEW_URL, resolvePreviewUrl } from "../../src/scripts/resolvePreviewUrl.js"

function makeCtx(args: Record<string, unknown> = {}): Context {
  return {
    args,
    cwd: "/tmp",
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

describe("resolvePreviewUrl", () => {
  let prevEnv: string | undefined
  beforeEach(() => {
    prevEnv = process.env.PREVIEW_URL
    delete process.env.PREVIEW_URL
    execFileSyncMock.mockReset()
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PREVIEW_URL
    else process.env.PREVIEW_URL = prevEnv
  })

  it("prefers --preview-url flag over env and default", async () => {
    process.env.PREVIEW_URL = "https://env.example"
    const ctx = makeCtx({ previewUrl: "https://flag.example" })
    await resolvePreviewUrl(ctx, dummyProfile)
    expect(ctx.data.previewUrl).toBe("https://flag.example")
    expect(ctx.data.previewUrlSource).toBe("flag")
  })

  it("falls back to PREVIEW_URL env", async () => {
    process.env.PREVIEW_URL = "https://env.example"
    const ctx = makeCtx()
    await resolvePreviewUrl(ctx, dummyProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example")
    expect(ctx.data.previewUrlSource).toBe("env")
  })

  it("falls back to localhost:3000 default when nothing set", async () => {
    const ctx = makeCtx()
    await resolvePreviewUrl(ctx, dummyProfile)
    expect(ctx.data.previewUrl).toBe(DEFAULT_PREVIEW_URL)
    expect(ctx.data.previewUrlSource).toBe("default")
  })

  it("ignores empty flag and whitespace-only env", async () => {
    process.env.PREVIEW_URL = "   "
    const ctx = makeCtx({ previewUrl: "   " })
    await resolvePreviewUrl(ctx, dummyProfile)
    expect(ctx.data.previewUrl).toBe(DEFAULT_PREVIEW_URL)
  })

  it("uses latest successful Preview deployment when ctx.args.pr is set", async () => {
    // 1) gh api …/pulls/42 --jq .head.sha   → SHA
    // 2) gh api …/deployments?sha=…         → [{id:99}]
    // 3) gh api …/deployments/99/statuses   → [{state:"success", environment_url:"…"}]
    execFileSyncMock
      .mockReturnValueOnce("deadbeef\n")
      .mockReturnValueOnce(JSON.stringify([{ id: 99 }]))
      .mockReturnValueOnce(JSON.stringify([{ state: "success", environment_url: "https://preview.example" }]))

    const ctx = makeCtx({ pr: 42 })
    await resolvePreviewUrl(ctx, dummyProfile)
    expect(ctx.data.previewUrl).toBe("https://preview.example")
    expect(ctx.data.previewUrlSource).toBe("deployment")
  })

  it("falls back to default when no successful Preview deployment exists", async () => {
    execFileSyncMock
      .mockReturnValueOnce("deadbeef\n")
      .mockReturnValueOnce(JSON.stringify([{ id: 99 }]))
      .mockReturnValueOnce(JSON.stringify([{ state: "in_progress", environment_url: null }]))

    const ctx = makeCtx({ pr: 42 })
    await resolvePreviewUrl(ctx, dummyProfile)
    expect(ctx.data.previewUrl).toBe(DEFAULT_PREVIEW_URL)
    expect(ctx.data.previewUrlSource).toBe("default")
  })
})
