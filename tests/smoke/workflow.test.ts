import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runJob } from "../../src/job.js"
import { parseWorkflowRunState } from "../../src/workflowRunState.js"

let cwd: string
let originalCwd: string
beforeEach(() => {
  originalCwd = process.cwd()
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-smoke-"))
  process.chdir(cwd)
})
afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(cwd, { recursive: true, force: true })
})
function capability(name: string, script: string): void {
  const dir = path.join(cwd, ".kody-engine", "definitions", "capabilities", name)
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
  fs.writeFileSync(path.join(dir, "instructions.md"), `# ${name}\n`)
  fs.writeFileSync(
    path.join(dir, "contract.json"),
    JSON.stringify({ execution: "script", input: { type: "object" }, output: { type: "object" } }),
  )
  fs.writeFileSync(path.join(dir, "tools", "run.sh"), `#!/usr/bin/env bash\nset -eu\n${script}\n`)
}
function workflow(value: object): void {
  const dir = path.join(cwd, ".kody-engine", "runtime", "workflows", "smoke-flow")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({ version: 1, name: "Smoke flow", ...value }))
}
const job = { workflow: "smoke-flow", cliArgs: {}, flavor: "instant" as const }

describe("smoke: workflows through real script execution", () => {
  it("skips a conditional graph action and executes its default successor", async () => {
    capability("omit", 'echo omit >> actions.txt\nprintf \'{"status":"ok"}\'')
    capability("finish", 'echo finish >> actions.txt\nprintf \'{"status":"ok"}\'')
    workflow({
      startAt: "omit",
      steps: [
        { id: "omit", capability: "omit", runWhen: { "facts.allowed": true }, next: [{ to: "finish", default: true }] },
        { id: "finish", capability: "finish" },
      ],
    })
    const result = await runJob(job, { cwd, skipConfig: true })
    expect(result.exitCode, result.reason).toBe(0)
    expect(fs.readFileSync(path.join(cwd, "actions.txt"), "utf8")).toBe("finish\n")
  })

  it("returns saved completed state without repeating real actions", async () => {
    capability("prepare", 'echo prepare >> actions.txt\nprintf \'{"value":"saved"}\'')
    capability("finish", 'echo finish >> actions.txt\nprintf \'{"status":"ok"}\'')
    workflow({ steps: [{ capability: "prepare" }, { capability: "finish" }] })
    const first = await runJob(job, { cwd, skipConfig: true })
    expect(first.exitCode, first.reason).toBe(0)
    expect(first.workflowState?.status).toBe("done")
    const completed = parseWorkflowRunState(JSON.parse(JSON.stringify(first.workflowState)))!
    const replay = await runJob({ ...job, workflowState: completed }, { cwd, skipConfig: true })
    expect(replay.exitCode).toBe(0)
    expect(replay.workflowState).toEqual(completed)
    expect(fs.readFileSync(path.join(cwd, "actions.txt"), "utf8")).toBe("prepare\nfinish\n")
  })
})
