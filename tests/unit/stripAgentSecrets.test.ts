import { describe, expect, it } from "vitest"
import { buildAgentEnvironment, stripAgentSecrets } from "../../src/agent.js"

describe("stripAgentSecrets", () => {
  it("removes ALL_SECRETS-derived keys but keeps the agent's allowlist", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/root",
      ANTHROPIC_API_KEY: "sk-keep",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep",
      GH_TOKEN: "gh-keep",
      GITHUB_TOKEN: "ghs-keep",
      NPM_TOKEN: "npm-strip",
      KODY_MASTER_KEY: "master-strip",
      FLY_IO_TOKEN: "fly-strip",
      QA_GH_PAT: "pat-strip",
      ALL_SECRETS: JSON.stringify({
        NPM_TOKEN: "npm-strip",
        KODY_MASTER_KEY: "master-strip",
        FLY_IO_TOKEN: "fly-strip",
        QA_GH_PAT: "pat-strip",
        ANTHROPIC_API_KEY: "sk-keep",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep",
        GH_TOKEN: "gh-keep",
      }),
    }

    const out = stripAgentSecrets(env)

    // Stripped: the raw blob and every non-allowlisted secret it carried.
    expect(out.ALL_SECRETS).toBeUndefined()
    expect(out.NPM_TOKEN).toBeUndefined()
    expect(out.KODY_MASTER_KEY).toBeUndefined()
    expect(out.FLY_IO_TOKEN).toBeUndefined()
    expect(out.QA_GH_PAT).toBeUndefined()

    // Kept: non-secret env + the credentials the agent legitimately uses.
    expect(out.PATH).toBe("/usr/bin")
    expect(out.HOME).toBe("/root")
    expect(out.ANTHROPIC_API_KEY).toBe("sk-keep")
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-keep")
    expect(out.GH_TOKEN).toBe("gh-keep")
    expect(out.GITHUB_TOKEN).toBe("ghs-keep")
  })

  it("does not mutate the input object", () => {
    const env = { ALL_SECRETS: JSON.stringify({ NPM_TOKEN: "x" }), NPM_TOKEN: "x", PATH: "/bin" }
    const out = stripAgentSecrets(env)
    expect(env.ALL_SECRETS).toBeDefined()
    expect(env.NPM_TOKEN).toBe("x")
    expect(out.NPM_TOKEN).toBeUndefined()
  })

  it("drops the raw blob and leaves the rest intact when ALL_SECRETS is unparseable", () => {
    const env = { ALL_SECRETS: "{not json", SOME_TOKEN: "kept-because-unenumerable", PATH: "/bin" }
    const out = stripAgentSecrets(env)
    expect(out.ALL_SECRETS).toBeUndefined()
    expect(out.SOME_TOKEN).toBe("kept-because-unenumerable")
    expect(out.PATH).toBe("/bin")
  })

  it("is a no-op (minus nothing) when there is no ALL_SECRETS blob", () => {
    const env = { PATH: "/bin", GH_TOKEN: "t" }
    expect(stripAgentSecrets(env)).toEqual({ PATH: "/bin", GH_TOKEN: "t" })
  })
})

describe("buildAgentEnvironment", () => {
  it("exposes a request-scoped repo token to git without persisting it", () => {
    const out = buildAgentEnvironment({ PATH: "/bin", GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient" }, "request-token")

    expect(out.GH_TOKEN).toBe("request-token")
    expect(out.GITHUB_TOKEN).toBe("request-token")
  })
})
