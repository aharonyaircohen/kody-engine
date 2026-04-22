/**
 * End-to-end verification: does `maxThinkingTokens` in a profile.json actually
 * change the thinking depth when invoked via the kody2 CLI? Exercises the full
 * path: parseArgs → loadProfile → parseClaudeCode → executor → runAgent → SDK.
 *
 * For each budget, we create a temporary profile under src/executables/, run
 * `pnpm kody2 <name>` against a temp project dir, parse the NDJSON, and delete
 * the profile. No commits, no persistent fixtures.
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..")
const EXECUTABLES_ROOT = path.join(REPO_ROOT, "src", "executables")

const REASONING_PROMPT = [
  "Find the unique 10-digit number N (using each of the digits 0, 1, 2, 3, 4, 5,",
  "6, 7, 8, 9 exactly once) such that for every k from 1 to 10, the number",
  "formed by the first k digits of N is divisible by k.",
  "",
  "Work it out from scratch by case analysis — do NOT just state a memorized",
  "answer. Show your reasoning implicitly (via extended thinking), then reply",
  "with EXACTLY one line in this format: N = <the-10-digit-number>",
].join("\n")

interface RunResult {
  budget: number
  exitCode: number
  thinkingBlocks: number
  thinkingChars: number
  outputTokens: number
  durationMs: number
  costUsd: number
  finalText: string
}

function makeProfile(budget: number): string {
  const dirName = `verify-think-${budget}`
  const dir = path.join(EXECUTABLES_ROOT, dirName)
  fs.mkdirSync(dir, { recursive: true })

  const profile = {
    name: dirName,
    describe: `verification profile (maxThinkingTokens=${budget})`,
    inputs: [],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: 1,
      maxThinkingTokens: budget,
      systemPromptAppend: null,
      tools: ["Read"],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: {
      preflight: [{ script: "composePrompt" }],
      postflight: [],
    },
  }

  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2))
  fs.writeFileSync(path.join(dir, "prompt.md"), REASONING_PROMPT)
  return dirName
}

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody2-verify-think-"))
  const config = {
    quality: { typecheck: "", lint: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "verify", repo: "verify" },
    agent: { model: "claude/claude-sonnet-4-6" },
  }
  fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify(config, null, 2))
  return dir
}

function parseUsage(ndjsonPath: string): Omit<RunResult, "budget" | "exitCode"> {
  const lines = fs.readFileSync(ndjsonPath, "utf-8").trim().split("\n")
  let blocks = 0
  let chars = 0
  let outputTokens = 0
  let durationMs = 0
  let costUsd = 0
  let finalText = ""
  for (const line of lines) {
    if (!line) continue
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const m = msg as {
      message?: { content?: Array<{ type: string; thinking?: string; text?: string }> }
      type?: string
      subtype?: string
      result?: string
      usage?: { output_tokens?: number }
      total_cost_usd?: number
      duration_ms?: number
    }
    const content = m.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "thinking" && typeof block.thinking === "string") {
          blocks += 1
          chars += block.thinking.length
        }
      }
    }
    if (m.type === "result") {
      if (typeof m.result === "string") finalText = m.result
      if (typeof m.usage?.output_tokens === "number") outputTokens = m.usage.output_tokens
      if (typeof m.total_cost_usd === "number") costUsd = m.total_cost_usd
      if (typeof m.duration_ms === "number") durationMs = m.duration_ms
    }
  }
  return { thinkingBlocks: blocks, thinkingChars: chars, outputTokens, durationMs, costUsd, finalText }
}

function runOne(budget: number): RunResult {
  const profileName = makeProfile(budget)
  const projectDir = makeProjectDir()
  try {
    process.stderr.write(`[${budget}] invoking: pnpm kody2 ${profileName} --cwd ${projectDir}\n`)
    const res = spawnSync(
      "pnpm",
      ["kody2", profileName, "--cwd", projectDir, "--quiet"],
      { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"], encoding: "utf-8" },
    )
    const ndjsonPath = path.join(projectDir, ".kody2", "last-run.jsonl")
    if (!fs.existsSync(ndjsonPath)) {
      throw new Error(`no NDJSON at ${ndjsonPath} (exit=${res.status})`)
    }
    const usage = parseUsage(ndjsonPath)
    return { budget, exitCode: res.status ?? -1, ...usage }
  } finally {
    fs.rmSync(path.join(EXECUTABLES_ROOT, profileName), { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

async function main() {
  const budgets = [1024, 32000]
  const rows: RunResult[] = []
  for (const b of budgets) {
    rows.push(runOne(b))
  }
  console.log("\n=== results (via kody2 CLI) ===")
  console.log("budget\texit\tblocks\tth-chars\tout-tok\tms\tcost")
  for (const r of rows) {
    console.log(
      `${r.budget}\t${r.exitCode}\t${r.thinkingBlocks}\t${r.thinkingChars}\t${r.outputTokens}\t${r.durationMs}\t$${r.costUsd.toFixed(4)}`,
    )
  }
  for (const r of rows) {
    console.log(`\nbudget=${r.budget} final: ${r.finalText.trim().split("\n")[0]}`)
  }
  const [lo, hi] = rows
  if (lo && hi && lo.thinkingChars > 0) {
    console.log(`\nratio(hi/lo) thinking chars = ${(hi.thinkingChars / lo.thinkingChars).toFixed(2)}x`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
