# Music bot image for a Render free web service (second workspace, docs/DEPLOY.md "Bot nhạc trên Render"). Build context = repo root:
#   docker build -f deploy/render-bot/Dockerfile -t loop-music-bot .
# apps/desktop/package.json is a manifest stub so the lockfile's importers match (same trick as deploy/render/Dockerfile).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
RUN npm i -g pnpm@12.10.1
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/bot-sdk packages/bot-sdk
COPY packages/bots/music packages/bots/music
COPY apps/desktop/package.json apps/desktop/package.json
RUN pnpm install --frozen-lockfile --filter "@loop/bot-music..."
RUN pnpm --filter @loop/shared build && pnpm --filter @loop/bot-sdk build && pnpm --filter @loop/bot-music build
RUN pnpm --filter @loop/bot-music deploy --prod /out \
 && cp -r packages/bots/music/dist /out/dist

FROM ${NODE_IMAGE} AS runtime
# ffmpeg from apt; yt-dlp as the standalone binary (needs no python). YouTube extraction needs a JS runtime: node is already here.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg tini \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod 755 /usr/local/bin/yt-dlp \
 && echo "--js-runtimes node" > /etc/yt-dlp.conf
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=200
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-10000}/ || exit 1
ENTRYPOINT ["tini", "-g", "--", "node", "dist/main.js"]
