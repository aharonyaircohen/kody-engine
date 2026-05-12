#!/usr/bin/env bash
set -euo pipefail

# Expected env (passed by dashboard when spawning the Fly Machine):
#   REPO            owner/name of the repo to operate on (required)
#   REF             branch/sha to checkout (default: default branch)
#   GITHUB_TOKEN    PAT or installation token with repo scope (required)
#   SESSION_ID      chat session id (chat mode)
#   INIT_MESSAGE    initial chat message (chat mode)
#   MODEL           model override (optional)
#   DASHBOARD_URL   event ingest URL with inline ?token=... (chat mode)
#   ALL_SECRETS     JSON blob of secrets the engine reads (mirrors Actions toJSON(secrets))
#   ISSUE_NUMBER    issue number (agent mode)

: "${REPO:?REPO is required (owner/name)}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

WORKDIR="/workspace/repo"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

# Authenticated clone. The remote URL keeps the token so the engine's
# subsequent commits/pushes work without re-supplying creds. `x-access-token`
# is the standard username GitHub expects when the token is the password.
AUTH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
git clone "$AUTH_URL" "$WORKDIR"

cd "$WORKDIR"

# Configure committer identity so the engine's git commit calls succeed.
git config user.name  "${GIT_AUTHOR_NAME:-Kody Bot}"
git config user.email "${GIT_AUTHOR_EMAIL:-kody-bot@users.noreply.github.com}"

if [ -n "${REF:-}" ]; then
  git fetch origin "$REF" --depth=1
  git checkout "$REF"
fi

export SESSION_ID="${SESSION_ID:-}"
export INIT_MESSAGE="${INIT_MESSAGE:-}"
export MODEL="${MODEL:-}"
export DASHBOARD_URL="${DASHBOARD_URL:-}"
export ALL_SECRETS="${ALL_SECRETS:-{\}}"
export ISSUE_NUMBER="${ISSUE_NUMBER:-}"

exec kody
