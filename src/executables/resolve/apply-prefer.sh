#!/usr/bin/env bash
#
# Deterministic conflict resolution for `kody resolve --prefer ours|theirs`.
#
# Runs as a preflight shell entry (see src/executables/resolve/profile.json).
# Gated by runWhen on args.prefer, so it only fires when the user requested
# a side. Reads the side from $KODY_ARG_PREFER (the executor exposes every
# ctx.args.<key> as an env var).
#
# Preconditions set by the prior `resolveFlow` preflight:
#   - cwd is on the PR branch.
#   - `git merge origin/<base> --no-edit --no-ff` already ran and conflicted.
#   - Working tree has unmerged paths.
#
# Behavior: for each unmerged file, git checkout --ours (or --theirs), add,
# commit the merge, push the branch. Prints `KODY_SKIP_AGENT=true` on
# success so the executor bypasses the agent entirely.
#
# Exits:
#   0   — resolved + pushed (or nothing to resolve)
#   64  — invalid side value
#   1+  — git operation failed (executor will surface stderr)

set -euo pipefail

side="${KODY_ARG_PREFER:-}"
if [[ "$side" != "ours" && "$side" != "theirs" ]]; then
  echo "apply-prefer: expected KODY_ARG_PREFER=ours|theirs, got '$side'" >&2
  exit 64
fi

unmerged=$(git diff --name-only --diff-filter=U)
if [[ -z "$unmerged" ]]; then
  echo "apply-prefer: no unmerged paths — nothing to resolve"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

count=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  git checkout "--$side" -- "$f"
  git add -- "$f"
  count=$((count + 1))
done <<< "$unmerged"
echo "apply-prefer: resolved $count file(s) via --$side"

# Complete the merge. git merge left MERGE_MSG in place; --no-edit uses it.
HUSKY=0 SKIP_HOOKS=1 git -c commit.gpgsign=false commit --no-edit

branch=$(git rev-parse --abbrev-ref HEAD)
git push origin "$branch"
echo "apply-prefer: pushed $branch"
echo "KODY_SKIP_AGENT=true"
