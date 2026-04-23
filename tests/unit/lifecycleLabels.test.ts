import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { gh } from "../../src/issue.js"
import {
  KODY_LABEL_PREFIX,
  collectProfileLabels,
  ensureLabels,
  getIssueLabels,
  setKodyLabel,
} from "../../src/lifecycleLabels.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  ghMock.mockReset()
})

describe("KODY_LABEL_PREFIX", () => {
  it("is the shared namespace for kody-owned labels", () => {
    expect(KODY_LABEL_PREFIX).toBe("kody:")
  })
})

describe("collectProfileLabels", () => {
  it("harvests every label spec declared on profile script entries, deduped by name", () => {
    const labels = collectProfileLabels()
    const names = labels.map((l) => l.label).sort()

    // Preflight entries in executable profiles.
    expect(names).toEqual(
      expect.arrayContaining([
        "kody:planning",
        "kody:researching",
        "kody:running",
        "kody:reviewing",
        "kody:fixing",
        "kody:resolving",
        "kody:syncing",
      ]),
    )
    // Terminal labels declared inline on orchestrator finishFlow entries.
    expect(names).toEqual(expect.arrayContaining(["kody:done", "kody:failed"]))

    // Deduped: "kody:fixing" is in both fix and fix-ci profiles, but shows up once.
    expect(names.filter((n) => n === "kody:fixing")).toHaveLength(1)
    expect(names.filter((n) => n === "kody:reviewing")).toHaveLength(1)

    // Every collected spec has color + description.
    for (const l of labels) {
      expect(l.color).toMatch(/^[0-9a-f]{6}$/i)
      expect(l.description).toBeTruthy()
    }
  })
})

describe("ensureLabels", () => {
  it("creates every collected label with color + description + --force", () => {
    ghMock.mockReturnValue("")
    const result = ensureLabels("/tmp/repo")

    const expected = collectProfileLabels()
    expect(result.created).toHaveLength(expected.length)
    expect(result.failed).toEqual([])

    for (const spec of expected) {
      const call = ghMock.mock.calls.find(([args]) => Array.isArray(args) && args[2] === spec.label)
      expect(call, `gh was not called for ${spec.label}`).toBeDefined()
      const [args, opts] = call!
      expect(args).toEqual(expect.arrayContaining(["label", "create", spec.label, "--force"]))
      if (spec.color) expect(args).toEqual(expect.arrayContaining(["--color", spec.color]))
      if (spec.description) expect(args).toEqual(expect.arrayContaining(["--description", spec.description]))
      expect(opts).toEqual({ cwd: "/tmp/repo" })
    }
  })

  it("records failures without throwing", () => {
    ghMock.mockImplementation(() => {
      throw new Error("gh: auth required")
    })
    const result = ensureLabels()
    expect(result.created).toEqual([])
    expect(result.failed.length).toBeGreaterThan(0)
    expect(result.failed[0]).toMatchObject({ reason: expect.stringContaining("auth required") })
  })
})

describe("getIssueLabels", () => {
  it("parses one-per-line label names", () => {
    ghMock.mockReturnValue("kody:planning\nbug\nkody:running")
    expect(getIssueLabels(42)).toEqual(["kody:planning", "bug", "kody:running"])
  })

  it("returns [] on gh failure", () => {
    ghMock.mockImplementation(() => {
      throw new Error("not found")
    })
    expect(getIssueLabels(42)).toEqual([])
  })
})

describe("setKodyLabel", () => {
  it("removes any other kody:* label and adds the target", () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return "kody:planning\nkody:running\nbug\nenhancement"
      return ""
    })

    setKodyLabel(42, { label: "kody:reviewing", color: "d93f0b", description: "desc" })

    const editCalls = ghMock.mock.calls
      .map(([args]) => args as string[])
      .filter((a) => a[0] === "issue" && a[1] === "edit")

    const removed = editCalls.filter((a) => a.includes("--remove-label")).map((a) => a.at(-1))
    const added = editCalls.filter((a) => a.includes("--add-label")).map((a) => a.at(-1))

    expect(removed).toEqual(expect.arrayContaining(["kody:planning", "kody:running"]))
    // Non-kody labels are left alone.
    expect(removed).not.toContain("bug")
    expect(removed).not.toContain("enhancement")
    expect(added).toEqual(["kody:reviewing"])
  })

  it("refuses to set a label that doesn't start with kody:", () => {
    ghMock.mockReturnValue("")
    setKodyLabel(42, { label: "bug" })
    // No issue edit should happen.
    const editCalls = ghMock.mock.calls.filter(([args]) => Array.isArray(args) && args[1] === "edit")
    expect(editCalls).toHaveLength(0)
  })

  it("lazily creates the label on 'not found' and retries the add with spec", () => {
    let addAttempts = 0
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return ""
      if (args[0] === "issue" && args[1] === "edit" && args.includes("--add-label")) {
        addAttempts++
        if (addAttempts === 1) throw new Error("label not found")
        return ""
      }
      if (args[0] === "label" && args[1] === "create") return ""
      return ""
    })

    setKodyLabel(42, { label: "kody:done", color: "0e8a16", description: "desc" })

    const createCalls = ghMock.mock.calls
      .map(([args]) => args as string[])
      .filter((a) => a[0] === "label" && a[1] === "create")
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toEqual(
      expect.arrayContaining(["kody:done", "--color", "0e8a16", "--description", "desc", "--force"]),
    )
    expect(addAttempts).toBe(2)
  })

  it("never throws if both add + lazy-create fail", () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return ""
      throw new Error("network down")
    })
    expect(() => setKodyLabel(42, { label: "kody:failed" })).not.toThrow()
  })
})
