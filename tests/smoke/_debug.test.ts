import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { packageVersion, runCli } from "/home/runner/work/kody-engine/kody-engine/tests/smoke/helpers.js"

describe("debug", () => {
  it("debug smoke action", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-cli-smoke-"))
    fs.mkdirSync(path.join(root, ".kody", "capabilities"), { recursive: true })
    fs.mkdirSync(path.join(root, ".kody", "executables", "smoke-impl"), { recursive: true })
    fs.mkdirSync(path.join(root, ".kody", "agents"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "", lint: "", format: "", testUnit: "" },
        git: { defaultBranch: "main" },
        github: { owner: "o", repo: "r" },
        agent: { model: "anthropic/test" },
      }),
    )
    fs.mkdirSync(path.join(root, ".kody", "capabilities", "smoke-capability"), { recursive: true })
    fs.writeFileSync(path.join(root, ".kody", "agents", "kody.md"), "# Kody\n")
    fs.writeFileSync(
      path.join(root, ".kody", "capabilities", "smoke-capability", "profile.json"),
      JSON.stringify({
        name: "smoke-capability",
        action: "smoke-action",
        capabilityKind: "act",
        executable: "smoke-impl",
        agent: "kody",
      }),
    )
    fs.writeFileSync(path.join(root, ".kody", "capabilities", "smoke-capability", "capability.md"), "# Smoke\n")
    fs.writeFileSync(
      path.join(root, ".kody", "executables", "smoke-impl", "profile.json"),
      JSON.stringify({
        name: "smoke-impl",
        role: "utility",
        describe: "smoke impl",
        kind: "oneshot",
        inputs: [],
        claudeCode: {
          model: "inherit",
          permissionMode: "default",
          maxTurns: 0,
          maxThinkingTokens: null,
          systemPromptAppend: null,
          tools: [],
          hooks: [],
          skills: [],
          commands: [],
          subagents: [],
          plugins: [],
          mcpServers: [],
        },
        cliTools: [],
        scripts: { preflight: [{ script: "skipAgent" }], postflight: [] },
      }),
    )

    const r = runCli(["smoke-action"], { cwd: root, env: { KODY_COMPANY_STORE: "off" } })
    console.log("STATUS:", r.status)
    console.log("STDOUT:", r.stdout)
    console.log("STDERR:", r.stderr)
    expect(r.status).toBe(0)
  })
})
