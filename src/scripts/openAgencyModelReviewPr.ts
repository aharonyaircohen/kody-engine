import { createHash } from "node:crypto"
import type { Context, PostflightScript } from "../implementations/types.js"
import { gh } from "../issue.js"
import { createStateBackendFromEnv } from "../state-backend.js"

interface AgencyModelFile {
  path: string
  content: string
}

interface AgencyModelProposal {
  title: string
  summary: string
  files: AgencyModelFile[]
  model?: unknown
}

export const openAgencyModelReviewPr: PostflightScript = async (ctx, profile, agentResult) => {
  if (agentResult?.outcome !== "completed" || ctx.data.agentDone !== true) {
    throw new Error(`openAgencyModelReviewPr: agent did not complete successfully`)
  }
  const issueNumber = readIssueNumber(ctx)
  const sourceLabel = creatorSourceLabel(ctx, profile.name)
  const bundle = parseAgencyModelProposal(String(ctx.data.prSummary ?? ""))
  const files = normalizeBundleFiles(bundle)
  const proposalId = buildProposalId(issueNumber, bundle, sourceLabel)
  const tenantId = `${ctx.config.github.owner}/${ctx.config.github.repo}`
  const proposal = {
    schemaVersion: 1,
    proposalId,
    status: "pending-review",
    title: bundle.title,
    summary: bundle.summary,
    source: { issueNumber, capability: sourceLabel },
    files,
    model: bundle.model,
    createdAt: new Date().toISOString(),
  }

  if (!isDryRun(ctx)) {
    await createStateBackendFromEnv().saveRepoDoc(tenantId, `definition-proposal:${proposalId}`, proposal)
    gh(["issue", "comment", String(issueNumber), "--body-file", "-"], {
      cwd: ctx.cwd,
      input: renderIssueComment(proposalId, bundle, sourceLabel),
    })
  }

  ctx.data.agencyModelProposal = proposal
}

export function parseAgencyModelProposal(raw: string): AgencyModelProposal {
  const text = raw.trim()
  const jsonText = (text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)?.[1] ?? text).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(
      `openAgencyModelReviewPr: PR_SUMMARY must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("openAgencyModelReviewPr: PR_SUMMARY must be a JSON object")
  }
  const value = parsed as Record<string, unknown>
  const title = requiredString(value.title, "title")
  const summary = requiredString(value.summary, "summary")
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("openAgencyModelReviewPr: files must be a non-empty array")
  }
  const files = value.files.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`openAgencyModelReviewPr: files[${index}] must be an object`)
    }
    const file = item as Record<string, unknown>
    return {
      path: requiredString(file.path, `files[${index}].path`),
      content: stringValue(file.content, `files[${index}].content`),
    }
  })
  return { title, summary, files, model: value.model }
}

function normalizeBundleFiles(bundle: AgencyModelProposal): AgencyModelFile[] {
  const seen = new Set<string>()
  return bundle.files.map((file, index) => {
    const path = file.path.replace(/^\/+/, "")
    const parts = path.split("/")
    if (
      !path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`openAgencyModelReviewPr: files[${index}].path is unsafe`)
    }
    if (
      !/^(agents\/[^/]+\.md|capabilities\/[^/]+\/.+|goals\/(?:templates\/)?[^/]+\/.+|workflows\/[^/]+\.json)$/.test(
        path,
      )
    ) {
      throw new Error(`openAgencyModelReviewPr: files[${index}].path is not a supported definition path`)
    }
    if (seen.has(path)) throw new Error(`openAgencyModelReviewPr: duplicate generated file path: ${path}`)
    seen.add(path)
    return { path, content: file.content.replace(/\r\n?/g, "\n") }
  })
}

function buildProposalId(issueNumber: number, bundle: AgencyModelProposal, sourceLabel: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ issueNumber, sourceLabel, title: bundle.title, files: normalizeBundleFiles(bundle) }))
    .digest("hex")
    .slice(0, 16)
  return `issue-${issueNumber}-${digest}`
}

function isDryRun(ctx: Context): boolean {
  const arg = ctx.args.dry_run ?? ctx.args.dryRun
  if (arg === true) return true
  if (typeof arg === "string" && ["1", "true", "yes"].includes(arg.trim().toLowerCase())) return true
  return ["1", "true", "yes"].includes((process.env.KODY_DRY_RUN ?? "").trim().toLowerCase())
}

function readIssueNumber(ctx: Context): number {
  const issue = ctx.args.issue
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) {
    throw new Error("openAgencyModelReviewPr: ctx.args.issue must be a positive integer")
  }
  return issue
}

function requiredString(value: unknown, field: string): string {
  const text = stringValue(value, field).trim()
  if (!text) throw new Error(`openAgencyModelReviewPr: ${field} must be a non-empty string`)
  return text
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`openAgencyModelReviewPr: ${field} must be a string`)
  return value
}

function creatorSourceLabel(ctx: Context, profileName: string | undefined): string {
  return (
    (
      [ctx.data.jobCapability, ctx.data.selectedImplementation, profileName].find(
        (value) => typeof value === "string" && value.trim(),
      ) as string | undefined
    )?.trim() ?? "model-creator"
  )
}

function renderIssueComment(proposalId: string, bundle: AgencyModelProposal, sourceLabel: string): string {
  return [
    `${sourceLabel} created backend definition proposal \`${proposalId}\` for review.`,
    "",
    bundle.summary,
    "",
    "The proposal is inactive until it is approved in Kody Dashboard.",
  ].join("\n")
}
