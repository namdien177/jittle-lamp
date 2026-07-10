# syntax=docker/dockerfile:1

FROM oven/bun:1.3.13-slim AS build

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.base.json /app/tsconfig.base.json
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/evidence-web/package.json ./apps/evidence-web/package.json
COPY apps/extension/package.json ./apps/extension/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/viewer-core/package.json ./packages/viewer-core/package.json
COPY packages/viewer-react/package.json ./packages/viewer-react/package.json

RUN bun install --frozen-lockfile --production --filter @jittle-lamp/backend

COPY packages/shared ./packages/shared
COPY apps/backend ./apps/backend

RUN bun run --cwd packages/shared build:js
RUN bun run --cwd apps/backend build:js

FROM oven/bun:1.3.13-slim AS runtime

WORKDIR /app/apps/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/apps/backend/package.json ./package.json
COPY --from=build /app/apps/backend/bun.lock ./bun.lock
COPY --from=build /app/apps/backend/dist ./dist
COPY --from=build /app/apps/backend/drizzle ./drizzle

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    RUN_DB_MIGRATIONS=true

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "const port = process.env.PORT || '3001'; const res = await fetch(`http://127.0.0.1:${port}/health`); if (!res.ok) process.exit(1);"]

CMD ["bun", "./dist/index.js"]
