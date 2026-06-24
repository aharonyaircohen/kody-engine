import type { PostflightScript } from "../agent-actions/types.js"
import {
  logAppliedCompanyManagerActions,
  type AppliedCompanyManagerAction,
} from "./applyCompanyManagerDecision.js"

export const appendCompanyIntentDecision: PostflightScript = async (ctx) => {
  const applied = ctx.data.companyManagerApplied as AppliedCompanyManagerAction[] | undefined
  if (!applied || applied.length === 0) return
  try {
    logAppliedCompanyManagerActions(ctx.config, ctx.cwd, applied)
  } catch (err) {
    process.stderr.write(
      `[company-manager] failed append intent decision log: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
