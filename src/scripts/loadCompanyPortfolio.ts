import type { PreflightScript } from "../agent-actions/types.js"
import { listCompanyPortfolio } from "../companyIntent.js"

export const loadCompanyPortfolio: PreflightScript = async (ctx) => {
  const portfolio = listCompanyPortfolio(ctx.config, ctx.cwd)
  ctx.data.companyPortfolio = portfolio
  ctx.data.companyPortfolioJson = JSON.stringify(portfolio, null, 2)
}
