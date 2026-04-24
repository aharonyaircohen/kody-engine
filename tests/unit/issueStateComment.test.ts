/**
 * Pure-function tests for the state-comment parser/formatter. The I/O
 * functions (listIssueComments, createStateComment, etc.) are covered by
 * integration/e2e tests against a live repo.
 */

import { describe, expect, it } from "vitest"
import {
  formatStateCommentBody,
  initialStateEnvelope,
  isStateEnvelope,
  parseStateCommentBody,
  type StateEnvelope,
} from "../../src/scripts/issueStateComment.js"

const MARKER = "kody-manager-state"

describe("issueStateComment", () => {
  describe("initialStateEnvelope", () => {
    it("produces a valid envelope with defaults", () => {
      const s = initialStateEnvelope()
      expect(isStateEnvelope(s)).toBe(true)
      expect(s.rev).toBe(0)
      expect(s.cursor).toBe("seed")
      expect(s.done).toBe(false)
    })
  })

  describe("formatStateCommentBody / parseStateCommentBody round trip", () => {
    it("round-trips a minimal state", () => {
      const state: StateEnvelope = initialStateEnvelope()
      const body = formatStateCommentBody(MARKER, state)
      expect(parseStateCommentBody(MARKER, body)).toEqual(state)
    })

    it("round-trips a state with nested data", () => {
      const state: StateEnvelope = {
        version: 1,
        rev: 7,
        cursor: "waiting-release",
        data: { releaseRunId: "12345", spawnedAt: "2026-04-24T09:00:00Z", children: [42, 43] },
        done: false,
      }
      const body = formatStateCommentBody(MARKER, state)
      expect(parseStateCommentBody(MARKER, body)).toEqual(state)
    })

    it("starts with the marker line", () => {
      const body = formatStateCommentBody(MARKER, initialStateEnvelope())
      expect(body.startsWith(`<!-- ${MARKER} -->`)).toBe(true)
    })

    it("contains a json fenced block", () => {
      const body = formatStateCommentBody(MARKER, initialStateEnvelope())
      expect(body).toContain("```json")
      expect(body).toContain("```\n")
    })
  })

  describe("parseStateCommentBody rejects non-matching input", () => {
    it("returns null when marker is absent", () => {
      const body = "some random user comment with no marker"
      expect(parseStateCommentBody(MARKER, body)).toBeNull()
    })

    it("returns null for a different marker", () => {
      const body = formatStateCommentBody("some-other-marker", initialStateEnvelope())
      expect(parseStateCommentBody(MARKER, body)).toBeNull()
    })

    it("returns null when JSON is malformed", () => {
      const body = `<!-- ${MARKER} -->\n\n\`\`\`json\n{ not valid json \n\`\`\`\n`
      expect(parseStateCommentBody(MARKER, body)).toBeNull()
    })

    it("returns null when JSON is missing required fields", () => {
      const body = `<!-- ${MARKER} -->\n\n\`\`\`json\n{ "cursor": "x" }\n\`\`\`\n`
      expect(parseStateCommentBody(MARKER, body)).toBeNull()
    })

    it("returns null when no fenced json block follows the marker", () => {
      const body = `<!-- ${MARKER} -->\n\nsome prose`
      expect(parseStateCommentBody(MARKER, body)).toBeNull()
    })

    it("returns null when fence is opened but never closed", () => {
      const body = `<!-- ${MARKER} -->\n\n\`\`\`json\n{ "version": 1 }\n`
      expect(parseStateCommentBody(MARKER, body)).toBeNull()
    })
  })

  describe("parseStateCommentBody tolerance", () => {
    it("tolerates leading whitespace before the marker", () => {
      const state = initialStateEnvelope()
      const body = `   \n\n${formatStateCommentBody(MARKER, state)}`
      expect(parseStateCommentBody(MARKER, body)).toEqual(state)
    })

    it("ignores content after the closing fence", () => {
      const state = initialStateEnvelope()
      const body = `${formatStateCommentBody(MARKER, state)}\n\n<!-- trailing garbage -->`
      expect(parseStateCommentBody(MARKER, body)).toEqual(state)
    })
  })

  describe("isStateEnvelope", () => {
    it("rejects version other than 1", () => {
      expect(isStateEnvelope({ ...initialStateEnvelope(), version: 2 })).toBe(false)
    })

    it("rejects negative rev", () => {
      expect(isStateEnvelope({ ...initialStateEnvelope(), rev: -1 })).toBe(false)
    })

    it("rejects non-integer rev", () => {
      expect(isStateEnvelope({ ...initialStateEnvelope(), rev: 1.5 })).toBe(false)
    })

    it("rejects null", () => {
      expect(isStateEnvelope(null)).toBe(false)
    })

    it("rejects arrays", () => {
      expect(isStateEnvelope([])).toBe(false)
    })

    it("rejects an array in data", () => {
      expect(isStateEnvelope({ ...initialStateEnvelope(), data: [] as unknown as Record<string, unknown> })).toBe(false)
    })

    it("accepts arbitrary nested data payloads", () => {
      expect(
        isStateEnvelope({
          version: 1,
          rev: 0,
          cursor: "x",
          data: { anything: { goes: ["here", 1, true, null] } },
          done: false,
        } as StateEnvelope),
      ).toBe(true)
    })
  })
})
