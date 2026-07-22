import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  detectPackageManager,
  parseCiArgs,
  resolveAuthToken,
  runCi,
  shouldPostRunFailureTail,
  unpackAllSecrets,
} from "../../src/kody-cli.js"

const { privateKey: appPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-cli-test-"))
}

function writeEvent(body: unknown): string {
  const dir = tmpDir()
  const p = path.join(dir, "event.json")
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

const prevEnv: Record<string, string | undefined> = {}

afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

describe("kody-cli: parseCiArgs", () => {
  it("parses --issue", () => {
    const a = parseCiArgs(["--issue", "42"])
    expect(a.issueNumber).toBe(42)
    expect(a.errors).toEqual([])
  })

  it("requires --issue", () => {
    const a = parseCiArgs([])
    expect(a.errors.some((e) => e.includes("--issue"))).toBe(true)
  })

  it("rejects non-positive --issue", () => {
    expect(parseCiArgs(["--issue", "0"]).errors.length).toBeGreaterThan(0)
    expect(parseCiArgs(["--issue", "abc"]).errors.length).toBeGreaterThan(0)
  })

  it("parses --cwd + --skip-install + --skip-litellm + --verbose", () => {
    const a = parseCiArgs(["--issue", "1", "--cwd", "/tmp", "--skip-install", "--skip-litellm", "--verbose"])
    expect(a.cwd).toBe("/tmp")
    expect(a.skipInstall).toBe(true)
    expect(a.skipLitellm).toBe(true)
    expect(a.verbose).toBe(true)
  })

  it("parses --package-manager override", () => {
    const a = parseCiArgs(["--issue", "1", "--package-manager", "yarn"])
    expect(a.packageManager).toBe("yarn")
  })

  it("rejects invalid --package-manager", () => {
    const a = parseCiArgs(["--issue", "1", "--package-manager", "cargo"])
    expect(a.errors.some((e) => e.includes("--package-manager"))).toBe(true)
  })

  it("rejects unknown --flags", () => {
    const a = parseCiArgs(["--issue", "1", "--bogus"])
    expect(a.errors.some((e) => e.includes("--bogus"))).toBe(true)
  })
})

describe("kody-cli: unpackAllSecrets", () => {
  it("returns 0 when ALL_SECRETS missing", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(unpackAllSecrets(env)).toBe(0)
  })

  it("unpacks JSON into env vars", () => {
    const env: NodeJS.ProcessEnv = {
      ALL_SECRETS: JSON.stringify({ MINIMAX_API_KEY: "m123", ANTHROPIC_API_KEY: "a456" }),
    }
    const n = unpackAllSecrets(env)
    expect(n).toBe(2)
    expect(env.MINIMAX_API_KEY).toBe("m123")
    expect(env.ANTHROPIC_API_KEY).toBe("a456")
  })

  it("does not override already-set env vars", () => {
    const env: NodeJS.ProcessEnv = {
      MINIMAX_API_KEY: "preexisting",
      ALL_SECRETS: JSON.stringify({ MINIMAX_API_KEY: "from-secrets", NEW_KEY: "new" }),
    }
    const n = unpackAllSecrets(env)
    expect(n).toBe(1)
    expect(env.MINIMAX_API_KEY).toBe("preexisting")
    expect(env.NEW_KEY).toBe("new")
  })

  it("returns 0 on malformed JSON", () => {
    const env: NodeJS.ProcessEnv = { ALL_SECRETS: "{not-json" }
    expect(unpackAllSecrets(env)).toBe(0)
  })

  it("skips non-string values", () => {
    const env: NodeJS.ProcessEnv = {
      ALL_SECRETS: JSON.stringify({ A: "str", B: 123, C: null, D: true }),
    }
    const n = unpackAllSecrets(env)
    expect(n).toBe(1)
    expect(env.A).toBe("str")
    expect(env.B).toBeUndefined()
  })

  it("skips empty strings", () => {
    const env: NodeJS.ProcessEnv = { ALL_SECRETS: JSON.stringify({ X: "", Y: "v" }) }
    expect(unpackAllSecrets(env)).toBe(1)
    expect(env.X).toBeUndefined()
    expect(env.Y).toBe("v")
  })
})

describe("kody-cli: resolveAuthToken", () => {
  it("prefers a configured PAT over GitHub App credentials", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const body = String(url).endsWith("/installation")
        ? JSON.stringify({ id: 12345 })
        : JSON.stringify({ token: "ghs_installation" })
      return new Response(body, { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const env: NodeJS.ProcessEnv = {
      KODY_APP_ID: "42",
      KODY_APP_PRIVATE_KEY: appPrivateKey,
      GITHUB_REPOSITORY: "A-Guy-educ/A-Guy-Web",
      GH_PAT: "pat_repo_token",
    }

    expect(await resolveAuthToken(env)).toBe("pat_repo_token")
    expect(env.GH_TOKEN).toBe("pat_repo_token")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("uses GitHub App credentials when no PAT is configured", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const body = String(url).endsWith("/installation")
        ? JSON.stringify({ id: 12345 })
        : JSON.stringify({ token: "ghs_installation" })
      return new Response(body, { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const env: NodeJS.ProcessEnv = {
      KODY_APP_ID: "42",
      KODY_APP_PRIVATE_KEY: appPrivateKey,
      GITHUB_REPOSITORY: "A-Guy-educ/A-Guy-Web",
      GITHUB_TOKEN: "built_in_token",
    }

    expect(await resolveAuthToken(env)).toBe("ghs_installation")
    expect(env.GH_TOKEN).toBe("ghs_installation")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("picks GH_PAT before legacy ready-made tokens", async () => {
    const env: NodeJS.ProcessEnv = { KODY_TOKEN: "k", GH_TOKEN: "g", GITHUB_TOKEN: "gh", GH_PAT: "p" }
    expect(await resolveAuthToken(env)).toBe("p")
    expect(env.GH_TOKEN).toBe("p")
  })

  it("falls back to GH_TOKEN", async () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "g" }
    expect(await resolveAuthToken(env)).toBe("g")
    expect(env.GH_TOKEN).toBe("g")
  })

  it("keeps GH_PAT for state writes while recovering checkout token for repo calls", async () => {
    const cwd = process.cwd()
    const dir = tmpDir()
    try {
      process.chdir(dir)
      execFileSync("git", ["init"], { stdio: "ignore" })
      const checkoutToken = "repo-token"
      const encoded = Buffer.from(`x-access-token:${checkoutToken}`).toString("base64")
      execFileSync("git", [
        "config",
        "--local",
        "http.https://github.com/.extraheader",
        `AUTHORIZATION: basic ${encoded}`,
      ])
      const env: NodeJS.ProcessEnv = { GH_PAT: "state-token" }
      expect(await resolveAuthToken(env)).toBe("state-token")
      expect(env.GH_TOKEN).toBe("state-token")
      expect(env.GITHUB_TOKEN).toBe(checkoutToken)
    } finally {
      process.chdir(cwd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to GITHUB_TOKEN and copies into GH_TOKEN", async () => {
    const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: "gh" }
    expect(await resolveAuthToken(env)).toBe("gh")
    expect(env.GH_TOKEN).toBe("gh")
  })

  it("falls back to GH_PAT", async () => {
    const env: NodeJS.ProcessEnv = { GH_PAT: "p" }
    expect(await resolveAuthToken(env)).toBe("p")
    expect(env.GH_TOKEN).toBe("p")
  })

  it("returns undefined when no token and no App creds set", async () => {
    const env: NodeJS.ProcessEnv = {}
    expect(await resolveAuthToken(env)).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
  })
})

describe("kody-cli: detectPackageManager", () => {
  it("detects pnpm from pnpm-lock.yaml", () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "lockfile: 1")
    expect(detectPackageManager(d)).toBe("pnpm")
  })

  it("detects yarn from yarn.lock", () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, "yarn.lock"), "")
    expect(detectPackageManager(d)).toBe("yarn")
  })

  it("detects bun from bun.lockb", () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, "bun.lockb"), "")
    expect(detectPackageManager(d)).toBe("bun")
  })

  it("defaults to npm when no lockfile", () => {
    const d = tmpDir()
    expect(detectPackageManager(d)).toBe("npm")
  })

  it("prefers pnpm over yarn when both lockfiles exist", () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "")
    fs.writeFileSync(path.join(d, "yarn.lock"), "")
    expect(detectPackageManager(d)).toBe("pnpm")
  })
})

describe("kody-cli: run exit reporting", () => {
  it("treats no-commit exit 3 as already reported, not as a raw-tail crash", () => {
    expect(shouldPostRunFailureTail(3)).toBe(false)
  })

  it("still posts raw tails for wrapper/crash class exits", () => {
    expect(shouldPostRunFailureTail(4)).toBe(true)
    expect(shouldPostRunFailureTail(99)).toBe(true)
  })
})

describe("kody-cli: runCi event dispatch", () => {
  it("fails loudly when bare @kody needs config defaults but config is invalid", async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "kody.config.json"), "{not-json")
    prevEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prevEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody", user: { login: "alice", type: "User" }, author_association: "OWNER" },
      issue: { number: 42 },
    })
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(64)
    expect(stderr.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/config error: kody\.config\.json/)
  })
})
