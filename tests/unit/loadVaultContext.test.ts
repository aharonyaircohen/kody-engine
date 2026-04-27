import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadVaultContext } from "../../src/scripts/loadVaultContext.js"

function makeCtx(cwd: string, data: Record<string, unknown> = {}): Context {
  return {
    args: {},
    cwd,
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/haiku" },
    } as unknown as Context["config"],
    data,
    output: { exitCode: 0 },
  }
}

const dummyProfile = {} as Profile

describe("loadVaultContext", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-vault-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("sets vaultContext to empty string when vault directory is missing", async () => {
    const ctx = makeCtx(tmp)
    await loadVaultContext(ctx, dummyProfile, {})
    expect(ctx.data.vaultContext).toBe("")
  })

  it("sets vaultContext to empty string when vault has no markdown files", async () => {
    fs.mkdirSync(path.join(tmp, ".kody/vault/architecture"), { recursive: true })
    fs.writeFileSync(path.join(tmp, ".kody/vault/architecture/.keep"), "")
    const ctx = makeCtx(tmp)
    await loadVaultContext(ctx, dummyProfile, {})
    expect(ctx.data.vaultContext).toBe("")
  })

  it("loads frontmatter title and content into the block", async () => {
    const dir = path.join(tmp, ".kody/vault/architecture")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "executor.md"),
      `---\ntitle: Executor pipeline\ntype: architecture\nupdated: 2026-01-01\n---\n\nExecutor runs preflight → agent → postflight.\n`,
    )
    const ctx = makeCtx(tmp)
    await loadVaultContext(ctx, dummyProfile, {})
    const block = ctx.data.vaultContext as string
    expect(block).toContain("Project memory")
    expect(block).toContain("Executor pipeline")
    expect(block).toContain("architecture/executor.md")
    expect(block).toContain("Executor runs preflight → agent → postflight.")
  })

  it("ranks pages by overlap with the issue title when one is present", async () => {
    const dir = path.join(tmp, ".kody/vault")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "executor.md"),
      `---\ntitle: Executor pipeline\nupdated: 2026-01-01\n---\n\nExecutor runs preflight → agent → postflight.\n`,
    )
    fs.writeFileSync(
      path.join(dir, "release.md"),
      `---\ntitle: Release flow\nupdated: 2026-02-02\n---\n\nThe release executable orchestrates publish + deploy.\n`,
    )
    const ctx = makeCtx(tmp, { issue: { title: "fix executor preflight ordering" } })
    await loadVaultContext(ctx, dummyProfile, {})
    const block = ctx.data.vaultContext as string
    const execIdx = block.indexOf("Executor pipeline")
    const releaseIdx = block.indexOf("Release flow")
    expect(execIdx).toBeGreaterThan(-1)
    expect(releaseIdx).toBeGreaterThan(-1)
    // Executor matches "executor" + "preflight" → must rank before release.
    expect(execIdx).toBeLessThan(releaseIdx)
  })

  it("falls back to recency ordering when no query terms are extractable", async () => {
    const dir = path.join(tmp, ".kody/vault")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "old.md"),
      `---\ntitle: Old page\nupdated: 2025-01-01\n---\n\nstale\n`,
    )
    fs.writeFileSync(
      path.join(dir, "new.md"),
      `---\ntitle: New page\nupdated: 2026-04-01\n---\n\nfresh\n`,
    )
    const ctx = makeCtx(tmp)
    await loadVaultContext(ctx, dummyProfile, {})
    const block = ctx.data.vaultContext as string
    const oldIdx = block.indexOf("Old page")
    const newIdx = block.indexOf("New page")
    expect(newIdx).toBeGreaterThan(-1)
    expect(oldIdx).toBeGreaterThan(-1)
    expect(newIdx).toBeLessThan(oldIdx)
  })
})
