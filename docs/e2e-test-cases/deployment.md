# Deploying AI-driven E2E test cases

This guide is for the operator who stands up local development, staging and production for the test-case feature. It covers the services, their configuration, database migrations, model providers, runner pools, integrations, operating limits, the release order and troubleshooting.

Every variable name, default, port, route and command below was checked against the code on `feat/e2e-test-cases`. Values in angle brackets and hosts under `*.example` are placeholders. Never put a real secret in this file or in any committed file.

Related guides:

- [runner-setup.md](runner-setup.md): installing and operating runners (Docker, systemd, CLI).
- [onboarding-qa.md](onboarding-qa.md): what QA engineers do once the feature is live.
- [design.md](design.md) and [ADR 0002](../adr/0002-ai-driven-e2e-test-cases.md): why it works this way.
- [../gitlab-migration.md](../gitlab-migration.md): the LittleLives GitLab and production cutover plan.
- [../mcp.md](../mcp.md): MCP tools and token kinds.

## 1. Topology

The feature adds no new service type. The backend gains routes and background workers, and runners are a new kind of client that only makes outbound calls.

```text
   QA browsers                      desktop app            extension
       | HTTPS                          | HTTPS                | http://127.0.0.1:48115
       v                                v                      v
 evidence-web (static) --HTTPS-->  backend API :3001  <--  desktop companion (local only)
                                   Elysia + workers
          +-------------------+--------+--------+--------------------------+
          |                   |        |        |                          |
          v                   v        v        v                          v
   libSQL / Turso        S3 bucket   Clerk   GitLab/GitHub API, Slack,   model provider
                                             webhook callbacks, Jira     (Jira import)
          ^
          |  GitLab/GitHub deliveries: POST /hooks/:endpointId
          |
   backend API :3001  <--HTTPS, runner-initiated--  runner pools
                                                    cloud: Docker compose
                                                    self-hosted: systemd or CLI
                                                       |                  |
                                                       v                  v
                                               target app (UAT,    model provider
                                               often behind VPN)
```

| From | To | Port and protocol | What for |
| --- | --- | --- | --- |
| Browser | evidence-web | 443 HTTPS | Static app (any static host with a fallback to `index.html`; `apps/evidence-web/vercel.json` does this on Vercel) |
| Browser | backend | 443 HTTPS to the backend's `PORT` (default 3001) behind your proxy | All API calls. Cross-origin calls need the web origin in `WEB_APP_ORIGIN` or `CLERK_AUTHORIZED_PARTIES` (CORS) |
| Browser | Clerk | 443 HTTPS | Sign-in, using the build-time `CLERK_PUBLISHABLE_KEY` |
| Browser | S3 | 443 HTTPS | Video and artifacts through signed read URLs (`S3_SIGNED_URL_TTL_SECONDS`) |
| Desktop renderer | backend | 443 HTTPS | Build-time `JITTLE_LAMP_API_ORIGIN` |
| Extension | desktop companion | `http://127.0.0.1:48115` | Local artifact intake. Never exposed off the machine |
| Backend | libSQL/Turso | 443 (`libsql://`) or a local `file:` path | Data |
| Backend | S3-compatible storage | 443 | Evidence artifacts |
| Backend | Clerk Backend API | 443 | User directory and token checks with `CLERK_SECRET_KEY` (a JWT can also be verified locally with `CLERK_JWT_KEY`) |
| Backend | GitLab/GitHub API, Slack incoming webhooks, webhook channels, rule callback URLs | 443, or 80 for plain `http://` | Outbound reports and notifications, through the SSRF guard in `apps/backend/src/services/outbound-http.ts` |
| Backend | Jira | 443 | Jira import (`/rest/api/3/search/jql`). Not routed through the SSRF guard |
| Backend | Model provider | 443 | Transcript generation during Jira import, with the organisation's model key |
| GitLab/GitHub | backend | 443 | Inbound webhook deliveries to `POST /hooks/:endpointId` |
| Runner | backend | 443 HTTPS (`JL_API_ORIGIN`) | Register, heartbeat every 10 s, claim, run config, progress, step cache, live frames, evidence ZIP (up to 64 MB), finalise |
| Runner | Target app | The environment's base URL | The browser under test. HTTPS required unless the app is on the runner host's loopback |
| Runner | Model provider | 443 | Act and judge model calls |
| CI job (`jl-e2e`) | backend | 443 | Starts a suite with an automation token and waits for the result |

Runners have no inbound port. The backend never connects to a runner; everything is runner-initiated polling.

## 2. Environments

### What differs

| Setting | Local dev (dev-auth) | Staging | Production |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `staging` | `production` |
| Auth | No Clerk account. A generated RS256 key pair: the public key is `CLERK_JWT_KEY`, the signed token is `JITTLE_LAMP_DEV_AUTH_TOKEN` | Its own Clerk instance | The production Clerk instance |
| `DATABASE_URL` | `file:./local.dev-auth.db` (relative to `apps/backend`) | Its own Turso database | The production Turso database |
| Artifact storage | None: in-memory, served through `/dev/artifacts`, lost on restart | Its own bucket | Its own bucket |
| `JL_SECRETS_MASTER_KEY` | Generated by the setup script and kept across runs | Its own key. Never the production key | Its own key, kept in a secret manager |
| Origins | API `http://127.0.0.1:3001`, web `http://127.0.0.1:4173` | Staging hosts | Production hosts |
| `JL_OUTBOUND_ALLOW_LOOPBACK` | `true` only while testing webhooks or channels against a local receiver | Unset | Unset |
| `JL_OUTBOUND_ALLOW_HOSTS` | Empty | Internal hosts staging must call | Internal hosts production must call |
| `RUN_DB_MIGRATIONS` | `true` | `true`, or a migration job (section 4) | A migration job, or `true` on the single instance (section 4) |
| OpenAPI at `/docs` | On | Off | Off |
| `APP_SECRET` | Generated | Set it | Required (startup fails without it) |
| `JITTLE_LAMP_DEV_AUTH_ENABLED` | `true` | Unset | Unset |

`NODE_ENV` accepts `local`, `development`, `staging` and `production` (default `local`). `staging` and `production` turn OpenAPI off, default `LOG_LEVEL` to `info`, require `CLERK_PUBLISHABLE_KEY` and `CLERK_AUTHORIZED_PARTIES` when Clerk is configured, and log a warning at boot if `JITTLE_LAMP_API_ORIGIN` is missing. Only `production` requires `APP_SECRET` and `S3_BUCKET`.

### Local development

```bash
bun install
bun run dev:test-auth:setup   # writes .env.dev-auth at the repository root (gitignored)
bun run dev:test-auth         # builds evidence-web, serves it on 127.0.0.1:4173, starts the backend on 127.0.0.1:3001
```

`scripts/dev/test-auth-env.ts` writes `.env.dev-auth` with `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3001`, `DATABASE_URL=file:./local.dev-auth.db`, `RUN_DB_MIGRATIONS=true`, a fresh `CLERK_JWT_KEY` and `JITTLE_LAMP_DEV_AUTH_TOKEN` (valid 30 days), `CLERK_AUDIENCE=jittle-lamp-dev`, the local origins and a random `JL_SECRETS_MASTER_KEY`. The master key is reused on later runs so stored secrets stay readable. `dev:test-auth` regenerates the token on every start.

The setup script also takes a few values from a root `.env` when one exists: `APP_SECRET`, the dev-auth identity, `JITTLE_LAMP_WEB_ORIGIN` and `CLERK_AUDIENCE`. If your root `.env` points at production, move it aside before running the setup, or check that `.env.dev-auth` does not carry a production `APP_SECRET`.

The run script passes your shell environment to the backend, so extra backend settings go on the command line:

```bash
JL_OUTBOUND_ALLOW_LOOPBACK=true bun run dev:test-auth
```

For runs, create a self-hosted pool under Settings → Test cases → Runner pools and start a runner against the local API (see [runner-setup.md](runner-setup.md), "Foreground"):

```bash
bun run --cwd packages/e2e-runner build
node packages/e2e-runner/dist/daemon.js start --api http://127.0.0.1:3001 --token <registration token> --once
```

Use `mock:<fixture.json>` model ids for offline work, or `claude-code/<model>` with `--allow-claude-code` (section 5).

### Staging

Staging should mirror production: the same image, `NODE_ENV=staging`, its own Clerk instance, Turso database, bucket and master key, and its own runner deployment.

Use a copy of production data to rehearse migrations before every production release that adds migrations (section 4). Keep these effects of a copy in mind:

- **Secrets stay sealed.** Credentials, model keys, webhook secrets and Slack URLs in the copy are wrapped with the production master key. Staging has its own key, so reading them fails with `SECRET_DECRYPTION_FAILED`. This is the intended outcome. Do not give staging the production key; re-enter the secrets staging needs.
- **Disable outbound targets.** Disable the copied webhook endpoints and notification channels, so a staging test never posts to production GitLab merge requests or Slack channels even after secrets are re-entered.
- **Accounts may not match.** Users are keyed by Clerk user id (`users.clerk_user_id`). With a separate Clerk instance, staging sign-ins create new users that are not members of the copied organisations. Treat the copy as a migration rehearsal target, and use fresh organisations for functional testing.
- **Runners do not cross over.** Worker credentials in the copy belong to production pools and point at the production API. Register staging runners separately.

### Production

Production follows section 9. The open decisions (instance count, registry, migration ownership) are listed at the end of this guide.

## 3. Backend configuration reference

The backend reads `process.env` once at startup (`apps/backend/src/config/env.ts`, `config/runtime.ts`, `app.ts`). It does not load a `.env` file by itself in a container; inject variables through your orchestrator's secret store. Invalid values stop the process at boot with the Zod message.

### Core and runtime

| Variable | Required | Default | Example | Notes |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | No | `local` | `production` | `local`, `development`, `staging`, `production`. The Docker image sets `production` |
| `HOST` | No | `0.0.0.0` | `0.0.0.0` | Bind address |
| `PORT` | No | `3001` | `3001` | The Docker image exposes 3001 and health-checks `http://127.0.0.1:$PORT/health` |
| `APP_VERSION` | No | `0.1.3` | `1.8.2` | Returned by `GET /version`. Set it to the release version |
| `APP_SECRET` | In production | none | `<at least 24 random characters>` | Used by the desktop and extension auth flows and to encrypt organisation migration tokens. Keep it stable across deploys |
| `JITTLE_LAMP_API_ORIGIN` | Yes in staging and production | none | `https://api.jittlelamp.example` | Public API origin. Used for upload URLs and for webhook endpoint URLs (`<origin>/hooks/<id>`). Without it, the backend falls back to the connection origin, which is wrong behind a proxy |
| `WEB_APP_ORIGIN` | Yes | none | `https://app.jittlelamp.example` | CORS, and the links in Slack messages, MR notes and share links |
| `VIDEO_NORMALIZATION_CONCURRENCY` | No | `2` | `2` | 1 to 8 parallel ffmpeg jobs |
| `FFMPEG_PATH` | No | `ffmpeg` | `/usr/bin/ffmpeg` | The image installs ffmpeg |
| `MIGRATION_WORKER_CONCURRENCY` | No | `1` | `1` | 1 to 4. Organisation migration workers, not schema migrations |
| `JITTLE_LAMP_DEV_AUTH_ENABLED` | No | `false` | unset | Development only. Enables `/dev/artifacts` when no S3 is configured |

### Database

| Variable | Required | Default | Example | Notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Yes for the feature | none | `libsql://<db>-<org>.turso.io` | Without it the backend starts, but every test-case route fails. Relative `file:` paths resolve against the process working directory, which is `apps/backend` for `bun run --cwd apps/backend …` and `/app/apps/backend` in the image |
| `TURSO_AUTH_TOKEN` | For `libsql://` | none | `<turso token>` | |
| `RUN_DB_MIGRATIONS` | No | `false` | `true` | `1`, `true`, `yes`, `on` enable it. The Docker image sets `true`. See section 4 |

### Auth (Clerk)

| Variable | Required | Default | Example | Notes |
| --- | --- | --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | Staging, production | none | `pk_live_<…>` | Also baked into evidence-web and desktop at build time |
| `CLERK_SECRET_KEY` | One of the two | none | `sk_live_<…>` | Needed for organisation migration and the user directory |
| `CLERK_JWT_KEY` | One of the two | none | `-----BEGIN PUBLIC KEY-----\n…` | PEM; literal `\n` sequences are converted to newlines |
| `CLERK_AUDIENCE` | No | none | `jittle-lamp` | |
| `CLERK_AUTHORIZED_PARTIES` | Staging, production | none | `https://app.jittlelamp.example` | Comma separated. Also allowed by CORS |

### Artifact storage (S3-compatible)

| Variable | Required | Default | Example | Notes |
| --- | --- | --- | --- | --- |
| `S3_BUCKET` | In production | none | `jittle-lamp-prod-evidence` | Setting any `S3_*` value makes bucket, region, key id and secret all required |
| `S3_REGION` | With S3 | none | `ap-southeast-1` | |
| `S3_ENDPOINT` | For R2, MinIO, Tigris | none | `https://<account>.r2.cloudflarestorage.com` | Leave empty for AWS S3 |
| `S3_ACCESS_KEY_ID` | With S3 | none | `<key id>` | |
| `S3_SECRET_ACCESS_KEY` | With S3 | none | `<secret>` | |
| `S3_FORCE_PATH_STYLE` | No | `false` | `true` for MinIO | |
| `S3_SIGNED_URL_TTL_SECONDS` | No | `900` | `900` | Minimum 60 |

Without S3, artifacts live in memory. That is only usable for local development.

### Secrets master key

| Variable | Required | Default | Example | Notes |
| --- | --- | --- | --- | --- |
| `JL_SECRETS_MASTER_KEY` | To read or write any credential | none | `<base64 of 32 random bytes>` | Startup fails if set but not exactly 32 bytes. When unset, the backend starts, but credential, model key, webhook and channel writes return `503 SECRETS_MASTER_KEY_MISSING` and runs cannot get their configuration |
| `JL_SECRETS_MASTER_KEY_PREVIOUS` | Only during rotation | none | `<old base64 key>` | Used only to unwrap data keys sealed by the old key |

How it works (`apps/backend/src/services/test-config.ts`): each organisation has a data key (AES-256-GCM, table `organization_data_keys`). The master key wraps the data key, and the data key encrypts the organisation's credential secrets (including the model key), webhook endpoint secrets and notification channel secrets. A data key row records the id of the master key that wrapped it: `mk_` plus the first 16 hex characters of the SHA-256 of the key bytes.

Generate a key:

```bash
openssl rand -base64 32
```

Store it in the secret manager that feeds the backend, separate from database backups. A database backup together with the master key exposes every stored secret. A lost master key makes every stored secret unreadable; the only recovery is to re-enter them.

**Rotation as implemented.** There is no command that re-wraps all organisations at once. `rewrapDataKeys()` exists in `services/test-config.ts` but no route, CLI or startup hook calls it. The working procedure uses the per-organisation route `POST /test-credentials/rotate-key`:

1. Generate a new key. Set `JL_SECRETS_MASTER_KEY=<new>` and `JL_SECRETS_MASTER_KEY_PREVIOUS=<old>`, then restart. Reads keep working, because each data key is unwrapped with whichever key matches its `master_key_id`.
2. For each organisation that has secrets, call `POST /test-credentials/rotate-key` as a member with `test_config.manage`. It needs a signed-in session token; AI and automation tokens are refused. It creates a new data key version wrapped with the new master key, re-encrypts every credential, webhook endpoint secret and channel secret of the organisation, and marks the old version `retired`. The web app has no button for it in this version.
3. Check that no active data key still uses the old master key:

   ```sql
   select org_id, key_version, master_key_id from organization_data_keys where status = 'active';
   ```

   Every row must show the new key id. Compute it with `printf '%s' '<new base64 key>' | openssl base64 -d -A | shasum -a 256 | cut -c1-16` and prefix `mk_`.
4. Remove `JL_SECRETS_MASTER_KEY_PREVIOUS` and restart. Retired rows still name the old key, but no secret references them.

Run the procedure on staging first.

### Outbound HTTP allowlist

Outbound calls to addresses an organisation configures (GitLab and GitHub API, rule callbacks, Slack and webhook channels) must resolve to public addresses. Loopback, RFC 1918, link-local, CGNAT, ULA and multicast addresses are refused, and redirects are never followed.

| Variable | Required | Default | Example | Notes |
| --- | --- | --- | --- | --- |
| `JL_OUTBOUND_ALLOW_HOSTS` | No | empty | `gitlab.internal.example,hooks.internal.example` | Comma separated host names that skip the address check. Exact, case-insensitive match on the host name: no wildcards and no ports |
| `JL_OUTBOUND_ALLOW_LOOPBACK` | No | `false` | `true` | Only the exact value `true` works. Allows loopback addresses only, not private ranges. Local development only |

The check resolves DNS before the request, so a DNS answer that changes in between is not covered. Run the backend behind an egress proxy if that matters to you.

### Logging

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `LOG_LEVEL` | No | `debug` for `local`/`development`, `info` for `staging`/`production` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`; `silent` is treated as `info` |

Logs are pino JSON on stdout with ISO timestamps. The `authorization` header and fields named `secret` or `password` are redacted.

### Build-time configuration of the clients

These are compiled into the bundles. The build scripts read the shell first and fall back to the root `.env`, so build staging and production bundles in CI with explicit variables, never on a machine whose root `.env` points elsewhere.

| App | Variables | Notes |
| --- | --- | --- |
| evidence-web (`apps/evidence-web/scripts/build.ts`) | `CLERK_PUBLISHABLE_KEY`, `JITTLE_LAMP_API_ORIGIN`, `JITTLE_LAMP_DEV_AUTH_*`, `REACT_APP_VERCEL_OBSERVABILITY_*` | Without `JITTLE_LAMP_API_ORIGIN`, a Vercel build calls `/api`, which `vercel.json` rewrites to the production API host. Staging on Vercel must set `JITTLE_LAMP_API_ORIGIN` or carry its own rewrites. Keep `JITTLE_LAMP_DEV_AUTH_*` empty for staging and production builds |
| desktop (`apps/desktop/scripts/build.ts`) | `CLERK_PUBLISHABLE_KEY`, `JITTLE_LAMP_API_ORIGIN`, `JITTLE_LAMP_WEB_ORIGIN`, `JITTLE_LAMP_DESKTOP_BUILD_ENV` (`dev`, `canary`, `stable`) | A `stable` build fails without `CLERK_PUBLISHABLE_KEY` and `JITTLE_LAMP_API_ORIGIN` |
| extension (`apps/extension/scripts/build.ts`) | `JITTLE_LAMP_API_ORIGIN`, `JITTLE_LAMP_WEB_ORIGIN` | Default to the production hosts when unset, so staging builds must set both |

### Runner and CLI variables

Runners read their own environment; the backend never reads `JL_API_ORIGIN` or `JL_RUNNER_*`. The daemon needs `JL_API_ORIGIN` and, on first start, `JL_RUNNER_TOKEN`; it also reads `JL_RUNNER_CONCURRENCY` (1 to 50), `JL_RUNNER_WORK_DIR` and `JL_RUNNER_KEEP_RUNS=1`. The CLI in CI needs `JL_API_ORIGIN`, `JL_API_TOKEN` and optionally `JL_WEB_ORIGIN` for evidence links. On managed runs the environment, credentials and model keys come from the backend; `JL_*` names and model key variables set on the daemon host are dropped before the browser process starts. See `.env.sample` and [runner-setup.md](runner-setup.md).

## 4. Database migrations

### How they run

Two ways, both applying `apps/backend/drizzle/*.sql` in journal order and recording them in Drizzle's migrations table:

- **On startup.** With `RUN_DB_MIGRATIONS=true` the backend runs Drizzle's migrator before it starts listening (`apps/backend/src/startup/run-database-migrations.ts`). The folder is `./drizzle` relative to the working directory, so the process must start in `apps/backend` (the image uses `/app/apps/backend`). On failure it logs `failed to apply database migrations` and exits with code 1.
- **As a separate step.** `bun run --cwd apps/backend db:migrate` runs `drizzle-kit migrate` with `DATABASE_URL` and `TURSO_AUTH_TOKEN` from the shell. `drizzle-kit` is a dev dependency, so this runs from a full checkout (`bun install`), not from the production image.

[gitlab-migration.md](../gitlab-migration.md) asks for the second form in production: application containers with `RUN_DB_MIGRATIONS=false`, and one migration job before the new version takes traffic. The image default (`true`) is safe only while one instance starts at a time, because two instances starting together would both migrate.

### Migrations of this feature

| Migration | Kind | What it does |
| --- | --- | --- |
| `0022_test_case_platform` | New tables only | 33 tables: test cases, versions, datasets, suites, environments, credentials, macros, tags, runs, steps, batches, step scripts, runner pools and workers, organisation data keys, model settings and prices, run settings, rate buckets, notifications, webhook endpoints and deliveries, agent notes. Unique indexes are created on empty tables |
| `0023_test_cases_fts` | New objects plus seed data | FTS5 table `test_cases_fts` with the `trigram` tokenizer and three triggers on `test_cases`. Seeds the global model price rows (version `seed-2026-09-25`) with `INSERT OR IGNORE` |
| `0024_test_permissions_backfill` | Data backfill | Adds the `test_case.*`, `test_run.*` and `test_config.*` permissions to the stored `developer`, `qa_engineer`, `moderator` and `admin` roles of every existing organisation. It only adds values; customised permissions stay |
| `0025_test_run_batch_members` | Additive column | `test_run_batches.run_ids_json` (default `[]`) |
| `0026_test_run_dedupe_unique` | Column plus unique index | `test_runs.dedupe_exclusive` (default false) and the partial unique index `test_runs_org_dedupe_open_unique` on `(org_id, dedupe_key)` for open exclusive runs. Existing rows get `false`, so the index cannot fail on existing data |
| `0027_webhooks_live` | New table and columns | `webhook_batches` with unique `(endpoint_id, rule_key, trigger_ref)`, `test_runs.base_url_override`, `webhook_deliveries.delivery_id` and an index |
| `0028_phase2_review` | Columns plus data update | `notification_channels.secret_enc`, `key_version`; `notification_events.channels_dispatched_at`; `webhook_batches.report_stage`. Marks existing notification events as already dispatched to channels, so the new channel worker does not resend old events |

All of them are additive. Nothing is dropped or renamed. The FTS5 trigram tokenizer needs SQLite 3.34 or newer with FTS5, which libSQL and Turso provide.

### Procedure

1. **Back up first.** Take a Turso point-in-time marker or a dump (for example `turso db shell <db> .dump > <file>.sql`; check the commands of your Turso CLI and plan). For a `file:` database, stop the backend and copy the file.
2. **Rehearse on a production copy** in staging: restore the backup into the staging database, run the migrations exactly as production will, start the backend and run the smoke test in section 9.
3. **Migrate production**, then deploy the backend.

### Rollback

Drizzle has no down migrations. Because these migrations only add, an older backend build will probably start against the migrated schema, but that is not tested, and 0024 has already granted the new permissions. The supported rollback is: stop the backend, restore the backup taken in step 1, deploy the previous version. Data written after the backup is lost, so decide quickly.

## 5. Model providers

The feature is provider-neutral. Each organisation brings its own key (BYOK), and every run of the organisation uses it. Model ids are Vercel AI SDK ids; the prefix picks the provider (`packages/e2e-runner/src/model/providers.ts`). The backend uses the same resolver for transcript generation during Jira import.

| Prefix | Id shape | Key variable on the runner | Notes |
| --- | --- | --- | --- |
| `anthropic/` | `anthropic/<model>` | `ANTHROPIC_API_KEY` | Defaults for new organisations: act `anthropic/claude-opus-5-5`, judge `anthropic/claude-sonnet-5-5` |
| `openai/` | `openai/<model>` | `OPENAI_API_KEY` | |
| `openrouter/` | `openrouter/<vendor>/<model>` | `OPENROUTER_API_KEY` | The id is checked against `https://openrouter.ai/api/v1/models` when the run starts; an unknown id blocks with `MODEL_UNAVAILABLE` and suggestions |
| `openai-compatible/` | `openai-compatible/<model>` | `OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_API_KEY` | Any server with the OpenAI API: vLLM, LiteLLM, Azure-style gateways |
| `gateway/` | `gateway/<provider>/<model>` | `AI_GATEWAY_API_KEY` | Vercel AI Gateway |
| `xai/` | `xai/<model>` | `XAI_API_KEY` | Being added to the runner on `feat/e2e-providers`. On this branch an `xai/` id blocks with `MODEL_UNAVAILABLE` |
| `claude-code/` | `claude-code/<alias or model>` | The local `claude` login | **Development only.** Removed from the backend image; the daemon refuses it unless started with `--allow-claude-code`, the CLI unless given `--allow-claude-code` or `JL_ALLOW_CLAUDE_CODE=1`. Never on a cloud or shared pool |
| `mock:` | `mock:<fixture.json>` | none | Recorded turns, no network. Tests and offline work |

**Organisation settings** (Settings → Test cases → AI model, permission `test_config.manage`):

- act model id and judge model id;
- the provider key, stored write-only as a `model_key` credential and shown only by its last four characters;
- a base URL when the act model is `openai-compatible/`;
- a separate judge key when the judge uses a different provider from the act model.

The base URL and judge key fields come with `feat/e2e-providers`. On this branch the page holds one key, which is handed to both models under their provider's variable name. Until that branch lands, keep act and judge on the same provider, and do not use `openai-compatible/` on managed runs: without a base URL they block with `MODEL_KEY_MISSING`.

**Spend.** Each run records model, calls, input, cached input, output and reasoning tokens per step. When the run report carries a cost (reported by the provider, for example OpenRouter, or estimated by the engine), it is stored as reported, with price table version `provider`. Otherwise the backend prices tokens from `test_model_prices`: global rows (`org_id` null) seeded by migration 0023 for the Anthropic ids, their `gateway/anthropic/` forms and `claude-code/` aliases, overridden per organisation through `PUT /model-prices` (`test_config.manage`; no web form in this version). A model with neither a reported cost nor a price row shows no cost. Settings → Test cases → Model spend shows spend by user and model.

The Test runs settings have a daily budget field (`dailyBudgetUsd`). It is stored but not enforced in this version: no code sets `BUDGET_EXCEEDED`. Watch Model spend instead.

## 6. Runner pools

A runner pool belongs to one organisation. Each environment names its pool (Settings → Test cases → Environments). Every organisation has a `cloud` pool, created on first use, plus any self-hosted pools it creates. A worker registers into exactly one pool, so **a cloud runner deployment serves one organisation**. To give three organisations cloud runs, run three deployments.

### Cloud pool (Docker compose)

1. **Build and push the image** from the repository root:

   ```bash
   docker build -f deploy/runner/Dockerfile -t <registry>/jittle-lamp-e2e-runner:<version> .
   docker push <registry>/jittle-lamp-e2e-runner:<version>
   ```

   The image is `mcr.microsoft.com/playwright:v1.63.0-noble` with Bun 1.4.2 for the build, runs as `pwuser`, and starts `jl-e2e-runner start`. CI builds it (`build_runner_image`) but does not push it anywhere (section 9).

2. **Get a registration token for the organisation's cloud pool.** The web app shows **New token** only for self-hosted pools, so for the cloud pool call the API as a member with `test_config.manage`, using that member's signed-in session token (copy the bearer token from an authenticated request in the browser's network panel):

   ```bash
   curl -s -H "Authorization: Bearer <session token>" https://api.jittlelamp.example/runner-pools
   # note the id of the pool named "cloud"
   curl -s -X POST -H "Authorization: Bearer <session token>" \
     https://api.jittlelamp.example/runner-pools/<cloud pool id>/registration-token
   ```

   The token is returned once. Issuing a new one replaces the old one; registered workers keep working.

3. **Configure and start**, one directory and compose project per organisation:

   ```bash
   cp deploy/runner/runner.env.sample deploy/runner/runner.env   # JL_API_ORIGIN, JL_RUNNER_TOKEN
   docker pull <registry>/jittle-lamp-e2e-runner:<version>
   docker tag <registry>/jittle-lamp-e2e-runner:<version> jittle-lamp/e2e-runner:<version>
   JL_RUNNER_IMAGE_TAG=<version> JL_RUNNER_CONCURRENCY=1 \
     docker compose -p jl-runner-<org> -f deploy/runner/compose.yaml up -d --no-build --scale runner=<N>
   ```

   `compose.yaml` names the image `jittle-lamp/e2e-runner:${JL_RUNNER_IMAGE_TAG:-latest}`, hence the retag. The `-p` name keeps each organisation's volumes apart.

**Scaling.** Parallel runs are the smallest of three numbers: replicas times `JL_RUNNER_CONCURRENCY`, and the organisation's `maxConcurrentRuns` (Settings → Test cases → Test runs, 1 to 50, default 1). The cloud pool has no limit of its own. Raise both together.

- Set `JL_RUNNER_CONCURRENCY` in the shell or in a `.env` file next to `compose.yaml`. The value in `runner.env` has no effect, because the compose `environment:` entry overrides `env_file`.
- A run needs about 1 CPU and 1 to 1.5 GB of memory. Each container is limited to 3 GB, so keep `JL_RUNNER_CONCURRENCY` at 1 or 2 and scale with replicas.
- `shm_size: 1gb` is required for Chromium.

**State.** Volume `runner-state` (`/home/pwuser/.config/jittle-lamp/runner`) holds one worker credential per API host and container host name, mode 600. Volume `runner-work` (`/var/lib/jl-e2e-runner`) holds run directories, deleted after each run unless `JL_RUNNER_KEEP_RUNS=1`. A container's host name is its container id, so a recreated container (for example after an image upgrade) registers as a new worker using the token in `runner.env`. Its old entry shows offline once and can be deleted in Settings → Test cases → Runner pools.

**Stopping.** `stop_grace_period: 20m` lets a running case finish (attempt deadline 15 min). On SIGTERM the daemon stops claiming and finishes its current runs. A worker that stops heartbeating loses its lease after 30 s; the run is requeued, and after 3 attempts it fails with `RUNNER_LOST`.

### Self-hosted pools

Use a self-hosted pool when the target is only reachable from inside a network, such as UAT behind a VPN. An organisation admin creates the pool in Settings → Test cases → Runner pools, which shows the registration token once, then installs the runner on a host inside that network with systemd (`deploy/runner/jl-e2e-runner.service`), Docker or the foreground CLI. Steps, file locations and the operating table are in [runner-setup.md](runner-setup.md); they are not repeated here. A self-hosted pool's concurrency is set on the pool itself.

### Network requirements

| From the runner to | Needed for | Notes |
| --- | --- | --- |
| Backend API (`JL_API_ORIGIN`) | Everything | Outbound HTTPS only. Allow request bodies of at least 64 MB on your proxy for evidence uploads |
| Target app (environment base URL) | The browser | HTTPS, unless the app runs on the runner host itself (in Docker that means `--network host`). VPN must be up on self-hosted hosts |
| Model provider | Act and judge calls | The provider's API host; for OpenRouter also `openrouter.ai` for the model list |

**Proxies and private CAs.** `runner.env.sample` and the systemd unit pass `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` through to the run's browser process (only `JL_*`, model key and test-secret variables are dropped). Whether each client honours a proxy variable depends on the client: Node's built-in `fetch`, used by the daemon to reach the backend and by the model SDKs, ignores `HTTPS_PROXY` unless the Node version supports and enables it (`NODE_USE_ENV_PROXY=1`). Prove the path with one run before relying on a proxy.

## 7. Integrations

All integration settings are per organisation and need `test_config.manage`. Their secrets are encrypted with the organisation data key, so `JL_SECRETS_MASTER_KEY` must be set first.

### GitLab and GitHub webhooks

1. **Provider credential** (Settings → Test cases → Credentials):
   - GitLab: kind `gitlab_token`, field `api_url` (for example `https://gitlab.example.com/api/v4`), secret `token` (project or group access token with `api` scope). The token is only ever sent to `api_url`, never to a host taken from a payload.
   - GitHub: kind `github_app`, secret `token` (a fine-grained personal access token or an installation token with statuses and pull requests write), and `api_url` for GitHub Enterprise.
2. **Endpoint** (Settings → Test cases → Webhooks → new): pick the provider, then add rules: event, branch pattern or label, suite, environment, allowed hosts for review-app or deployment URLs (default: the base environment's host), and what to report (commit status, MR or PR note, callback URL, credential). The dialog shows the endpoint URL, `<JITTLE_LAMP_API_ORIGIN>/hooks/<endpoint id>`, and the secret once.
3. **Provider side.** GitLab: Settings → Webhooks, URL and Secret token, triggers for push, merge request, pipeline or deployment events. GitHub: Settings → Webhooks, Payload URL, content type `application/json`, the secret. The provider must reach the backend's public origin.
4. **Network.** The backend calls `api_url` and callback URLs through the SSRF guard. A self-managed GitLab or GitHub Enterprise that resolves to a private address needs its host name in `JL_OUTBOUND_ALLOW_HOSTS`. Review apps are opened by the runner, not the backend, so they need runner reachability, not an allowlist entry.

Inbound deliveries are verified in constant time (`X-Gitlab-Token`, or `X-Hub-Signature-256` for GitHub and generic), limited to 120 per minute per endpoint and client, and refused as replays when seen in the last 7 days. Outbound reports are retried with backoff up to 5 attempts per stage; Settings → Test cases → Webhooks shows each delivery and its report state.

### Slack and webhook channels

1. Create a Slack incoming webhook.
2. Settings → Test cases → Credentials: kind `slack_webhook`, secret field `url` holding the webhook URL.
3. Settings → Test cases → Notifications: add a Slack channel with that credential, filter by event kinds and tags, and press **Send test**.

A generic webhook channel stores its URL encrypted and must resolve to a public address or be in `JL_OUTBOUND_ALLOW_HOSTS`. Channel deliveries run from the backend's queue sweep (about every 10 s), never inside the request, and failed deliveries are retried 60 s apart up to 5 attempts. Message links use `WEB_APP_ORIGIN`.

### Jira import

Settings → Test cases → Credentials: kind `jira` with fields `base_url` and `email` and secret `api_token`. Test cases → Import → Jira then takes a JQL query. The backend calls Jira directly and generates one transcript per issue with the organisation's model, so the backend needs network access to Jira and the model provider, and the organisation needs a model key. The Jira call does not pass through the SSRF guard, so `JL_OUTBOUND_ALLOW_HOSTS` does not apply to it.

### Automation tokens for CI

Create a token in Settings → API tokens (main settings, not the test-case section). It starts with `jl_api_`, belongs to one organisation and acts with its owner's role, so the owner needs `test_run.create`, `test_run.view` and `test_config.use`. CI tokens get their own run-request bucket (default 30 requests per 600 s).

Templates: `deploy/ci/gitlab-ci-e2e.yml` and `deploy/ci/github-actions-e2e.yml`. Set `JL_RUNNER_IMAGE` (the pushed runner image), `JL_API_ORIGIN`, `JL_WEB_ORIGIN`, `JL_SUITE_ID`, `JL_ENVIRONMENT_ID` and the masked secret `JL_API_TOKEN`. The job runs `jl-e2e run --suite … --env … --cache strict --wait --junit …`: the suite executes on the environment's runner pool, and the CI job only waits and writes JUnit. Failed cases fail the job; blocked cases appear as skipped unless `--fail-on-blocked` is given.

## 8. Operational constraints

### One backend instance

Run exactly one backend instance. Several pieces of state live in process memory, or are processed without a lease:

| Piece | Where | With two or more instances |
| --- | --- | --- |
| Live view hub: watchers, latest frame per run, take-over input queue | `apps/backend/src/services/test-live.ts` (`createLiveHub`, one `Map` per process; the file says it is designed for one instance) | A runner's frame upload and a viewer's frame read can land on different instances: blank live view, lost take-over input |
| Webhook rate limiter, 120 requests per minute per endpoint and client | `services/window-limiter.ts`, used by `routes/test-webhooks.ts` | The limit multiplies by the instance count |
| Outbound webhook reports (commit status, MR note, callback) | `services/test-webhooks.ts`, `createWebhookReportWorker`, every 5 s | Progress is stored in the database (`webhook_batches.context_json` remembers what was sent), so retries and restarts do not repeat a report. But rows are picked without a lease, so two instances can post the same status or note at the same moment |
| Slack and webhook channel delivery | `services/notifications.ts`, `dispatchPendingNotifications`, called from the queue sweep in `services/test-run-queue.ts` | No lease either: duplicate Slack messages are possible |
| Schema migrations on startup | `startup/run-database-migrations.ts` | Instances starting together race on migrations. Use a migration job |

What is already safe across instances: run claims (one atomic `UPDATE`), run leases and requeue, dedupe (partial unique index from 0026), request rate buckets (`test_rate_buckets`), the organisation migration worker (database leases) and the hourly maintenance (idempotent).

**Scaling path.** Scale the backend vertically and the runners horizontally for now. Before running several API instances: move the live hub to a shared store (a small table or Redis), add a lease or claim column to `webhook_batches` and to channel dispatch, move the webhook limiter to the database or Redis, and run migrations as a job.

### Background work

Started in `apps/backend/src/index.ts` once a database is configured:

| Worker | Interval | Does |
| --- | --- | --- |
| Test run queue sweep | 10 s, and on every runner claim | Expired leases (requeue, `RUNNER_LOST` after 3 attempts), `NO_RUNNER` marking, offline runner notices (after 60 s without a heartbeat), then Slack and webhook channel delivery |
| Webhook report worker | 5 s | Pending and final commit statuses, MR notes, callbacks |
| Hourly maintenance | Every hour and once at startup | Organisation migration staging cleanup, expired guest memberships, abandoned uploads (24 h grace), test run evidence retention, purge of the evidence bin (30 days), expired device sessions, expired activity logs |
| Organisation migration workers | Continuous | `MIGRATION_WORKER_CONCURRENCY` workers |

### Retention

`applyTestRunRetention` moves test-run evidence to the bin per organisation (Settings → Test cases → Test runs): failed and blocked runs after `retention.failedDays` (default 180), passed runs after `retention.passedDays` (default 30). The latest run of each case is always kept. Binned evidence is purged with its S3 objects 30 days later. Retention pauses for an organisation while it is being migrated.

### Backups

| What | How | Notes |
| --- | --- | --- |
| Database | Turso point-in-time restore or scheduled dumps | Before every release with migrations, and on a schedule |
| Artifact bucket | Bucket versioning or replication | Evidence videos and archives |
| `JL_SECRETS_MASTER_KEY` | Secret manager, stored apart from database backups | Without it, restored secrets are unreadable |
| Runner state volumes | Optional | Losing them only means re-registering workers with a registration token |

### Monitoring

Health: `GET /health` returns `{"status":"ok"}`; `GET /version` returns the version and `NODE_ENV`.

Backend log lines to watch:

| Line | Meaning |
| --- | --- |
| `applying database migrations`, `database migrations applied` | Startup migrations ran |
| `failed to apply database migrations` | Startup failed; the process exits with code 1 |
| `test run queue maintenance started` | Queue sweep and channel delivery running |
| `backend listening` | Ready |
| `JITTLE_LAMP_API_ORIGIN is not set; …` | Fix before clients upload or webhooks are configured |
| `DEV ONLY: serving in-memory artifacts …` | Must never appear outside local development |
| `expired test run evidence moved to the bin` / `failed to apply test run evidence retention` | Retention result |
| `expired deleted evidences purged` / `failed to purge expired deleted evidences` | Bin purge result |
| `abandoned evidence uploads cleaned up` / `failed to clean up abandoned evidence uploads` | Upload cleanup |

The queue sweep, the webhook report worker and channel delivery swallow their errors without logging; failures are recorded in the database. Check them there:

```sql
-- runs waiting for a runner
select org_id, count(*) from test_runs where status = 'queued' and blocked_reason = 'NO_RUNNER' group by org_id;
-- workers silent for more than a minute
select pool_id, hostname, last_heartbeat_at from runner_workers
  where revoked_at is null and last_heartbeat_at < (strftime('%s','now') * 1000 - 60000);
-- outbound reports that gave up
select endpoint_id, report_stage, report_error from webhook_batches where final_reported_at is null and report_attempts >= 5;
-- channel deliveries that gave up
select channel_kind, last_error from notification_deliveries where status = 'failed' and attempts >= 5;
```

Runner logs (`journalctl -u jl-e2e-runner`, `docker compose logs`): `registered as worker …`, `claimed <run> …`, `[<run>] passed|failed|blocked (<reason>)`, `heartbeat failed: …`, `claim failed: …`, `worker credential rejected (…)`, `[<run>] lease lost; …`, `[<run>] evidence upload failed: …`.

## 9. Release and rollout

### CI

GitLab (`.gitlab-ci.yml`) runs pipelines for merge request events, commits on the default branch and tags; every other push gets no pipeline.

- `verify`: frozen install, `bun run release:check-version`, backend lint, typecheck and tests, workspace typecheck, root, MCP and runner unit tests, and `bun run build`.
- `runner-browser`: the runner against the fixture app in real Chromium with the mock model.
- `build_backend_image` (root `Dockerfile`) and `build_runner_image` (`deploy/runner/Dockerfile`): only on the default branch and on `vX.Y.Z` tags. Each builds an OCI tarball, checks it is not empty and deletes it. **Neither image is pushed to a registry.** See [gitlab-migration.md](../gitlab-migration.md) for why.

GitHub (`.github/workflows/ci.yml`) runs the same checks on pull requests and pushes to `main`; `release.yml` builds and publishes the extension and desktop app for `vX.Y.Z` tags.

**Version sync.** Every workspace `package.json` and the extension manifest carry the root version (1.8.2 at the time of writing). `bun run release:check-version` fails on any mismatch, and with a tag argument also checks the tag. `bun run release <version>` sets, checks and tags a release from a clean `main`. Tag both images with the same version and set `APP_VERSION` to it.

### Deploy order

1. **Back up** the production database (section 4) and confirm the master key is in the secret manager.
2. **Rehearse** on staging with a copy of production data: migrations, startup, smoke test.
3. **Configure** the new backend variables: `JL_SECRETS_MASTER_KEY`, `JITTLE_LAMP_API_ORIGIN` if missing, `JL_OUTBOUND_ALLOW_HOSTS` if a self-managed GitLab is used.
4. **Backend with migrations.** Run the migration job (or start the single instance with `RUN_DB_MIGRATIONS=true`), then deploy the new image. Wait for `database migrations applied`, `test run queue maintenance started` and `backend listening`, and for `GET /health`.
5. **evidence-web.** Build with the production `CLERK_PUBLISHABLE_KEY` and API origin, and deploy.
6. **Runner pool.** Issue the pilot organisation's cloud pool token (section 6) and start its runner deployment. Check that the worker shows online.
7. **Enable for one organisation** (below), run the smoke test there, then widen.

Desktop and extension releases are independent; the web app is enough to use the feature.

### Smoke test

- [ ] `GET /health` and `GET /version` answer, and the logs show no `DEV ONLY` or `JITTLE_LAMP_API_ORIGIN is not set` line.
- [ ] Settings → Test cases → AI model: save act and judge ids and a key. The key shows as configured with its last four characters (this proves the master key works).
- [ ] Create an environment bound to `cloud` and a credential profile.
- [ ] Runner pools: the cloud pool shows at least one worker online.
- [ ] Create a case, run it on the cloud pool: live progress, live view, outcome, and evidence that opens in the viewer.
- [ ] Re-run with **Run again (force)**: Act steps show `replayed` with no model calls.
- [ ] Settings → Test cases → Model spend shows the runs' cost.
- [ ] Webhooks: create an endpoint, send a test from the provider (GitLab: the webhook's Test button; GitHub: the ping on creation, stored as ignored with a `pong` answer), and see the delivery in the endpoint's list. With a matching rule, a commit status appears on the merge request.
- [ ] Notifications: a Slack channel's **Send test** posts to Slack.
- [ ] CI: an automation token runs a suite through a template and produces JUnit.
- [ ] After an hour, no `failed to apply test run evidence retention` line.

### Rollout per organisation

There is no feature flag. Migration 0024 grants the test-case permissions to the default roles of every existing organisation, and new organisations get them by default, so every organisation sees Test cases after the release. What actually gates runs:

- **Runners.** A cloud run needs a worker registered in that organisation's cloud pool, and only the operator deploys those. Without one, runs wait with `NO_RUNNER`.
- **Model key.** Without one, runs block with `MODEL_KEY_MISSING`, and Jira import cannot generate transcripts.

To limit the feature to one team: deploy cloud runners only for the pilot organisation, and ask other organisations' admins to leave the AI model empty. To also hide the pages, an organisation admin can remove the `test_case.*`, `test_run.*` and `test_config.*` permissions from the organisation's roles (`PATCH /orgs/:orgId/roles/:role`, in the organisation's role settings). The admin role always keeps every permission.

## 10. Troubleshooting

### Blocked runs and queue states

| Reason or code | Cause | Fix |
| --- | --- | --- |
| `NO_RUNNER` (run stays `queued`) | No worker of the environment's pool sent a heartbeat in the last 30 s | Start or fix the pool's runner. For `cloud`, the organisation needs its own cloud deployment (section 6) |
| `RUNNER_LOST` (run `failed`) | The lease expired 3 times: host died, network cut, container killed | Check the runner host and its logs; check `stop_grace_period` and memory limits |
| `MODEL_KEY_MISSING` | No key, or the key does not cover the model's provider, or `openai-compatible/` without a base URL | Settings → Test cases → AI model. Keep act and judge on one provider until `feat/e2e-providers` lands |
| `MODEL_UNAVAILABLE` | Unknown prefix (for example `xai/` before `feat/e2e-providers`), an OpenRouter id not in its list, `claude-code/` on a runner without `--allow-claude-code`, or the provider rejected the call | Fix the model id; check provider status and the runner's egress |
| `MISSING_CREDENTIAL` | The transcript names a credential profile the environment lacks, or a secret is unavailable | Settings → Test cases → Credentials |
| `MISSING_VARIABLE` | A `{variable}` is undefined in the environment and params | Settings → Test cases → Environments, or case params |
| `APP_UNREACHABLE` | The browser could not open the base URL from the runner | VPN or DNS on the runner host; environment bound to the wrong pool; plain `http://` to a non-loopback host |
| `AUTH_CREDENTIAL_UNAVAILABLE` | The login credential was refused or missing | Rotate or fix the credential |
| `INCONCLUSIVE` | The judge could not decide, also used for unmapped engine codes | Make the assert specific; use `[Wait]` |
| `REPLAY_STALE` | A cached script no longer replays in `strict` cache mode (CI) | Run once without strict mode to re-record, or clear the step's script |
| `STEP_BUDGET_EXHAUSTED` | The agent used up its step budget | Split the step |
| `MACRO_ERROR`, `TRANSCRIPT_INVALID` | Macro expansion or transcript parsing failed | Fix the case; lint shows the line |
| `ENGINE_ERROR` | Setup failed inside the runner (browser, policy, unsupported action) | Runner logs; `JL_RUNNER_KEEP_RUNS=1` to keep the run directory |
| `BUDGET_EXCEEDED` | Not produced in this version (the daily budget is not enforced) | n/a |
| `429 QUEUE_FULL` | More than `maxQueuedRuns` (default 20) queued | Wait, or raise it in Test runs settings |
| `429 RATE_LIMITED` | Request bucket empty for the user or token | Wait `retryAfter`, or raise the bucket |

### Deployment errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| Boot fails: `APP_SECRET is required in production` | `NODE_ENV=production` without `APP_SECRET` | Set at least 24 random characters |
| Boot fails: `TURSO_AUTH_TOKEN is required for remote libSQL/Turso URLs` | `libsql://` URL without a token | Set `TURSO_AUTH_TOKEN` |
| Boot fails: `S3_BUCKET is required in production`, or `<name> is required when S3 storage is configured` | Partial S3 settings | Set bucket, region, key id and secret together |
| Boot fails: `CLERK_PUBLISHABLE_KEY` or `CLERK_AUTHORIZED_PARTIES is required in staging/production …` | Clerk configured without them | Set both |
| Boot fails: `JL_SECRETS_MASTER_KEY must be base64 of exactly 32 bytes …` | Wrong key format | `openssl rand -base64 32` |
| Boot fails: `failed to apply database migrations` | Database unreachable, wrong working directory (no `./drizzle`), or a migration error | Start in `apps/backend`; restore from backup if a migration half-applied |
| `503 SECRETS_MASTER_KEY_MISSING` on credential or model key save | `JL_SECRETS_MASTER_KEY` unset | Set it and restart |
| `500 SECRET_DECRYPTION_FAILED` | Data keys wrapped by a key that is not configured (wrong key, copied data, rotation without `JL_SECRETS_MASTER_KEY_PREVIOUS`) | Configure the right key, or re-enter the secrets |
| Browser shows CORS errors | Web origin missing from `WEB_APP_ORIGIN` and `CLERK_AUTHORIZED_PARTIES` | Add it |
| Webhook URL in settings points at an internal host | `JITTLE_LAMP_API_ORIGIN` unset behind a proxy | Set it and reopen the endpoint |
| Commit status or Slack delivery fails with `resolves to a private or local address` | Target is internal | Add the host to `JL_OUTBOUND_ALLOW_HOSTS` |
| `… answered with a redirect (3xx); redirects are not followed` | `api_url` or channel URL redirects (often http to https) | Use the final URL |
| Runner exits: `No worker registration in …; start once with --token …` | No stored credential and no token | Set `JL_RUNNER_TOKEN` |
| Runner logs `worker credential rejected (401)` and stops | Worker deleted in the UI, or pool removed | Register again with a fresh registration token |
| Chromium crashes in Docker | Shared memory too small | Keep `shm_size: 1gb` |
| Runner evidence upload fails with 413 | Proxy body limit below 64 MB | Raise the limit on the API proxy |

## Open questions for the operator

1. How many backend instances will production run? This guide assumes one (section 8).
2. Where are the backend and runner images pushed (GitLab Container Registry or LittleLives ECR), and who publishes them? CI builds both and discards them.
3. Who owns the migration job in production, and is `RUN_DB_MIGRATIONS` set to `false` on the application containers?
4. Where does the cloud runner pool run (host, orchestrator, size), and for which organisations? Each organisation needs its own deployment.
5. Should the web app offer **New token** for the cloud pool, or will the operator keep issuing it through the API?
6. Should a master key re-wrap command (around `rewrapDataKeys()`) be added before the first rotation?
7. Which secret manager holds `JL_SECRETS_MASTER_KEY`, and where are database backups stored, so the two stay apart?
8. Does staging get its own Clerk instance, and how will functional tests sign in against a copy of production data?
9. Which internal hosts (self-managed GitLab, internal callback receivers) go into `JL_OUTBOUND_ALLOW_HOSTS`?
10. Do runners need a corporate proxy or private CA, and has one run been proven through it?
11. Is a daily model budget needed before rollout? It is not enforced today.
