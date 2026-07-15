import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
  truncate: (s: string) => s,
}))

import { gh } from "../../src/issue.js"
import { ensurePr } from "../../src/pr.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  ghMock.mockReset()
})

describe("ensurePr repo token preference", () => {
  const base = {
    branch: "3705-feature",
    defaultBranch: "dev",
    issueNumber: 3705,
    issueTitle: "Add feature marker",
    draft: false,
    changedFiles: ["src/utils/normalize-feature-marker.ts"],
    cwd: "/repo",
  }

  it("uses the repo token for existing PR lookup and body update", () => {
    ghMock
      .mockReturnValueOnce(
        JSON.stringify([
          {
            number: 3706,
            url: "https://github.com/aharonyaircohen/Kody-Engine-Tester/pull/3706",
            body: "Closes #3705",
          },
        ]),
      )
      .mockReturnValueOnce("")

    const result = ensurePr(base)

    expect(result.action).toBe("updated")
    expect(ghMock).toHaveBeenNthCalledWith(
      1,
      ["pr", "list", "--head", "3705-feature", "--state", "open", "--json", "number,url,body,title,isDraft", "--limit", "1"],
      { cwd: "/repo", preferRepoToken: true },
    )
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      [
        "api",
        "--method",
        "PATCH",
        "repos/aharonyaircohen/Kody-Engine-Tester/pulls/3706",
        "-f",
        expect.stringContaining("body="),
      ],
      { cwd: "/repo", preferRepoToken: true },
    )
  })

  it("uses the repo token for new PR creation", () => {
    ghMock
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce("https://github.com/aharonyaircohen/Kody-Engine-Tester/pull/3706")

    const result = ensurePr(base)

    expect(result.action).toBe("created")
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      [
        "pr",
        "create",
        "--head",
        "3705-feature",
        "--base",
        "dev",
        "--title",
        "#3705: Add feature marker",
        "--body-file",
        "-",
      ],
      { cwd: "/repo", input: expect.stringContaining("Closes #3705"), preferRepoToken: true },
    )
  })
})
