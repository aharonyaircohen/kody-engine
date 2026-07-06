import { createCipheriv } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Context } from "../../src/implementations/types.js"
import { resolveRuntimeSecret } from "../../src/scripts/runtimeSecrets.js"

function makeCtx(): Pick<Context, "config"> {
  return {
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/haiku" },
    },
  }
}

function encryptVault(doc: unknown, key: Buffer): string {
  const iv = Buffer.alloc(12, 7)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(doc), "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`
}

function contents(content: string): Response {
  return new Response(
    JSON.stringify({
      type: "file",
      encoding: "base64",
      content: Buffer.from(content, "utf8").toString("base64"),
      sha: "sha",
    }),
    { status: 200 },
  )
}

describe("resolveRuntimeSecret", () => {
  it("reads repo vault secrets before env fallback", async () => {
    const key = Buffer.alloc(32, 1)
    const payload = encryptVault(
      {
        version: 1,
        secrets: {
          LOGIN_PASSWORD: { value: "from-vault" },
        },
      },
      key,
    )
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      if (u.endsWith("/repos/o/r/contents/kody.config.json")) return new Response("{}", { status: 404 })
      if (u.endsWith("/repos/o/kody-state/contents/r/secrets.enc")) return contents(payload)
      return new Response("not found", { status: 404 })
    }

    const result = await resolveRuntimeSecret("LOGIN_PASSWORD", makeCtx(), {
      env: {
        KODY_MASTER_KEY: key.toString("hex"),
        GITHUB_TOKEN: "gh-token",
        LOGIN_PASSWORD: "from-env",
      } as NodeJS.ProcessEnv,
      fetchImpl,
    })

    expect(result).toEqual({ value: "from-vault", source: "vault" })
  })

  it("falls back to env when vault credentials are unavailable", async () => {
    const result = await resolveRuntimeSecret("LOGIN_PASSWORD", makeCtx(), {
      env: { LOGIN_PASSWORD: "from-env" } as NodeJS.ProcessEnv,
    })

    expect(result).toEqual({ value: "from-env", source: "env" })
  })

  it("falls back to env and records a warning when vault decryption fails", async () => {
    const goodKey = Buffer.alloc(32, 2)
    const badKey = Buffer.alloc(32, 3)
    const payload = encryptVault(
      {
        version: 1,
        secrets: {
          LOGIN_PASSWORD: { value: "from-vault" },
        },
      },
      goodKey,
    )
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      if (u.endsWith("/repos/o/r/contents/kody.config.json")) return new Response("{}", { status: 404 })
      if (u.endsWith("/repos/o/kody-state/contents/r/secrets.enc")) return contents(payload)
      return new Response("not found", { status: 404 })
    }

    const result = await resolveRuntimeSecret("LOGIN_PASSWORD", makeCtx(), {
      env: {
        KODY_MASTER_KEY: badKey.toString("hex"),
        GITHUB_TOKEN: "gh-token",
        LOGIN_PASSWORD: "from-env",
      } as NodeJS.ProcessEnv,
      fetchImpl,
    })

    expect(result.value).toBe("from-env")
    expect(result.source).toBe("env")
    expect(result.warning).toContain("vault read failed for LOGIN_PASSWORD")
  })
})
