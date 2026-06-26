import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/lifecycleLabels.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lifecycleLabels.js")>("../../src/lifecycleLabels.js")
  return {
    ...actual,
    setKodyLabel: vi.fn(),
  }
})

import type { Context, Profile } from "../../src/executables/types.js"
import { setKodyLabel } from "../../src/lifecycleLabels.js"
import { setLifecycleLabel } from "../../src/scripts/setLifecycleLabel.js"

const profile = {} as Profile
const setKodyLabelMock = setKodyLabel as unknown as ReturnType<typeof vi.fn>

function makeCtx(args: Record<string, unknown>): Context {
  return {
    args,
    cwd: "/tmp/repo",
    config: {} as Context["config"],
    data: {},
    output: { exitCode: 0 },
  } as Context
}

beforeEach(() => {
  setKodyLabelMock.mockReset()
})

describe("setLifecycleLabel script", () => {
  it("labels the issue with the spec declared in `with`", async () => {
    await setLifecycleLabel(makeCtx({ issue: 42 }), profile, {
      label: "kody:running",
      color: "fbca04",
      description: "implementing",
    })
    expect(setKodyLabelMock).toHaveBeenCalledWith(
      42,
      { label: "kody:running", color: "fbca04", description: "implementing" },
      "/tmp/repo",
    )
  })

  it("falls back to ctx.args.pr for PR-scoped executables", async () => {
    await setLifecycleLabel(makeCtx({ pr: 7 }), profile, {
      label: "kody:reviewing",
      color: "d93f0b",
      description: "reviewing",
    })
    expect(setKodyLabelMock).toHaveBeenCalledWith(
      7,
      { label: "kody:reviewing", color: "d93f0b", description: "reviewing" },
      "/tmp/repo",
    )
  })

  it("prefers issue over pr when both are set", async () => {
    await setLifecycleLabel(makeCtx({ issue: 42, pr: 7 }), profile, { label: "kody:fixing" })
    expect(setKodyLabelMock).toHaveBeenCalledWith(
      42,
      { label: "kody:fixing", color: undefined, description: undefined },
      "/tmp/repo",
    )
  })

  it("no-ops when neither issue nor pr is present", async () => {
    await setLifecycleLabel(makeCtx({}), profile, { label: "kody:running" })
    expect(setKodyLabelMock).not.toHaveBeenCalled()
  })

  it("no-ops when label arg is missing or non-kody", async () => {
    await setLifecycleLabel(makeCtx({ issue: 1 }), profile, undefined)
    await setLifecycleLabel(makeCtx({ issue: 1 }), profile, { label: "bug" })
    expect(setKodyLabelMock).not.toHaveBeenCalled()
  })
})
