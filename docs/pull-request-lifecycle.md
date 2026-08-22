# Pull request lifecycle

Kody uses the same lifecycle labels on the source issue and the pull request so
the Dashboard and GitHub show one consistent state.

| Label | Meaning |
|---|---|
| `kody:running` | Kody is implementing or repairing the task. |
| `kody:reviewing` | Kody delivered a normal pull request and its configured repository gate passed. Pull request CI or human review may still be pending. |
| `kody:failed` | The run or safe-delivery boundary failed. A draft or partial branch may still exist for inspection. |
| `kody:done` | No delivery was needed, or the delivered pull request has merged. |

## Merge finalization

The generated `kody.yml` listens for merged pull requests. When the merged pull
request has a `kody:*` lifecycle label, Kody:

1. changes the pull request label to `kody:done`;
2. reads GitHub closing references such as `Closes #42`, `Fixes #42`, or
   `Resolves #42` from the pull request body;
3. changes each linked issue label to `kody:done`.

Unmerged pull requests and pull requests without a Kody lifecycle label are
ignored. This prevents Kody from taking ownership of unrelated repository work.

`kody:reviewing` does not mean every downstream check has passed. It means the
Engine's configured pre-delivery gate passed and the pull request is available
for its remaining CI and review process.
