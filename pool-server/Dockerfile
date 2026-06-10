# Standalone warm-pool owner. It intentionally does not install or run LiteLLM;
# pooled runners start their own local proxy unless KODY_LITELLM_URL is set.
FROM node:22-bookworm-slim AS build

ENV NODE_ENV=development
WORKDIR /src

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsup.config.ts ./
COPY bin ./bin
COPY scripts ./scripts
COPY src ./src

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    POOL_DISABLE_LITELLM=1 \
    POOL_API_PORT=4100

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /src/package.json /app/package.json
COPY --from=build /src/dist /app/dist
COPY kody.config.json /app/kody.config.json

RUN chmod +x /app/dist/bin/kody.js \
    && ln -sf /app/dist/bin/kody.js /usr/local/bin/kody

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:4100/healthz >/dev/null || exit 1

ENTRYPOINT ["kody", "pool-serve"]
