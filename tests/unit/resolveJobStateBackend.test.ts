/**
 * Unit tests for resolveBackend — the configuration-driven entry point that
 * job scripts use to pick a state backend.
 */

import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { BackendStateBackend } from "../../src/scripts/jobState/backendStateBackend.js"
import { resolveBackend } from "../../src/scripts/jobState/index.js"

function configWith(): KodyConfig {
  return {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "acme", repo: "widgets" },
    agent: { model: "anthropic/test" },
  }
}

describe("resolveBackend", () => {
  it("returns BackendStateBackend by default (no jobs config)", () => {
    const testSeam = process.env.KODY_TEST_LOCAL_JOB_STATE
    delete process.env.KODY_TEST_LOCAL_JOB_STATE
    const backend = resolveBackend({ config: configWith(), cwd: "/tmp", jobsDir: ".kody-engine/runtime/jobs" })
    if (testSeam !== undefined) process.env.KODY_TEST_LOCAL_JOB_STATE = testSeam
    expect(backend).toBeInstanceOf(BackendStateBackend)
    expect(backend.name).toBe("backend")
  })
})
