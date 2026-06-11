import { describe, expect, it } from "vitest"
import {
  isScheduleEvery,
  type JobFrontmatter,
  scheduleEveryToMs,
  splitFrontmatter,
} from "../../src/scripts/jobFrontmatter.js"

describe("splitFrontmatter", () => {
  it("returns empty frontmatter and untouched body when no block is present", () => {
    const raw = "# Just a job\n\nDo the thing."
    const { frontmatter, body } = splitFrontmatter(raw)
    expect(frontmatter).toEqual({})
    expect(body).toBe(raw)
  })

  it("parses recognized scalar keys and strips the block from the body", () => {
    const raw = [
      "---",
      "action: triage",
      "executable: duty-tick",
      "every: 30m",
      "staff: triage-bot",
      "---",
      "# Body",
      "line two",
    ].join("\n")
    const { frontmatter, body } = splitFrontmatter(raw)
    expect(frontmatter).toEqual<JobFrontmatter>({
      action: "triage",
      executable: "duty-tick",
      every: "30m",
      staff: "triage-bot",
    })
    expect(body).toBe("# Body\nline two")
  })

  it("coerces disabled to a boolean and ignores unknown keys", () => {
    const raw = ["---", "disabled: TRUE", "color: blue", "---", "body"].join("\n")
    const { frontmatter } = splitFrontmatter(raw)
    expect(frontmatter.disabled).toBe(true)
    expect(frontmatter).not.toHaveProperty("color")
  })

  it("treats disabled: false as active", () => {
    const { frontmatter } = splitFrontmatter("---\ndisabled: false\n---\nx")
    expect(frontmatter.disabled).toBe(false)
  })

  it("drops an invalid `every` value rather than storing it", () => {
    const { frontmatter } = splitFrontmatter("---\nevery: 5s\n---\nx")
    expect(frontmatter.every).toBeUndefined()
  })

  it("strips matching surrounding quotes from values", () => {
    const { frontmatter } = splitFrontmatter('---\ntickScript: "scripts/tick.sh"\n---\nx')
    expect(frontmatter.tickScript).toBe("scripts/tick.sh")
  })

  it("ignores comments and blank lines inside the block", () => {
    const raw = ["---", "# a comment", "", "every: 1h", "---", "body"].join("\n")
    const { frontmatter } = splitFrontmatter(raw)
    expect(frontmatter.every).toBe("1h")
  })

  it("handles CRLF line endings", () => {
    const raw = "---\r\nevery: 6h\r\n---\r\nbody"
    const { frontmatter, body } = splitFrontmatter(raw)
    expect(frontmatter.every).toBe("6h")
    expect(body).toBe("body")
  })

  it("ignores a key line with no colon", () => {
    const { frontmatter } = splitFrontmatter("---\njust-a-word\nevery: 1d\n---\nx")
    expect(frontmatter.every).toBe("1d")
  })

  it("parses a comma-separated `mentions` list into trimmed logins", () => {
    const { frontmatter } = splitFrontmatter("---\nmentions: a, b\n---\nx")
    expect(frontmatter.mentions).toEqual(["a", "b"])
  })

  it("strips a leading @ from each mention login", () => {
    const { frontmatter } = splitFrontmatter("---\nmentions: @a, @b\n---\nx")
    expect(frontmatter.mentions).toEqual(["a", "b"])
  })

  it("leaves mentions undefined when the key is absent", () => {
    const { frontmatter } = splitFrontmatter("---\nevery: 1h\n---\nx")
    expect(frontmatter.mentions).toBeUndefined()
  })

  it("leaves mentions unset when the value is blank or all-empty", () => {
    expect(splitFrontmatter("---\nmentions:\n---\nx").frontmatter.mentions).toBeUndefined()
    expect(splitFrontmatter("---\nmentions: , ,\n---\nx").frontmatter.mentions).toBeUndefined()
  })

  it("parses a comma-separated `executables` list into trimmed executable names", () => {
    const { frontmatter } = splitFrontmatter("---\nexecutables: plan-verify, probe-skill\n---\nx")
    expect(frontmatter.executables).toEqual(["plan-verify", "probe-skill"])
  })

  it("leaves executables unset when the value is blank or all-empty", () => {
    expect(splitFrontmatter("---\nexecutables:\n---\nx").frontmatter.executables).toBeUndefined()
    expect(splitFrontmatter("---\nexecutables: , ,\n---\nx").frontmatter.executables).toBeUndefined()
  })
})

describe("isScheduleEvery", () => {
  it("accepts every supported cadence including the manual sentinel", () => {
    for (const v of ["15m", "30m", "1h", "2h", "6h", "12h", "1d", "3d", "7d", "manual"]) {
      expect(isScheduleEvery(v)).toBe(true)
    }
  })

  it("rejects unsupported strings and non-strings", () => {
    expect(isScheduleEvery("5s")).toBe(false)
    expect(isScheduleEvery("")).toBe(false)
    expect(isScheduleEvery(60)).toBe(false)
    expect(isScheduleEvery(null)).toBe(false)
    expect(isScheduleEvery(undefined)).toBe(false)
  })
})

describe("scheduleEveryToMs", () => {
  it("converts each cadence to its millisecond span", () => {
    const MIN = 60_000
    expect(scheduleEveryToMs("15m")).toBe(15 * MIN)
    expect(scheduleEveryToMs("30m")).toBe(30 * MIN)
    expect(scheduleEveryToMs("1h")).toBe(60 * MIN)
    expect(scheduleEveryToMs("2h")).toBe(120 * MIN)
    expect(scheduleEveryToMs("6h")).toBe(360 * MIN)
    expect(scheduleEveryToMs("12h")).toBe(720 * MIN)
    expect(scheduleEveryToMs("1d")).toBe(1440 * MIN)
    expect(scheduleEveryToMs("3d")).toBe(3 * 1440 * MIN)
    expect(scheduleEveryToMs("7d")).toBe(7 * 1440 * MIN)
  })

  it("returns Infinity for the manual sentinel so it never appears due", () => {
    expect(scheduleEveryToMs("manual")).toBe(Number.POSITIVE_INFINITY)
  })
})
