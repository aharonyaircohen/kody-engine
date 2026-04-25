import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { summarizeFailure, verifyAll } from "../../src/verify.js"

const baseConfig: KodyConfig = {
  quality: { typecheck: "", testUnit: "", lint: "", format: "" },
  git: { defaultBranch: "main" },
  github: { owner: "o", repo: "r" },
  agent: { model: "m/x" },
}

describe("verify: verifyAll", () => {
  it("returns ok when no commands configured", async () => {
    const result = await verifyAll(baseConfig)
    expect(result.ok).toBe(true)
    expect(result.failed).toEqual([])
  })

  it("captures exit code 0 as success", async () => {
    const cfg: KodyConfig = { ...baseConfig, quality: { ...baseConfig.quality, typecheck: "true" } }
    const result = await verifyAll(cfg)
    expect(result.ok).toBe(true)
    expect(result.details.typecheck?.exitCode).toBe(0)
  })

  it("captures non-zero exit as failure", async () => {
    const cfg: KodyConfig = { ...baseConfig, quality: { ...baseConfig.quality, typecheck: "false" } }
    const result = await verifyAll(cfg)
    expect(result.ok).toBe(false)
    expect(result.failed).toContain("typecheck")
  })

  it("runs all configured commands", async () => {
    const cfg: KodyConfig = {
      ...baseConfig,
      quality: { typecheck: "true", testUnit: "true", lint: "false", format: "" },
    }
    const result = await verifyAll(cfg)
    expect(result.failed).toEqual(["lint"])
    expect(Object.keys(result.details).sort()).toEqual(["lint", "test", "typecheck"])
  })

  it("runs format check when configured and surfaces failure", async () => {
    const cfg: KodyConfig = {
      ...baseConfig,
      quality: { typecheck: "", testUnit: "", lint: "", format: "false" },
    }
    const result = await verifyAll(cfg)
    expect(result.ok).toBe(false)
    expect(result.failed).toEqual(["format"])
  })
})

describe("verify: summarizeFailure", () => {
  it("includes failed command names in summary", () => {
    const summary = summarizeFailure({
      ok: false,
      failed: ["typecheck", "test"],
      details: {
        typecheck: { exitCode: 1, durationMs: 1000, tail: "TS error here" },
        test: { exitCode: 1, durationMs: 2000, tail: "test failed" },
      },
    })
    expect(summary).toMatch(/typecheck/)
    expect(summary).toMatch(/test/)
    expect(summary).toMatch(/TS error here/)
  })
})
