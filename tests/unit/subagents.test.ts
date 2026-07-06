import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Profile } from "../../src/implementations/types.js"
import { getPluginsCatalogRoot } from "../../src/scripts/buildSyntheticPlugin.js"
import { captureSubagentTemplates, loadSubagents } from "../../src/subagents.js"

function makeProfile(subagents: string[], dir: string): Profile {
  return {
    name: "test-exec",
    role: "primitive",
    describe: "test",
    kind: "oneshot",
    inputs: [],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: null,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: [],
      hooks: [],
      skills: [],
      commands: [],
      subagents,
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: { preflight: [], postflight: [] },
    inputArtifacts: [],
    outputArtifacts: [],
    dir,
  } as Profile
}

/** Make a temp implementation dir and write `agents/<file>.md` with given content. */
function withLocalAgent(file: string, content: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-subagents-"))
  const agentsDir = path.join(tmp, "agents")
  fs.mkdirSync(agentsDir, { recursive: true })
  fs.writeFileSync(path.join(agentsDir, `${file}.md`), content)
  return tmp
}

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length) fs.rmSync(cleanups.pop()!, { recursive: true, force: true })
})

describe("loadSubagents", () => {
  it("returns undefined when the profile declares no subagents", () => {
    expect(loadSubagents(makeProfile([], "/tmp/none"))).toBeUndefined()
  })

  it("loads a local agent and parses description, prompt, tools, and model", () => {
    const tmp = withLocalAgent(
      "scout",
      "---\nname: scout\ndescription: A read-only scout.\ntools: Read, Grep, Glob\nmodel: haiku\n---\nYou are a scout. Investigate and report.\n",
    )
    cleanups.push(tmp)

    const agents = loadSubagents(makeProfile(["scout"], tmp))!
    expect(agents.scout).toEqual({
      description: "A read-only scout.",
      prompt: "You are a scout. Investigate and report.",
      tools: ["Read", "Grep", "Glob"],
      model: "haiku",
    })
  })

  it("keys by the frontmatter name when it differs from the filename", () => {
    const tmp = withLocalAgent("file-name", "---\nname: declared-name\ndescription: x\n---\nbody\n")
    cleanups.push(tmp)
    const agents = loadSubagents(makeProfile(["file-name"], tmp))!
    expect(Object.keys(agents)).toEqual(["declared-name"])
  })

  it("falls back to the filename as key when frontmatter has no name", () => {
    const tmp = withLocalAgent("anon", "---\ndescription: x\n---\nbody\n")
    cleanups.push(tmp)
    const agents = loadSubagents(makeProfile(["anon"], tmp))!
    expect(Object.keys(agents)).toEqual(["anon"])
  })

  it("defaults the description and omits tools/model when frontmatter lacks them", () => {
    const tmp = withLocalAgent("bare", "---\nname: bare\n---\njust a body\n")
    cleanups.push(tmp)
    const agents = loadSubagents(makeProfile(["bare"], tmp))!
    expect(agents.bare).toEqual({ description: "Subagent bare", prompt: "just a body" })
  })

  it("treats a file with no frontmatter as an all-body prompt", () => {
    const tmp = withLocalAgent("raw", "You are a raw-prompt agent.")
    cleanups.push(tmp)
    const agents = loadSubagents(makeProfile(["raw"], tmp))!
    expect(agents.raw).toEqual({ description: "Subagent raw", prompt: "You are a raw-prompt agent." })
  })

  it("throws when an agent file is found in neither the local dir nor the catalog", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-subagents-empty-"))
    cleanups.push(tmp)
    expect(() => loadSubagents(makeProfile(["missing"], tmp))).toThrow(/agent 'missing' not found/)
  })

  it("throws when the agent prompt body is empty", () => {
    const tmp = withLocalAgent("hollow", "---\nname: hollow\ndescription: x\n---\n")
    cleanups.push(tmp)
    expect(() => loadSubagents(makeProfile(["hollow"], tmp))).toThrow(/empty prompt body/)
  })

  it("prefers the load-time snapshot, surviving a dir that no longer exists (branch churn)", () => {
    // Capture from a real dir, then delete it to simulate a task-branch checkout
    // that dropped the capability's agents/. loadSubagents must still succeed.
    const tmp = withLocalAgent("scout", "---\nname: scout\ndescription: snap\n---\nsnapshot body\n")
    const profile = makeProfile(["scout"], tmp)
    profile.subagentTemplates = captureSubagentTemplates(profile)
    fs.rmSync(tmp, { recursive: true, force: true }) // dir gone, like a PR-branch checkout
    const agents = loadSubagents(profile)!
    expect(agents.scout).toEqual({ description: "snap", prompt: "snapshot body" })
  })

  it("captureSubagentTemplates skips unresolved names (best-effort)", () => {
    const tmp = withLocalAgent("present", "---\nname: present\ndescription: x\n---\nbody\n")
    cleanups.push(tmp)
    const snap = captureSubagentTemplates(makeProfile(["present", "absent"], tmp))
    expect(Object.keys(snap)).toEqual(["present"])
  })

  it("falls back to the shared catalog when the implementation dir has no match", () => {
    const catalogAgents = path.join(getPluginsCatalogRoot(), "agents")
    const createdDir = !fs.existsSync(catalogAgents)
    if (createdDir) fs.mkdirSync(catalogAgents, { recursive: true })
    const name = `tmp-catalog-${process.pid}`
    const file = path.join(catalogAgents, `${name}.md`)
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: from catalog\n---\ncatalog body\n`)
    const emptyExec = fs.mkdtempSync(path.join(os.tmpdir(), "kody-subagents-nolocal-"))
    cleanups.push(emptyExec)
    try {
      const agents = loadSubagents(makeProfile([name], emptyExec))!
      expect(agents[name]).toEqual({ description: "from catalog", prompt: "catalog body" })
    } finally {
      fs.rmSync(file, { force: true })
      if (createdDir) fs.rmSync(catalogAgents, { recursive: true, force: true })
    }
  })
})
