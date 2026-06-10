#!/usr/bin/env bash
set -euo pipefail

# Entrypoint for a WARM-POOL runner machine (runner-serve mode).
#
# Unlike entrypoint.sh, no REPO/ISSUE_NUMBER is known at boot — the machine
# is generic, gets frozen, and receives its job over HTTP after wake. This
# entrypoint only:
#   1. If KODY_LITELLM_URL is explicitly set, establishes the always-on LiteLLM
#      forward once. Otherwise each job starts/prewarms its own local LiteLLM.
#   2. Execs `kody runner-serve`, which listens until it gets a job.
#
# Expected env (set by the pool owner at create time):
#   RUNNER_API_KEY   bearer key the pool owner uses to POST /run (required)
#   KODY_LITELLM_URL optional always-on LiteLLM proxy URL
#   PORT             listen port (default 8080)

: "${RUNNER_API_KEY:?RUNNER_API_KEY is required}"

# The engine refuses to boot any executable without a kody.config.json in cwd.
# In serve mode we idle in /workspace with no repo yet, so write a minimal
# placeholder. (Per-job runs clone into /workspace/repo and use the repo's
# real config — this file is only for the idle runner-serve process itself.)
cd /workspace
if [ ! -f /workspace/kody.config.json ]; then
  cat > /workspace/kody.config.json <<'EOF'
{
  "agent": { "model": "minimax/MiniMax-M2.7-highspeed" },
  "github": { "owner": "kody-ade", "repo": "pool" }
}
EOF
fi

LITELLM_PORT=4000

# Forward localhost:4000 → the always-on proxy with socat so the engine's
# checkLitellmHealth() succeeds against localhost without a per-job spawn.
# Mirrors entrypoint.sh's KODY_LITELLM_URL branch.
if [ -n "${KODY_LITELLM_URL:-}" ]; then
  if command -v socat >/dev/null 2>&1; then
    target_host="$(echo "$KODY_LITELLM_URL" | sed -E 's#^https?://([^:/]+).*#\1#')"
    target_port="$(echo "$KODY_LITELLM_URL" | sed -nE 's#^https?://[^:]+:([0-9]+).*#\1#p')"
    target_port="${target_port:-4000}"
    if [ -n "$target_host" ]; then
      echo "→ runner-serve: forwarding localhost:${LITELLM_PORT} → ${target_host}:${target_port} (always-on litellm)"
      socat "TCP-LISTEN:${LITELLM_PORT},reuseaddr,fork" \
            "TCP:${target_host}:${target_port}" \
            >>/tmp/socat.log 2>&1 &

      # CRITICAL: wait for the forward to answer /health BEFORE exec'ing kody.
      # The engine's executor calls startLitellmIfNeeded() at boot; if the
      # forward isn't healthy yet it spawns its own litellm, which then races
      # socat for port 4000 and the engine exits 99. Block until 4000 is up
      # (or give up and let the engine spawn its own) — mirrors entrypoint.sh.
      for _ in $(seq 1 30); do
        if curl -sf "http://localhost:${LITELLM_PORT}/health" >/dev/null 2>&1; then
          echo "→ runner-serve: litellm forward is ready"
          break
        fi
        sleep 1
      done
    else
      echo "→ runner-serve: KODY_LITELLM_URL malformed ('${KODY_LITELLM_URL}') — skipping forward"
    fi
  else
    echo "→ runner-serve: socat missing — skipping litellm forward"
  fi
fi

exec kody runner-serve
