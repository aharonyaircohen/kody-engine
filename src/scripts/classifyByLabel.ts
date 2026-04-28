/**
 * Preflight (classify-only): label-first fast path for issue classification.
 * If the issue has a GitHub label matching one in `config.classify.labelMap`,
 * record the resulting classification and tell the executor to skip the
 * agent entirely. The postflight `recordClassification` finalizes the
 * action + audit comment, and `dispatchClassified` (last) posts the
 * `@kody <type>` comment using `ctx.data.classification`.
 *
 * When no label matches, this script is a no-op — control falls through to
 * the agent, which picks a classification from the prompt rubric.
 *
 * Config shape (kody.config.json):
 *
 *   "classify": {
 *     "labelMap": {
 *       "bug": "bug",
 *       "enhancement": "bug",
 *       "refactor": "feature",
 *       "rfc": "spec",
 *       "design": "spec",
 *       "docs": "chore"
 *     }
 *   }
 */

import type { PreflightScript } from "../executables/types.js"
import type { IssueData } from "../issue.js"

const VALID_CLASSES = new Set(["feature", "bug", "spec", "chore"])

export const classifyByLabel: PreflightScript = async (ctx) => {
  const issue = ctx.data.issue as (IssueData & { labelsFormatted?: string }) | undefined
  const labels = issue?.labels
  if (!labels || labels.length === 0) return

  const cfgMap = (ctx.config as unknown as { classify?: { labelMap?: Record<string, string> } }).classify?.labelMap
  const map = cfgMap ?? defaultLabelMap()

  for (const label of labels) {
    const candidate = map[label.toLowerCase()]
    if (candidate && VALID_CLASSES.has(candidate)) {
      ctx.data.classification = candidate
      ctx.data.classificationSource = "label"
      ctx.data.classificationReason = `label \`${label}\` → ${candidate}`
      ctx.skipAgent = true
      return
    }
  }
}

export function defaultLabelMap(): Record<string, string> {
  return {
    bug: "bug",
    enhancement: "bug",
    refactor: "feature",
    feature: "feature",
    performance: "feature",
    rfc: "spec",
    design: "spec",
    spec: "spec",
    docs: "chore",
    chore: "chore",
    dependencies: "chore",
  }
}
