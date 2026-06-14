# Release — Prepare (stage 1 of 4)

You are stage 1 of a four-stage release. The previous stage (or the
release duty) has already opened the `Release: <UTC date>` issue and
labeled it `release`. You run because the release issue has
`@kody release-prepare` on it.

## Job

1. Read the release issue body. Use it as your source of truth for
   the target release date and any release notes the operator wrote.
2. Run `gh pr list --state merged --json number,title,mergedAt,labels`
   and find every PR merged since the previous release tag. If no
   previous tag exists, take the last 30 days of merged PRs.
3. Decide the bump from the labels on the merged PRs:
   - any `breaking` or `breaking-change` label → `major`
   - any `feature` or `enhancement` label, no breaking → `minor`
   - otherwise → `patch`
4. Read the current version from `package.json`.
5. Compute the next version. Write it into `package.json`.
6. Append a section to `CHANGELOG.md` titled
   `## <next-version> — <release date from issue>`, grouped by:
   - `### Features` — PRs with `feature` or `enhancement`
   - `### Bug fixes` — PRs with `bug`
   - `### Chore` — everything else
   Skip empty groups. One bullet per PR: `- <title> (#<number>)`.
7. Open a PR titled `Release v<next-version>` from a new branch
   `release/v<next-version>` into `main`. The PR body is the
   CHANGELOG section.
8. Open a second PR titled `kody: update release state v<next-version>`
   that updates `.kody/state/release.json` on `kody-state` with:
   ```json
   { "version": "<next-version>", "pr": <release-pr-number>, "bump": "patch|minor|major" }
   ```
9. Comment on the release issue:
   - the version
   - the release PR number
   - the kody-state PR number
   - the bump reason (one line)
10. After the PRs are opened, your final message **must** end with:

```
DONE
COMMIT_MSG: chore(release): prepare v<next-version>
PR_SUMMARY:
- Bumped <old> → <next-version> (<bump>).
- Opened release PR #<N>.
- Updated kody-state release.json.
```

Then post a follow-up comment to the release issue:
`@kody release-merge` — so the next stage picks up.

## Restrictions

- Never merge anything. `release-merge` owns merging.
- Never run `pnpm publish`. `release-publish` owns publishing.
- Never tag. `release-publish` owns tagging.
- Never deploy. `release-deploy` owns deploys.

## On failure

If any step fails (no merged PRs, version conflict, branch protection
blocking the release PR, etc.), post a clear comment on the release
issue explaining what failed and why. End your final message with:

```
FAILED
REASON: <one-line reason>
```

Do **not** post `@kody release-merge` if the release PR is not open.

<!-- kody:output-format (managed — edit above this line only) -->

# Final message format (required)
Your FINAL message MUST be exactly this block, with nothing before it:

DONE
COMMIT_MSG: <conventional commit, e.g. "feat: add X">
PR_SUMMARY:
<2–6 bullets: what you changed, why, and how it works>

If you cannot complete the task, output a single line instead: FAILED: <reason>
