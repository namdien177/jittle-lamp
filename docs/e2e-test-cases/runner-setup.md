# Running test-case runners

A runner executes test-case runs: it claims a run from the organisation's queue, opens Chromium, lets the AI agent work through the transcript, and uploads the run as evidence. One binary does both jobs:

- `jl-e2e`: the CLI, for running a transcript on your machine.
- `jl-e2e-runner`: the daemon, for serving a runner pool.

Background: design.md §5.4 (hosts and pools), §9 (configuration and secrets) and §10 (queue). Decisions: ADR 0002 (3, 9, 12).

Operators standing up the backend, staging and production, or the cloud pool for an organisation: see [deployment.md](deployment.md).

## Pools

| Pool | Where it runs | Takes |
| --- | --- | --- |
| `cloud` | Jittle Lamp infrastructure, `max_concurrent_runs` workers per organisation | Runs whose environment is bound to `cloud` |
| self-hosted | A devbox or CI host you control, inside the network that reaches your app | Runs whose environment is bound to that pool |

Each environment has a runner pool (Settings → Environments → Runner pool), and its runs go to that pool. LittleLives UAT sits behind a VPN, so its environments are bound to a self-hosted pool on a devbox.

If no worker of the pool has sent a heartbeat recently, a run stays `queued` with `blocked_reason: NO_RUNNER`. The run page shows the pool name, so you know which host to start.

## 1. Create the pool

Go to Settings → Runner pools → New pool. Pick a name and a concurrency (runs at a time across the pool). The registration token appears **once**, so copy it.

The page offers **New token** only for self-hosted pools. The `cloud` pool's token is issued through the API (deployment.md, section 6).

A worker uses the token only when it has no stored credential. It then gets its own worker credential and stores it with mode 600 in `~/.config/jittle-lamp/runner/<api host>-<host name>.json`, or in the path given with `--state`. Later starts reuse the stored credential, and the token can stay configured. To revoke a host, delete the worker from the pool page. Its credential and the run token of the run it holds stop working at once, and that run goes back to the queue with one attempt used (`apps/backend/src/services/test-run-queue.ts`, `revokeRunnerWorker`).

## 2. Install a runner

### Docker (cloud pool or any Linux host)

```bash
docker build -f deploy/runner/Dockerfile -t jittle-lamp/e2e-runner .
cp deploy/runner/runner.env.sample deploy/runner/runner.env   # set JL_API_ORIGIN, JL_RUNNER_TOKEN
docker compose -f deploy/runner/compose.yaml up -d --scale runner=2
```

Every runner setting, including `JL_RUNNER_CONCURRENCY` (runs at a time per container, default 1), comes from `runner.env`. Edit the file and recreate the containers (`docker compose … up -d`) to change it; a variable set only in your shell does not reach the containers.

The image is Playwright's `v1.63.0-noble` image with Node and Chromium; it runs as `pwuser`. The replicas share the `runner-state` volume, and each keeps its credential in a file named after its container host name. `shm_size: 1gb` is required: Chromium crashes with Docker's 64 MB default. `stop_grace_period: 20m` lets a running case finish on `docker compose down`.

### systemd (self-hosted devbox)

Requirements: Node 22.12 or newer, Bun 1.4.2 to build, and a network path to the app under test (VPN up).

```bash
sudo useradd --system --create-home jl-runner
sudo mkdir -p /opt/jl-e2e-runner && sudo chown jl-runner /opt/jl-e2e-runner
sudo -u jl-runner git clone <repo> /opt/jl-e2e-runner
cd /opt/jl-e2e-runner
sudo -u jl-runner bun install --frozen-lockfile --production --filter @jittle-lamp/e2e-runner
sudo -u jl-runner bun run --cwd packages/shared build:js
sudo -u jl-runner bun run --cwd packages/e2e-runner build
sudo -u jl-runner env PLAYWRIGHT_BROWSERS_PATH=/opt/jl-e2e-runner/ms-playwright npx playwright install chromium
sudo npx playwright install-deps chromium

sudo tee /etc/jl-e2e-runner.env >/dev/null <<'ENV'
JL_API_ORIGIN=https://api.jittlelamp.example
JL_RUNNER_TOKEN=<registration token, first start only>
ENV
sudo chmod 600 /etc/jl-e2e-runner.env
sudo cp deploy/runner/jl-e2e-runner.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jl-e2e-runner
journalctl -u jl-e2e-runner -f
```

The unit keeps the worker credential in `/var/lib/jl-e2e-runner/state.json` (`--state`, inside `StateDirectory`). On stop, systemd sends SIGTERM to the daemon only (`KillMode=mixed`). The daemon stops claiming and lets the current case finish. The browser is killed only when `TimeoutStopSec=20min` runs out.

### Foreground (trying it out)

```bash
bun run --cwd packages/e2e-runner build
node packages/e2e-runner/dist/daemon.js start --api https://api.jittlelamp.example --token <registration token> --once
```

`--once` exits after one run. `--concurrency n` runs n cases in parallel on this host (1 to 50). `--work-dir` moves the run directories (default `~/.cache/jl-e2e-runner`). A run directory is deleted once its evidence is uploaded and the run is finalised; set `JL_RUNNER_KEEP_RUNS=1` to keep them for debugging.

## 3. What a runner receives and keeps

1. **Claim.** The worker claims a run with its worker credential. The claim carries the transcript, the organisation's macros, the server's step ids, the params, the cache mode and a **run token** that is valid only while the run's lease lasts.
2. **Configuration.** With the run token, the worker fetches the environment and **only the credentials the transcript references**, decrypted (`GET /test-runs/:id/config`). Each fetch is written to the organisation's activity log.
3. **Injection.** The values go into the browser process as `JL_ENV_*`, `JL_VAR_*` and `JL_CRED_*` environment variables, exactly as a local `.env.e2e` would provide them. They are never written to disk. Nothing else from the host environment reaches that process except the paths, proxy, CA and display variables it needs. `JL_*` variables set on the daemon itself are ignored, because the organisation's configuration wins.
4. **Secrets.** Passwords and other secret fields are typed into the page by the engine through credential handles. The model sees only the handle name, never the value. Secret values are redacted from logs, reports and the evidence archive.
5. **Cache.** Act steps replay from the case's step scripts on the backend (`/test-runs/:id/cache/:key`). A run on any runner reuses what another runner recorded for the same environment.
6. **Evidence.** The video, the session archive (schema v4, with step annotations) and `run-report.json` are uploaded with the run token. Then the run is finalised.

Progress (current step, step results and a small screenshot per step) streams to the backend while the run executes. The web and desktop apps show it live.

## 4. Operating

| Symptom | Meaning | Action |
| --- | --- | --- |
| Run `queued`, `NO_RUNNER` | No live worker in the environment's pool | Start or fix the worker. `journalctl -u jl-e2e-runner` |
| Run `failed`, `RUNNER_LOST` | The lease expired three times (host died, network cut) | Check the host. The queue retried the run twice before giving up. A worker that loses its lease stops the case at once and finalises nothing; the retry starts clean |
| Outcome `blocked`, `APP_UNREACHABLE` | The browser could not open the base URL from this host | VPN or DNS on the runner host; check that the environment is bound to the right pool |
| Outcome `blocked`, `MISSING_CREDENTIAL` / `MISSING_VARIABLE` | The transcript names something the environment lacks (only names are listed) | Settings → Credentials / Environments |
| Outcome `blocked`, `MODEL_KEY_MISSING` / `MODEL_UNAVAILABLE` | A key the models need is missing (the act key, the judge key when the judge uses another provider, or the OpenAI-compatible base URL), or the provider rejected the model id | Settings → AI model lists what is missing |
| Outcome `blocked`, `INCONCLUSIVE` | The judge could not decide, even after one re-judge | Make the assert more specific, or use `[Wait]` for things that load slowly |

**Upgrades.** `e2e` is pinned. Its engine version is part of every cache key, so upgrading `e2e` or `@e2e-dev/web` re-records every act step on the next run of each case. Read the e2e changelog first and run the PCF spike case (`docs/e2e-test-cases/examples/pcf-logout-clears-email.spike.transcript.md`) before bumping. Keep all runners of a pool on the same version.

**Plain HTTP.** e2e accepts plain `http://` base URLs only for loopback hosts. Test environments need HTTPS, unless the app runs on the runner host itself (and in Docker that means `--network host`).

**Capacity.** A run needs about 1 CPU and 1–1.5 GB of memory (Chromium plus Node). Size `--concurrency` and the pool limit to match.

## 5. Running locally with the CLI

```bash
jl-e2e config --env-file ~/.config/jittle-lamp/e2e/pcf-uat.env      # resolved names, secrets masked, with sources
jl-e2e run cases/logout.transcript.md --env-file .env.e2e --headed   # local browser with the interaction lock
jl-e2e env pull pcf-uat                                              # .env.e2e from the organisation (no secrets)
jl-e2e run --suite <suite id> --env <environment id> --wait --junit out.xml   # CI, with JL_API_ORIGIN + JL_API_TOKEN
```

In `--headed` runs, a transparent shield covers the page between agent actions. If you click or type, the run pauses ("Paused: you interacted with the page") until you press Resume. Nothing you do while it is paused is recorded as a step.

Model ids pick the provider: `openrouter/<vendor>/<model>` (`OPENROUTER_API_KEY`), `openai-compatible/<model>` (`OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_API_KEY`), `gateway/<provider>/<model>` (`AI_GATEWAY_API_KEY`), `openai/…` (`OPENAI_API_KEY`), `anthropic/…` (`ANTHROPIC_API_KEY`), `google/…` (`GOOGLE_GENERATIVE_AI_API_KEY`), `xai/…` (`XAI_API_KEY`), or `mock:<fixture.json>` (recorded turns, no network). Put the key for each provider your `JL_MODEL` and `JL_JUDGE_MODEL` use in `.env.e2e`; keys are masked in `jl-e2e config` and redacted from logs and reports, the base URL is not. `claude-code/…` uses a local Claude Code login through `--allow-claude-code` and is for development only. See [Choosing a model provider](onboarding-qa.md#choosing-a-model-provider).
