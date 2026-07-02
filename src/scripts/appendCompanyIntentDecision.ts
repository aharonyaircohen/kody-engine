import type { PostflightScript } from "../executables/types.js"
import { type AppliedAgencyArchitectAction, logAppliedAgencyArchitectActions } from "./applyAgencyArchitectDecision.js"

export const appendCompanyIntentDecision: PostflightScript = async (ctx) => {
  const applied = ctx.data.agencyArchitectApplied as AppliedAgencyArchitectAction[] | undefined
  if (!applied || applied.length === 0) return
  try {
    logAppliedAgencyArchitectActions(ctx.config, ctx.cwd, applied)
  } catch (err) {
    process.stderr.write(
      `[agency-architect] failed append intent decision log: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
