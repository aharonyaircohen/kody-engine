import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hoist-safe mock of the executor so runJob is tested in isolation (no real
// implementation spins up). Mirrors tests/unit/dispatchCapabilityFileTicks.routing.test.ts.
const { gh, runImplementationChain } = vi.hoisted(() => ({
  gh: vi.fn(),
  runImplementationChain: vi.fn(),
}))
vi.mock("../../src/executor.js", () => ({ runImplementationChain }))
vi.mock("../../src/issue.js", () => ({ gh }))

import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import {
  DEFAULT_INSTANT_AGENT,
  InvalidJobError,
  mintInstantJob,
  mintScheduledJob,
  newJobId,
  runJob,
  validateJob,
} from "../../src/job.js"

describe("runJob (Phase 1 seam)", () => {
  beforeEach(() => {
    runImplementationChain.mockReset()
    runImplementationChain.mockResolvedValue({ exitCode: 0 })
    gh.mockReset()
    gh.mockImplementation(() => {
      throw new Error("HTTP 404 Not Found")
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetCompanyStoreCacheForTests()
  })

  it("lowers an instant job onto runImplementationChain with its implementation + cliArgs", async () => {
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    expect(runImplementationChain).toHaveBeenCalledTimes(1)
    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.cwd).toBe("/x")
    expect(input.preloadedData?.jobCapability).toBe("run")
  })

  it("seeds result target as internal postflight context, not CLI args", async () => {
    await runJob(
      {
        capability: "vercel-production-deploy",
        implementation: "vercel-production-deploy",
        cliArgs: {},
        flavor: "instant",
        resultTarget: { type: "goal", id: "web-release-2026-07-01", evidence: "productionDeployed" },
      },
      { cwd: "/x" },
    )

    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.cliArgs).toEqual({})
    expect(input.preloadedData?.capabilityResultTarget).toEqual({
      type: "goal",
      id: "web-release-2026-07-01",
      evidence: "productionDeployed",
    })
  })

  it("lowers an action-only instant job through the capability action registry", async () => {
    await runJob({ action: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" }, { cwd: "/x" })
    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.preloadedData?.jobAction).toBe("run")
    expect(input.preloadedData?.jobCapability).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
  })

  it("accepts implementation as the selected profile and writes both metadata fields", async () => {
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
  })

  it("resolves a capability-only job to the capability-selected implementation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-job-"))
    const capabilityDir = path.join(cwd, ".kody", "capabilities", "ci-health")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({ name: "ci-health", action: "ci-health", implementation: "ci-check", agent: "kody" }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# CI Health\n")

    await runJob(
      {
        capability: "ci-health",
        cliArgs: { pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" },
        flavor: "instant",
      },
      { cwd },
    )

    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("ci-check")
    expect(input.cliArgs).toEqual({ pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" })
    expect(input.preloadedData?.jobCapability).toBe("ci-health")
    expect(input.preloadedData?.selectedImplementation).toBe("ci-check")
    expect(input.preloadedData?.selectedImplementation).toBe("ci-check")
  })

  it("seeds capabilityKind from capability folders for shared implementation traces", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-kind-job-"))
    const capabilityDir = path.join(cwd, ".kody", "capabilities", "pr-health")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({
        name: "pr-health",
        action: "pr-health",
        implementation: "capability-tick",
        agent: "kody",
        capabilityKind: "observe",
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# PR Health\n")

    await runJob({ capability: "pr-health", cliArgs: {}, flavor: "scheduled" }, { cwd })

    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobCapability).toBe("pr-health")
    expect(input.preloadedData?.jobCapabilityKind).toBe("observe")
  })

  it("preserves capability identity without injecting capability args when implementation is explicit", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-goal-handoff-"))
    const capabilityDir = path.join(cwd, ".kody", "capabilities", "company-graph")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(path.join(capabilityDir, "profile.json"), JSON.stringify({ name: "company-graph" }))
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Company Graph\n")
    await runJob(
      {
        capability: "company-graph",
        implementation: "company-graph",
        cliArgs: { goal: "hourly-monitor-goal-smoke" },
        flavor: "instant",
      },
      { cwd },
    )
    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("company-graph")
    expect(input.cliArgs).toEqual({ goal: "hourly-monitor-goal-smoke" })
    expect(input.preloadedData?.jobCapability).toBe("company-graph")
    expect(input.preloadedData?.selectedImplementation).toBe("company-graph")
  })

  it("seeds inline why into preloadedData.jobWhy", async () => {
    await runJob(
      { capability: "unit-fix", implementation: "unit-fix", why: "fix the flaky test", cliArgs: {}, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("fix the flaky test")
    expect(input.preloadedData?.jobIntent).toBeUndefined()
  })

  it("does not seed jobWhy for an empty why string", async () => {
    await runJob({ capability: "run", implementation: "run", why: "", cliArgs: {}, flavor: "instant" }, { cwd: "/x" })
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBeUndefined()
  })

  it("always seeds a jobId + flavor so the run can be recorded in the task ledger", async () => {
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(typeof input.preloadedData?.jobId).toBe("string")
    expect(input.preloadedData?.jobKey).toBe("instant:run:42")
    expect(input.preloadedData?.jobFlavor).toBe("instant")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
    expect(input.preloadedData?.jobTarget).toBe(42)
  })

  it("keeps the same stable job key for retries of the same target + implementation", async () => {
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )

    const first = runImplementationChain.mock.calls[0]![1].preloadedData
    const second = runImplementationChain.mock.calls[1]![1].preloadedData
    expect(first?.jobKey).toBe("instant:run:42")
    expect(second?.jobKey).toBe("instant:run:42")
    expect(first?.jobId).not.toBe(second?.jobId)
  })

  it("keeps GitHub attempt ids unique when multiple jobs run in one workflow", () => {
    vi.stubEnv("GITHUB_RUN_ID", "77")
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "3")

    const first = newJobId("instant")
    const second = newJobId("instant")

    expect(first).toMatch(/^gh-77-3-\d+$/)
    expect(second).toMatch(/^gh-77-3-\d+$/)
    expect(first).not.toBe(second)
  })

  it("carries the DispatchResult's why through mintInstantJob into jobWhy", async () => {
    await runJob(
      mintInstantJob({
        action: "run",
        capability: "run",
        implementation: "run",
        cliArgs: { issue: 5 },
        target: 5,
        why: "also add tests",
      }),
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("also add tests")
  })

  it("seeds agent into preloadedData.jobAgent", async () => {
    await runJob(
      { capability: "run", agent: "kody", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" },
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobAgent).toBe("kody")
  })

  it("uses the capability reference in the stable key for scheduled jobs", async () => {
    await runJob(
      {
        capability: "capability-tick",
        implementation: "capability-tick",
        schedule: "*/5 * * * *",
        cliArgs: {},
        flavor: "scheduled",
      },
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobKey).toBe("scheduled:capability-tick:capability-tick")
  })

  it("falls back to the capability slug as the profile when no implementation", async () => {
    await runJob({ capability: "run", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    expect(runImplementationChain.mock.calls[0]![0]).toBe("run")
  })

  it("seeds only job identity (no why/agent) for a bare scheduled job", async () => {
    await runJob({ capability: "run", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobWhy).toBeUndefined()
    expect(input.preloadedData?.jobAgent).toBeUndefined()
  })

  it("rejects a job with no capability action or capability", () => {
    expect(() => validateJob({ cliArgs: {}, flavor: "instant" })).toThrow(InvalidJobError)
  })

  it("rejects an implementation-only job", () => {
    expect(() => validateJob({ implementation: "run", cliArgs: {}, flavor: "instant" })).toThrow(
      /capability action, capability, or workflow/,
    )
  })

  it("rejects an unknown flavor", () => {
    expect(() => validateJob({ capability: "run", implementation: "run", cliArgs: {}, flavor: "bogus" })).toThrow(
      InvalidJobError,
    )
  })

  it("defaults cliArgs to an empty object when omitted", () => {
    const j = validateJob({ capability: "run", implementation: "run", flavor: "instant" })
    expect(j.cliArgs).toEqual({})
  })

  it("accepts a workflow-only job", () => {
    const j = validateJob({ workflow: "bug-flow", flavor: "instant" })
    expect(j.workflow).toBe("bug-flow")
    expect(j.cliArgs).toEqual({})
  })

  it("runs a workflow capability as ordered child capability jobs", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "bug", {
        name: "bug",
        action: "bug",
        workflow: {
          steps: [
            { capability: "reproduce", reason: "capture the failing test" },
            { capability: "run", reason: "fix the bug using the repro artifact" },
          ],
        },
      })
      writeCapability(cwd, "reproduce", {
        name: "reproduce",
        action: "reproduce",
        implementation: "reproduce",
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "bug",
          capability: "bug",
          cliArgs: { issue: 42, base: "feature/base" },
          target: 42,
          why: "operator note",
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42 })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "bug",
        workflowStep: "reproduce",
        workflowStepIndex: 1,
        workflowStepCount: 2,
        jobCapability: "reproduce",
        selectedImplementation: "reproduce",
      })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData?.jobWhy).toContain("operator note")
      expect(runImplementationChain.mock.calls[0]![1].preloadedData?.jobWhy).toContain("capture the failing test")

      expect(runImplementationChain.mock.calls[1]![0]).toBe("run")
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({ issue: 42, base: "feature/base" })
      expect(runImplementationChain.mock.calls[1]![1].preloadedData).toMatchObject({
        workflowCapability: "bug",
        workflowStep: "run",
        workflowStepIndex: 2,
        workflowStepCount: 2,
        jobCapability: "run",
        selectedImplementation: "run",
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("emits an agency boundary trace for workflow capabilities", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-trace-job-"))
    const originalCwd = process.cwd()
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        capabilityKind: "act",
        workflow: {
          steps: [{ capability: "run", reason: "implement the feature" }],
        },
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "feature",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      const out = write.mock.calls.map((call) => String(call[0])).join("")
      expect(out).toContain("KODY_AGENCY_BOUNDARY_EVAL=")
      expect(out).toContain('"capability":"feature"')
      expect(out).toContain('"capabilityKind":"act"')
    } finally {
      write.mockRestore()
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("runs an action-only workflow capability without treating the action as an implementation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-action-workflow-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        workflow: {
          steps: [{ capability: "run", reason: "implement the feature" }],
        },
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "feature",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(1)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("run")
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42 })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "feature",
        workflowStep: "run",
        jobCapability: "run",
        selectedImplementation: "run",
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("runs a stored workflow definition as ordered child capability jobs", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-definition-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "reproduce", {
        name: "reproduce",
        action: "reproduce",
        implementation: "reproduce",
      })
      writeCapability(cwd, "run", {
        name: "run",
        action: "run",
        implementation: "run",
      })
      writeCapability(cwd, "bug-flow", {
        name: "bug-flow",
        action: "bug-flow",
        implementation: "bug-flow",
      })
      const workflow = {
        version: 1,
        name: "Bug workflow",
        capabilities: ["reproduce", "run"],
        createdAt: "2026-06-27T00:00:00Z",
        updatedAt: "2026-06-27T00:00:00Z",
      }
      gh.mockReturnValue(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(workflow), "utf8").toString("base64"),
          sha: "workflow-sha",
        }),
      )
      process.chdir(cwd)

      await runJob(
        {
          workflow: "bug-flow",
          cliArgs: { issue: 42 },
          flavor: "instant",
        },
        {
          cwd,
          config: {
            quality: { typecheck: "", lint: "", testUnit: "", format: "" },
            git: { defaultBranch: "main" },
            github: { owner: "o", repo: "r" },
            agent: { model: "anthropic/claude-haiku-4-5-20251001" },
            state: { repo: "o/kody-state", path: "r" },
          },
        },
      )

      expect(gh).toHaveBeenCalledWith(
        ["api", "/repos/o/kody-state/contents/r/workflows/bug-flow/workflow.json?ref=main"],
        {
          cwd,
        },
      )
      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runImplementationChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "bug-flow",
        workflowTitle: "Bug workflow",
        workflowStep: "reproduce",
        workflowStepIndex: 1,
        workflowStepCount: 2,
      })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData).not.toHaveProperty("jobWhy")
      expect(runImplementationChain.mock.calls[1]![0]).toBe("run")
      expect(runImplementationChain.mock.calls[1]![1].preloadedData).toMatchObject({
        workflowCapability: "bug-flow",
        workflowStep: "run",
        workflowStepIndex: 2,
        workflowStepCount: 2,
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("preserves stored workflow step order, duplicate capabilities, and PR handoff", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-web-release-workflow-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "release-prepare", {
        name: "release-prepare",
        action: "release-prepare",
        implementation: "release-prepare",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: false }],
      })
      writeCapability(cwd, "release-merge", {
        name: "release-merge",
        action: "release-merge",
        implementation: "release-merge",
        inputs: [
          { name: "pr", flag: "--pr", type: "int", required: true },
          { name: "issue", flag: "--issue", type: "int", required: false },
        ],
      })
      writeCapability(cwd, "release-promote", {
        name: "release-promote",
        action: "release-promote",
        implementation: "release-promote",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: false }],
      })
      writeCapability(cwd, "vercel-production-deploy", {
        name: "vercel-production-deploy",
        action: "vercel-production-deploy",
        implementation: "vercel-production-deploy",
        inputs: [],
      })
      const workflow = {
        version: 1,
        name: "Web release",
        steps: [
          { capability: "release-prepare", target: "issue" },
          { capability: "release-merge", target: "pr" },
          { capability: "release-promote", target: "issue" },
          { capability: "release-merge", target: "pr" },
          { capability: "vercel-production-deploy" },
        ],
      }
      gh.mockReturnValue(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(workflow), "utf8").toString("base64"),
          sha: "workflow-sha",
        }),
      )
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({
          exitCode: 0,
          prUrl: "https://github.com/o/r/pull/10",
        })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RELEASE_MERGED") })
        .mockResolvedValueOnce({
          exitCode: 0,
          prUrl: "https://github.com/o/r/pull/11",
        })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RELEASE_BRANCH_MERGED") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("VERCEL_PRODUCTION_DEPLOY_COMPLETED") })

      await runJob(
        {
          workflow: "web-release",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        {
          cwd,
          config: {
            quality: { typecheck: "", lint: "", testUnit: "", format: "" },
            git: { defaultBranch: "main" },
            github: { owner: "o", repo: "r" },
            agent: { model: "anthropic/claude-haiku-4-5-20251001" },
            state: { repo: "o/kody-state", path: "r" },
          },
        },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(5)
      expect(runImplementationChain.mock.calls.map((call) => call[0])).toEqual([
        "release-prepare",
        "release-merge",
        "release-promote",
        "release-merge",
        "vercel-production-deploy",
      ])
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42 })
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({ issue: 42, pr: 10 })
      expect(runImplementationChain.mock.calls[2]![1].cliArgs).toEqual({ issue: 42 })
      expect(runImplementationChain.mock.calls[3]![1].cliArgs).toEqual({ issue: 42, pr: 11 })
      expect(runImplementationChain.mock.calls[4]![1].cliArgs).toEqual({})
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("runs a Store-only workflow definition after state repo lookup misses", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-store-workflow-definition-job-"))
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "kody-store-workflow-definition-store-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "release-prepare", {
        name: "release-prepare",
        action: "release-prepare",
        implementation: "release-prepare",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: false }],
      })
      writeCapability(cwd, "release-merge", {
        name: "release-merge",
        action: "release-merge",
        implementation: "release-merge",
        inputs: [{ name: "pr", flag: "--pr", type: "int", required: false }],
      })
      writeWorkflowDefinition(store, "web-release", {
        version: 1,
        name: "Web release",
        steps: [
          { capability: "release-prepare", target: "issue", cliArgs: { prefer: "ours" } },
          { capability: "release-merge", target: "pr" },
        ],
      })
      fs.writeFileSync(
        path.join(store, "kody-store.json"),
        JSON.stringify({ name: "test-store", layoutVersion: 1, assetRoots: { workflows: "workflows" } }),
      )
      vi.stubEnv("KODY_COMPANY_STORE", store)
      vi.stubEnv("KODY_COMPANY_STORE_REF", "main")
      resetCompanyStoreCacheForTests()
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({ exitCode: 0, prUrl: "https://github.com/o/r/pull/12" })
        .mockResolvedValueOnce({ exitCode: 0 })

      await runJob(
        {
          workflow: "web-release",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        {
          cwd,
          config: {
            quality: { typecheck: "", lint: "", testUnit: "", format: "" },
            git: { defaultBranch: "main" },
            github: { owner: "o", repo: "r" },
            agent: { model: "anthropic/claude-haiku-4-5-20251001" },
            state: { repo: "o/kody-state", path: "r" },
          },
        },
      )

      expect(gh).toHaveBeenCalledWith(
        ["api", "/repos/o/kody-state/contents/r/workflows/web-release/workflow.json?ref=main"],
        {
          cwd,
        },
      )
      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("release-prepare")
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42, prefer: "ours" })
      expect(runImplementationChain.mock.calls[1]![0]).toBe("release-merge")
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({ issue: 42, pr: 12 })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(store, { recursive: true, force: true })
    }
  })

  it("runs a workflow when the public route includes the selected implementation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-route-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "bug", {
        name: "bug",
        action: "bug",
        workflow: { steps: ["reproduce", "run"] },
      })
      writeCapability(cwd, "reproduce", {
        name: "reproduce",
        action: "reproduce",
        implementation: "reproduce",
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "bug",
          capability: "bug",
          implementation: "reproduce",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runImplementationChain.mock.calls[1]![0]).toBe("run")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("passes workflow issue and PR targets to matching steps", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-targets-"))
    const originalCwd = process.cwd()
    try {
      writeWorkflowStages(cwd)
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        workflow: {
          steps: [
            { capability: "run", target: "issue" },
            { capability: "review", target: "pr" },
            {
              capability: "fix",
              target: "pr",
              runWhen: { "lastOutcome.type": ["REVIEW_CONCERNS", "REVIEW_FAIL"] },
            },
          ],
        },
      })
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RUN_COMPLETED", "https://github.com/o/r/pull/99") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("REVIEW_CONCERNS") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("FIX_COMPLETED") })

      await runJob(
        {
          action: "feature",
          capability: "feature",
          cliArgs: { issue: 42, base: "feature/base" },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(3)
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42, base: "feature/base" })
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({ pr: 99 })
      expect(runImplementationChain.mock.calls[2]![1].cliArgs).toEqual({ pr: 99 })
      expect(runImplementationChain.mock.calls[1]![1].preloadedData?.workflowStep).toBe("review")
      expect(runImplementationChain.mock.calls[2]![1].preloadedData?.workflowStep).toBe("fix")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("skips conditional workflow steps when runWhen does not match", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-skip-"))
    const originalCwd = process.cwd()
    try {
      writeWorkflowStages(cwd)
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        workflow: {
          steps: [
            { capability: "run", target: "issue" },
            { capability: "review", target: "pr" },
            {
              capability: "fix",
              target: "pr",
              runWhen: { "lastOutcome.type": ["REVIEW_CONCERNS", "REVIEW_FAIL"] },
            },
          ],
        },
      })
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RUN_COMPLETED", "https://github.com/o/r/pull/99") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("REVIEW_PASS") })

      await runJob(
        { action: "feature", capability: "feature", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("run")
      expect(runImplementationChain.mock.calls[1]![0]).toBe("review")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("can continue a workflow after an allowed non-zero action outcome", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-continue-"))
    const originalCwd = process.cwd()
    try {
      writeWorkflowStages(cwd)
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        workflow: {
          steps: [
            { capability: "run", target: "issue" },
            { capability: "review", target: "pr", continueOn: ["REVIEW_FAIL"] },
            {
              capability: "fix",
              target: "pr",
              runWhen: { "lastOutcome.type": ["REVIEW_CONCERNS", "REVIEW_FAIL"] },
            },
          ],
        },
      })
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RUN_COMPLETED", "https://github.com/o/r/pull/99") })
        .mockResolvedValueOnce({ exitCode: 1, reason: "blocking review", taskState: taskState("REVIEW_FAIL") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("FIX_COMPLETED") })

      const result = await runJob(
        { action: "feature", capability: "feature", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({ exitCode: 0 })
      expect(runImplementationChain).toHaveBeenCalledTimes(3)
      expect(runImplementationChain.mock.calls[1]![1].preloadedData?.workflowContinueOn).toEqual(["REVIEW_FAIL"])
      expect(runImplementationChain.mock.calls[2]![0]).toBe("fix")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("stops a workflow when a child capability fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-fail-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "bug", {
        name: "bug",
        action: "bug",
        workflow: { steps: ["reproduce", "run"] },
      })
      writeCapability(cwd, "reproduce", {
        name: "reproduce",
        action: "reproduce",
        implementation: "reproduce",
      })
      process.chdir(cwd)
      runImplementationChain.mockResolvedValueOnce({ exitCode: 1, reason: "repro failed" })

      const result = await runJob(
        { action: "bug", capability: "bug", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({ exitCode: 1, reason: "repro failed" })
      expect(runImplementationChain).toHaveBeenCalledTimes(1)
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function writeCapability(cwd: string, slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(cwd, ".kody", "capabilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile))
  fs.writeFileSync(path.join(dir, "capability.md"), `# ${slug}\n`)
}

function writeWorkflowDefinition(cwd: string, slug: string, workflow: Record<string, unknown>): void {
  const dir = path.join(cwd, "workflows", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(workflow))
}

function writeWorkflowStages(cwd: string): void {
  writeCapability(cwd, "run", {
    name: "run",
    action: "run",
    role: "primitive",
    inputs: [
      { name: "issue", flag: "--issue", type: "int", required: true },
      { name: "base", flag: "--base", type: "string", required: false },
    ],
  })
  writeCapability(cwd, "review", {
    name: "review",
    action: "review",
    role: "primitive",
    inputs: [{ name: "pr", flag: "--pr", type: "int", required: true }],
  })
  writeCapability(cwd, "fix", {
    name: "fix",
    action: "fix",
    role: "primitive",
    inputs: [
      { name: "pr", flag: "--pr", type: "int", required: true },
      { name: "feedback", flag: "--feedback", type: "string", required: false },
    ],
  })
}

function taskState(type: string, prUrl?: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    core: {
      phase: "idle",
      status: "succeeded",
      currentImplementation: null,
      attempts: {},
      lastOutcome: { type, payload: {}, timestamp: "2026-06-26T00:00:00.000Z" },
      ...(prUrl ? { prUrl } : {}),
    },
    implementations: {},
    artifacts: {},
    jobs: {},
    history: [],
  }
}

describe("mintInstantJob (Phase 2)", () => {
  const dispatch = {
    action: "fix",
    capability: "fix",
    implementation: "fix",
    cliArgs: { pr: 7 },
    target: 7,
  }

  it("maps a DispatchResult to an instant job", () => {
    const job = mintInstantJob(dispatch, { why: "fix the typo" })
    expect(job).toMatchObject({
      implementation: "fix",
      capability: "fix",
      target: 7,
      cliArgs: { pr: 7 },
      why: "fix the typo",
      flavor: "instant",
    })
  })

  it("defaults agent to the standard agent", () => {
    expect(mintInstantJob(dispatch).agent).toBe(DEFAULT_INSTANT_AGENT)
  })

  it("lets the caller override the agent", () => {
    expect(mintInstantJob(dispatch, { agent: "reviewer" }).agent).toBe("reviewer")
  })

  it("produces a job that runJob can run", async () => {
    runImplementationChain.mockResolvedValue({ exitCode: 0 })
    await runJob(mintInstantJob(dispatch, { why: "x" }), { cwd: "/x" })
    expect(runImplementationChain.mock.calls.at(-1)![0]).toBe("fix")
  })
})

describe("mintScheduledJob (Phase 2)", () => {
  it("maps a due capability slug to a scheduled job", () => {
    const job = mintScheduledJob({
      capability: "stale-prs",
      implementation: "capability-tick",
      schedule: "*/5 * * * *",
      agent: "kody",
      cliArgs: { capability: "stale-prs" },
    })
    expect(job).toMatchObject({
      capability: "stale-prs",
      implementation: "capability-tick",
      schedule: "*/5 * * * *",
      agent: "kody",
      cliArgs: { capability: "stale-prs" },
      flavor: "scheduled",
    })
  })

  it("defaults cliArgs to empty", () => {
    expect(mintScheduledJob({ capability: "d", implementation: "capability-tick" }).cliArgs).toEqual({})
  })

  it("carries the cadence onto ctx.data.jobSchedule so the ledger records when it fired", async () => {
    await runJob(
      mintScheduledJob({
        capability: "capability-tick",
        implementation: "capability-tick",
        schedule: "7d",
      }),
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSchedule).toBe("7d")
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobCapability).toBe("capability-tick")
    expect(input.preloadedData?.selectedImplementation).toBe("capability-tick")
    expect(input.preloadedData?.selectedImplementation).toBe("capability-tick")
  })

  it("carries saveReport onto ctx.data.jobSaveReport", async () => {
    await runJob(
      mintScheduledJob({
        capability: "model-health-audit",
        implementation: "model-health-audit",
        saveReport: true,
      }),
      { cwd: "/x" },
    )

    const [, input] = runImplementationChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSaveReport).toBe(true)
  })
})
