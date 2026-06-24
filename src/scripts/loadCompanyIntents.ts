import type { PreflightScript } from "../agent-actions/types.js"
import { listCompanyIntents } from "../companyIntent.js"

export const loadCompanyIntents: PreflightScript = async (ctx) => {
  const intents = listCompanyIntents(ctx.config, ctx.cwd)
  const active = intents.filter((record) => record.intent.status === "active")
  ctx.data.companyIntents = intents
  ctx.data.companyActiveIntents = active
  ctx.data.companyIntentsJson = JSON.stringify(
    active.map((record) => record.intent),
    null,
    2,
  )
  if (active.length === 0) {
    ctx.output.reason = "no active company intents"
  }
}
