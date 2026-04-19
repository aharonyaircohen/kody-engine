import { describe, it, expect } from "vitest"
import { formatStaleReport } from "../../src/scripts/watchStalePrsFlow.js"

describe("watchStalePrsFlow: formatStaleReport", () => {
  it("reports green when no stale PRs", () => {
    const out = formatStaleReport([], 7)
    expect(out).toMatch(/🟢/)
    expect(out).toMatch(/no open PRs untouched for more than 7 days/)
  })

  it("lists stale PRs sorted by days stale (descending)", () => {
    const out = formatStaleReport(
      [
        { number: 1, title: "oldest", url: "https://gh/repo/pull/1", updatedAt: "2026-04-01", daysStale: 20 },
        { number: 2, title: "newer", url: "https://gh/repo/pull/2", updatedAt: "2026-04-10", daysStale: 10 },
      ],
      7,
    )
    expect(out).toMatch(/🟡/)
    expect(out).toMatch(/2 PR\(s\) untouched for > 7 days/)
    expect(out).toMatch(/#1/)
    expect(out).toMatch(/20 days stale/)
  })

  it("caps listing at 50 entries", () => {
    const stale = Array.from({ length: 60 }, (_, i) => ({
      number: i + 1,
      title: `pr ${i + 1}`,
      url: `https://gh/repo/pull/${i + 1}`,
      updatedAt: "2026-04-01",
      daysStale: 20,
    }))
    const out = formatStaleReport(stale, 7)
    const bulletCount = (out.match(/^- \[/gm) ?? []).length
    expect(bulletCount).toBe(50)
    expect(out).toMatch(/and 10 more/)
  })

  it("truncates very long titles in report", () => {
    const stale = [{
      number: 1,
      title: "x".repeat(200),
      url: "https://gh/repo/pull/1",
      updatedAt: "2026-04-01",
      daysStale: 20,
    }]
    const out = formatStaleReport(stale, 7)
    expect(out).toMatch(/\+/) // truncate marker
  })
})
