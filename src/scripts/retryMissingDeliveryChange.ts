import type { AgentResult } from "../agent.js"
import { isForbiddenPath, listChangedFiles } from "../commit.js"
import type { PostflightScript } from "../implementations/types.js"
import { parseAgentResult } from "./parseAgentResult.js"
import { parseSimpleCapabilityOutput } from "./parseSimpleCapabilityOutput.js"

type Invoker = (prompt: string) => Promise<AgentResult>

export const retryMissingDeliveryChange: PostflightScript = async (ctx, profile) => {
  if (ctx.data.jobDelivery !== "pull-request") return
  if (!claimsChange(ctx.data.capabilityOutput)) return
  if (listChangedFiles(ctx.cwd).some((file) => !isForbiddenPath(file))) return

  const invoker = ctx.data.__invokeAgent as Invoker | undefined
  const prompt = ctx.data.prompt as string | undefined
  if (!invoker || !prompt) return

  process.stderr.write("[kody] capability claimed a pull-request fix without a file change; retrying once\n")
  const retry = await invoker(
    [
      prompt,
      "",
      "# Missing delivery change (retry)",
      "",
      "Your previous result claimed the pull request was fixed, but no repository file changed.",
      "Inspect the supplied input and failure evidence, make the actual repair, and verify it.",
      "If no safe change is possible, return a blocked result instead of claiming fixed.",
      "This is the only retry.",
    ].join("\n"),
  )

  await parseAgentResult(ctx, profile, retry)
  await parseSimpleCapabilityOutput(ctx, profile, retry)
}

function claimsChange(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false
  const status = (output as { status?: unknown }).status
  return status === "fixed" || status === "changed"
}
