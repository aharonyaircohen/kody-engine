import type { PostflightScript } from "../implementations/types.js"
import { createStateBackendFromEnv } from "../state-backend.js"

export const saveLiveAgentState: PostflightScript = async (ctx, _profile, agentResult) => {
  const agent = String(ctx.data.liveAgentSlug ?? "")
  const previousRevision = Number(ctx.data.liveAgentPreviousRevision ?? 0)
  const next = ctx.data.nextJobState as { cursor?: unknown; data?: unknown } | undefined
  if (!agent || !next || typeof next.cursor !== "string" || !next.cursor) {
    throw new Error(String(ctx.data.nextStateParseError ?? "Live Agent did not submit valid continuation state"))
  }
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY ?? "").split("/")
  const owner = ctx.config.github?.owner?.trim() || envOwner
  const repo = ctx.config.github?.repo?.trim() || envRepo
  if (!owner || !repo) throw new Error("Repository identity is required for live Agent state")
  const summary = (agentResult?.finalText ?? "").trim().slice(0, 1000)
  const output = {
    cursor: next.cursor,
    data: next.data && typeof next.data === "object" ? next.data : {},
  }
  await createStateBackendFromEnv().saveAgentState(
    `${owner}/${repo}`,
    {
      version: 1,
      agent,
      revision: previousRevision + 1,
      cursor: output.cursor,
      summary,
      data: output.data,
      updatedAt: new Date().toISOString(),
    },
    previousRevision,
  )
  ctx.data.capabilityOutput = output
}
