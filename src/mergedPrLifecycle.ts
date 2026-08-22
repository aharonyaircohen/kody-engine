import * as fs from "node:fs"
import { type KodyLabelSpec, setKodyLabel } from "./lifecycleLabels.js"

const DONE: KodyLabelSpec = {
  label: "kody:done",
  color: "0e8a16",
  description: "kody: work complete",
}

type LabelWriter = (target: number, spec: KodyLabelSpec, cwd: string) => void

export interface MergedPrTargets {
  pr: number
  issues: number[]
}

export function mergedKodyPullRequestTargets(event: unknown): MergedPrTargets | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null
  const root = event as Record<string, unknown>
  if (root.action !== "closed") return null
  const pr = root.pull_request
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) return null
  const record = pr as Record<string, unknown>
  if (record.merged !== true) return null

  const labels = Array.isArray(record.labels) ? record.labels : []
  const hasKodyLifecycleLabel = labels.some((label) => {
    if (!label || typeof label !== "object" || Array.isArray(label)) return false
    const name = (label as Record<string, unknown>).name
    return typeof name === "string" && name.startsWith("kody:")
  })
  if (!hasKodyLifecycleLabel) return null

  const prNumber = Number(record.number ?? root.number ?? 0)
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null
  const body = typeof record.body === "string" ? record.body : ""
  const issues = new Set<number>()
  const closingReference = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi
  for (const match of body.matchAll(closingReference)) {
    const issue = Number(match[1])
    if (Number.isInteger(issue) && issue > 0 && issue !== prNumber) issues.add(issue)
  }
  return { pr: prNumber, issues: [...issues] }
}

export function finalizeMergedPullRequestEvent(
  event: unknown,
  cwd: string,
  writeLabel: LabelWriter = setKodyLabel,
): MergedPrTargets | null {
  const targets = mergedKodyPullRequestTargets(event)
  if (!targets) return null
  writeLabel(targets.pr, DONE, cwd)
  for (const issue of targets.issues) writeLabel(issue, DONE, cwd)
  return targets
}

export function readGitHubEvent(env: NodeJS.ProcessEnv = process.env): unknown {
  const eventPath = env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return null
  return JSON.parse(fs.readFileSync(eventPath, "utf-8"))
}
