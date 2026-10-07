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

**New token** on a pool, the `cloud` pool included, issues a fresh registration token (shown once) and replaces the previous one; registered workers keep working. The cloud pool's token goes into the cloud deployment's `runner.env` (deployment.md, section 6).

A worker uses the token only when it has no stored credential. It then gets its own worker credential and stores it with mode 600 in `~/.config/jittle-lamp/runner/<api host>-<host name>.json`, or in the path given with `--state`. Later starts reuse the stored credential, and the token can stay configured. To revoke a host, delete the worker from the pool page. Its credential and the run token of the run it holds stop working at once, and that run goes back to the queue with one attempt used (`apps/backend/src/services/test-run-queue.ts`, `revokeRunnerWorker`).

## 2. Install a runner

### Docker (cloud pool or any Linux host)

The cloud host needs Docker Compose and a published or preloaded image. It does **not** need Git, Bun, or this repository. The image contains Node 22, Chromium, the runner bundles and the TypeScript modules the engine loads; it excludes other apps, tests and build tools.

**From CI:** download `release-artifacts/runner/` from the `build_runner_image` job, or use the image at `$CI_REGISTRY_IMAGE/e2e-runner:<release version>`. CI publishes semver tags on matching `vX.Y.Z` release tags; main builds use `sha-<commit>` tags. Use a released semver image for managed updates, and keep release tags immutable.

**Export locally:** on a development machine, run:

```bash
bun run release:export-runner                    # optional output directory as first argument
```

This builds and exports `release-artifacts/runner-X.Y.Z/jittle-lamp-e2e-runner-X.Y.Z.docker.tar.gz`, its SHA-256 file, and the small deployment files. Copy that directory to the cloud host. A Dockerfile alone still needs a build context; the image archive is the single portable file that removes the source checkout requirement. Build separately for each host CPU architecture.

On the cloud host, inside the exported directory:

```bash
sha256sum -c *.sha256
docker load -i jittle-lamp-e2e-runner-X.Y.Z.docker.tar.gz   # CI names this image.docker.tar.gz
cp runner.env.sample runner.env                          # set JL_API_ORIGIN and JL_RUNNER_TOKEN
docker compose --env-file image.env -f compose.yaml up -d --scale runner=2
```

For a registry deployment, set `JL_RUNNER_IMAGE=<registry repository>/e2e-runner` and `JL_RUNNER_IMAGE_TAG=X.Y.Z` in `image.env`, log into the registry, then run the same Compose command. `runner.env` configures the containers; `image.env` configures Compose's image selection. Changing only a shell variable does not change container settings.

The runtime installs only Playwright 1.63.0 Chromium and its OS dependencies, and runs as `pwuser`. Replicas share the state and work volumes. `shm_size: 1gb` supports Chromium; `stop_grace_period: 20m` lets a case finish during a normal stop. Do not mount the Docker socket into the runner.

For a **local source build** only:

```bash
docker compose -f deploy/runner/compose.yaml -f deploy/runner/compose.build.yaml up -d --build
```

### Detect version skew and update from Settings

Deploy the server and runner from the same release. The server defaults to its package version; `APP_VERSION`, when explicitly set by deployment, must match that release. Settings → Runner pools shows the server version and each worker's version, flags differences, and offers **Update cloud runner to X.Y.Z** to users with `test_config.manage`. Heartbeats refresh the actual worker version even when it reuses a saved credential, and the daemon logs mismatches. A mismatch alone does not interrupt existing runs or disable an unmanaged runner.

Managed updates require a host supervisor. On that Docker host:

1. Set `JL_RUNNER_MANAGED_UPDATES=1` in `runner.env` and recreate the runners once.
2. Ensure `image.env` pins a semver release and the registry repository. Keep the registration token configured so replacement containers can register.
3. Install Node 22+ and run `node update-runner.mjs --compose compose.yaml --image-env image.env` as a host service (or use `--once` from a scheduler). Run one updater per deployment and one pool per deployment. It uses credentials from the host's running containers, so no extra token is needed. Authenticate the Docker host to a private registry with `docker login` first.
4. Click **Update cloud runner** in Settings. The server records its own version as the target; the UI cannot select arbitrary images. Workers stop claiming, finish active runs **and explorations**, then acknowledge the update with zero load. The supervisor verifies the candidate image's runner version, re-checks the request and drain, preserves replica count, recreates changed containers and persists the new image pin. Credentials and work volumes stay mounted.

Settings shows each update stage: finish jobs, download, verify, restart, reconnect, and completion. During image pulls on a local Unix Docker socket, the host updater reads Docker's byte progress and reports a measured download percentage once every uncached layer has a known size. The percentage covers image download only; unpacking and other stages use an indeterminate bar. Remote/TLS Docker contexts use the CLI and an indeterminate download bar. Registry credentials come from the host's Docker login configuration or credential helper; they are never sent to the Jittle Lamp server. Keep `docker-pull.mjs` beside `update-runner.mjs`, including when upgrading an existing host updater.

The active UI refreshes every two seconds and warns if the host stops reporting for 45 seconds. Progress is persisted across page reloads. Completion requires replacement-worker heartbeats at the target version. Cancellation is blocked once container replacement starts; failed updates show the affected stage and recovery guidance.

Use `node update-runner.mjs --offline` for disconnected hosts after loading the matching exported image. The supervisor uses its locally configured repository and skips registry pulls.

**Cancel update** resumes claims if the update has not started replacing containers. Image pull/verification failures leave the old containers and pin intact and keep the update pending; inspect the supervisor log, then retry or cancel. A failure during container recreation needs operator recovery with the previous image pin. Do not run deployment commands or scale the service concurrently with the updater. The UI can detect skew on old runners, but enabling managed updates on a legacy deployment needs the one-time manual upgrade above. Offline worker entries from replaced hostnames can remain in the pool history.

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

**Upgrades.** `e2e` is pinned. Its engine version is part of every cache key, so upgrading `e2e` or `@e2e-dev/web` re-records every act step on the next run of each case. Read the e2e changelog first and run the PCF spike case (`docs/e2e-test-cases/examples/pcf-logout-clears-email.spike.transcript.md`) before bumping. Keep all runners of a pool on the same version; use the managed-update procedure above.

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

## Local credential field metadata

`jl-e2e env pull` exports public/secret classification separately from values, so arbitrary field names work without runner code changes:

```dotenv
JL_CREDENTIAL_DEMO_PUBLIC_FIELDS="nickname,email"
JL_CREDENTIAL_DEMO_SECRET_FIELDS="password"
JL_CREDENTIAL_DEMO_LOGIN_FIELD="nickname"
JL_CRED_DEMO_NICKNAME="qa-nick"
JL_CRED_DEMO_EMAIL="qa@example.test"
JL_CRED_DEMO_PASSWORD=""
```

Fill the password locally. Omit `JL_CREDENTIAL_DEMO_LOGIN_FIELD` for automatic selection (`username`, otherwise the only public field). Classification from an organisation also applies to local value overrides, and an organisation secret cannot be made public by local metadata. Without metadata, legacy field-name secrecy rules still apply.
