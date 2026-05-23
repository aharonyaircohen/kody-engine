import { describe, expect, it } from "vitest"

import { evaluateMergeGate } from "../../src/scripts/mergeFlow.js"

const clean = {
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  title: "QA fixes",
  url: "https://example/pr/1",
}

describe("evaluateMergeGate", () => {
  it("merges a clean, mergeable, open PR", () => {
    expect(evaluateMergeGate(clean)).toEqual({ ok: true })
  })

  it("skips (not blocks) a PR that is already merged/closed", () => {
    const r = evaluateMergeGate({ ...clean, state: "MERGED" })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ action: "MERGE_SKIPPED" })
  })

  it("blocks a draft PR", () => {
    const r = evaluateMergeGate({ ...clean, isDraft: true })
    expect(r).toMatchObject({ ok: false, action: "MERGE_BLOCKED" })
  })

  it("blocks a conflicting PR (mergeable=CONFLICTING)", () => {
    const r = evaluateMergeGate({ ...clean, mergeable: "CONFLICTING" })
    expect(r).toMatchObject({ ok: false, action: "MERGE_BLOCKED" })
  })

  it("blocks a dirty PR (mergeStateStatus=DIRTY)", () => {
    const r = evaluateMergeGate({ ...clean, mergeStateStatus: "DIRTY" })
    expect(r).toMatchObject({ ok: false, action: "MERGE_BLOCKED" })
  })

  it("blocks while mergeability is still UNKNOWN (retry next tick)", () => {
    const r = evaluateMergeGate({ ...clean, mergeable: "UNKNOWN" })
    expect(r).toMatchObject({ ok: false, action: "MERGE_BLOCKED" })
  })

  it("blocks a branch that is BEHIND its base", () => {
    const r = evaluateMergeGate({ ...clean, mergeStateStatus: "BEHIND" })
    expect(r).toMatchObject({ ok: false, action: "MERGE_BLOCKED" })
  })

  it("blocks a BLOCKED PR (required checks/reviews unmet)", () => {
    const r = evaluateMergeGate({ ...clean, mergeStateStatus: "BLOCKED" })
    expect(r).toMatchObject({ ok: false, action: "MERGE_BLOCKED" })
  })

  it("blocks an UNSTABLE PR (a check is failing)", () => {
    const r = evaluateMergeGate({ ...clean, mergeStateStatus: "UNSTABLE" })
    expect(r).toMatchObject({ ok: false, action: "MERGE_BLOCKED" })
  })
})
