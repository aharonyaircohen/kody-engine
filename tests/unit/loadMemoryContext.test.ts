import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadMemoryContext } from "../../src/scripts/loadMemoryContext.js"

const profile = { name: "run" } as Profile

function makeCtx(cwd: string, data: Record<string, unknown> = {}): Context {
  return {
    args: {},
    cwd,
    config: {} as never,
    data,
    output: { exitCode: 0 },
    skipAgent: false,
  }
}

function writeMemory(root: string, relPath: string, content: string): void {
  const full = path.join(root, ".kody", "memory", relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, "utf-8")
}

describe("loadMemoryContext", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-mem-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("fast path: leaves a preloaded string memoryContext untouched", async () => {
    const ctx = makeCtx(tmp, { memoryContext: "preloaded block" })
    await loadMemoryContext(ctx, profile)
    expect(ctx.data.memoryContext).toBe("preloaded block")
  })

  it("fast path honors an empty preloaded string (key present)", async () => {
    writeMemory(tmp, "lesson.md", "would-be content")
    const ctx = makeCtx(tmp, { memoryContext: "" })
    await loadMemoryContext(ctx, profile)
    expect(ctx.data.memoryContext).toBe("")
  })

  it("returns '' when the memory dir does not exist", async () => {
    const ctx = makeCtx(tmp)
    await loadMemoryContext(ctx, profile)
    expect(ctx.data.memoryContext).toBe("")
  })

  it("returns '' when the memory dir is empty", async () => {
    fs.mkdirSync(path.join(tmp, ".kody", "memory"), { recursive: true })
    const ctx = makeCtx(tmp)
    await loadMemoryContext(ctx, profile)
    expect(ctx.data.memoryContext).toBe("")
  })

  it("formats a block from a single page (recency path, no query terms)", async () => {
    writeMemory(tmp, "lesson.md", "---\ntitle: Lesson One\nupdated: 2026-01-01\n---\nBody about caching.")
    const ctx = makeCtx(tmp)
    await loadMemoryContext(ctx, profile)
    const block = ctx.data.memoryContext as string
    expect(block).toContain("# Project memory (state repo `memory/`)")
    expect(block).toContain("## Lesson One — `lesson.md`")
    expect(block).toContain("Body about caching.")
  })

  it("falls back to the filename when frontmatter title is absent", async () => {
    writeMemory(tmp, "notes.md", "no frontmatter here, just text")
    const ctx = makeCtx(tmp)
    await loadMemoryContext(ctx, profile)
    expect(ctx.data.memoryContext).toContain("## notes — `notes.md`")
  })

  it("orders pages by 'updated:' frontmatter (most recent first) when no query", async () => {
    writeMemory(tmp, "old.md", "---\ntitle: Old\nupdated: 2025-01-01\n---\nold body")
    writeMemory(tmp, "new.md", "---\ntitle: New\nupdated: 2026-05-01\n---\nnew body")
    const ctx = makeCtx(tmp)
    await loadMemoryContext(ctx, profile)
    const block = ctx.data.memoryContext as string
    expect(block.indexOf("## New")).toBeLessThan(block.indexOf("## Old"))
  })

  it("scores pages by overlap with the issue title when present", async () => {
    writeMemory(tmp, "caching.md", "---\ntitle: Caching Guide\n---\nall about cache layers and caching")
    writeMemory(tmp, "auth.md", "---\ntitle: Auth Guide\n---\nlogin and tokens")
    const ctx = makeCtx(tmp, { issue: { title: "Fix caching layer bug" } })
    await loadMemoryContext(ctx, profile)
    const block = ctx.data.memoryContext as string
    expect(block.indexOf("## Caching Guide")).toBeLessThan(block.indexOf("## Auth Guide"))
  })

  it("uses the PR title as a query source too", async () => {
    writeMemory(tmp, "tokens.md", "---\ntitle: Token Notes\n---\ntokens and refresh logic")
    writeMemory(tmp, "misc.md", "---\ntitle: Misc\n---\nunrelated trivia")
    const ctx = makeCtx(tmp, { pr: { title: "Improve token refresh" } })
    await loadMemoryContext(ctx, profile)
    const block = ctx.data.memoryContext as string
    expect(block.indexOf("## Token Notes")).toBeLessThan(block.indexOf("## Misc"))
  })

  it("always promotes INDEX.md to the top of the block", async () => {
    writeMemory(tmp, "INDEX.md", "---\ntitle: Index\n---\ntable of contents")
    writeMemory(tmp, "deep.md", "---\ntitle: Deep Lesson\n---\nrelevant caching content caching")
    const ctx = makeCtx(tmp, { issue: { title: "caching caching caching" } })
    await loadMemoryContext(ctx, profile)
    const block = ctx.data.memoryContext as string
    expect(block.indexOf("## Index")).toBeLessThan(block.indexOf("## Deep Lesson"))
  })

  it("truncates an oversized single page with the truncation suffix", async () => {
    const huge = "x".repeat(5000)
    writeMemory(tmp, "big.md", `---\ntitle: Big\n---\n${huge}`)
    const ctx = makeCtx(tmp)
    await loadMemoryContext(ctx, profile)
    expect(ctx.data.memoryContext).toContain("… (truncated)")
  })

  it("walks nested subdirectories and skips dotfiles / non-md files", async () => {
    writeMemory(tmp, "sub/nested.md", "---\ntitle: Nested\n---\nnested body")
    writeMemory(tmp, "ignore.txt", "not markdown")
    const memRoot = path.join(tmp, ".kody", "memory")
    fs.writeFileSync(path.join(memRoot, ".hidden.md"), "hidden", "utf-8")
    const ctx = makeCtx(tmp)
    await loadMemoryContext(ctx, profile)
    const block = ctx.data.memoryContext as string
    expect(block).toContain("## Nested")
    expect(block).not.toContain("not markdown")
    expect(block).not.toContain("hidden")
  })

  it("caps total output at the byte budget across many pages", async () => {
    const body = "y".repeat(3500)
    for (let i = 0; i < 8; i++) {
      writeMemory(tmp, `p${i}.md`, `---\ntitle: Page ${i}\n---\n${body}`)
    }
    const ctx = makeCtx(tmp)
    await loadMemoryContext(ctx, profile)
    expect(ctx.data.memoryContext).toContain("further pages truncated to fit budget")
  })
})
