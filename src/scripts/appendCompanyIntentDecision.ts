import type { PostflightScript } from "../executables/types.js"
import { type AppliedCompanyManagerAction, logAppliedCompanyManagerActions } from "./applyCompanyManagerDecision.js"

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
