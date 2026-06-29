#!/bin/bash
set -e
rm -rf /tmp/test-with-store
mkdir -p /tmp/test-with-store/.kody/agent-actions/smoke-impl
mkdir -p /tmp/test-with-store/.kody/agent-responsibilities
mkdir -p /tmp/test-with-store/.kody/agents
cat > /tmp/test-with-store/kody.config.json << 'EOFCONFIG'
{
  "quality": { "typecheck": "", "lint": "", "format": "", "testUnit": "" },
  "git": { "defaultBranch": "main" },
  "github": { "owner": "o", "repo": "r" },
  "agent": { "model": "anthropic/test" }
}
EOFCONFIG
cat > /tmp/test-with-store/.kody/agents/kody.md << 'EOF'
# Kody
