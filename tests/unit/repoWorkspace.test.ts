/**
 * repoWorkspace — shared clone helpers used by brain-serve (ensureRepoCwd)
 * and the fetch_repo chat tool (fetchRepo). ensureRepoCwd's behavior is
 * covered in brain-serve.test.ts; here we focus on the strict `fetchRepo`
 * entry point the agent tool depends on.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ensureRepoCwd, fetchRepo } from "../../src/repoWorkspace.js"

describe("fetchRepo (strict, for the fetch_repo tool)", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-repoworkspace-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("clones into reposRoot/<owner>/<name> and returns the path", async () => {
    const reposRoot = path.join(tmp, "repos")
    const calls: Array<{ repo: string; token?: string; dir: string }> = []
    const cloneRepo = async (
      repo: string,
      token: string | undefined,
      dir: string,
    ) => {
      calls.push({ repo, token, dir })
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    }
    const dir = await fetchRepo({
      reposRoot,
      repo: "octocat/Hello-World",
      repoToken: "tok",
      cloneRepo,
    })
    expect(dir).toBe(path.join(reposRoot, "octocat/Hello-World"))
    expect(calls).toEqual([
      { repo: "octocat/Hello-World", token: "tok", dir },
    ])
  })

  it("reuses an already-cloned repo without cloning again", async () => {
    const reposRoot = path.join(tmp, "repos")
    const dir = path.join(reposRoot, "octocat/Hello-World")
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    const out = await fetchRepo({
      reposRoot,
      repo: "octocat/Hello-World",
      cloneRepo: async () => {
        throw new Error("should not clone")
      },
    })
    expect(out).toBe(dir)
  })

  it("throws on a malformed or path-escaping repo", async () => {
    const reposRoot = path.join(tmp, "repos")
    const noClone = async () => {
      throw new Error("should not clone")
    }
    for (const bad of ["noslash", "../escape", "a/../../etc", "/abs/x", "a/b/c"]) {
      await expect(
        fetchRepo({ reposRoot, repo: bad, cloneRepo: noClone }),
      ).rejects.toThrow(/invalid repo/)
    }
  })

  it("ensureRepoCwd shares the clone path but falls back to baseCwd on a bad repo", async () => {
    const reposRoot = path.join(tmp, "repos")
    const base = path.join(tmp, "boot")
    const out = await ensureRepoCwd({
      baseCwd: base,
      reposRoot,
      repo: "noslash",
      cloneRepo: async () => {
        throw new Error("should not clone")
      },
    })
    expect(out).toBe(base)
  })
})
