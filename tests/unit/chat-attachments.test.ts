import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { prepareAttachments } from "../../src/chat/attachments.js"
import type { ChatTurn } from "../../src/chat/session.js"
import { runtimeStatePath } from "../../src/runtimePaths.js"

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("chat attachments: prepareAttachments", () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-att-"))
  })
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it("materialises the current turn's image to a file and references it", () => {
    const turns: ChatTurn[] = [
      {
        role: "user",
        content: `[Image: shot.png (1.2 KB)]\ndata:image/png;base64,${PNG_B64}\n\nwhat do you see?`,
        timestamp: "t0",
      },
    ]
    const { turns: out, imagePaths } = prepareAttachments(turns, cwd, "s1")

    expect(imagePaths).toHaveLength(1)
    expect(fs.existsSync(imagePaths[0]!)).toBe(true)
    expect(imagePaths[0]!).toContain(runtimeStatePath(cwd, "attachments", "s1"))
    expect(imagePaths[0]!).not.toContain(path.join(cwd, ".kody"))
    expect(imagePaths[0]!.endsWith(".png")).toBe(true)
    // No base64 left in the prompt text, and the path is referenced.
    expect(out[0]!.content).not.toContain("base64,")
    expect(out[0]!.content).toContain(imagePaths[0]!)
    expect(out[0]!.content).toContain("what do you see?")
  })

  it("materialises images from earlier turns too, not just the last", () => {
    const turns: ChatTurn[] = [
      {
        role: "user",
        content: `[Image: old.png (3 KB)]\ndata:image/png;base64,${PNG_B64}`,
        timestamp: "t0",
      },
      { role: "assistant", content: "a red dot", timestamp: "t1" },
      { role: "user", content: "and now?", timestamp: "t2" },
    ]
    const { turns: out, imagePaths } = prepareAttachments(turns, cwd, "s2")

    expect(imagePaths).toHaveLength(1)
    expect(fs.existsSync(imagePaths[0]!)).toBe(true)
    expect(out[0]!.content).not.toContain("base64,")
    expect(out[0]!.content).toContain(imagePaths[0]!)
  })

  it("materialises multiple images in one turn", () => {
    const turns: ChatTurn[] = [
      {
        role: "user",
        content:
          `[Image: a.png (1 KB)]\ndata:image/png;base64,${PNG_B64}\n\n` +
          `[Image: b.png (1 KB)]\ndata:image/png;base64,${PNG_B64}\n\ncompare these`,
        timestamp: "t0",
      },
    ]
    const { turns: out, imagePaths } = prepareAttachments(turns, cwd, "s4")

    expect(imagePaths).toHaveLength(2)
    expect(imagePaths.every((p) => fs.existsSync(p))).toBe(true)
    expect(out[0]!.content).not.toContain("base64,")
    expect(out[0]!.content).toContain(imagePaths[0]!)
    expect(out[0]!.content).toContain(imagePaths[1]!)
    expect(out[0]!.content).toContain("compare these")
  })

  it("leaves plain-text turns untouched", () => {
    const turns: ChatTurn[] = [{ role: "user", content: "hello", timestamp: "t0" }]
    const { turns: out, imagePaths } = prepareAttachments(turns, cwd, "s3")
    expect(imagePaths).toHaveLength(0)
    expect(out[0]).toBe(turns[0])
  })
})
