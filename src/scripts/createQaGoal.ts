/**
 * Postflight for the `qa-engineer` executable. Turns the agent's QA report
 * into a kody goal whose tasks are real, severity-labelled bug tickets:
 *
 *   1. Parse the agent's final message — markdown report on top + a
 *      machine-readable `<!-- KODY_QA_REPORT_JSON ... -->` block at the
 *      bottom carrying the structured findings list.
 *   2. Slugify scope + date → goal id (e.g. `qa-admin-chat-memory-recall-2026-05-08`).
 *      Disambiguate against existing goals.
 *   3. Append the new goal to the `kody:goals-manifest` issue's embedded
 *      JSON (creating the manifest issue if absent). The dashboard reads
 *      this to render the goal in its UI.
 *   4. Write `.kody/goals/instances/<id>/state.json` (`state: "active"`) and
 *      commit + push it on the current branch — that's how the engine
 *      knows to tick the goal.
 *   5. Open N task issues — one per finding — each labelled
 *      `goal:<id>`, `severity:P{n}`, `kody:qa-finding`. The issue body
 *      is rendered from the structured fields.
 *
 * The agent's markdown above the JSON block (verdict / summary /
 * what-browsed / gaps / bottom line) becomes the goal's `description`,
 * so the dashboard shows the report context as the goal panel.
 *
 * Exit codes:
 *   PASS / CONCERNS  → 0
 *   FAIL             → 1
 *   missing report / parse failure / gh failure → 1+
 */
import type { AgentResult } from "../agent.js"
import type { PostflightScript } from "../executables/types.js"
import type { ManagedGoal } from "../goal/manager.js"
import { type GoalState, nowIso } from "../goal/state.js"
import { putGoalState } from "../goal/stateStore.js"
import { gh, postIssueComment, truncate } from "../issue.js"
import type { Action } from "../state.js"
import { detectVerdict, type ReviewVerdict } from "./postReviewResult.js"

const MANIFEST_LABEL = "kody:goals-manifest"
const MANIFEST_TITLE = "Kody Goals Manifest"
const MANIFEST_START = "<!-- kody-goals-start -->"
const MANIFEST_END = "<!-- kody-goals-end -->"
const FINDING_LABEL = "kody:qa-finding"
const REPORT_JSON_OPEN = "<!-- KODY_QA_REPORT_JSON"
const REPORT_JSON_CLOSE = "-->"

interface ParsedFinding {
  severity: "P0" | "P1" | "P2" | "P3"
  title: string
  route?: string
  steps: string
  expected: string
  actual: string
  evidence?: string
}

interface ReportJson {
  findings: ParsedFinding[]
}

interface ManifestGoal {
  id: string
  name: string
  description?: string
  dueDate?: string
  createdAt: string
  updatedAt?: string
}

interface ManifestBody {
  version: 1
  goals: ManifestGoal[]
}

function qaAction(verdict: ReviewVerdict, payload: Record<string, unknown>): Action {
  const type =
    verdict === "PASS"
      ? "QA_PASS"
      : verdict === "CONCERNS"
        ? "QA_CONCERNS"
        : verdict === "FAIL"
          ? "QA_FAIL"
          : "QA_COMPLETED"
  return { type, payload: { verdict, ...payload }, timestamp: new Date().toISOString() }
}

function failedAction(reason: string): Action {
  return { type: "QA_FAILED", payload: { reason }, timestamp: new Date().toISOString() }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function buildGoalId(scope: string | undefined, existing: Set<string>): string {
  const focus = slugify(scope?.trim() ? scope.trim() : "smoke") || "smoke"
  const base = `qa-${focus}-${todayIso()}`
  if (!existing.has(base)) return base
  let i = 2
  while (existing.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

function buildGoalName(scope: string | undefined, verdict: ReviewVerdict): string {
  const focus = scope?.trim() ? scope.trim() : "smoke"
  const verdictTag = verdict === "UNKNOWN" ? "REPORT" : verdict
  return `QA: ${focus} — ${verdictTag} — ${todayIso()}`.slice(0, 240)
}

/**
 * Split the agent's final message into the human-readable markdown report
 * and the structured `<!-- KODY_QA_REPORT_JSON ... -->` block. Returns null
 * for the JSON if the block is missing or malformed — caller handles that.
 */
export function splitReport(text: string): { markdown: string; data: ReportJson | null; jsonError?: string } {
  const open = text.indexOf(REPORT_JSON_OPEN)
  if (open < 0) {
    return { markdown: text.trim(), data: null, jsonError: "no JSON block marker" }
  }
  const closeRel = text.slice(open + REPORT_JSON_OPEN.length).indexOf(REPORT_JSON_CLOSE)
  if (closeRel < 0) {
    return { markdown: text.slice(0, open).trim(), data: null, jsonError: "JSON block not terminated" }
  }
  const closeAbs = open + REPORT_JSON_OPEN.length + closeRel
  const rawJson = text.slice(open + REPORT_JSON_OPEN.length, closeAbs).trim()

  // Strip optional ```json fencing inside the comment
  const fenced = rawJson.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const cleanJson = fenced ? fenced[1]!.trim() : rawJson
  let parsed: ReportJson | null = null
  let parseError: string | undefined
  try {
    const obj = JSON.parse(cleanJson) as ReportJson
    if (!obj || !Array.isArray(obj.findings)) {
      parseError = "JSON missing 'findings' array"
    } else {
      parsed = obj
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err)
  }

  const markdown = text.slice(0, open).trim()
  return { markdown, data: parsed, jsonError: parseError }
}

function loadManifest(cwd: string): { number: number | null; manifest: ManifestBody } {
  let issuesJson: string
  try {
    issuesJson = gh(
      ["issue", "list", "--label", MANIFEST_LABEL, "--state", "all", "--limit", "1", "--json", "number,body"],
      { cwd },
    )
  } catch {
    return { number: null, manifest: { version: 1, goals: [] } }
  }

  let arr: Array<{ number: number; body: string }> = []
  try {
    arr = JSON.parse(issuesJson) as Array<{ number: number; body: string }>
  } catch {
    return { number: null, manifest: { version: 1, goals: [] } }
  }

  if (arr.length === 0) return { number: null, manifest: { version: 1, goals: [] } }

  const issue = arr[0]!
  const manifest = parseManifestBody(issue.body)
  return { number: issue.number, manifest }
}

export function parseManifestBody(body: string | undefined | null): ManifestBody {
  if (!body) return { version: 1, goals: [] }
  const start = body.indexOf(MANIFEST_START)
  const end = body.indexOf(MANIFEST_END)
  if (start < 0 || end < 0 || end < start) return { version: 1, goals: [] }
  const inner = body.slice(start + MANIFEST_START.length, end)
  const fenceOpen = inner.indexOf("```")
  const fenceClose = inner.lastIndexOf("```")
  if (fenceOpen < 0 || fenceClose <= fenceOpen) return { version: 1, goals: [] }
  const afterOpen = inner.indexOf("\n", fenceOpen)
  if (afterOpen < 0) return { version: 1, goals: [] }
  const json = inner.slice(afterOpen + 1, fenceClose).trim()
  if (!json) return { version: 1, goals: [] }
  try {
    const parsed = JSON.parse(json) as Partial<ManifestBody>
    if (!parsed || !Array.isArray(parsed.goals)) return { version: 1, goals: [] }
    return { version: 1, goals: parsed.goals as ManifestGoal[] }
  } catch {
    return { version: 1, goals: [] }
  }
}

export function serializeManifestBody(manifest: ManifestBody): string {
  const preamble =
    "> Kody goals manifest — the dashboard reads and writes the JSON block below.\n> Prefer editing via the UI to avoid merge conflicts.\n\n"
  const json = JSON.stringify(manifest, null, 2)
  return `${preamble}${MANIFEST_START}\n\n\`\`\`json\n${json}\n\`\`\`\n\n${MANIFEST_END}\n`
}

function ensureLabel(name: string, color: string, description: string, cwd: string): void {
  try {
    gh(["label", "create", name, "--color", color, "--description", description, "--force"], { cwd })
  } catch {
    /* best effort */
  }
}

function severityLabel(sev: ParsedFinding["severity"]): string {
  return `severity:${sev}`
}

const SEVERITY_COLORS: Record<ParsedFinding["severity"], string> = {
  P0: "b60205",
  P1: "d93f0b",
  P2: "fbca04",
  P3: "0e8a16",
}

function ensureSeverityLabels(findings: ParsedFinding[], cwd: string): void {
  const seen = new Set<ParsedFinding["severity"]>()
  for (const f of findings) {
    if (seen.has(f.severity)) continue
    seen.add(f.severity)
    ensureLabel(severityLabel(f.severity), SEVERITY_COLORS[f.severity], `kody QA finding severity ${f.severity}`, cwd)
  }
}

function buildIssueBody(f: ParsedFinding, goalId: string, parentManifestNumber: number | null): string {
  const lines: string[] = []
  if (f.route) lines.push(`**Route:** \`${f.route}\``)
  lines.push("")
  lines.push("**Steps**")
  lines.push("")
  lines.push(f.steps.trim())
  lines.push("")
  lines.push("**Expected**")
  lines.push("")
  lines.push(f.expected.trim())
  lines.push("")
  lines.push("**Actual**")
  lines.push("")
  lines.push(f.actual.trim())
  lines.push("")
  if (f.evidence?.trim()) {
    lines.push("**Evidence**")
    lines.push("")
    lines.push(f.evidence.trim())
    lines.push("")
  }
  lines.push("---")
  if (parentManifestNumber !== null) {
    lines.push(`Goal: \`${goalId}\` — manifest issue #${parentManifestNumber}`)
  } else {
    lines.push(`Goal: \`${goalId}\``)
  }
  return lines.join("\n")
}

function createOrUpdateManifestIssue(
  number: number | null,
  manifest: ManifestBody,
  cwd: string,
): { number: number; created: boolean } {
  ensureLabel(MANIFEST_LABEL, "8b5cf6", "kody: goals manifest", cwd)
  const body = serializeManifestBody(manifest)

  if (number !== null) {
    gh(["issue", "edit", String(number), "--body-file", "-"], { input: body, cwd })
    return { number, created: false }
  }

  const out = gh(["issue", "create", "--title", MANIFEST_TITLE, "--label", MANIFEST_LABEL, "--body-file", "-"], {
    input: body,
    cwd,
  })
  const url =
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ""
  const m = url.match(/\/issues\/(\d+)\b/)
  if (!m) throw new Error(`gh issue create returned unexpected output: ${out}`)
  return { number: Number(m[1]), created: true }
}

function createTaskIssue(
  finding: ParsedFinding,
  goalId: string,
  manifestNumber: number | null,
  cwd: string,
): { number: number; url: string } {
  const labels = [`goal:${goalId}`, severityLabel(finding.severity), FINDING_LABEL]
  ensureLabel(`goal:${goalId}`, "1d76db", `goal: ${goalId}`, cwd)
  ensureLabel(FINDING_LABEL, "ededed", "kody: QA finding", cwd)

  const title = `[${finding.severity}] ${finding.title}`.slice(0, 240)
  const body = buildIssueBody(finding, goalId, manifestNumber)
  const args = ["issue", "create", "--title", title, "--body-file", "-"]
  for (const l of labels) {
    args.push("--label", l)
  }
  const out = gh(args, { input: body, cwd })
  const url =
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ""
  const m = url.match(/\/issues\/(\d+)\b/)
  if (!m) throw new Error(`gh issue create returned unexpected output: ${out}`)
  return { number: Number(m[1]), url }
}

export function buildQaManagedGoal(
  goalId: string,
  verdict: ReviewVerdict,
  opened: number,
  failed: number,
): ManagedGoal {
  return {
    type: "qa",
    destination: {
      outcome: `QA findings filed for ${goalId}`,
      evidence: ["qaFindingsFiled"],
    },
    duties: ["qa-goal"],
    route: [],
    stage: "filed",
    facts: {
      qaFindingsFiled: true,
      verdict,
      findingsOpened: opened,
      findingsFailed: failed,
    },
    blockers: failed > 0 ? [`${failed} QA finding issue(s) failed to open`] : [],
  }
}

export const createQaGoal: PostflightScript = async (ctx, _profile, agentResult: AgentResult | null) => {
  if (!agentResult || agentResult.outcome !== "completed") {
    const reason = agentResult?.error ?? "agent did not complete"
    process.stderr.write(`[createQaGoal] ${reason}\n`)
    ctx.output.exitCode = 1
    ctx.output.reason = reason
    ctx.data.action = failedAction(reason)
    return
  }

  const finalText = agentResult.finalText.trim()
  if (!finalText) {
    process.stderr.write("[createQaGoal] agent produced no report body\n")
    ctx.output.exitCode = 1
    ctx.output.reason = "empty report body"
    ctx.data.action = failedAction("empty report body")
    return
  }

  const { markdown } = splitReport(finalText)
  const verdict = detectVerdict(markdown)
  const existingIssue = ctx.args.issue as number | undefined

  // ── Advisory mode (duty-driven QA) ──────────────────────────────────────
  // When dispatched at a tracking issue (`--issue <n>`, as qa.md / qa-sweep /
  // approval-gate do), post the FULL report there (markdown + the
  // KODY_QA_REPORT_JSON block) and STOP. We do NOT auto-create the goal +
  // fix-tickets — that would violate "QA never acts on its own". The duty
  // reads this report and surfaces an inbox rec; goal creation is gated behind
  // operator approval via `@kody qa-goal --issue <n>` (see promoteQaGoal).
  if (typeof existingIssue === "number" && existingIssue > 0) {
    try {
      postIssueComment(existingIssue, finalText, ctx.cwd)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.output.exitCode = 4
      ctx.output.reason = `failed to comment on issue #${existingIssue}: ${msg}`
      ctx.data.action = failedAction(ctx.output.reason)
      return
    }
    process.stdout.write(
      `\nQA_REPORT_POSTED=https://github.com/${ctx.config.github.owner}/${ctx.config.github.repo}/issues/${existingIssue} (verdict: ${verdict})\n`,
    )
    ctx.data.action = qaAction(verdict, { issueNumber: existingIssue, mode: "comment" })
    ctx.output.exitCode = verdict === "FAIL" ? 1 : 0
    return
  }

  // ── Standalone mode (no tracking issue) ─────────────────────────────────
  // A direct, operator-initiated `@kody qa-engineer` with no --issue keeps the
  // original auto-goal behavior — the operator explicitly asked for it.
  await promoteReportToGoal(ctx, finalText, ctx.args.scope as string | undefined, ctx.args.goal as string | undefined)
}

/**
 * Turn a QA report (markdown + `<!-- KODY_QA_REPORT_JSON ... -->`) into a kody
 * goal: append to the goals manifest, open one fix-ticket per finding, and
 * write+commit `.kody/goals/instances/<id>/state.json` so goal-scheduler ticks it. This
 * is the operator-gated half of QA — invoked by the standalone qa-engineer
 * path and by the `qa-goal` verb (which approve posts). PASS / no-findings
 * reports open a single record issue instead.
 */
export async function promoteReportToGoal(
  ctx: {
    args: Record<string, unknown>
    cwd: string
    config: { github: { owner: string; repo: string } }
    data: Record<string, unknown>
    output: { exitCode: number; reason?: string }
  },
  finalText: string,
  scopeArg?: string,
  explicitGoalArg?: string,
): Promise<void> {
  const { markdown, data, jsonError } = splitReport(finalText)
  const verdict = detectVerdict(markdown)
  const findings = data?.findings ?? []

  if (findings.length === 0 || jsonError) {
    if (jsonError) {
      process.stderr.write(`[promoteReportToGoal] JSON parse: ${jsonError} — falling back to single-issue mode\n`)
    }
    // Open a record-only issue with the markdown body.
    ensureLabel(FINDING_LABEL, "ededed", "kody: QA finding", ctx.cwd)
    const scope = scopeArg
    const title = `QA [${verdict}]: ${scope?.trim() || "smoke"} — ${todayIso()}`.slice(0, 240)
    let url = ""
    try {
      const out = gh(["issue", "create", "--title", title, "--label", FINDING_LABEL, "--body-file", "-"], {
        input: finalText,
        cwd: ctx.cwd,
      })
      url =
        out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .pop() ?? ""
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.output.exitCode = 4
      ctx.output.reason = `failed to open record issue: ${truncate(msg, 1000)}`
      ctx.data.action = failedAction(ctx.output.reason)
      return
    }
    process.stdout.write(`\nQA_REPORT_POSTED=${url} (verdict: ${verdict})\n`)
    const m = url.match(/\/issues\/(\d+)\b/)
    ctx.data.action = qaAction(verdict, {
      issueNumber: m ? Number(m[1]) : 0,
      issueUrl: url,
      mode: "create-record",
    })
    ctx.output.exitCode = verdict === "FAIL" ? 1 : 0
    return
  }

  // Goal mode. Two paths:
  //   - --goal <id> set → attach findings to that existing goal. Skip the
  //     manifest update (goal already exists; we don't own the entry's
  //     description). Still write/commit state.json so goal-scheduler keeps
  //     ticking, in case it had been marked done/abandoned.
  //   - no --goal     → create a new qa-<scope>-<date> goal, append it to
  //     the manifest, write a fresh state.json. Original behavior.
  const explicitGoal = explicitGoalArg?.trim()
  const scope = scopeArg

  let goalId: string
  let manifestIssueNumber: number | null = null
  let manifestCreated = false
  let manifestUpdated = false

  if (explicitGoal && explicitGoal.length > 0) {
    goalId = explicitGoal
    // Best-effort: still post the report markdown as a comment on the
    // existing manifest issue so the run isn't invisible. Skip manifest body
    // mutation entirely — the goal description belongs to whoever opened the
    // goal, not to this QA pass.
    const manifestRead = loadManifest(ctx.cwd)
    if (manifestRead.number !== null) {
      manifestIssueNumber = manifestRead.number
      try {
        postIssueComment(manifestRead.number, `## QA — ${verdict} · goal \`${goalId}\`\n\n${markdown}`, ctx.cwd)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[createQaGoal] could not comment on manifest issue: ${reason.slice(0, 300)}\n`)
      }
    }
  } else {
    const manifestRead = loadManifest(ctx.cwd)
    const existingIds = new Set(manifestRead.manifest.goals.map((g) => g.id))
    goalId = buildGoalId(scope, existingIds)
    const goalName = buildGoalName(scope, verdict)

    // Append goal to manifest BEFORE opening task issues. If a downstream
    // step fails, the dashboard at least sees the goal entry it can manually
    // clean.
    const newGoal: ManifestGoal = {
      id: goalId,
      name: goalName,
      description: markdown,
      createdAt: new Date().toISOString(),
    }
    const nextManifest: ManifestBody = {
      version: 1,
      goals: [...manifestRead.manifest.goals, newGoal],
    }
    let manifestIssue: { number: number; created: boolean }
    try {
      manifestIssue = createOrUpdateManifestIssue(manifestRead.number, nextManifest, ctx.cwd)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.output.exitCode = 4
      ctx.output.reason = `failed to update goals manifest: ${truncate(msg, 1000)}`
      ctx.data.action = failedAction(ctx.output.reason)
      return
    }
    manifestIssueNumber = manifestIssue.number
    manifestCreated = manifestIssue.created
    manifestUpdated = true
  }

  // Open task issues. If any fail, log and continue — partial coverage is
  // better than nothing, and the operator can manually open the rest.
  ensureSeverityLabels(findings, ctx.cwd)
  const opened: Array<{ number: number; url: string; severity: ParsedFinding["severity"] }> = []
  const failed: Array<{ title: string; reason: string }> = []
  for (const f of findings) {
    try {
      const issue = createTaskIssue(f, goalId, manifestIssueNumber, ctx.cwd)
      opened.push({ ...issue, severity: f.severity })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failed.push({ title: f.title, reason })
      process.stderr.write(`[createQaGoal] could not open issue for "${f.title}": ${reason.slice(0, 300)}\n`)
    }
  }

  // Persist the activated goal's state to the kody-state branch so
  // goal-scheduler picks it up — off the default branch, no commit churn.
  const now = nowIso()
  const managedGoal = buildQaManagedGoal(goalId, verdict, opened.length, failed.length)
  const goalState: GoalState = {
    state: "active",
    startedAt: now,
    updatedAt: now,
    extra: { version: 1, ...managedGoal },
  }
  try {
    putGoalState(
      ctx.config.github.owner,
      ctx.config.github.repo,
      goalId,
      goalState,
      `chore(goals): activate ${goalId}`,
      ctx.cwd,
    )
  } catch (err) {
    process.stderr.write(
      `[createQaGoal] failed to persist goal state to kody-state: ${err instanceof Error ? err.message : String(err)}\n` +
        `[createQaGoal]   goal-scheduler will not see ${goalId} until this succeeds.\n`,
    )
  }

  const repoUrl = `https://github.com/${ctx.config.github.owner}/${ctx.config.github.repo}`
  if (manifestIssueNumber !== null) {
    const verb = manifestUpdated ? (manifestCreated ? "OPENED" : "UPDATED") : "TARGETED"
    process.stdout.write(
      `\nQA_GOAL_${verb}=${repoUrl}/issues/${manifestIssueNumber} (id: ${goalId}, verdict: ${verdict})\n`,
    )
  } else {
    process.stdout.write(`\nQA_GOAL_TARGETED=(no manifest issue) (id: ${goalId}, verdict: ${verdict})\n`)
  }
  for (const o of opened) {
    process.stdout.write(`QA_FINDING_OPENED=${o.url} (severity: ${o.severity})\n`)
  }
  if (failed.length > 0) {
    process.stdout.write(`QA_FINDINGS_FAILED=${failed.length} (see stderr above)\n`)
  }

  ctx.data.action = qaAction(verdict, {
    goalId,
    manifestIssue: manifestIssueNumber ?? undefined,
    findingsOpened: opened.length,
    findingsFailed: failed.length,
    mode: explicitGoal ? "goal-attach" : manifestCreated ? "goal-create" : "goal-append",
  })
  ctx.output.exitCode = verdict === "FAIL" ? 1 : 0
}
