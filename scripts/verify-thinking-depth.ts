import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { runAgent } from "../src/agent.js"

const PROMPT = [
  "Think carefully step by step, then answer.",
  "",
  "Problem: Five houses in a row are painted five different colors (red, green,",
  "blue, yellow, white). Each has a resident of a different nationality,",
  "drinks a different beverage, smokes a different cigar, and keeps a different",
  "pet. Given these clues, determine who owns the zebra:",
  "1. The Brit lives in the red house.",
  "2. The Swede keeps dogs.",
  "3. The Dane drinks tea.",
  "4. The green house is immediately left of the white house.",
  "5. The green house's owner drinks coffee.",
  "6. The Pall Mall smoker keeps birds.",
  "7. The yellow house's owner smokes Dunhill.",
  "8. The middle house's owner drinks milk.",
  "9. The Norwegian lives in the first house.",
  "10. The Blend smoker lives next to the cat owner.",
  "11. The horse owner lives next to the Dunhill smoker.",
  "12. The Blue Master smoker drinks beer.",
  "13. The German smokes Prince.",
  "14. The Norwegian lives next to the blue house.",
  "15. The Blend smoker has a neighbor who drinks water.",
  "",
  "Answer with just one line: NATIONALITY owns the zebra.",
].join("\n")

interface ThinkingBlock {
  type: "thinking"
  thinking?: string
}

interface ContentBlock {
  type: string
  thinking?: string
  text?: string
}

function countThinking(ndjsonPath: string): { blocks: number; chars: number; sample: string } {
  const lines = fs.readFileSync(ndjsonPath, "utf-8").trim().split("\n")
  let blocks = 0
  let chars = 0
  let sample = ""
  for (const line of lines) {
    if (!line) continue
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const m = msg as { message?: { content?: ContentBlock[] } }
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        blocks += 1
        chars += block.thinking.length
        if (!sample) sample = block.thinking.slice(0, 180)
      }
    }
  }
  return { blocks, chars, sample }
}

async function runOne(budget: number): Promise<{ blocks: number; chars: number; sample: string; finalText: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kody-thinking-${budget}-`))
  const result = await runAgent({
    prompt: PROMPT,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    cwd: tmp,
    ndjsonDir: tmp,
    quiet: true,
    maxTurns: 1,
    maxThinkingTokens: budget,
    allowedToolsOverride: [],
    permissionModeOverride: "default",
    settingSources: [],
  })
  const counts = countThinking(result.ndjsonPath)
  return { ...counts, finalText: result.finalText.slice(0, 120) }
}

async function main() {
  const budgets = [1024, 16000]
  const rows: Array<{ budget: number; blocks: number; chars: number; finalText: string }> = []
  for (const b of budgets) {
    process.stderr.write(`running with maxThinkingTokens=${b}...\n`)
    const r = await runOne(b)
    rows.push({ budget: b, blocks: r.blocks, chars: r.chars, finalText: r.finalText })
    process.stderr.write(`  blocks=${r.blocks} chars=${r.chars}\n`)
    if (r.sample) process.stderr.write(`  sample: ${r.sample.replace(/\n/g, " ")}...\n`)
  }
  console.log("\n=== results ===")
  console.log("budget\tblocks\tchars\tfinal")
  for (const r of rows) {
    console.log(`${r.budget}\t${r.blocks}\t${r.chars}\t${r.finalText.replace(/\n/g, " ")}`)
  }
  const [lo, hi] = rows
  if (lo && hi && lo.chars > 0) {
    const ratio = hi.chars / lo.chars
    console.log(`\nratio(hi/lo) = ${ratio.toFixed(2)}x`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
