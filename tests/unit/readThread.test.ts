import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({ gh: vi.fn() }))

import { readThread } from "../../src/capabilityMcp.js"
import { gh } from "../../src/issue.js"

beforeEach(() => vi.clearAllMocks())

describe("readThread", () => {
  it("returns title/state/labels + newest-last comments via the issues API", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      const path = args[1] ?? ""
      if (path === "repos/o/r/issues/42") {
        return JSON.stringify({
          title: "QA: feature X",
          state: "open",
          labels: [{ name: "kody:qa" }, { name: "kody:qa-report" }],
        })
      }
      if (path.startsWith("repos/o/r/issues/42/comments")) {
        return JSON.stringify([
          { user: { login: "alice" }, created_at: "t1", body: "first" },
          { user: { login: "app/kodyade" }, created_at: "t2", body: "QA [CONCERNS]: ..." },
        ])
      }
      throw new Error(`unexpected gh: ${args.join(" ")}`)
    })
    const r = readThread("o/r", 42)
    expect(r.title).toBe("QA: feature X")
    expect(r.labels).toEqual(["kody:qa", "kody:qa-report"])
    expect(r.comments.at(-1)?.author).toBe("app/kodyade")
    expect(r.comments.at(-1)?.body).toContain("CONCERNS")
  })

  it("honours the limit (keeps the newest N)", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      const path = args[1] ?? ""
      if (path === "repos/o/r/issues/7") return JSON.stringify({ title: "t", state: "open", labels: [] })
      return JSON.stringify(
        Array.from({ length: 5 }, (_, i) => ({ user: { login: "u" }, created_at: `t${i}`, body: `c${i}` })),
      )
    })
    const r = readThread("o/r", 7, 2)
    expect(r.comments.map((c) => c.body)).toEqual(["c3", "c4"])
  })
})
