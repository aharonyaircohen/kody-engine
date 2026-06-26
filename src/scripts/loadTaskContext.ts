/**
 * Preflight: assemble whatever context the prior loaders populated into a
 * typed TaskContext object on ctx.data.taskContext, and persist a snapshot
 * to runtime scratch storage.
 *
 * Composition contract: this script ALWAYS runs after the existing
 * loaders (loadIssueContext, loadConventions, loadPriorArt,
 * loadMemoryContext, loadCoverageRules). It does not call them itself —
 * it just collects whatever is already on ctx.data into a typed shape.
 *
 * Missing loaders are tolerated: each field falls back to a safe empty
 * default. A profile that wants the context object but not (say) prior
 * art simply omits loadPriorArt from its preflight; the resulting
 * TaskContext just has `priorArt: ""`.
 */

import type { PreflightScript } from "../executables/types.js"
import type { TestRequirement } from "../config.js"
import { resolveRunId } from "../events.js"
import type { IssueData } from "../issue.js"
import type { LoadedConvention } from "../prompt.js"
import { buildTaskContext, persistTaskContext, type TaskContext } from "../taskContext.js"

type IssueDataWithFormatting = IssueData & {
  commentsFormatted?: string
  labelsFormatted?: string
}

export const loadTaskContext: PreflightScript = async (ctx) => {
  const runId = resolveRunId()
  const rawIssue = ctx.data.issue as IssueDataWithFormatting | undefined
  const issue: TaskContext["issue"] = rawIssue
    ? {
        ...rawIssue,
        commentsFormatted: rawIssue.commentsFormatted ?? "",
        labelsFormatted: rawIssue.labelsFormatted ?? "",
      }
    : undefined

  const taskContext = buildTaskContext({
    runId,
    issue,
    conventions: ctx.data.conventions as LoadedConvention[] | undefined,
    priorArt: typeof ctx.data.priorArt === "string" ? (ctx.data.priorArt as string) : "",
    memoryContext: typeof ctx.data.memoryContext === "string" ? (ctx.data.memoryContext as string) : "",
    coverageRules: ctx.data.coverageRules as TestRequirement[] | undefined,
  })

  ctx.data.taskContext = taskContext
  const persistedPath = persistTaskContext(ctx.cwd, taskContext)
  if (persistedPath && ctx.verbose) {
    process.stderr.write(`[kody taskContext] persisted ${persistedPath}\n`)
  }
}
