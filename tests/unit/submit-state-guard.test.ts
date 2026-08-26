import { describe, expect, it } from "vitest"
import { createSubmitStateStopHook } from "../../src/submitStateGuard.js"

describe("submit state completion guard", () => {
  it("allows completion after state was submitted", async () => {
    const hook = createSubmitStateStopHook(() => ({ cursor: "waiting", data: {}, done: false }))

    await expect(hook()).resolves.toEqual({})
  })

  it("blocks the first stop without state and asks only for submission", async () => {
    const hook = createSubmitStateStopHook(() => undefined)

    await expect(hook()).resolves.toMatchObject({
      decision: "block",
      reason: expect.stringMatching(/call `submit_state` exactly once/i),
    })
  })

  it("allows the second stop without state so deterministic postflight reports the failure", async () => {
    const hook = createSubmitStateStopHook(() => undefined)

    await hook()

    await expect(hook()).resolves.toEqual({})
  })

  it("allows completion when state is submitted during the final chance", async () => {
    let submitted = false
    const hook = createSubmitStateStopHook(() =>
      submitted ? { cursor: "checking", data: { pending: true }, done: false } : undefined,
    )

    await hook()
    submitted = true

    await expect(hook()).resolves.toEqual({})
  })
})
