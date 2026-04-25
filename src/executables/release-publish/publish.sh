#!/usr/bin/env bash
#
# release-publish: tag the current package version, push the tag, run the
# configured publishCommand (e.g. `pnpm publish --access public`), create
# the GitHub release. Runs AFTER the orchestrator has merged the release
# PR into the default branch. No agent.
#
# Inputs (env):
#   KODY_ARG_DRY_RUN          true|false
#   KODY_ARG_ISSUE            triggering issue/PR number (optional)
#
# Config (env):
#   KODY_CFG_GIT_DEFAULTBRANCH         e.g. main
#   KODY_CFG_RELEASE_PUBLISHCOMMAND    optional; $VERSION is substituted
#   KODY_CFG_RELEASE_DRAFTRELEASE      "true" → create as draft
#   KODY_CFG_RELEASE_TIMEOUTMS         publish timeout (default 600000ms)
#
# Stdout signals:
#   KODY_REASON=<text>
#   KODY_PR_URL=<release URL>   — gh release create URL (used as the "PR" link)
#   KODY_SKIP_AGENT=true

set -euo pipefail

dry_run="${KODY_ARG_DRY_RUN:-false}"
default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"
publish_cmd="${KODY_CFG_RELEASE_PUBLISHCOMMAND:-}"
draft="${KODY_CFG_RELEASE_DRAFTRELEASE:-false}"
timeout_ms="${KODY_CFG_RELEASE_TIMEOUTMS:-600000}"
timeout_s=$((timeout_ms / 1000))

fail() {
  echo "KODY_REASON=$1"
  echo "KODY_SKIP_AGENT=true"
  exit "${2:-1}"
}

read_pkg_version() {
  python3 -c "import json; print(json.load(open('package.json'))['version'])"
}

if [[ ! -f package.json ]]; then
  fail "release publish: package.json not found" 99
fi

export HUSKY=0 SKIP_HOOKS=1 CI="${CI:-1}"

# Make sure we're on the merged commit. The orchestrator merged the release
# PR into default_branch; pull so the local tree has the bump commit.
git fetch origin "$default_branch" --tags
git checkout "$default_branch"
git reset --hard "origin/$default_branch"

version=$(read_pkg_version)
tag="v${version}"

echo "→ release publish: ${tag}"

# Refuse if the tag already exists locally (left over from a prior failed run).
if git rev-parse --verify "$tag" >/dev/null 2>&1; then
  fail "release publish: tag ${tag} already exists" 1
fi

if [[ "$dry_run" == "true" ]]; then
  echo "KODY_REASON=dry-run — would tag + publish ${tag}"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Tag + push.
git tag -a "$tag" -m "Release ${tag}"
git push origin "$tag"

# publishCommand (optional). Failure here is recorded but does not abort —
# we still want the GH release entry so the tag is discoverable.
publish_status="skipped"
if [[ -n "$publish_cmd" ]]; then
  cmd="${publish_cmd//\$VERSION/$version}"
  echo "  publish: ${cmd}"
  if timeout "${timeout_s}" bash -c "$cmd"; then
    publish_status="ok"
  else
    publish_status="failed"
    echo "[kody release-publish] publishCommand failed (continuing to create GH release)" >&2
  fi
fi

# GitHub release.
release_url=""
draft_flag=""
[[ "$draft" == "true" ]] && draft_flag="--draft"
if release_url=$(gh release create "$tag" --title "$tag" --notes "Release ${tag} — automated by kody." $draft_flag 2>&1); then
  :
else
  echo "[kody release-publish] gh release create failed: $release_url" >&2
  release_url=""
fi

echo "RELEASE_TAG=${tag}"
[[ -n "$release_url" ]] && echo "RELEASE_URL=${release_url}"

if [[ "$publish_status" == "failed" ]]; then
  echo "KODY_REASON=tag + GH release created, but publishCommand failed"
  echo "KODY_SKIP_AGENT=true"
  exit 1
fi

[[ -n "$release_url" ]] && echo "KODY_PR_URL=${release_url}"
echo "KODY_REASON=tagged ${tag}, published${publish_status:+ ($publish_status)}"
echo "KODY_SKIP_AGENT=true"
