#!/usr/bin/env bash
set -euo pipefail

# Expected env (passed by dashboard when spawning the Fly Machine):
#   REPO            owner/name of the repo to operate on (required)
#   REF             branch/sha to checkout (default: default branch)
#   GITHUB_TOKEN    PAT or installation token with repo scope (required)
#   SESSION_ID      chat session id (chat mode)
#   INIT_MESSAGE    initial chat message (chat mode)
#   MODEL           model override (optional, e.g. "gemini/gemini-2.5-flash")
#   DASHBOARD_URL   event ingest URL with inline ?token=... (chat mode)
#   ALL_SECRETS     JSON blob of secrets the engine reads (mirrors Actions toJSON(secrets))
#   ISSUE_NUMBER    issue number (agent mode)

: "${REPO:?REPO is required (owner/name)}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

WORKDIR="/workspace/repo"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

# ─── In parallel: pre-warm LiteLLM while the repo clones ───────────────────
#
# The engine spawns LiteLLM lazily, after reading the session file from
# the cloned repo. That serializes ~24s clone + ~27s LiteLLM start.
# LiteLLM doesn't need the repo (or any specific model — it only needs
# provider keys), so we kick it off in the background while git runs.
# The engine's checkLitellmHealth() detects the live process and reuses
# it instead of spawning a duplicate.
#
# We don't pick a model here — that's the engine's job. Instead we
# build a LiteLLM config from whichever provider keys exist in
# ALL_SECRETS using LiteLLM's wildcard syntax (`<provider>/*`). Any
# model the engine eventually picks routes to its provider via the
# matching key.
#
# If LiteLLM isn't installed, jq is missing, or ALL_SECRETS contains
# no recognized provider key, pre-warm silently skips and the engine
# falls back to its own spawn — same wall time as today, no worse.
LITELLM_PORT=4000
LITELLM_LOG=/tmp/litellm.log
LITELLM_PID=""

# Provider → API key env var. Mirrors kody2/src/config.ts
# providerApiKeyEnvVar(). Add new providers in lockstep when the
# engine learns about them.
declare -A LITELLM_PROVIDER_KEY=(
  [anthropic]=ANTHROPIC_API_KEY
  [openai]=OPENAI_API_KEY
  [gemini]=GEMINI_API_KEY
  [minimax]=MINIMAX_API_KEY
  [groq]=GROQ_API_KEY
  [mistral]=MISTRAL_API_KEY
  [deepseek]=DEEPSEEK_API_KEY
)

prewarm_litellm() {
  if ! command -v litellm >/dev/null 2>&1; then return 0; fi
  if ! command -v jq >/dev/null 2>&1; then return 0; fi
  if [ -z "${ALL_SECRETS:-}" ]; then return 0; fi

  local cfg=/tmp/kody-litellm.yaml
  : >"$cfg"
  printf 'model_list:\n' >>"$cfg"

  local providersAdded=0
  for provider in "${!LITELLM_PROVIDER_KEY[@]}"; do
    local apiKeyVar="${LITELLM_PROVIDER_KEY[$provider]}"
    local apiKey
    apiKey="$(printf '%s' "$ALL_SECRETS" | jq -r --arg k "$apiKeyVar" '.[$k] // empty' 2>/dev/null || true)"
    [ -z "$apiKey" ] && continue
    export "$apiKeyVar=$apiKey"
    cat >>"$cfg" <<EOF
  - model_name: "${provider}/*"
    litellm_params:
      model: "${provider}/*"
      api_key: os.environ/${apiKeyVar}
EOF
    providersAdded=$((providersAdded + 1))
  done

  if [ "$providersAdded" -eq 0 ]; then
    return 0  # No provider keys to warm with.
  fi

  cat >>"$cfg" <<'EOF'

litellm_settings:
  drop_params: true
EOF

  echo "→ runner: pre-warming litellm (providers=${providersAdded}, port=${LITELLM_PORT})"
  litellm --config "$cfg" --port "$LITELLM_PORT" --host 0.0.0.0 \
    >"$LITELLM_LOG" 2>&1 &
  LITELLM_PID=$!
}

prewarm_litellm

# ─── Foreground: clone the repo ────────────────────────────────────────────
#
# BRANCH defaults to "main" to match the GH Actions path (kody.yml's
# workflow_dispatch always uses ref:main; session JSONL is written to main
# by the dashboard).
AUTH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
CLONE_DEPTH="${CLONE_DEPTH:-1}"
BRANCH="${REF:-${BRANCH:-main}}"
if [ "$CLONE_DEPTH" = "0" ] || [ "$CLONE_DEPTH" = "full" ]; then
  git clone --branch "$BRANCH" "$AUTH_URL" "$WORKDIR"
else
  git clone --depth="$CLONE_DEPTH" --single-branch --branch "$BRANCH" "$AUTH_URL" "$WORKDIR"
fi

cd "$WORKDIR"

# Configure committer identity so the engine's git commit calls succeed.
git config user.name  "${GIT_AUTHOR_NAME:-Kody Bot}"
git config user.email "${GIT_AUTHOR_EMAIL:-kody-bot@users.noreply.github.com}"

# ─── Wait for the LiteLLM pre-warm to be ready (or timeout) ────────────────
#
# By the time the clone finishes, LiteLLM is usually already listening.
# We block briefly to make sure it's up before exec'ing kody — otherwise
# the engine would spawn its own and waste the parallelism we just gained.
if [ -n "$LITELLM_PID" ]; then
  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:${LITELLM_PORT}/health" >/dev/null 2>&1; then
      echo "→ runner: pre-warmed litellm is ready"
      break
    fi
    if ! kill -0 "$LITELLM_PID" 2>/dev/null; then
      echo "→ runner: pre-warm litellm exited early (engine will spawn its own)"
      LITELLM_PID=""
      break
    fi
    sleep 1
  done
fi

export SESSION_ID="${SESSION_ID:-}"
export INIT_MESSAGE="${INIT_MESSAGE:-}"
export MODEL="${MODEL:-}"
export DASHBOARD_URL="${DASHBOARD_URL:-}"
export ALL_SECRETS="${ALL_SECRETS:-{\}}"
export ISSUE_NUMBER="${ISSUE_NUMBER:-}"

exec kody
