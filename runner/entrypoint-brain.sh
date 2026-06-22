#!/usr/bin/env bash
set -euo pipefail

# Brain runner entrypoint. Long-lived HTTP server (one machine per user)
# that wraps the kody chat loop and speaks the Brain SSE protocol so the
# Kody-Dashboard /api/kody/chat/brain proxy can talk to it unchanged.
#
# Two modes (BRAIN_BACKEND):
#   brain-serve (default) — kody-engine's Node.js brain-serve runs on :8080
#   hermes                 — Hermes Agent (Python) runs on :3000, the kody
#                            brain-proxy runs on :8080 and translates
#                            Brain SSE → OpenAI SSE. The kody HTTP MCP server
#                            runs on :8643 and exposes kody's MCP tools to
#                            Hermes as MCP client.
#
# Expected env (set on the Fly machine config by the dashboard provisioner):
#   REPO              owner/name of the repo the brain operates inside (required)
#   REF               branch to clone (default: main)
#   GITHUB_TOKEN      PAT with repo + workflow scope (required)
#   BRAIN_API_KEY     bearer key the dashboard sends as x-api-key (required)
#   BRAIN_BACKEND      "brain-serve" (default) | "hermes" — env override of
#                      kody.config.json brain.mode
#   PORT              HTTP port for brain-serve (default: 8080)
#   MODEL             model override, e.g. "anthropic/claude-sonnet-4-6" (optional)
#   ALL_SECRETS       JSON blob of provider keys (mirrors GH Actions toJSON(secrets))

# REPO is OPTIONAL. A repo-less Brain boots with no work repo and clones
# each repo on demand per chat message (into $BRAIN_REPOS_ROOT). When REPO
# is set we still clone it as a convenience boot repo (back-compat).
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${BRAIN_API_KEY:?BRAIN_API_KEY is required}"

# Per-message repo clones land here regardless of whether a boot repo exists.
# Set explicitly so brain-serve's reposRoot is correct even when the server
# runs from /workspace/brain (whose dirname is /workspace, not the repos root).
export BRAIN_REPOS_ROOT="${BRAIN_REPOS_ROOT:-/workspace/repos}"
mkdir -p "$BRAIN_REPOS_ROOT"

if [ -n "${REPO:-}" ]; then
  WORKDIR="/workspace/repo"
else
  # No boot repo — run from a plain, repo-independent dir. Chat sessions and
  # events live under here (keyed by chatId), not inside any work repo.
  WORKDIR="/workspace/brain"
fi
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

# Flatten ALL_SECRETS into top-level env vars BEFORE anything else looks
# at them. The chat loop / startLitellmIfNeeded reads provider keys from
# process.env directly, and the local LiteLLM config uses `os.environ/<KEY>`.
extract_secrets_to_env() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "→ brain: secret-extract skipped (jq not in PATH)"
    return 0
  fi
  if [ -z "${ALL_SECRETS:-}" ] || [ "${ALL_SECRETS}" = "{}" ]; then
    echo "→ brain: secret-extract skipped (ALL_SECRETS empty)"
    return 0
  fi
  for entry in $LITELLM_PROVIDERS; do
    apiKeyVar="${entry#*:}"
    apiKey="$(printf '%s' "$ALL_SECRETS" | jq -r --arg k "$apiKeyVar" '.[$k] // empty' 2>/dev/null || true)"
    if [ -n "$apiKey" ]; then
      export "$apiKeyVar=$apiKey"
      echo "→ brain: exported $apiKeyVar from ALL_SECRETS"
    fi
  done
}

extract_secrets_to_env

prewarm_litellm() {
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

  cfg=/tmp/kody-local-litellm.yaml
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

# ─── Foreground: clone the boot repo (only when REPO is set) ────────────────
BRANCH="${REF:-${BRANCH:-main}}"
if [ -n "${REPO:-}" ]; then
  AUTH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
  CLONE_DEPTH="${CLONE_DEPTH:-1}"
  if [ "$CLONE_DEPTH" = "0" ] || [ "$CLONE_DEPTH" = "full" ]; then
    git clone --branch "$BRANCH" "$AUTH_URL" "$WORKDIR"
  else
    git clone --depth="$CLONE_DEPTH" --single-branch --branch "$BRANCH" "$AUTH_URL" "$WORKDIR"
  fi
fi

cd "$WORKDIR"

# Committer identity for commits the agent makes. Use --global so it works
# even when WORKDIR is not a git repo (the repo-less boot dir); per-message
# repo clones also set their own identity.
git config --global user.name  "${GIT_AUTHOR_NAME:-Kody Brain}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-kody-brain@users.noreply.github.com}"

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
    echo "→ brain: pre-warm never responded — releasing port"
    kill "$LITELLM_PID" 2>/dev/null || true
    wait "$LITELLM_PID" 2>/dev/null || true
    LITELLM_PID=""
  fi
fi

export PORT="${PORT:-8080}"
export MODEL="${MODEL:-}"
export ALL_SECRETS="${ALL_SECRETS:-\{\}}"

# ─── Resolve brain backend (BRAIN_BACKEND env overrides kody.config.json) ────
# Precedence: BRAIN_BACKEND env > kody.config.json brain.mode > "brain-serve"
# The config file is written by the dashboard provisioner when the Fly Machine
# is created. One machine = one backend (no per-request routing). The env
# override is the dev/CI escape hatch — useful for flipping a machine to
# Hermes without rewriting the config (and redeploying the dashboard side).
BRAIN_BACKEND_FROM_CONFIG=""
if [ -f "$WORKDIR/kody.config.json" ] && command -v jq >/dev/null 2>&1; then
  CONFIG_MODE="$(jq -r '.brain.mode // empty' "$WORKDIR/kody.config.json" 2>/dev/null || true)"
  if [ -n "$CONFIG_MODE" ]; then
    BRAIN_BACKEND_FROM_CONFIG="$CONFIG_MODE"
  fi
fi
# Apply precedence: env wins, then config, then default.
export BRAIN_BACKEND="${BRAIN_BACKEND:-$BRAIN_BACKEND_FROM_CONFIG}"
export BRAIN_BACKEND="${BRAIN_BACKEND:-brain-serve}"

if [ -n "$BRAIN_BACKEND_FROM_CONFIG" ] && [ "$BRAIN_BACKEND" != "$BRAIN_BACKEND_FROM_CONFIG" ]; then
  echo "→ brain: BRAIN_BACKEND='$BRAIN_BACKEND' (env override of kody.config.json brain.mode='$BRAIN_BACKEND_FROM_CONFIG')"
elif [ -n "$BRAIN_BACKEND_FROM_CONFIG" ]; then
  echo "→ brain: BRAIN_BACKEND='$BRAIN_BACKEND' (from kody.config.json brain.mode)"
else
  echo "→ brain: BRAIN_BACKEND='$BRAIN_BACKEND' (default — no kody.config.json brain.mode)"
fi

if [ "$BRAIN_BACKEND" != "brain-serve" ] && [ "$BRAIN_BACKEND" != "hermes" ]; then
  echo "→ brain: ERROR: brain.mode must be 'brain-serve' or 'hermes', got '$BRAIN_BACKEND'"
  exit 2
fi

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

if [ "$BRAIN_BACKEND" = "hermes" ]; then
  # ─── Hermes mode ──────────────────────────────────────────────────────
  # Three processes: Hermes on :3000, the kody brain-proxy on :8080 (the
  # public port the dashboard connects to), and the kody HTTP MCP server on
  # :8643 (Hermes connects to it as an MCP client).

  HERMES_PORT="${HERMES_PORT:-3000}"
  MCP_PORT="${KODY_MCP_HTTP_PORT:-8643}"

  # Start the HTTP MCP server (kody's MCP tools as HTTP endpoints).
  echo "→ brain: starting kody MCP HTTP server on :${MCP_PORT}"
  export KODY_MCP_HTTP_PORT="$MCP_PORT"
  export KODY_MCP_HTTP_HOST="127.0.0.1"
  export KODY_MCP_REPOS_ROOT="$BRAIN_REPOS_ROOT"
  node "$KODY_BIN" mcp-http-server &
  MCP_PID=$!

  # Start Hermes Agent (Python). Configured via ~/.hermes/config.yaml with
  # the API server enabled and the kody MCP server as an external MCP client.
  # NOTE: Hermes reads `mcp_servers` (snake_case), NOT `mcpServers`. The
  # mcpServers key is silently ignored — MCP tools will not load. Always
  # use the snake_case form in this config.
  HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
  mkdir -p "$HERMES_HOME"
  cat >"$HERMES_HOME/config.yaml" <<EOF
platforms:
  api_server:
    enabled: true
    port: ${HERMES_PORT}
    key: ${BRAIN_API_KEY}
mcp_servers:
  kody-fetch-repo:
    url: http://127.0.0.1:${MCP_PORT}/mcp/fetch-repo
    transport: streamable-http
    enabled: true
    headers:
      Authorization: "Bearer ${BRAIN_API_KEY}"
  kody-verify:
    url: http://127.0.0.1:${MCP_PORT}/mcp/verify
    transport: streamable-http
    enabled: true
    headers:
      Authorization: "Bearer ${BRAIN_API_KEY}"
  kody-submit-state:
    url: http://127.0.0.1:${MCP_PORT}/mcp/submit-state
    transport: streamable-http
    enabled: true
    headers:
      Authorization: "Bearer ${BRAIN_API_KEY}"
  kody-agentResponsibility:
    url: http://127.0.0.1:${MCP_PORT}/mcp/agentResponsibility
    transport: streamable-http
    enabled: true
    headers:
      Authorization: "Bearer ${BRAIN_API_KEY}"
model:
  provider: anthropic
  name: ${MODEL:-anthropic/claude-sonnet-4}
EOF

  echo "→ brain: starting Hermes Agent on :${HERMES_PORT}"
  export HERMES_HOME
  hermes gateway --platform api_server &
  HERMES_PID=$!

  # Wait for BOTH the kody MCP server AND Hermes to be ready before
  # starting the proxy. Hermes's MCP client connects to the kody MCP
  # server at boot — if Hermes comes up before the kody MCP server has
  # bound its port, the first chat message in a fresh machine loses its
  # MCP tools. Polling only Hermes's /health let the proxy start while
  # the kody MCP server was still warming up.
  echo "→ brain: waiting for kody MCP server + Hermes to be ready…"
  for _ in $(seq 1 30); do
    if ! kill -0 "$MCP_PID" 2>/dev/null; then
      echo "→ brain: ERROR: kody MCP HTTP server exited before becoming ready"
      exit 1
    fi
    if ! kill -0 "$HERMES_PID" 2>/dev/null; then
      echo "→ brain: ERROR: Hermes exited before becoming ready"
      exit 1
    fi
    if curl -sf "http://127.0.0.1:${MCP_PORT}/healthz" >/dev/null 2>&1 \
      && curl -sf "http://localhost:${HERMES_PORT}/health" >/dev/null 2>&1; then
      echo "→ brain: kody MCP server and Hermes are ready"
      break
    fi
    sleep 1
  done

  # Start the brain proxy (the public port the dashboard connects to).
  # BRAIN_BACKEND was resolved above (env > config > default); we know it
  # is "hermes" because we passed the if-check. No need to re-export.
  echo "→ brain: starting kody brain-proxy on :${PORT} (backend=hermes)"
  export HERMES_URL="http://127.0.0.1:${HERMES_PORT}"
  exec node "$KODY_BIN" brain-proxy
fi

# ─── brain-serve mode (default) ──────────────────────────────────────────

echo "→ brain: starting kody brain-serve on :${PORT} (boot repo=${REPO:-<none, repo-less>} ref=${BRANCH})"
exec node "$KODY_BIN" brain-serve
