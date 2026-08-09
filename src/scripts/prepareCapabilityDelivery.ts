import { capabilityDeliveryTarget } from "../capabilityDelivery.js"
import { checkoutPrBranch } from "../branch.js"
import type { PreflightScript } from "../implementations/types.js"
import { runFlow } from "./runFlow.js"

export const prepareCapabilityDelivery: PreflightScript = async (ctx, profile) => {
  const target = capabilityDeliveryTarget(ctx.data.capabilityInput)
  if (!target) {
    throw new Error("pull-request delivery requires exactly one positive issue or pr input")
  }

  ctx.args[target.kind] = target.number
  if (target.kind === "issue") {
    await runFlow(ctx, profile)
    return
  }

  checkoutPrBranch(target.number, ctx.cwd)
  ctx.data.commentTargetType = "pr"
  ctx.data.commentTargetNumber = target.number
}
