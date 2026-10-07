# syntax=docker/dockerfile:1
# Cloud runner pool image: jl-e2e-runner with Playwright's Chromium (design.md §5.4, ADR 0002 decision 3).
# Build from the repository root:
#   docker build -f deploy/runner/Dockerfile -t jittle-lamp/e2e-runner .

FROM node:22-bookworm-slim AS build

ENV BUN_INSTALL=/opt/bun PATH=/opt/bun/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/evidence-web/package.json ./apps/evidence-web/package.json
COPY apps/extension/package.json ./apps/extension/package.json
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/viewer-core/package.json ./packages/viewer-core/package.json
COPY packages/viewer-react/package.json ./packages/viewer-react/package.json
COPY packages/e2e-runner/package.json ./packages/e2e-runner/package.json

RUN bun install --frozen-lockfile --production --filter @jittle-lamp/e2e-runner --ignore-scripts --no-optional \
  # Local Claude Code login is development-only; the cloud runner does not ship its native CLI.
  && rm -rf node_modules/ai-sdk-provider-claude-code node_modules/@anthropic-ai/claude-agent-sdk*

COPY packages/shared ./packages/shared
COPY packages/e2e-runner ./packages/e2e-runner
RUN bun run --cwd packages/shared build:js && bun run --cwd packages/e2e-runner build

FROM node:22-bookworm-slim AS runtime

# The generated project loads runtime TypeScript and its model/cache helpers through e2e's loader.
WORKDIR /app
COPY --from=build /app/node_modules /app/node_modules

ENV NODE_ENV=production \
    E2E_TELEMETRY_DISABLED=1 \
    JL_RUNNER_WORK_DIR=/var/lib/jl-e2e-runner \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Keep the browser layer independent of application source changes.
RUN node node_modules/playwright/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1001 pwuser && useradd --uid 1001 --gid 1001 --create-home pwuser \
  && mkdir -p /var/lib/jl-e2e-runner /home/pwuser/.config/jittle-lamp/runner \
  && chown -R pwuser:pwuser /var/lib/jl-e2e-runner /home/pwuser/.config

COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/e2e-runner/package.json /app/packages/e2e-runner/package.json
COPY --from=build /app/packages/e2e-runner/dist /app/packages/e2e-runner/dist
COPY --from=build /app/packages/e2e-runner/macros /app/packages/e2e-runner/macros
COPY --from=build /app/packages/e2e-runner/src/runtime /app/packages/e2e-runner/src/runtime
COPY --from=build /app/packages/e2e-runner/src/model /app/packages/e2e-runner/src/model
COPY --from=build /app/packages/e2e-runner/src/cache/render.ts /app/packages/e2e-runner/src/cache/render.ts

RUN ln -s /app/packages/e2e-runner/dist/cli.js /usr/local/bin/jl-e2e \
  && ln -s /app/packages/e2e-runner/dist/daemon.js /usr/local/bin/jl-e2e-runner \
  && chmod +x /app/packages/e2e-runner/dist/cli.js /app/packages/e2e-runner/dist/daemon.js \
  && node /app/packages/e2e-runner/dist/cli.js help >/dev/null

USER pwuser
VOLUME ["/home/pwuser/.config/jittle-lamp/runner", "/var/lib/jl-e2e-runner"]

# JL_API_ORIGIN and, on first start, JL_RUNNER_TOKEN (registration token from Settings → Runner pools).
ENTRYPOINT ["node", "/app/packages/e2e-runner/dist/daemon.js"]
CMD ["start"]
