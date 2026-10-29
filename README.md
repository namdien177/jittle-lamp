# Jittle Lamp

**QA evidence that agents can read, write and run.**

Jittle Lamp records browser sessions as reviewable evidence: video, user actions, console and full network traffic in one timeline. AI agents can then debug that evidence, write test cases in plain language, run them in real browsers and report results back to your merge requests.

The canonical repository is [`Front-End/jittle-lamp`](https://git.littlelives.io/Front-End/jittle-lamp) on GitLab. GitHub stays the public release source during the migration ([migration notes](docs/gitlab-migration.md)).

![Jittle Lamp product preview](apps/evidence-web/assets/img-prev.png)

## What agents can do

### Debug a recording from a link

Hand an agent an evidence link and it gets the whole session as structured data, not a video it has to watch.

- `GET /ai/evidences/:id/debug` returns the evidence, session and artifact context for one recording. It needs an AI token with the `evidence:debug` scope.
- `GET /llms.txt` tells agents how to use these endpoints.
- Through MCP, `read_evidence_events` pages through actions, console lines and network requests, and `get_evidence_debug` returns the same debug context.

Archives mask secrets before they leave the recorder: auth headers, cookies, tokens and password fields keep only their first and last four characters. Typed field values are never captured.

### Write test cases in plain language

A test case is a transcript of tagged lines grouped into checkpoints:

```markdown
## Checkpoint: Sign in
[Login: profile=PCF, tenant=HQ]
[Open] /attendance
[Act] Mark the first child as present
[Assert] The child's status shows "Present"
```

The transcript is the source of truth, and the parser lives in `packages/shared/src/test-case.ts`. Tags include `Open`, `Act`, `Assert`, `Wait`, `Extract`, `Screenshot` and `Note`, plus a few that do more:

- `[Login: …]` calls an organisation macro.
- `[Use: TC-0001]` runs another case inline.
- `[Query]` runs a read-only Postgres check behind `packages/shared/src/sql-guard.ts`.

Variables and credentials are referenced only by name (`vars.KEY`, `secret('PROFILE.field')`), so transcripts never contain secrets. A missing name blocks the run instead of guessing. Faker fields such as `{person.name}` generate test data in the environment's locale.

Test cases can be created several ways:

- **From your requirements.** Import Jira issues (by JQL), Gherkin, CSV or XLSX files, or another transcript doc.
- **By exploring.** Give the app plain instructions and a runner explores the app in a real browser, then drafts the transcript.

Cases created by agents always land in the review queue, and agent-created macros start as drafts. A person approves them.

### Run in a browser, then replay without the model

The first run is agentic: a model drives a real browser through each step and a judge model checks the asserts. Every verified action is cached as a structured record and shown as Playwright code. Later runs replay that cache with no model calls, and only hand control back to the agent when the page has changed and the cached target is gone.

- **Verdicts are honest.** A run's `outcome` is `passed`, `failed` or `blocked`. Missing credentials, broken setup and runner problems are `blocked`, not `failed`.
- **Runs are evidence.** Each run uploads a normal evidence record, with `recording.webm`, `session.archive.json` and `run-report.json` tagged by step and checkpoint. You review a test run in the same viewer as a manual recording.
- **Live view and take-over.** Watch a cloud run as it happens and take control of the browser when it gets stuck. Take-over input is tagged `user:takeover` and never cached.
- **Cost is tracked.** Token usage and cost are recorded per step. An organisation can set a daily USD budget, and runs past it wait with `BUDGET_EXCEEDED`.

### Choose your model

The runner uses the Vercel AI SDK. Each organisation picks an act model and a judge model. A provider can have several model accounts, each with a priority and daily or monthly budgets. When one account is rate-limited, out of quota or rejects its key, the run fails over to the next.

| Model prefix | Key |
| --- | --- |
| `anthropic/` | `ANTHROPIC_API_KEY` |
| `openai/` | `OPENAI_API_KEY` |
| `google/` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `xai/` | `XAI_API_KEY` |
| `openrouter/` | `OPENROUTER_API_KEY` |
| `gateway/` | `AI_GATEWAY_API_KEY` (Vercel AI Gateway, the default for new organisations) |
| `openai-compatible/` | `OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_API_KEY` |

### Gate merges on E2E results

Webhooks connect test suites to your repository:

- **Inbound.** `POST /hooks/:endpointId` takes GitHub or GitLab push, merge request, pipeline and deployment events (verified by HMAC or token). Rules map those events to suite runs, deduplicated by commit SHA.
- **Outbound.** Runs post a `jittle-lamp/e2e` commit status, from pending to final, and can add a comment to the PR or MR. Deliveries retry, and failed ones end in a dead-letter list.
- **Pipelines.** Templates for [GitHub Actions](deploy/ci/github-actions-e2e.yml) and [GitLab CI](deploy/ci/gitlab-ci-e2e.yml) run `jl-e2e run --suite … --cache strict --wait --junit` and fail the job on failed cases (add `--fail-on-blocked` to fail on blocked ones too).
- **Notifications.** Test run and batch results go to in-app notifications, Slack or a signed webhook.

## Connect Codex or Claude Code (MCP)

`apps/mcp` is a local MCP server named `jittlelamp`. It exposes over 40 tools:

- **Evidence.** List, read, rename, move, copy, tag, comment on and delete evidence; read events; download artifacts.
- **Share links.** Create, list, resolve and revoke share links.
- **Uploads.** Upload evidence ZIPs, or stage a manual upload.
- **Test cases.** Search, create, update, deduplicate and import cases; generate cases from Jira or instructions.
- **Runs.** Start a run (optionally waiting for it) and read results.

The full list is in the [MCP guide](docs/mcp.md).

There are two token types, and both go in `JL_AI_TOKEN`:

- **AI tokens** (`jl_ai_`, **Settings > AI tokens**) act with your account's permissions.
- **Automation tokens** (`jl_api_`, **Settings > API tokens**) are tied to one organisation and limited to ZIP uploads and a small set of test tools.

No token can approve, reject, bulk-edit or delete test cases.

### Install from terminal

On macOS or Linux, with Git and your client installed:

```bash
curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/install-mcp.sh | bash
```

Choose `codex`, `claude` or `both`, then paste your token at the hidden prompt. The installer:

- builds a standalone bundle in `~/.local/share/jittle-lamp/mcp` (or under `$XDG_DATA_HOME`);
- installs Bun 1.3.11 if no suitable Bun is found, which needs `curl` and `unzip`;
- registers the `jittlelamp` entry, at user scope for Claude.

Rerun it to update. Restart your client afterwards; with an AI token, asking for your Jittle Lamp context verifies the connection.

```bash
# pick the client up front
curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/install-mcp.sh | bash -s -- --client both

# or install from a checkout
bash scripts/install-mcp.sh
```

The [MCP guide](docs/mcp.md) covers custom API origins, unattended setup and manual configuration. Run `bash scripts/install-mcp.sh --help` for all installer options.

## Run tests from the command line

`packages/e2e-runner` ships two commands.

**`jl-e2e`** runs a case locally, or drives the backend:

```bash
jl-e2e run checkout.transcript.md --env-file .env --mode hybrid --upload   # run locally, upload the evidence
jl-e2e run --suite <suiteId> --env staging --wait --junit report.xml      # run a suite on the runner pool
jl-e2e generate instructions.txt --env <environmentId>                    # explore, then draft cases
jl-e2e cache ls --code                                                    # inspect cached Playwright actions
```

Remote commands need `JL_API_ORIGIN` plus `JL_API_TOKEN` or `JL_AI_TOKEN`. The exit code is `0` for passed, `1` failed, `3` blocked and `4` error. `--mode hybrid` replays `[Use]` preconditions through recorded API calls instead of the browser, and `--mode api` does the same for the case's own actions. A failed API check falls back to the browser.

**`jl-e2e-runner`** is a worker daemon for a runner pool. It registers with a pool token, claims queued runs and explorations, and uploads their evidence:

```bash
jl-e2e-runner start --api https://api.example.com --token <registration-token> --concurrency 2
```

Docker, Compose and systemd setups are in [`deploy/runner/`](deploy/runner), and the [runner setup guide](docs/e2e-test-cases/runner-setup.md) walks through them.

## Record evidence by hand

The test runner isn't the only source of evidence. People record sessions too:

1. **Record** with the Chromium extension. Press **Start** on any `http(s)` page and **Stop** when done. It captures `recording.webm` and `session.archive.json`.
2. **Review** in the macOS desktop app. It receives recordings from the extension, plays them against the timeline, and lets you inspect network requests and add tags and notes. It can also record the screen, a window or an app itself, with that app's logs.
3. **Share** by uploading to your organisation and sending a link. The evidence web viewer renders the same review UI in the browser.

On macOS 15+ (Apple silicon), install or update the desktop app with:

```bash
curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | bash
# a specific release: ... | JITTLE_LAMP_VERSION=vX.Y.Z bash
```

The desktop app has no in-app updater, so rerun the installer to upgrade. To load the extension from source, run `bun run --cwd apps/extension build`, then load `apps/extension/dist` unpacked from `chrome://extensions` with Developer mode on.

[Recording, archives and storage](docs/recording.md) covers what the recorder captures, how archives are compacted and masked, and upload limits.

## Architecture

```
extension (record) ──▶ desktop companion (127.0.0.1:48115) ──▶ desktop reviewer
                                                                     │ upload
 jl-e2e / runner pool ──▶ backend (Elysia, S3 artifacts) ◀───────────┘
 MCP / CI webhooks    ──▶        │
                                 ▼
                         evidence-web (shared review)
```

| Path | What it is |
| --- | --- |
| `apps/backend` | Elysia API: Clerk auth, Drizzle over libSQL/Turso, S3 artifact storage, test runs, webhooks, AI endpoints |
| `apps/mcp` | Local MCP server for Codex and Claude Code |
| `apps/extension` | Chromium MV3 recorder |
| `apps/desktop` | Native macOS app in Rust and GPUI: recorder, companion, reviewer and uploader |
| `apps/evidence-web` | Web workspace and shared-link viewer |
| `packages/e2e-runner` | `jl-e2e` CLI and `jl-e2e-runner` daemon |
| `packages/shared` | Zod schemas for every cross-process payload, including the transcript parser |
| `packages/viewer-core`, `packages/viewer-react` | Review UI for the web workspace and shared links |
| `packages/ui` | Shared UI components |

## Develop

Use Bun 1.4.4, the version pinned for CI and containers. Copy `.env.sample` to `.env` first.

```bash
bun install
bun run typecheck
bun test
bun run build                 # ordered build: shared → viewer-core → viewer-react → apps (no Rust)
bun run --cwd apps/backend dev
```

The desktop app needs macOS 15+ and the Rust toolchain from [rustup](https://rustup.rs) (stable; Homebrew's `rustc` is too old). See [`apps/desktop/DESIGN.md`](apps/desktop/DESIGN.md).

```bash
bun run --cwd apps/desktop dev      # cargo run, with the companion on 127.0.0.1:48115
bun run --cwd apps/desktop test     # cargo test --workspace
bun run --cwd apps/desktop bundle   # signed "Jittle Lamp.app" in apps/desktop/target/bundle
```

To use the web workspace without a real Clerk account, run `bun run dev:test-auth`. It starts the backend on `http://127.0.0.1:3001` and the web app on `http://127.0.0.1:4173`, signed in as `dev+clerk_test@jittlelamp.local`. `bun run dev:test-auth:setup` only regenerates `.env.dev-auth`.

[`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) hold the coding conventions for people and agents working in this repo.

## Docs

- [MCP guide](docs/mcp.md)
- [AI-driven E2E test cases (ADR 0002)](docs/adr/0002-ai-driven-e2e-test-cases.md), plus [design](docs/e2e-test-cases/design.md), [status](docs/e2e-test-cases/STATUS.md) and [deployment](docs/e2e-test-cases/deployment.md)
- [Runner setup](docs/e2e-test-cases/runner-setup.md)
- [Recording, archives and storage](docs/recording.md)
- [Releasing](docs/release.md)
- [V1 scope](docs/v1-scope.md)
