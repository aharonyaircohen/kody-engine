#!/usr/bin/env bash
#
# release-deploy: promote the integration branch (dev) to the default
# branch (main). Runs AFTER release-publish has tagged the bump commit
# on dev. No agent.
#
# Behavior:
#   - If release.devBranch is unset OR equals git.defaultBranch:
#       no-op success (single-branch repos have nothing to promote).
#   - Else: fast-forward `defaultBranch` to `devBranch` and push. If a
#     fast-forward isn't possible (defaultBranch has commits dev doesn't
#     have), fall back to `git merge --no-ff` so history is preserved.
#
# After the merge, runs `release.notifyCommand` (if set) as a best-effort
# post-deploy hook.
#
# Inputs (env):
#   KODY_ARG_DRY_RUN          true|false
#   KODY_ARG_ISSUE            triggering issue/PR number (optional)
#
# Config (env):
#   KODY_CFG_GIT_DEFAULTBRANCH         e.g. main
#   KODY_CFG_RELEASE_DEVBRANCH         e.g. dev (unset → no-op)
#   KODY_CFG_RELEASE_NOTIFYCOMMAND     optional; $VERSION substituted
#   KODY_CFG_RELEASE_TIMEOUTMS         per-command timeout in ms (default 600000)
#
# Stdout signals:
#   KODY_REASON=<text>
#   KODY_SKIP_AGENT=true

set -euo pipefail

dry_run="${KODY_ARG_DRY_RUN:-false}"
default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"
dev_branch="${KODY_CFG_RELEASE_DEVBRANCH:-}"
notify_cmd="${KODY_CFG_RELEASE_NOTIFYCOMMAND:-}"
timeout_ms="${KODY_CFG_RELEASE_TIMEOUTMS:-600000}"
timeout_s=$((timeout_ms / 1000))

read_pkg_version() {
  python3 -c "import json; print(json.load(open('package.json'))['version'])" 2>/dev/null || echo "unknown"
}

version=$(read_pkg_version)
echo "→ release deploy: v${version}"

# Single-branch repos: nothing to promote.
if [[ -z "$dev_branch" || "$dev_branch" == "$default_branch" ]]; then
  echo "KODY_REASON=no devBranch configured (or equals defaultBranch) — nothing to promote"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

if [[ "$dry_run" == "true" ]]; then
  echo "KODY_REASON=dry-run — would merge ${dev_branch} into ${default_branch}"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

export HUSKY=0 SKIP_HOOKS=1 CI="${CI:-1}"

# Sync local refs.
git fetch origin "$dev_branch" "$default_branch" --tags

# Move to defaultBranch and reset to its remote tip.
git checkout "$default_branch"
git reset --hard "origin/$default_branch"

# Try fast-forward first; fall back to a merge commit.
if git merge --ff-only "origin/$dev_branch" 2>/dev/null; then
  echo "  fast-forwarded ${default_branch} to origin/${dev_branch}"
else
  echo "  fast-forward not possible — using --no-ff merge"
  if ! git -c commit.gpgsign=false merge --no-ff "origin/$dev_branch" -m "chore: deploy ${dev_branch} → ${default_branch} (v${version})"; then
    echo "KODY_REASON=release deploy: merge ${dev_branch} into ${default_branch} failed (conflicts?)"
    echo "KODY_SKIP_AGENT=true"
    exit 1
  fi
fi

if ! git push origin "$default_branch"; then
  echo "KODY_REASON=release deploy: push to origin/${default_branch} failed"
  echo "KODY_SKIP_AGENT=true"
  exit 1
fi

echo "  pushed ${default_branch}"

# Optional post-deploy notification.
notify_status="skipped"
if [[ -n "$notify_cmd" ]]; then
  cmd="${notify_cmd//\$VERSION/$version}"
  echo "  notify: ${cmd}"
  if timeout "${timeout_s}" bash -c "$cmd"; then
    notify_status="ok"
  else
    notify_status="failed"
    echo "[kody release-deploy] notifyCommand failed (non-fatal)" >&2
  fi
fi

echo "KODY_REASON=promoted ${dev_branch} → ${default_branch} (notify=${notify_status})"
echo "KODY_SKIP_AGENT=true"
