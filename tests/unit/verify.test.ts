import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { buildVerifyEnv, summarizeFailure, verifyAll } from "../../src/verify.js"

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

  it("stops an active verification command when the workflow is aborted", async () => {
    const controller = new AbortController()
    const cfg: KodyConfig = {
      ...baseConfig,
      quality: {
        ...baseConfig.quality,
        typecheck: 'node -e "setTimeout(() => {}, 30000)"',
      },
    }
    const startedAt = Date.now()
    setTimeout(() => controller.abort(new Error("step deadline reached")), 25)

    const result = await verifyAll(cfg, undefined, { signal: controller.signal })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(result.ok).toBe(false)
    expect(result.details.typecheck?.tail).toContain("step deadline reached")
  })

  it("does not expose unpacked consumer secrets to verification commands", async () => {
    const previousBlob = process.env.ALL_SECRETS
    const previousServiceKey = process.env.KODY_SERVICE_KEY
    process.env.ALL_SECRETS = JSON.stringify({ KODY_SERVICE_KEY: "test-secret" })
    process.env.KODY_SERVICE_KEY = "test-secret"
    try {
      const cfg: KodyConfig = {
        ...baseConfig,
        quality: {
          ...baseConfig.quality,
          typecheck: 'node -e "process.exit(process.env.KODY_SERVICE_KEY || process.env.ALL_SECRETS ? 1 : 0)"',
        },
      }
      const result = await verifyAll(cfg)
      expect(result.ok).toBe(true)
    } finally {
      if (previousBlob === undefined) delete process.env.ALL_SECRETS
      else process.env.ALL_SECRETS = previousBlob
      if (previousServiceKey === undefined) delete process.env.KODY_SERVICE_KEY
      else process.env.KODY_SERVICE_KEY = previousServiceKey
    }
  })
})

describe("verify: buildVerifyEnv", () => {
  it("removes the secret blob, every unpacked secret, and credential-shaped variables", () => {
    const env = buildVerifyEnv({
      ALL_SECRETS: JSON.stringify({
        KODY_SERVICE_KEY: "service-secret",
        CUSTOM_CREDENTIAL: "custom-secret",
      }),
      KODY_SERVICE_KEY: "service-secret",
      CUSTOM_CREDENTIAL: "custom-secret",
      GITHUB_TOKEN: "github-secret",
      SAFE_FEATURE_FLAG: "enabled",
      PATH: "/usr/bin",
    })

    expect(env.ALL_SECRETS).toBeUndefined()
    expect(env.KODY_SERVICE_KEY).toBeUndefined()
    expect(env.CUSTOM_CREDENTIAL).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.SAFE_FEATURE_FLAG).toBe("enabled")
    expect(env.PATH).toBe("/usr/bin")
    expect(env.CI).toBe("1")
    expect(env.HUSKY).toBe("0")
    expect(env.SKIP_HOOKS).toBe("1")
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
