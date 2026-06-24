import { execFileSync } from "node:child_process"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { generateLitellmConfigYaml, resolveLitellmCommand } from "../../src/litellm.js"

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawn: vi.fn() }))

const mockExec = vi.mocked(execFileSync)

/**
 * Route the mocked execFileSync by command:
 *   - `which litellm`      → whichOk
 *   - `python3 -c import…` → next value of importOkSeq (so we can fail-then-succeed)
 *   - `pip|pip3 install`   → pipOk
 */
function routeExec(opts: { whichOk: boolean; importOkSeq: boolean[]; pipOk: boolean; scriptPath?: string }) {
  let importCall = 0
  mockExec.mockImplementation(((file: string, args?: readonly string[]) => {
    const a = args ?? []
    if (file === "which") {
      if (opts.whichOk) return Buffer.from("")
      throw new Error("not on PATH")
    }
    if (file === "python3" && a[0] === "-c") {
      // `import litellm` is the importability probe; any other -c snippet is the
      // console-script locator (returns the path string, or "" when missing).
      if (a[1] === "import litellm") {
        const ok = opts.importOkSeq[Math.min(importCall, opts.importOkSeq.length - 1)]
        importCall++
        if (ok) return Buffer.from("")
        throw new Error("ImportError")
      }
      return opts.scriptPath ?? "/py/bin/litellm"
    }
    if (file === "pip" || file === "pip3") {
      if (opts.pipOk) return Buffer.from("")
      throw new Error("pip failed")
    }
    return Buffer.from("")
  }) as never)
}

describe("litellm: generateLitellmConfigYaml", () => {
  beforeEach(() => mockExec.mockReset())

  it("emits a model_list with provider/model and api_key env var", () => {
    const yaml = generateLitellmConfigYaml({ provider: "minimax", model: "MiniMax-M2.7-highspeed" })
    expect(yaml).toMatch(/model_list:/)
    expect(yaml).toMatch(/model_name: MiniMax-M2\.7-highspeed/)
    expect(yaml).toMatch(/model: minimax\/MiniMax-M2\.7-highspeed/)
    expect(yaml).toMatch(/api_key: os\.environ\/MINIMAX_API_KEY/)
  })

  it("includes drop_params: true to silence non-anthropic warnings", () => {
    const yaml = generateLitellmConfigYaml({ provider: "openai", model: "gpt-4o" })
    expect(yaml).toMatch(/drop_params: true/)
  })

  it("derives api_key env var from provider name", () => {
    const yaml = generateLitellmConfigYaml({ provider: "openai", model: "gpt-4o" })
    expect(yaml).toMatch(/api_key: os\.environ\/OPENAI_API_KEY/)
  })
})

describe("litellm: resolveLitellmCommand (auto-install)", () => {
  beforeEach(() => mockExec.mockReset())

  it("returns 'litellm' when the binary is on PATH", () => {
    routeExec({ whichOk: true, importOkSeq: [false], pipOk: false })
    expect(resolveLitellmCommand()).toBe("litellm")
  })

  it("returns the console-script path when importable but not on PATH, without installing", () => {
    routeExec({ whichOk: false, importOkSeq: [true], pipOk: false, scriptPath: "/py/bin/litellm" })
    // NOT "python3" — `python3 -m litellm` is invalid (no __main__); must use the script.
    expect(resolveLitellmCommand()).toBe("/py/bin/litellm")
    expect(mockExec).not.toHaveBeenCalledWith("pip", expect.arrayContaining(["install"]), expect.anything())
  })

  it("installs on demand when missing, then returns the script path", () => {
    routeExec({ whichOk: false, importOkSeq: [false, true], pipOk: true, scriptPath: "/py/bin/litellm" })
    expect(resolveLitellmCommand()).toBe("/py/bin/litellm")
    // pip install was attempted (this is the gap that broke scheduled agentResponsibilities)
    const installed = mockExec.mock.calls.some(
      (c) => (c[0] === "pip" || c[0] === "pip3") && Array.isArray(c[1]) && c[1].includes("install"),
    )
    expect(installed).toBe(true)
  })

  it("throws a clear error when install fails", () => {
    routeExec({ whichOk: false, importOkSeq: [false], pipOk: false })
    expect(() => resolveLitellmCommand()).toThrow(/auto-install failed/)
  })
})
