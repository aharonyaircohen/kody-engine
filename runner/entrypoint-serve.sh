#!/usr/bin/env bash
set -euo pipefail

# Entrypoint for a WARM-POOL runner machine (runner-serve mode).
#
# Unlike entrypoint.sh, no REPO/ISSUE_NUMBER is known at boot — the machine
# is generic, gets frozen, and receives its job over HTTP after wake. This
# entrypoint only:
#   1. Writes the minimal idle config needed before any repo is cloned.
#   2. Execs `kody runner-serve`, which listens until it gets a job. The job
#      runner starts/prewarms its own local LiteLLM from repo secrets.
#
# Expected env (set by the pool owner at create time):
#   RUNNER_API_KEY   bearer key the pool owner uses to POST /run (required)
#   PORT             listen port (default 8080)

: "${RUNNER_API_KEY:?RUNNER_API_KEY is required}"

start_local_test_database() {
  if [ -n "${DATABASE_URL:-}" ] || ! command -v pg_ctlcluster >/dev/null 2>&1; then
    return 0
  fi
  if ! pg_isready -q; then
    pg_ctlcluster 15 main start
  fi
  export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres"
  export PAYLOAD_SECRET="${PAYLOAD_SECRET:-kody-local-runner-test-secret}"
  echo "→ runner: local PostgreSQL ready for repository verification"
}

start_local_test_database

# The engine refuses to boot any executable without a kody.config.json in cwd.
# In serve mode we idle in /workspace with no repo yet, so write a minimal
# placeholder. (Per-job runs clone into /workspace/repo and use the repo's
# real config — this file is only for the idle runner-serve process itself.)
cd /workspace
if [ ! -f /workspace/kody.config.json ]; then
  cat > /workspace/kody.config.json <<'EOF'
{
  "agent": { "model": "minimax/MiniMax-M3" },
  "github": { "owner": "kody-ade", "repo": "pool" }
}
EOF
fi

exec kody runner-serve
