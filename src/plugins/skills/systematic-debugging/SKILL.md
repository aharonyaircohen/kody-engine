---
name: systematic-debugging
description: Use when a test fails, a build breaks, or runtime behavior is wrong and the cause is not immediately obvious — especially before changing code to "see if it helps".
---

# Systematic debugging

A failing check is a question ("why did this happen?"), not a prompt to start
editing. Guessing-and-checking edits the code before you understand it; it
usually masks the symptom, leaves the real bug, and burns turns. Find the cause
first, then make one targeted fix.

## The loop

1. **Reproduce.** Run the exact failing command and read the FULL output and
   exit code — not a summary, not memory of a past run. If you can't reproduce
   it, you can't fix it; say so.
2. **Isolate.** Narrow to the smallest input/file/line that still fails. Read
   the full failing function and the code that calls it — the cause often sits
   outside the line the error points at.
3. **Find the root cause.** State, in one sentence, the actual mechanism: "X is
   null here because Y never set it." If you can't write that sentence, you
   don't understand it yet — keep reading, don't start editing.
4. **Fix the cause, not the symptom.** Make the smallest change that addresses
   the mechanism you named. Do not swallow the error, loosen the assertion, or
   special-case the one failing input to make it pass.
5. **Verify.** Re-run the exact command from step 1, fresh. Confirm it now
   passes AND that you didn't break a sibling — run the surrounding tests too.

## Red flags — stop if you think any of these

| The thought | The reality |
|---|---|
| "Let me just try this and see if it works." | You're editing before you understand. Reproduce and isolate first. |
| "I'll wrap it in try/catch / loosen the test." | That hides the bug, it doesn't fix it. Find why it throws. |
| "It only fails sometimes, probably flaky." | "Probably" is not a root cause. Isolate the condition that triggers it. |
| "The fix is obvious from the error message." | Confirm the mechanism by reading the code; error messages mislead. |

## When you're stuck

If two genuine attempts at the root cause fail, stop and say what you tried,
what you ruled out, and what you'd need to get unblocked. An honest dead-end
beats a symptom-masking patch that ships a latent bug.
