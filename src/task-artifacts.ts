/**
 * Per-task artifacts: at the end of every task (issue/agent mode and
 * chat mode alike), the agent that ran the task writes four local temp files.
 * The engine then copies them into the configured Kody state repo at
 * `tasks/<taskId>/`. These are knowledge attached to the task itself —
 * separate from the long-lived memory under `memory/`.
 *
 *   1. context.json      — task header (id, type, target, outcome,
 *                          filesTouched, sessionLog, timestamps)
 *   2. memory-recs.json  — array of sticky-note candidates worth
 *                          promoting to long-term memory (LLM judgment)
 *   3. followups.json    — array of TODOs this task uncovered but did
 *                          not fix
 *   4. handoff-notes.md  — short prose for the next person/agent
 *
 * The agent itself produces all four as its final act, so no extra LLM
 * call is required. The engine just:
 *   (a) ensures the directory exists before the agent runs,
 *   (b) appends the artifact contract to the system prompt,
 *   (c) verifies the files exist after the agent finishes (best-effort,
 *       missing files log a warning but do not fail the task).
 */

import fs from "node:fs"
import path from "node:path"
import posixPath from "node:path/posix"
import { runtimeStatePath } from "./runtimePaths.js"
import { createStateBackendFromEnv } from "./state-backend.js"
import { type StateRepoConfig, upsertStateText } from "./stateRepo.js"

export const TASK_ARTIFACT_FILES = ["context.json", "memory-recs.json", "followups.json", "handoff-notes.md"] as const

export type TaskArtifactFile = (typeof TASK_ARTIFACT_FILES)[number]

export interface TaskArtifactPaths {
  taskId: string
  /** Canonical backend address, e.g. issues/42 or sessions/abc. */
  taskKey?: string
  absDir: string
  relDir: string
}

/**
 * Resolve and create the task artifacts directory. Returns both the absolute
 * path (for filesystem ops) and the path shown to the agent in the prompt.
 * The directory is runtime scratch outside the consumer repo; runAgent grants
 * it explicitly through additionalDirectories.
 */
export function prepareTaskArtifactsDir(cwd: string, taskId: string | number): TaskArtifactPaths {
  const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, "_")
  const absDir = runtimeStatePath(cwd, "task-artifacts", safeId)
  const relDir = absDir
  fs.mkdirSync(absDir, { recursive: true })
  return { taskId: safeId, absDir, relDir }
}

/**
 * Returns missing artifact filenames (relative to the task dir).
 * Empty array means the agent produced all four.
 */
export function verifyTaskArtifacts(absDir: string): TaskArtifactFile[] {
  const missing: TaskArtifactFile[] = []
  for (const name of TASK_ARTIFACT_FILES) {
    const full = path.join(absDir, name)
    try {
      const stat = fs.statSync(full)
      if (!stat.isFile() || stat.size === 0) missing.push(name)
    } catch {
      missing.push(name)
    }
  }
  return missing
}

export function taskArtifactStatePath(taskId: string, file: TaskArtifactFile): string {
  return posixPath.join("tasks", taskId, file)
}

export async function persistTaskArtifactsToState(
  config: StateRepoConfig,
  cwd: string,
  artifacts: TaskArtifactPaths,
): Promise<void> {
  const tenantId = config.github?.owner && config.github.repo
    ? `${config.github.owner}/${config.github.repo}`
    : process.env.GITHUB_REPOSITORY?.trim()
  if (process.env.GITHUB_ACTIONS === "true" && (!process.env.CONVEX_URL || !process.env.KODY_SERVICE_KEY || !tenantId)) {
    throw new Error("Convex artifact backend is required in GitHub Actions (CONVEX_URL, KODY_SERVICE_KEY, and repository identity)")
  }
  if (process.env.CONVEX_URL && process.env.KODY_SERVICE_KEY && tenantId) {
    const backend = createStateBackendFromEnv()
    for (const file of TASK_ARTIFACT_FILES) {
      const full = path.join(artifacts.absDir, file)
      if (!fs.existsSync(full)) continue
      const stat = fs.statSync(full)
      if (!stat.isFile() || stat.size === 0) continue
      const content = fs.readFileSync(full, "utf-8")
      const kind = file.replace(/\.(json|md)$/, "")
      let doc: unknown = content
      if (file.endsWith(".json")) {
        try {
          doc = JSON.parse(content)
        } catch (err) {
          throw new Error(`task artifact ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      await backend.save(tenantId, artifacts.taskKey ?? artifacts.taskId, kind, doc)
    }
    return
  }

  for (const file of TASK_ARTIFACT_FILES) {
    const full = path.join(artifacts.absDir, file)
    if (!fs.existsSync(full)) continue
    const stat = fs.statSync(full)
    if (!stat.isFile() || stat.size === 0) continue
    const content = fs.readFileSync(full, "utf-8")
    upsertStateText(
      config,
      cwd,
      taskArtifactStatePath(artifacts.taskId, file),
      content,
      `task artifacts: ${artifacts.taskId}`,
    )
  }
}

/**
 * The prose contract the agent reads as part of its system prompt.
 * Kept terse: the agent is already context-saturated; it does not need
 * a tutorial here, only the schema and the rule that all four files
 * are required.
 */
export function taskArtifactsPromptAddendum(opts: {
  taskId: string
  taskType: "issue" | "pr" | "chat" | "job" | "goal"
  relDir: string
}): string {
  return [
    "## Per-task artifacts (REQUIRED before your final response)",
    "",
    `Before you finish, write these four local temp files into \`${opts.relDir}/\`:`,
    "",
    `1. **context.json** — task header. Shape:`,
    "   ```json",
    "   {",
    `     "taskId": "${opts.taskId}",`,
    `     "taskType": "${opts.taskType}",`,
    `     "target": "<issue/PR number, session id, or job slug>",`,
    `     "outcome": "success" | "failure" | "partial",`,
    `     "exitCode": <number>,`,
    `     "reason": "<one-line summary of why you exited>",`,
    `     "prUrl": "<url or null>",`,
    `     "runUrl": "<url or null>",`,
    `     "filesTouched": ["path/from/repo/root.ts", ...],`,
    `     "sessionLog": "sessions/<id>.jsonl",`,
    `     "startedAt": "<ISO>",`,
    `     "finishedAt": "<ISO>"`,
    "   }",
    "   ```",
    "",
    `2. **memory-recs.json** — array of sticky-note candidates worth promoting`,
    `   to long-term state-repo \`memory/\`. Each item:`,
    "   ```json",
    "   {",
    `     "type": "preference" | "decision" | "lesson",`,
    `     "name": "kebab-case-slug",`,
    `     "hook": "one-line summary for INDEX.md",`,
    `     "body": "markdown body — explain the rule plus a Why: line",`,
    `     "why": "the load-bearing reason a future session needs this",`,
    `     "confidence": 0.0 to 1.0`,
    "   }",
    "   ```",
    `   Use \`[]\` if nothing in this task is worth remembering. Forced`,
    `   filler is worse than nothing — only record what would be lost`,
    `   otherwise.`,
    "",
    `3. **followups.json** — array of TODOs uncovered but not fixed.`,
    "   ```json",
    "   {",
    `     "title": "short summary",`,
    `     "body": "what the operator should do, and where",`,
    `     "rationale": "why this matters",`,
    `     "priority": "low" | "medium" | "high"`,
    "   }",
    "   ```",
    `   Use \`[]\` if nothing surfaced.`,
    "",
    `4. **handoff-notes.md** — short prose (≤200 words), no frontmatter:`,
    `   what you did and why, so the next person/agent can pick up cold.`,
    "",
    "Skipping any of the four files is an error. Empty arrays are fine;",
    "skipping the file is not.",
  ].join("\n")
}
