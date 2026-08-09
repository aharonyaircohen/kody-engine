{{prompt}}

## Delivery

The delivery wrapper has already checked out the requested target before you
start. Inspect and edit the current working tree. Do not fetch, checkout, sync,
merge, commit, push, or run any other git or GitHub write command; the wrapper
owns those operations.

After completing the capability work, finish with exactly this structure:

DONE
PLAN_DEVIATIONS: none
COMMIT_MSG: <conventional commit message>
PR_SUMMARY:
- <what changed>
```json
<the capability result matching its output contract>
```
