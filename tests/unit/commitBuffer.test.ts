import { beforeEach, describe, expect, it, vi } from "vitest"

const execFileSync = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", () => ({
  execFileSync,
}))

import { listChangedFiles } from "../../src/commit.js"

describe("commit: git output buffering", () => {
  beforeEach(() => {
    execFileSync.mockReset()
    execFileSync.mockReturnValue("")
  })

  it("allows large repository status output", () => {
    listChangedFiles("/repo")

    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
    )
    const options = execFileSync.mock.calls[0]?.[2] as { maxBuffer?: number }
    expect(options.maxBuffer).toBeGreaterThan(1024 * 1024)
  })

  it.each(["R ", " R", "C "])("consumes bare source paths after %s status records", (status) => {
    execFileSync.mockReturnValue(`${status} destination.txt\0source.txt\0 M next.txt\0`)
    expect(listChangedFiles("/repo")).toEqual(["destination.txt", "source.txt", "next.txt"])
  })

  it("refuses incomplete rename records", () => {
    execFileSync.mockReturnValue("R  destination.txt\0")
    expect(() => listChangedFiles("/repo")).toThrow("incomplete rename/copy")
  })
})
