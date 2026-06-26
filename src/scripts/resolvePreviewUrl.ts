/**
 * Preflight: resolve the URL the UI-review agent should browse.
 *
 * Resolution order (first match wins):
 *   1. ctx.args.previewUrl           — `--preview-url` CLI flag
 *   2. process.env.PREVIEW_URL       — set by Vercel bot comment, workflow env, or local shell
 *   3. GitHub Deployments API        — latest successful Preview deployment for the PR head SHA
 *   4. "http://localhost:3000"       — last-resort default (matches Next.js dev)
 *
 * Populates:
 *   ctx.data.previewUrl       — the resolved URL
 *   ctx.data.previewUrlSource — "flag" | "env" | "deployment" | "default"  (for diagnostics)
 */

import { findPreviewDeploymentUrl } from "../deployments.js"
import type { PreflightScript } from "../executables/types.js"

export const DEFAULT_PREVIEW_URL = "http://localhost:3000"

export const resolvePreviewUrl: PreflightScript = async (ctx) => {
  const fromFlag = typeof ctx.args.previewUrl === "string" ? (ctx.args.previewUrl as string).trim() : ""
  if (fromFlag.length > 0) {
    ctx.data.previewUrl = fromFlag
    ctx.data.previewUrlSource = "flag"
    return
  }

  const fromEnv = (process.env.PREVIEW_URL ?? "").trim()
  if (fromEnv.length > 0) {
    ctx.data.previewUrl = fromEnv
    ctx.data.previewUrlSource = "env"
    return
  }

  const prNumber = typeof ctx.args.pr === "number" ? ctx.args.pr : null
  if (prNumber !== null) {
    const fromDeployment = findPreviewDeploymentUrl(prNumber, ctx.cwd)
    if (fromDeployment) {
      ctx.data.previewUrl = fromDeployment
      ctx.data.previewUrlSource = "deployment"
      return
    }
  }

  ctx.data.previewUrl = DEFAULT_PREVIEW_URL
  ctx.data.previewUrlSource = "default"
}
