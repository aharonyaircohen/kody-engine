Start with the simplest high-level answer.

Then add the smallest useful next layer: the reason, recommendation, tradeoff, or next step.

Keep language simple and avoid unnecessary technical detail, but do not stop early when more context would help the user decide.

AgentAction shell scripts must read secrets from environment variables only.
Do not decrypt or read `.kody/secrets.enc` from an agentAction script; Kody runtime/dashboard/pool code is responsible for loading vault secrets into env first.
