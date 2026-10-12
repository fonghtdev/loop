# Render free web service image (Redis inside the container, external Postgres, no Caddy). Build context = repo root:
#   docker build -f deploy/render/Dockerfile -t loop-render .
# The build stage is the same as apps/server/Dockerfile; keep the two in step.
# Debian-slim (not alpine): Prisma's engines need glibc + OpenSSL. No arch-specific steps: builds for amd64 and arm64.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
# openssl must exist before `prisma generate` so it picks the openssl-3 engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g pnpm@12.10.1
WORKDIR /repo
# Only what the server build needs. apps/desktop/package.json is a manifest stub so the lockfile's importers match.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/desktop/package.json apps/desktop/package.json
RUN pnpm install --frozen-lockfile --filter "@loop/server..."
RUN pnpm --filter @loop/shared build \
 && pnpm --filter @loop/server exec prisma generate \
 && pnpm --filter @loop/server exec tsc
# Self-contained copy of the server (workspace package @loop/shared included): regenerate the Prisma client there,
# then drop the dev dependencies.
RUN pnpm --filter @loop/server deploy /out \
 && cp -r apps/server/dist /out/dist \
 && cd /out && pnpm exec prisma generate && pnpm prune --prod \
 && rm -rf src test tsconfig.json vitest.config.ts Dockerfile docker-entrypoint.sh

# The migration CLI (a devDependency, pruned above) at exactly the version the client was generated with.
RUN mkdir /prisma-cli && cd /prisma-cli \
 && npm init -y >/dev/null \
 && npm i --no-audit --no-fund prisma@"$(node -p "require('/repo/apps/server/node_modules/prisma/package.json').version")"

FROM ${NODE_IMAGE} AS runtime
# redis-server: in-container cache (pub/sub + rate-limit counters). tini: PID 1 that forwards signals and reaps.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl redis-server tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256 \
    RATE_LIMIT=on \
    TRUST_PROXY=1
WORKDIR /app
COPY --from=build --chown=node:node /out /app
COPY --from=build --chown=node:node /prisma-cli /prisma-cli
COPY --chown=node:node apps/server/docker-entrypoint.render.sh /app/docker-entrypoint.sh
USER node
EXPOSE 10000
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/health || exit 1
ENTRYPOINT ["tini", "-g", "--", "/app/docker-entrypoint.sh"]
