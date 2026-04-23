import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadProfile, ProfileError } from "../../src/profile.js"
import { renderScheduledWorkflow } from "../../src/scripts/initFlow.js"

function writeProfile(body: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody2-sched-"))
  const p = path.join(dir, "profile.json")
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

const VALID_BASE = {
  name: "watch-x",
  role: "watch",
  describe: "scheduled thing",
  inputs: [],
  claudeCode: {
    model: "inherit",
    permissionMode: "default",
    tools: [],
    hooks: [],
    skills: [],
    commands: [],
    subagents: [],
    plugins: [],
    mcpServers: [],
  },
  cliTools: [],
  scripts: { preflight: [], postflight: [] },
}

describe("profile: kind / schedule", () => {
  let p: string
  afterEach(() => {
    fs.rmSync(path.dirname(p), { recursive: true, force: true })
  })

  it("defaults to kind=oneshot when omitted", () => {
    p = writeProfile(VALID_BASE)
    const loaded = loadProfile(p)
    expect(loaded.kind).toBe("oneshot")
    expect(loaded.schedule).toBeUndefined()
  })

  it("accepts kind=scheduled with a schedule string", () => {
    p = writeProfile({ ...VALID_BASE, kind: "scheduled", schedule: "0 8 * * MON" })
    const loaded = loadProfile(p)
    expect(loaded.kind).toBe("scheduled")
    expect(loaded.schedule).toBe("0 8 * * MON")
  })

  it("rejects kind=scheduled without a schedule", () => {
    p = writeProfile({ ...VALID_BASE, kind: "scheduled" })
    expect(() => loadProfile(p)).toThrow(ProfileError)
    expect(() => loadProfile(p)).toThrow(/requires a "schedule" cron string/)
  })

  it("treats unknown kind values as oneshot (fail-soft)", () => {
    p = writeProfile({ ...VALID_BASE, kind: "bogus" })
    const loaded = loadProfile(p)
    expect(loaded.kind).toBe("oneshot")
  })
})

describe("renderScheduledWorkflow", () => {
  it("emits a workflow with the declared cron", () => {
    const yaml = renderScheduledWorkflow("watch-stale-prs", "0 8 * * MON")
    expect(yaml).toMatch(/name: kody2 watch-stale-prs/)
    expect(yaml).toMatch(/cron: "0 8 \* \* MON"/)
    expect(yaml).toMatch(/kody2 watch-stale-prs/)
    expect(yaml).toMatch(/@kody-ade\/kody-engine@latest/)
  })

  it("includes workflow_dispatch for manual firing", () => {
    const yaml = renderScheduledWorkflow("watch-x", "*/30 * * * *")
    expect(yaml).toMatch(/workflow_dispatch:/)
  })
})
