import { createCipheriv, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { masterKeyBytes } from "../../src/pool/keys.js"
import { loadQaContext } from "../../src/scripts/loadQaContext.js"

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-qactx-load-"))
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
    data: {},
    output: { exitCode: 0 },
  }
}

const dummyProfile = {} as Profile

// 64-char hex → 32 raw bytes, matching masterKeyBytes() expectations.
const MASTER_HEX = "a".repeat(64)

/** Encrypt a JSON document into the "v1:iv:ct:tag" vault payload — the exact
 * shape decryptVault() (and the dashboard's vault/crypto.ts) expects. */
function encryptVault(doc: unknown, masterHex: string): string {
  const key = masterKeyBytes(masterHex)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const plaintext = Buffer.from(JSON.stringify(doc), "utf8")
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return ["v1", iv.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(":")
}

function writeVariables(cwd: string, vars: Record<string, string>): void {
  const variables: Record<string, { value: string }> = {}
  for (const [k, v] of Object.entries(vars)) variables[k] = { value: v }
  const dir = path.join(cwd, ".kody")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "variables.json"), JSON.stringify({ version: 1, variables }))
}

describe("loadQaContext", () => {
  let tmp: string
  let prevKey: string | undefined

  beforeEach(() => {
    tmp = mktmp()
    prevKey = process.env.KODY_MASTER_KEY
    delete process.env.KODY_MASTER_KEY
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    if (prevKey === undefined) delete process.env.KODY_MASTER_KEY
    else process.env.KODY_MASTER_KEY = prevKey
  })

  it("reads LOGIN_USER from variables into qaLogin and the auth block (no password)", async () => {
    writeVariables(tmp, { LOGIN_USER: "qa@example.com" })
    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaLogin).toBe("qa@example.com")
    expect(ctx.data.qaAuthBlock).toContain("qa@example.com")
    expect(ctx.data.qaAuthBlock).toContain("no `LOGIN_PASSWORD` secret was found")
  })

  it("decrypts LOGIN_PASSWORD from the vault and emits the full login auth block", async () => {
    writeVariables(tmp, { LOGIN_USER: "qa@example.com" })
    const payload = encryptVault({ version: 1, secrets: { LOGIN_PASSWORD: { value: "hunter2" } } }, MASTER_HEX)
    fs.writeFileSync(path.join(tmp, ".kody", "secrets.enc"), payload)
    process.env.KODY_MASTER_KEY = MASTER_HEX

    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaLogin).toBe("qa@example.com")
    expect(ctx.data.qaAuthBlock).toContain("qa@example.com")
    expect(ctx.data.qaAuthBlock).toContain("hunter2")
    expect(ctx.data.qaAuthBlock).toContain("Re-use the session")
  })

  it("ignores the vault when no master key is set (no-key path)", async () => {
    writeVariables(tmp, { LOGIN_USER: "qa@example.com" })
    const payload = encryptVault({ version: 1, secrets: { LOGIN_PASSWORD: { value: "hunter2" } } }, MASTER_HEX)
    fs.writeFileSync(path.join(tmp, ".kody", "secrets.enc"), payload)
    // KODY_MASTER_KEY intentionally unset → password unavailable.

    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaAuthBlock).not.toContain("hunter2")
    expect(ctx.data.qaAuthBlock).toContain("no `LOGIN_PASSWORD` secret was found")
  })

  it("concatenates .kody/profile/*.md into qaProfile with filename headings", async () => {
    const profileDir = path.join(tmp, ".kody", "profile")
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(path.join(profileDir, "scenarios.md"), "Check the checkout flow.")
    fs.writeFileSync(path.join(profileDir, "notes.md"), "Seed data lives in fixtures.")

    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    const qaProfile = ctx.data.qaProfile as string
    expect(qaProfile).toContain("## notes.md")
    expect(qaProfile).toContain("Seed data lives in fixtures.")
    expect(qaProfile).toContain("## scenarios.md")
    expect(qaProfile).toContain("Check the checkout flow.")
  })

  it("emits the no-creds auth block and empty qaProfile when nothing is configured", async () => {
    const ctx = makeCtx(tmp)
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaLogin).toBe("")
    expect(ctx.data.qaProfile).toBe("")
    expect(ctx.data.qaAuthBlock).toContain("no QA credentials configured")
    expect(ctx.data.qaAuthBlock).toContain("Browse public routes only")
  })

  it("emits the storageState auth block when --auth-profile is passed", async () => {
    const ctx = makeCtx(tmp, { authProfile: ".kody/qa-storage-state.json" })
    await loadQaContext(ctx, dummyProfile)
    expect(ctx.data.qaAuthBlock).toContain(".kody/qa-storage-state.json")
    expect(ctx.data.qaAuthBlock).toContain("storageState")
  })

  it("never throws when the vault payload is corrupt (fail-soft)", async () => {
    writeVariables(tmp, { LOGIN_USER: "qa@example.com" })
    fs.writeFileSync(path.join(tmp, ".kody", "secrets.enc"), "v1:not:valid:base64==")
    process.env.KODY_MASTER_KEY = MASTER_HEX

    const ctx = makeCtx(tmp)
    await expect(loadQaContext(ctx, dummyProfile)).resolves.toBeUndefined()
    expect(ctx.data.qaAuthBlock).toContain("no `LOGIN_PASSWORD` secret was found")
  })
})
