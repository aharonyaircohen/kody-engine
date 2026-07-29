import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "../../src/implementations/types.js"

const secrets = vi.hoisted(() => ({
  resolve: vi.fn(),
}))

vi.mock("../../src/scripts/runtimeSecrets.js", () => ({
  resolveRuntimeSecret: secrets.resolve,
}))

import { resolveRuntimeModelEnvironment } from "../../src/runtimeModelEnvironment.js"

const ctx = {
  config: {
    quality: { typecheck: "", lint: "", testUnit: "", format: "" },
    git: { defaultBranch: "main" },
    github: { owner: "trusted", repo: "repo" },
    agent: { model: "minimax/MiniMax-M3" },
  },
} satisfies Pick<Context, "config">

describe("resolveRuntimeModelEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("loads the selected provider key from the repository vault", async () => {
    secrets.resolve.mockResolvedValue({
      value: "vault-model-key",
      source: "vault",
    })

    const result = await resolveRuntimeModelEnvironment({ provider: "minimax", model: "MiniMax-M3" }, ctx)

    expect(secrets.resolve).toHaveBeenCalledWith("MINIMAX_API_KEY", ctx)
    expect(result).toEqual({
      environment: { MINIMAX_API_KEY: "vault-model-key" },
      warnings: [],
    })
  })

  it("honors a model's explicit API-key environment name", async () => {
    secrets.resolve.mockResolvedValue({
      value: "custom-key",
      source: "vault",
    })

    const result = await resolveRuntimeModelEnvironment(
      {
        provider: "custom",
        model: "private-model",
        apiKeyEnvVar: "PRIVATE_MODEL_TOKEN",
      },
      ctx,
    )

    expect(secrets.resolve).toHaveBeenCalledWith("PRIVATE_MODEL_TOKEN", ctx)
    expect(result.environment).toEqual({
      PRIVATE_MODEL_TOKEN: "custom-key",
    })
  })

  it("reports a missing model credential without inventing a value", async () => {
    secrets.resolve.mockResolvedValue({
      value: "",
      source: "missing",
    })

    const result = await resolveRuntimeModelEnvironment({ provider: "minimax", model: "MiniMax-M3" }, ctx)

    expect(result.environment).toEqual({})
    expect(result.warnings).toEqual(["Model credential MINIMAX_API_KEY is missing from the Kody vault."])
  })
})
