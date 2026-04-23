/**
 * Live harness for `ui-review`.
 *
 * Bypasses reviewFlow (which needs a real GitHub PR) and postReviewResult
 * (which posts a comment). Everything else — discovery, qa-guide loading,
 * preview-URL resolution, prompt composition, and the actual agent/Playwright
 * invocation — runs for real against a local static preview.
 *
 * Usage:
 *   npx tsx scripts/ui-review-live-harness.ts <repo-root> <preview-url> <diff-file>
 *
 * Prints the agent's final review text to stdout.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { runAgent } from "../src/agent.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
import { loadConfig, parseProviderModel } from "../src/config.js"
import type { Context } from "../src/executables/types.js"
import { startLitellmIfNeeded } from "../src/litellm.js"
import { loadProfile } from "../src/profile.js"
import { composePrompt } from "../src/scripts/composePrompt.js"
import { discoverQaContext } from "../src/scripts/discoverQaContext.js"
import { loadQaGuide } from "../src/scripts/loadQaGuide.js"
import { resolvePreviewUrl } from "../src/scripts/resolvePreviewUrl.js"

async function main(): Promise<void> {
  const [, , repoArg, previewUrlArg, diffFileArg] = process.argv
  if (!repoArg || !previewUrlArg || !diffFileArg) {
    console.error("Usage: ui-review-live-harness.ts <repo-root> <preview-url> <diff-file>")
    process.exit(64)
  }

  const repoRoot = path.resolve(repoArg)
  const diff = fs.readFileSync(path.resolve(diffFileArg), "utf-8")

  const profilePath = path.resolve(HERE, "..", "src", "executables", "ui-review", "profile.json")
  const profile = loadProfile(profilePath)
  const config = loadConfig(repoRoot)

  const ctx: Context = {
    args: { pr: 0, previewUrl: previewUrlArg },
    cwd: repoRoot,
    config,
    data: {
      // Stand in for what reviewFlow would populate
      pr: {
        number: 0,
        title: "Add welcome banner to home + discussion count on lesson cards",
        baseRefName: "main",
        headRefName: "feat/welcome-banner",
        body: "Adds a banner on /, and a discussion-count pill on each lesson card at /lessons.",
      },
      prDiff: diff,
      branch: "feat/welcome-banner",
      commentTargetType: "pr",
      commentTargetNumber: 0,
    },
    output: { exitCode: 0 },
  }

  console.error("[harness] running preflight scripts…")
  await discoverQaContext(ctx, profile)
  await loadQaGuide(ctx, profile)
  await resolvePreviewUrl(ctx, profile)
  await composePrompt(ctx, profile)

  const promptPath = path.join(repoRoot, "composed-prompt.md")
  fs.writeFileSync(promptPath, ctx.data.prompt as string)
  console.error(`[harness] composed prompt → ${promptPath} (${(ctx.data.prompt as string).length} chars)`)

  const model = parseProviderModel(config.agent.model)
  console.error(`[harness] model = ${model.provider}/${model.model}`)

  const litellm = await startLitellmIfNeeded(model, repoRoot)
  try {
    console.error("[harness] invoking agent (this may take several minutes)…")
    const result = await runAgent({
      prompt: ctx.data.prompt as string,
      model,
      cwd: repoRoot,
      litellmUrl: litellm?.url ?? null,
      verbose: true,
      quiet: false,
      ndjsonDir: path.join(repoRoot, ".kody2"),
      allowedToolsOverride: profile.claudeCode.tools,
      permissionModeOverride: profile.claudeCode.permissionMode,
      mcpServers: profile.claudeCode.mcpServers as unknown as Array<Record<string, unknown>> | undefined,
      maxTurns: profile.claudeCode.maxTurns,
      maxThinkingTokens: profile.claudeCode.maxThinkingTokens,
      systemPromptAppend: profile.claudeCode.systemPromptAppend,
    })

    console.error(`\n[harness] agent outcome = ${result.outcome}`)
    console.log("\n===== AGENT FINAL TEXT =====\n")
    console.log(result.finalText)
    console.log("\n===== END =====\n")
    fs.writeFileSync(path.join(repoRoot, "agent-output.md"), result.finalText)
  } finally {
    try {
      litellm?.kill()
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error("[harness] crashed:", err)
  process.exit(1)
})
