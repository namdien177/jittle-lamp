# syntax=docker/dockerfile:1
# Cloud runner pool image: jl-e2e-runner with Playwright's Chromium (design.md §5.4, ADR 0002 decision 3).
# Build from the repository root:
#   docker build -f deploy/runner/Dockerfile -t jittle-lamp/e2e-runner .

FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

ENV BUN_INSTALL=/opt/bun PATH=/opt/bun/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* \
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

RUN bun install --frozen-lockfile --production --filter @jittle-lamp/e2e-runner --ignore-scripts

COPY packages/shared ./packages/shared
COPY packages/e2e-runner ./packages/e2e-runner
RUN bun run --cwd packages/shared build:js && bun run --cwd packages/e2e-runner build

FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime

# The browser run and the generated e2e project load TypeScript runtime modules from src/runtime
# with e2e's own loader, so the package ships src next to dist.
WORKDIR /app
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/e2e-runner /app/packages/e2e-runner

ENV NODE_ENV=production \
    E2E_TELEMETRY_DISABLED=1 \
    JL_RUNNER_WORK_DIR=/var/lib/jl-e2e-runner \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN ln -s /app/packages/e2e-runner/dist/cli.js /usr/local/bin/jl-e2e \
  && ln -s /app/packages/e2e-runner/dist/daemon.js /usr/local/bin/jl-e2e-runner \
  && chmod +x /app/packages/e2e-runner/dist/cli.js /app/packages/e2e-runner/dist/daemon.js \
  && mkdir -p /var/lib/jl-e2e-runner /home/pwuser/.config/jittle-lamp/runner \
  && chown -R pwuser:pwuser /var/lib/jl-e2e-runner /home/pwuser/.config \
  && node /app/packages/e2e-runner/dist/cli.js help >/dev/null

USER pwuser
VOLUME ["/home/pwuser/.config/jittle-lamp/runner", "/var/lib/jl-e2e-runner"]

# JL_API_ORIGIN and, on first start, JL_RUNNER_TOKEN (registration token from Settings → Runner pools).
ENTRYPOINT ["node", "/app/packages/e2e-runner/dist/daemon.js"]
CMD ["start"]
