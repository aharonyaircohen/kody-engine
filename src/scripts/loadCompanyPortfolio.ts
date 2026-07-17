import { listCompanyPortfolio } from "../companyIntent.js"
import type { PreflightScript } from "../implementations/types.js"

export const loadCompanyPortfolio: PreflightScript = async (ctx) => {
  const portfolio = await listCompanyPortfolio(ctx.config, ctx.cwd)
  ctx.data.companyPortfolio = portfolio
  ctx.data.companyPortfolioJson = JSON.stringify(portfolio, null, 2)
}
