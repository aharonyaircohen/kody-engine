import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { gh } from "../../src/issue.js"
import {
  KODY_NAMESPACE,
  collectProfileLabels,
  ensureLabels,
  getIssueLabels,
  setKodyLabel,
} from "../../src/lifecycleLabels.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  ghMock.mockReset()
})

describe("KODY_NAMESPACE", () => {
  it("is the shared prefix for kody-owned labels", () => {
    expect(KODY_NAMESPACE).toBe("kody")
  })
})

describe("collectProfileLabels", () => {
  it("harvests every label spec declared on profile script entries, deduped by name", () => {
    const labels = collectProfileLabels()
    const names = labels.map((l) => l.label)

    // All collected names live in the kody namespace.
    for (const n of names) {
      expect(n.startsWith(KODY_NAMESPACE)).toBe(true)
    }

    // Every profile-declared label is represented — at least a few must
    // exist; the exact set is profile-data so we don't hard-code it here.
    expect(names.length).toBeGreaterThan(0)

    // Dedup invariant: each name appears exactly once even when multiple
    // profiles declare the same label.
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)

    // Every collected spec has color + description (profile-level convention).
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
  it("removes same-group kody siblings but leaves non-kody labels alone", () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return "kody:a\nkody:b\nbug\nenhancement"
      return ""
    })

    setKodyLabel(42, { label: "kody:c", color: "d93f0b", description: "desc" })

    const editCalls = ghMock.mock.calls
      .map(([args]) => args as string[])
      .filter((a) => a[0] === "issue" && a[1] === "edit")

    const removed = editCalls.filter((a) => a.includes("--remove-label")).map((a) => a.at(-1))
    const added = editCalls.filter((a) => a.includes("--add-label")).map((a) => a.at(-1))

    expect(removed).toEqual(expect.arrayContaining(["kody:a", "kody:b"]))
    expect(removed).not.toContain("bug")
    expect(removed).not.toContain("enhancement")
    expect(added).toEqual(["kody:c"])
  })

  it("leaves different-group kody labels alone (cross-group coexistence)", () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return "kody:a\nkody-other:x\nkody-another:y"
      return ""
    })

    setKodyLabel(42, { label: "kody:b" })

    const editCalls = ghMock.mock.calls
      .map(([args]) => args as string[])
      .filter((a) => a[0] === "issue" && a[1] === "edit")

    const removed = editCalls.filter((a) => a.includes("--remove-label")).map((a) => a.at(-1))
    // Only same-group (prefix "kody:") siblings get removed.
    expect(removed).toEqual(["kody:a"])
    expect(removed).not.toContain("kody-other:x")
    expect(removed).not.toContain("kody-another:y")
  })

  it("refuses to set a label outside the kody namespace", () => {
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
