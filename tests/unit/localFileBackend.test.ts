/**
 * Unit tests for LocalFileBackend. Filesystem operations run against a real
 * temp dir; the Actions cache adapter is stubbed via constructor injection
 * so no network calls happen.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StateEnvelope } from "../../src/scripts/issueStateComment.js"
import { type ActionsCacheAdapter, LocalFileBackend } from "../../src/scripts/jobState/localFileBackend.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-job-state-"))
}

function envelope(overrides: Partial<StateEnvelope> = {}): StateEnvelope {
  return {
    version: 1,
    rev: 1,
    cursor: "tick-1",
    data: { foo: "bar" },
    done: false,
    ...overrides,
  }
}

function stubAdapter(overrides: Partial<ActionsCacheAdapter> = {}): ActionsCacheAdapter {
  return {
    isAvailable: vi.fn(() => true),
    restore: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    ...overrides,
  } as ActionsCacheAdapter
}

describe("LocalFileBackend", () => {
  let cwd: string

  beforeEach(() => {
    cwd = tmpDir()
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  describe("constructor", () => {
    it("requires cwd, jobsDir, owner, repo", () => {
      expect(() => new LocalFileBackend({ cwd: "", jobsDir: ".kody/jobs", owner: "o", repo: "r" })).toThrow(/cwd/i)
      expect(() => new LocalFileBackend({ cwd, jobsDir: "", owner: "o", repo: "r" })).toThrow(/jobsDir/i)
      expect(() => new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "", repo: "r" })).toThrow(/owner.*repo/i)
    })
  })

  describe("load", () => {
    it("returns a seed envelope when no state file exists", () => {
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r" })
      const out = b.load("auto-sync")
      expect(out.created).toBe(true)
      expect(out.handle).toBeNull()
      expect(out.state.rev).toBe(0)
      expect(out.state.cursor).toBe("seed")
      expect(out.path).toBe(".kody/jobs/auto-sync/state.json")
    })

    it("reads and parses an existing state file", () => {
      const dir = path.join(cwd, ".kody/jobs")
      const stateDir = path.join(dir, "auto-sync")
      fs.mkdirSync(dir, { recursive: true })
      fs.mkdirSync(stateDir, { recursive: true })
      const state = envelope({ rev: 7, cursor: "tick-7" })
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2))

      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r" })
      const out = b.load("auto-sync")

      expect(out.created).toBe(false)
      expect(out.handle).toBeNull()
      expect(out.state).toEqual(state)
    })

    it("throws on invalid JSON", () => {
      const stateDir = path.join(cwd, ".kody/jobs", "auto-sync")
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, "state.json"), "not json")

      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r" })
      expect(() => b.load("auto-sync")).toThrow(/not valid JSON/i)
    })

    it("throws on non-StateEnvelope JSON", () => {
      const stateDir = path.join(cwd, ".kody/jobs", "auto-sync")
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ wrong: "shape" }))

      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r" })
      expect(() => b.load("auto-sync")).toThrow(/not a StateEnvelope/i)
    })
  })

  describe("save", () => {
    it("creates the jobs directory and writes the file when seeding", () => {
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r" })
      const wrote = b.save(
        { path: ".kody/jobs/auto-sync/state.json", handle: null, state: envelope({ rev: 0 }), created: true },
        envelope({ rev: 1 }),
      )
      expect(wrote).toBe(true)
      const onDisk = fs.readFileSync(path.join(cwd, ".kody/jobs/auto-sync/state.json"), "utf-8")
      expect(JSON.parse(onDisk)).toEqual(envelope({ rev: 1 }))
    })

    it("skips writes when state is structurally unchanged", () => {
      const dir = path.join(cwd, ".kody/jobs")
      const stateDir = path.join(dir, "auto-sync")
      fs.mkdirSync(stateDir, { recursive: true })
      const prev = envelope({ rev: 5, cursor: "same", data: { x: 1 } })
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(prev))

      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r" })
      const next = envelope({ rev: 6, cursor: "same", data: { x: 1 } })
      const wrote = b.save({ path: ".kody/jobs/auto-sync/state.json", handle: null, state: prev, created: false }, next)
      expect(wrote).toBe(false)
      // Original file untouched.
      expect(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf-8"))).toEqual(prev)
    })

    it("writes when cursor or data changes", () => {
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r" })
      const prev = envelope({ rev: 5, cursor: "a" })
      b.save({ path: ".kody/jobs/auto-sync/state.json", handle: null, state: prev, created: true }, prev)
      const next = envelope({ rev: 6, cursor: "b" })
      const wrote = b.save({ path: ".kody/jobs/auto-sync/state.json", handle: null, state: prev, created: false }, next)
      expect(wrote).toBe(true)
    })

    it("writes atomically and leaves no temp file behind", () => {
      // Atomic write = temp file + rename. After a successful save the dir holds
      // only the final state file; no orphaned `.tmp` (a crash mid-write would
      // otherwise leave a truncated file that wedges the next load).
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r" })
      b.save(
        { path: ".kody/jobs/auto-sync/state.json", handle: null, state: envelope({ rev: 0 }), created: true },
        envelope({ rev: 1 }),
      )
      const dir = path.join(cwd, ".kody/jobs")
      const entries = fs.readdirSync(dir)
      expect(entries).toEqual(["auto-sync"])
      // Final file is complete, parseable JSON.
      expect(() => JSON.parse(fs.readFileSync(path.join(dir, "auto-sync", "state.json"), "utf-8"))).not.toThrow()
    })
  })

  describe("hydrate", () => {
    it("calls cache.restore with the repo-scoped prefix as a restore-key", async () => {
      const cache = stubAdapter()
      const b = new LocalFileBackend({
        cwd,
        jobsDir: ".kody/jobs",
        owner: "acme",
        repo: "widgets",
        cache,
      })
      await b.hydrate()
      expect(cache.restore).toHaveBeenCalledTimes(1)
      const [paths, primaryKey, restoreKeys] = (cache.restore as ReturnType<typeof vi.fn>).mock.calls[0]!
      expect(paths).toEqual([path.join(cwd, ".kody/jobs")])
      expect(primaryKey).toContain("kody-job-state-acme-widgets-")
      expect(restoreKeys).toEqual(["kody-job-state-acme-widgets-"])
    })

    it("is a no-op when cache is unavailable", async () => {
      const cache = stubAdapter({ isAvailable: vi.fn(() => false) })
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r", cache })
      await b.hydrate()
      expect(cache.restore).not.toHaveBeenCalled()
    })

    it("creates the jobs directory before restore", async () => {
      const cache = stubAdapter()
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r", cache })
      await b.hydrate()
      expect(fs.existsSync(path.join(cwd, ".kody/jobs"))).toBe(true)
    })

    it("does not throw if cache.restore throws", async () => {
      const cache = stubAdapter({
        restore: vi.fn(async () => {
          throw new Error("transient cache error")
        }),
      })
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r", cache })
      await expect(b.hydrate()).resolves.toBeUndefined()
    })

    it("sanitizes owner/repo characters that are invalid in cache keys", async () => {
      const cache = stubAdapter()
      const b = new LocalFileBackend({
        cwd,
        jobsDir: ".kody/jobs",
        owner: "weird org/name",
        repo: "x:y",
        cache,
      })
      await b.hydrate()
      const [, primaryKey] = (cache.restore as ReturnType<typeof vi.fn>).mock.calls[0]!
      expect(primaryKey).toMatch(/^kody-job-state-weird-org-name-x-y-/)
    })
  })

  describe("persist", () => {
    it("calls cache.save under a unique key when jobs dir exists", async () => {
      fs.mkdirSync(path.join(cwd, ".kody/jobs"), { recursive: true })
      const cache = stubAdapter()
      const b = new LocalFileBackend({
        cwd,
        jobsDir: ".kody/jobs",
        owner: "acme",
        repo: "widgets",
        cache,
      })
      await b.persist()
      expect(cache.save).toHaveBeenCalledTimes(1)
      const [paths, key] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0]!
      expect(paths).toEqual([path.join(cwd, ".kody/jobs")])
      expect(key).toContain("kody-job-state-acme-widgets-")
    })

    it("is a no-op when cache is unavailable", async () => {
      fs.mkdirSync(path.join(cwd, ".kody/jobs"), { recursive: true })
      const cache = stubAdapter({ isAvailable: vi.fn(() => false) })
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r", cache })
      await b.persist()
      expect(cache.save).not.toHaveBeenCalled()
    })

    it("is a no-op when jobs directory does not exist (no jobs ever ran)", async () => {
      const cache = stubAdapter()
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r", cache })
      await b.persist()
      expect(cache.save).not.toHaveBeenCalled()
    })

    it("swallows save errors so the workflow does not fail on cache hiccups", async () => {
      fs.mkdirSync(path.join(cwd, ".kody/jobs"), { recursive: true })
      const cache = stubAdapter({
        save: vi.fn(async () => {
          throw new Error("cache offline")
        }),
      })
      const b = new LocalFileBackend({ cwd, jobsDir: ".kody/jobs", owner: "o", repo: "r", cache })
      await expect(b.persist()).resolves.toBeUndefined()
    })
  })
})
