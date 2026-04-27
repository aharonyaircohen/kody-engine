import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { getPluginsCatalogRoot } from "../../src/scripts/buildSyntheticPlugin.js"

interface InlineHook {
  matcher: string
  command: string
}

function loadHook(name: string): InlineHook {
  const file = path.join(getPluginsCatalogRoot(), "hooks", `${name}.json`)
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    hooks?: { PreToolUse?: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
  }
  const entry = raw.hooks?.PreToolUse?.[0]
  if (!entry) throw new Error(`hook ${name} has no PreToolUse entry`)
  const cmd = entry.hooks[0]?.command
  if (!cmd) throw new Error(`hook ${name} PreToolUse entry has no command`)
  return { matcher: entry.matcher, command: cmd }
}

function runCommand(command: string, stdin: string): { code: number | null; stderr: string } {
  const r = spawnSync("sh", ["-c", command], { input: stdin, encoding: "utf-8" })
  return { code: r.status, stderr: r.stderr }
}

describe("hooks: block-git PreToolUse command", () => {
  const hook = loadHook("block-git")

  it("targets the Bash tool", () => {
    expect(hook.matcher).toBe("Bash")
  })

  it.each([
    ["git status", true],
    ["git", true],
    ["  git status", true],
    ["gh pr list", true],
    ["cd foo && git diff", true],
    ["pnpm test || git push", true],
    ["echo hello", false],
    ["pnpm run something-with-git-in-name", false],
    ["grep -r 'git' .", false],
    ["node -e 'console.log(1)'", false],
    ["", false],
  ])("blocks %s = %s", (cmd, shouldBlock) => {
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } })
    const { code } = runCommand(hook.command, stdin)
    if (shouldBlock) {
      expect(code).toBe(2)
    } else {
      expect(code).toBe(0)
    }
  })

  it("emits a message to stderr when blocking", () => {
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" } })
    const { code, stderr } = runCommand(hook.command, stdin)
    expect(code).toBe(2)
    expect(stderr).toContain("kody blocks git/gh")
  })

  it("does not block on malformed JSON input (fails open, exit 0)", () => {
    const { code } = runCommand(hook.command, "not-json")
    expect(code).toBe(0)
  })

  it("does not block on missing tool_input", () => {
    const stdin = JSON.stringify({ tool_name: "Bash" })
    const { code } = runCommand(hook.command, stdin)
    expect(code).toBe(0)
  })
})

describe("hooks: block-write PreToolUse command", () => {
  const hook = loadHook("block-write")

  it("targets Write/Edit/NotebookEdit", () => {
    expect(hook.matcher).toBe("Write|Edit|NotebookEdit")
  })

  it("always exits 2 when invoked", () => {
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x", content: "hi" },
    })
    const { code, stderr } = runCommand(hook.command, stdin)
    expect(code).toBe(2)
    expect(stderr).toContain("kody read-only mode")
  })

  it("exits 2 even with no stdin (matcher already filtered the call)", () => {
    const { code } = runCommand(hook.command, "")
    expect(code).toBe(2)
  })
})
