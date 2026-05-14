#!/usr/bin/env bash
set -euo pipefail

# Brain runner entrypoint. Long-lived HTTP server (one machine per user)
# that wraps the kody chat loop and speaks the Brain SSE protocol so the
# Kody-Dashboard /api/kody/chat/brain proxy can talk to it unchanged.
#
# Expected env (set on the Fly machine config by the dashboard provisioner):
#   REPO              owner/name of the repo the brain operates inside (required)
#   REF               branch to clone (default: main)
#   GITHUB_TOKEN      PAT with repo + workflow scope (required)
#   BRAIN_API_KEY     bearer key the dashboard sends as x-api-key (required)
#   PORT              HTTP port to listen on (default: 8080)
#   MODEL             model override, e.g. "anthropic/claude-sonnet-4-6" (optional)
#   ALL_SECRETS       JSON blob of provider keys (mirrors GH Actions toJSON(secrets))
#   KODY_LITELLM_URL  optional always-on litellm proxy URL (e.g. http://kody-litellm.internal:4000)

: "${REPO:?REPO is required (owner/name)}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${BRAIN_API_KEY:?BRAIN_API_KEY is required}"

WORKDIR="/workspace/repo"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

# ─── Pre-warm LiteLLM in parallel with the clone (same as runner) ─────────
#
# The chat loop hits the agent on every turn, so a hot LiteLLM saves ~24s
# off the first request. Reuses the runner's pre-warm logic verbatim.
LITELLM_PORT=4000
LITELLM_LOG=/tmp/litellm.log
LITELLM_PID=""

LITELLM_PROVIDERS="anthropic:ANTHROPIC_API_KEY openai:OPENAI_API_KEY gemini:GEMINI_API_KEY minimax:MINIMAX_API_KEY groq:GROQ_API_KEY mistral:MISTRAL_API_KEY deepseek:DEEPSEEK_API_KEY"

prewarm_litellm() {
  if [ -n "${KODY_LITELLM_URL:-}" ]; then
    if ! command -v socat >/dev/null 2>&1; then
      echo "→ brain: KODY_LITELLM_URL set but socat missing — skipping forward"
      return 0
    fi
    local target_host target_port
    target_host="$(echo "$KODY_LITELLM_URL" | sed -E 's#^https?://([^:/]+).*#\1#')"
    target_port="$(echo "$KODY_LITELLM_URL" | sed -nE 's#^https?://[^:]+:([0-9]+).*#\1#p')"
    target_port="${target_port:-4000}"
    if [ -z "$target_host" ]; then
      echo "→ brain: KODY_LITELLM_URL malformed ('${KODY_LITELLM_URL}') — skipping forward"
      return 0
    fi
    echo "→ brain: forwarding localhost:${LITELLM_PORT} → ${target_host}:${target_port} (always-on litellm)"
    socat "TCP-LISTEN:${LITELLM_PORT},reuseaddr,fork" \
          "TCP:${target_host}:${target_port}" \
          >>/tmp/socat.log 2>&1 &
    LITELLM_PID=$!
    return 0
  fi

  if ! command -v litellm >/dev/null 2>&1; then
    echo "→ brain: pre-warm skipped (litellm not in PATH)"
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "→ brain: pre-warm skipped (jq not in PATH)"
    return 0
  fi
  if [ -z "${ALL_SECRETS:-}" ] || [ "${ALL_SECRETS}" = "{}" ]; then
    echo "→ brain: pre-warm skipped (ALL_SECRETS empty)"
    return 0
  fi

  cfg=/tmp/kody-litellm.yaml
  : >"$cfg"
  printf 'model_list:\n' >>"$cfg"

  providersAdded=0
  for entry in $LITELLM_PROVIDERS; do
    provider="${entry%:*}"
    apiKeyVar="${entry#*:}"
    apiKey="$(printf '%s' "$ALL_SECRETS" | jq -r --arg k "$apiKeyVar" '.[$k] // empty' 2>/dev/null || true)"
    if [ -z "$apiKey" ]; then
      continue
    fi
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
    echo "→ brain: pre-warm skipped (no provider keys in ALL_SECRETS)"
    return 0
  fi

  cat >>"$cfg" <<'EOF'

litellm_settings:
  drop_params: true
EOF

  echo "→ brain: pre-warming litellm (providers=${providersAdded}, port=${LITELLM_PORT})"
  litellm --config "$cfg" --port "$LITELLM_PORT" --host 0.0.0.0 \
    >"$LITELLM_LOG" 2>&1 &
  LITELLM_PID=$!
}

prewarm_litellm

# ─── Foreground: clone the repo ────────────────────────────────────────────
AUTH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
CLONE_DEPTH="${CLONE_DEPTH:-1}"
BRANCH="${REF:-${BRANCH:-main}}"
if [ "$CLONE_DEPTH" = "0" ] || [ "$CLONE_DEPTH" = "full" ]; then
  git clone --branch "$BRANCH" "$AUTH_URL" "$WORKDIR"
else
  git clone --depth="$CLONE_DEPTH" --single-branch --branch "$BRANCH" "$AUTH_URL" "$WORKDIR"
fi

cd "$WORKDIR"

git config user.name  "${GIT_AUTHOR_NAME:-Kody Brain}"
git config user.email "${GIT_AUTHOR_EMAIL:-kody-brain@users.noreply.github.com}"

# ─── Wait for LiteLLM (best-effort) ────────────────────────────────────────
if [ -n "$LITELLM_PID" ]; then
  LITELLM_READY=0
  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:${LITELLM_PORT}/health" >/dev/null 2>&1; then
      echo "→ brain: pre-warmed litellm is ready"
      LITELLM_READY=1
      break
    fi
    if ! kill -0 "$LITELLM_PID" 2>/dev/null; then
      echo "→ brain: pre-warm litellm exited early (engine will spawn its own)"
      LITELLM_PID=""
      break
    fi
    sleep 1
  done
  if [ "$LITELLM_READY" = "0" ] && [ -n "$LITELLM_PID" ]; then
    echo "→ brain: pre-warm forward never responded — releasing port"
    kill "$LITELLM_PID" 2>/dev/null || true
    wait "$LITELLM_PID" 2>/dev/null || true
    LITELLM_PID=""
  fi
fi

export PORT="${PORT:-8080}"
export MODEL="${MODEL:-}"
export ALL_SECRETS="${ALL_SECRETS:-{\}}"

echo "→ brain: starting kody brain-serve on :${PORT} (repo=${REPO} ref=${BRANCH})"

# Use the absolute path to the engine's bin script. The `kody` shim on
# PATH is a symlink whose target may be lost between Docker layers in
# some build paths; the absolute path is invariant. If this fails the
# subsequent error will name the missing file directly.
KODY_BIN="/usr/local/lib/node_modules/@kody-ade/kody-engine/dist/bin/kody.js"
if [ ! -f "$KODY_BIN" ]; then
  echo "→ brain: ERROR: $KODY_BIN missing — image build is broken"
  ls -la /usr/local/lib/node_modules/@kody-ade/kody-engine/ 2>&1 || true
  exit 127
fi
exec node "$KODY_BIN" brain-serve
