# AI-driven E2E test cases — feature design

Status: proposal. Decisions are recorded in [ADR 0002](../adr/0002-ai-driven-e2e-test-cases.md). This document is the working spec: data model, transcript format, runner, caching, UI, API, MCP tools and phasing.

## 1. Goal

Turn Jittle Lamp from a recording library into an E2E platform:

- A **test case** is a transcript: a list of natural-language instructions with checkpoints, plus description and links (Jira, Google Docs).
- An **AI agent** reads the transcript, opens a real browser, follows the instructions like a user, verifies each checkpoint and records the whole session as evidence (video, actions, network, console).
- Every instruction that the agent executes is turned into a **cached step script**. Re-runs replay the script first and only fall back to the agent when the application changed.
- Each execution is a **test session** (run) with its own video, verdict, per-step results and metadata. A test case shows all its runs.

Later phases link existing recordings to test cases and derive transcripts from manual recordings.

## 2. What we learned from the references

| Topic | Tester Army (`tester.army`, `tester-army/e2e`) | Browserbase / Stagehand | What we take |
| --- | --- | --- | --- |
| Authoring | Plain-language steps with types `act`, `assert`, `login`, `files`, `screenshot`, `javascript`; 1–30 steps; login must be its own step; credentials referenced indirectly ("the saved admin account") | Code-first: `act("click the login button")`, `observe`, `extract`, `agent.execute(instruction)` | Typed transcript lines (`[Assert]`, `[Login: PCF]`), action/assert split, credential profiles never typed literally |
| Execution | Agent observes an accessibility snapshot with `@e` element refs, acts, judges outcomes; `assert` is judged on the current screen only | DOM-mode agent on an accessibility tree, CUA mode on screenshots | A11y snapshot with refs as the primary observation, screenshots only for `vision` asserts |
| Caching | Only verified `act` steps are recorded; entries store actions, target descriptions (role, name, test id, context), typed text and final-state checks, one JSON file per entry keyed by test/target/instruction/params; replay checks start route, finds each control, checks end state, then hands off to the agent on drift; `read-write`/`read-only`/`off`/`strict` modes | Cache keyed on instruction + a11y tree + URL + options; a cached act replays its selector with self-healing off and falls back to inference when the selector no longer resolves | Structured action records, end-state checks, hand-off semantics, strict mode for CI. We add a rendered Playwright view and a cached deterministic check for asserts |
| Verdicts | Execution status (`completed`/`failed`/`cancelled`) is separate from outcome (`PASSED`/`FAILED`/`BLOCKED`); blocked runs excluded from pass rates | n/a | Same two-level model; it already matches `record-flow.mjs` |
| Evidence | Run video, screenshots, agent transcript, console and network logs, JUnit export; share links per run | HLS session replay, network alongside video | Runs are normal Jittle Lamp evidence, reusing the viewer and share links |
| Context | Project Memory (site structure, test insights) injected into every run; Agent Instructions for behaviour rules | `systemPrompt` on the agent | Org-level "Agent notes" (phase 2); environment variables (base URL, routes) in phase 1 |
| Variables | `{name}` params; `unique()` for per-run values so the cache key stays stable | `%variables%` placeholders | `{name}` substitution from environment and run params; values are excluded from the cache key |

Where we differ from Tester Army: the user wants readable, exportable code per instruction. Tester Army treats the cache as opaque data. We keep the structured record as the replay source and render it to Playwright TypeScript so a tester can read, copy or export it.

## 3. Concepts and data model

```
organization
└── test_environment       (name, baseUrl, variables)
└── test_credential        (profile name, username, environment, secret ref)
└── test_macro             (name, params, transcript body)   e.g. Login
└── test_case
    ├── transcript (text) + steps[] (parsed, stable ids)
    ├── links[] (Jira, docs), tags[], description
    ├── test_step_script[]      (cache: one active entry per step + environment)
    ├── test_run[]              (test sessions)
    │   ├── test_run_step[]     (per-step verdict, mode, video offset)
    │   └── evidence            (recording.webm + session.archive.json + run-report.json)
    └── test_case_evidence[]    (manual links to any evidence; phase 3)
```

### 3.1 Backend tables (`apps/backend/src/db/tables/`)

All tables are organisation-scoped and follow the `evidences` conventions (uuid v7 ids, `created_by`, epoch-ms timestamps, soft delete where users can delete).

| Table | Key columns |
| --- | --- |
| `test_environments` | `org_id`, `name` (`pcf-uat`), `base_url`, `variables_json` (non-secret `KEY: value`), `notes` |
| `test_credentials` | `org_id`, `profile` (`PCF_HQ_ADMIN`), `environment_id?`, `fields_json` (public fields such as `username`), `secret_fields_enc` (AES-256-GCM, see §9), `key_version`, `last_used_at`, `login_macro_id?` |
| `test_macros` | `org_id`, `name` (`Login`), `params_json`, `transcript`, `steps_json`, `version` |
| `test_cases` | `org_id`, `key` (`TC-0001`, per-org sequence), `created_by`, `title`, `description`, `links_json`, `tags_json`, `environment_id?`, `transcript`, `steps_json`, `transcript_version`, `params_schema_json` (declared `{param}` names with defaults), `status` (`draft|review|active|archived`), `source` (`manual|import|ai|duplicate|recording`), `source_ref` (import batch, generation id, origin case, evidence id), `duplicated_from_id?`, `external_id?` (TestRail, Xray, sheet row), `fingerprint` (normalised transcript hash for exact-duplicate detection), soft-delete columns. A `test_cases_fts` FTS5 table indexes `key`, `title`, `description`, `transcript`, `tags` |
| `test_case_versions` | `test_case_id`, `version`, `transcript`, `steps_json`, `created_by`, `created_at`, `change_note?` | Every run points at a version; the run page shows the transcript as it was. Macro expansions are frozen into `steps_json` with the macro version, so editing a macro bumps the `instructionKey` of expanded steps and invalidates only those scripts |
| `test_run_batches` | `org_id`, `kind` (`dataset|suite|ci`), `test_case_id?`, `suite_id?`, `trigger`, `status`, counts | A dataset run creates one batch with one run per row; a suite run one batch with one run per member. Test sessions show batches collapsed with per-run drill-down |
| `test_case_datasets` | `test_case_id`, `name`, `rows_json` (array of `{param: value}`), `enabled` | A parameterised case runs once per row; each row is a variant run with `params_hash`, not a separate case |
| `test_suites`, `test_suite_members` | `org_id`, `name`, `description`, `filter_json?` (smart suite), `member test_case_id` + `position` (static suite) | Suites are the unit of grouping for group runs, CI and reports; a case can be in many |
| `test_import_batches`, `test_import_items` | batch: `org_id`, `created_by`, `source_kind` (`transcript-doc|gherkin|csv|xlsx|jira|ai-generation`), `file_artifact_id?`, `mapping_json`, `options_json`, `status`, counts; item: `batch_id`, `ordinal`, `external_id?`, `parsed_json`, `lint_json`, `similar_json`, `decision` (`create|update|skip|merge`), `result_test_case_id?`, `error` | Import runs as a background job on the lease worker; the batch page is the progress and error report |
| `test_step_scripts` | `test_case_id`, `step_id`, `instruction_key`, `environment_id?`, `version`, `actions_json`, `end_state_json`, `rendered_code`, `recorded_from_run_id`, `status` (`active|stale|invalid`), `stale_reason`, `verified_count`, `last_replayed_at` |
| `test_runs` | `test_case_id`, `org_id`, `created_by`, `transcript_version`, `environment_id`, `params_hash`, `dedupe_key`, `trigger` (`manual|cli|mcp|ci`), `priority`, `runner_affinity` (`cloud` or `desktop:<userId>`), `runner` (`desktop|cli|cloud`), `runner_info_json` (runner version, engine version, browser, viewport, cache mode), `status` (`queued|claimed|running|paused|completed|failed|cancelled`), `outcome` (`passed|failed|blocked|null`), `blocked_reason`, `queued_at`, `started_at`, `finished_at`, `evidence_id?`, `error`, **metrics**: `model_id`, `judge_model_id`, `provider`, `model_calls`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens`, `cost_usd`, `price_table_version`, `duration_ms`, `steps_total`, `steps_replayed`, `steps_agent`, `steps_handoff`; **lease**: `worker_lease_owner`, `worker_lease_expires_at`, `worker_heartbeat_at`, `attempts` |
| `test_run_steps` | `run_id`, `step_id`, `ordinal`, `type`, `status` (`passed|failed|blocked|skipped`), `mode` (`agent|replayed|handoff`), `cache_reason`, `started_at`, `finished_at`, `duration_ms`, `video_offset_ms`, `observed` (agent summary or assertion actual), `error`, `screenshot_artifact_id?`, `script_version?`, **metrics**: `model_id` (act model or judge), `model_calls`, `actions`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens`, `cost_usd`, `vision_input` |
| `test_run_subscribers` | `run_id`, `user_id`, `trigger`, `created_at` | Everyone who requested a run that was deduplicated onto this one; used for notifications and the "attached" badge |
| `test_model_prices` | `org_id?` (null = global default), `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `effective_from` | The AI SDK returns tokens, not money; cost is computed at run finalisation from this table and the version is stamped on the run |
| `test_case_evidences` | `test_case_id`, `evidence_id`, `run_id?`, `relation` (`run|import`), `note` |

`evidence_artifacts.kind` already allows `attachment`; `run-report.json` is stored as an attachment and `screenshot` artifacts use the existing kind.

### 3.2 Shared schemas (`packages/shared/src/test-case.ts`)

Zod schemas for `TranscriptStep`, `ParsedTranscript`, `StepScript` (action records), `RunReport`, `RunStepResult`, plus the parser. Everything that crosses backend ↔ desktop ↔ runner ↔ MCP goes through these.

## 4. Transcript format

A transcript is plain text. One instruction per line. Headings group steps into checkpoints.

```text
# Login as HQ admin and sign out again

[Open] /login
[Login: PCF] đăng nhập tài khoản HQ_ADMIN PCF
[Act] mở menu tài khoản ở góc trên bên phải và chọn "Đăng xuất"

## Checkpoint: Logout returns a clean login form
[Assert] trang hiện lại form đăng nhập
[Assert] input text Email phải trống
[Screenshot] login form after logout
```

Grammar:

```
line        := blank | heading | step
heading     := "#" text                     (title, first heading only)
             | "## Checkpoint:" text         (groups following steps until the next heading)
step        := "[" tag [":" args] "]" text
             | text                          (bare text = Act)
args        := value                         (fills the macro's first parameter)
             | name "=" value {"," name "=" value}
tag         := Open | Act | Assert | Login | Wait | Screenshot | Extract | Note | <macro name>
```

| Tag | Meaning | Cached? | Model call on replay |
| --- | --- | --- | --- |
| `[Open] <url or path>` | Navigate. Paths resolve against the environment base URL | deterministic, no cache needed | no |
| `[Act] <text>` or bare text | Agent performs one user intent | yes (action record) | only on hand-off |
| `[Assert] <text>` | Checkpoint. Agent judges the current screen; no data mutation allowed | deterministic check cached | on cached-check failure, and always when `vision` is requested |
| `[Login: <profile>] <text>` | Runs the org `Login` macro with the credential profile. Text is a human note | per macro step | only on hand-off |
| `[Wait] <condition>` | Poll until the condition holds (timeout from settings) | cached as a check | on cached-check failure |
| `[Screenshot] <label>` | Capture a screenshot artifact | n/a | no |
| `[Extract: <var>] <text>` | Agent extracts a value into `{var}` for later steps | no | always |
| `[Note] <text>` | Not executed; shown in reports | n/a | no |
| `[<Macro>: <arg>]` | Any other tag resolves to an org macro of that name | per macro step | only on hand-off |

Variables: `{name}` is substituted from run params, then environment variables. Values never enter the cache key, so `{email}` can vary per run while the step still replays. Secrets are never written in transcripts; `[Login: PCF]` references a credential profile and the runner fills the password without sending it to the model.

Step identity: each step gets a stable `stepId` when the transcript is saved. On edit, the parser re-matches steps by `instructionKey = sha256(type, arg, normalisedText)` so unchanged lines keep their id, cache and run history. A changed line is a new step with an empty cache.

Guidance surfaced in the editor (from Tester Army's writing guide): one intent per step, actions separate from asserts, visible labels instead of selectors, specific expected results, 3–15 steps per case.

## 5. Runner (`packages/e2e-runner`)

A workspace package with a library API and a `jl-e2e` CLI. No React, no Electron imports. Dependencies: `playwright-core` (uses the installed Chrome via `channel: "chrome"`, no browser download), the Vercel AI SDK (`ai` v7 plus provider packages such as `@ai-sdk/anthropic`), `@jittle-lamp/shared`, and, after the phase 0 gate below, `e2e` from Tester Army as the execution core.

### 5.0 Execution core: Tester Army `e2e` vs Stagehand vs our own loop

Evaluated on 2026-10-03 against our purpose (transcript-driven steps, per-step replayable record rendered to readable code, evidence with video + network + console, two-level verdicts, hand-off on drift, provider-neutral model access).

| Criterion | Tester Army `e2e` 0.16 (Apache-2.0) | Stagehand v3 / v4 (MIT) | Own loop on AI SDK + Playwright |
| --- | --- | --- | --- |
| Step semantics | `act` / `assert` / `waitFor` / `extract`, verdict `passed|failed|blocked` with error codes (`AUTH_CREDENTIAL_UNAVAILABLE`, `APP_UNREACHABLE`, `STEP_BUDGET_EXHAUSTED`…). Matches our model 1:1 | `act` / `observe` / `extract` / `agent`. No assert, no blocked; a verdict layer must be built | Whatever we build |
| Replay cache | Structured records (role, name, test id, context, typed text, end-state checks), hand-off reasons (`target-not-found`, `end-mismatch`…), modes `read-write/read-only/off/strict`, **pluggable `cache.store`** so entries can live in our `test_step_scripts` | v3: local `cacheDir`, entries keyed on instruction + URL, replay by recorded xpath selector, opaque. v4: server-side cache on Browserbase only | Build from scratch, could copy e2e's record format |
| Model access | AI SDK model instance required (`model`, separate `judge`), any AI SDK provider, OpenAI-compatible local models, subscriptions via OAuth | Own model strings, AI SDK-like, CUA modes | AI SDK `ToolLoopAgent` directly |
| Evidence | Playwright video per target, Playwright trace (network, console, screenshots, actions) with secret redaction, `artifacts.store` hook to push files elsewhere | Session replay only on Browserbase; local gets Playwright video in v3, nothing in v4 (CDP-only) | We port the extension capture |
| Extension points | `executor` (own step loop, or `createToolLoopExecutor` to reuse budgets, repeat detection, verdicts, usage accounting), `reporters` (step events with `durationMs`, `modelCalls`, replay on/off), `cache.store`, `artifacts.store`, engine SPI | Programmatic API, custom tools on `agent` | Everything |
| Programmatic run | **No.** Runs only through the CLI (`e2e run`) over `*.e2e.ts` files and `e2e.config.ts`. Per-step token usage is only in `ai-trace.json` / `--debug`, not in reporter events | Yes, plain library | Yes |
| Maturity | Pre-1.0, Node ≥ 22.12, engine version is part of the cache key so upgrades invalidate caches | v3 stable, v4 diverging from Playwright | Ours to maintain |

**Decision.** Use Tester Army `e2e` as the execution core in phase 0, wrapped by `packages/e2e-runner`:

1. The runner turns a transcript into a generated `case.e2e.ts` (`[Act]` → `agent.act()`, `[Assert]` → `agent.assert()`, `[Open]` → `app.open()`, `[Login]` → macro expansion, `{var}` → `params`, credentials → `Secret`) plus an `e2e.config.ts` with the resolved environment, `agents.default.model` built from the org's model setting through AI SDK, `video: 'on'`, `trace: 'on'`.
2. `cache.store` is backed by our backend (`test_step_scripts`) when online, by `.e2e/cache` when local. The record format is theirs; our "rendered Playwright" is a view over their record.
3. A `Reporter` streams step events to the run (`test_run_steps`), and `ai-trace.json` is parsed at finalisation for per-step tokens; `test_model_prices` converts tokens to cost.
4. `artifacts.store` pushes video, trace and screenshots to the evidence upload flow; the runner converts the Playwright trace into `session.archive.json` v4 (network, console, actions, step annotations), so the extension capture code is not ported.
5. Interaction lock and pause/take-over (§5.4) are implemented in a thin custom engine that wraps `@e2e-dev/web` and exposes the Playwright page.

**Gate at the end of phase 0.** Switch to our own loop (AI SDK `ToolLoopAgent`, same record format) if any of these hold: the generated-test-file route cannot express a transcript feature we need, per-step usage from `ai-trace.json` is unreliable, trace → archive conversion loses required data, or an `e2e` minor release breaks the config or cache contract twice during the spike. Stagehand is not a candidate for the core; it stays an option for an `observe`-based locator fallback only.


```
packages/e2e-runner/src/
  index.ts            runTestCase(plan, options) → RunReport + artifact paths
  plan.ts             resolve transcript + macros + environment + credentials into a RunPlan
  browser/            launch, context (recordVideo), viewport, storage state
  capture/            CDP network, console, DOM interaction listeners (port of extension content.ts), archive writer (schema v4)
  observe/            a11y snapshot with refs (same shape as playwright-mcp), screenshot helper
  agent/              act loop, assert judge, extract; Anthropic tool-use loop; secret masking
  replay/             action-record interpreter, locator resolution strategies, end-state checks
  cache/              cache store interface (file store for CLI, backend store for desktop)
  report/             RunReport, step results, token/cost accounting
  cli.ts              jl-e2e run / cache ls / cache clear
```

### 5.1 Run loop

```
for each step in plan.steps:
  emit step.started (lifecycle event + tag scope for capture)
  switch step.type:
    open        → page.goto(resolved url)
    act/macro   → script = cache.get(step)
                  if script: result = replay(script)
                     if result.ok → mode=replayed
                     else         → mode=handoff; agent.act(step, context=result.trace)
                  else            → mode=agent;   agent.act(step)
                  on success and a later verification → cache.put(step, recordedActions)
    assert/wait → check = cache.get(step)
                  if check and check passes → passed (mode=replayed)
                  else verdict = agent.assert(step, snapshot [+screenshot])
                     passed → cache.put(step, verdict.deterministicCheck)   (if the model produced one)
                     failed → step failed, run continues only if settings.continueOnFailure
                     inconclusive → blocked
    extract     → agent.extract(step) → params[var]
    screenshot  → artifact
  emit step.finished
```

The agent loop per `Act` step: observe (a11y snapshot with refs, current URL, title) → model returns one or more tool calls (`click(ref)`, `fill(ref, text)`, `press(key)`, `select(ref, option)`, `hover`, `scroll`, `navigate`, `wait_for(text|ref)`, `done(summary)`, `blocked(reason)`) → execute via Playwright → observe again → until `done` or `maxActions`. Every executed action is appended to the action record with the target descriptor taken from the snapshot node (role, name, test id, text, nth, ancestors), the typed value or param reference, the URL before and after, and the controls that appeared after the action (end-state candidates).

Model configuration goes through the AI SDK so the provider is a setting, not code. The organisation chooses `model` (act loop) and `judge` (assert, waitFor, extract) as AI SDK model ids; the runner instantiates them with the provider package named by the id prefix (`anthropic/…` → `@ai-sdk/anthropic`, `openai/…`, `google/…`, `openrouter/<vendor>/<model>` → `@openrouter/ai-sdk-provider`, `openai-compatible/<baseURL>/…` for local models) or through AI Gateway when `AI_GATEWAY_API_KEY` is set. Default `anthropic/claude-opus-5-5` for act and `anthropic/claude-sonnet-5-5` for judge; with an OpenRouter key the equivalents are `openrouter/anthropic/<claude model id as listed by OpenRouter>`. The runner validates a model id against the provider's model list at startup (`GET https://openrouter.ai/api/v1/models` for OpenRouter) and blocks the run with `MODEL_UNAVAILABLE` instead of failing mid-step. OpenRouter returns the request cost in its usage metadata; when a provider reports cost, the run stores it as `cost_usd` with `price_table_version: provider`, and `test_model_prices` is only used for providers that report tokens alone. Provider-specific options (Anthropic adaptive thinking and `effort`, OpenAI `store: false`) are passed through `providerOptions`. Usage comes back per step from the AI SDK (`inputTokens`, `inputTokenDetails.cacheReadTokens`, `outputTokens`, `outputTokenDetails.reasoningTokens`, `totalTokens`); cost is computed from `test_model_prices`. Secrets are filled by the runner from a param reference and masked in snapshots; screenshots are withheld for the rest of the run after a secret fill (Tester Army rule).

### 5.2 Action record and rendered code

```jsonc
{
  "schemaVersion": 1,
  "stepId": "st_01HX…",
  "instructionKey": "sha256:…",
  "startUrlPattern": "/login",
  "viewport": { "width": 1440, "height": 900 },
  "actions": [
    { "kind": "click", "target": { "role": "button", "name": "Account menu", "testId": null, "text": null, "nth": 0, "within": { "role": "banner" } } },
    { "kind": "click", "target": { "role": "menuitem", "name": "Đăng xuất" } }
  ],
  "endState": { "urlPattern": "/login", "controls": [ { "role": "textbox", "name": "Email" }, { "role": "button", "name": "Đăng nhập" } ] }
}
```

Rendered for display and export:

```ts
await page.getByRole('banner').getByRole('button', { name: 'Account menu' }).click();
await page.getByRole('menuitem', { name: 'Đăng xuất' }).click();
await expect(page).toHaveURL(/\/login/);
await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible();
```

Replay resolves each target by trying `getByTestId` → `getByRole(name)` → `getByLabel` → `getByText` scoped by `within`, waits up to 15 s, stops on ambiguity, and reports a `cache_reason` (`no-entry`, `wrong-context`, `target-not-found`, `target-ambiguous`, `end-mismatch`, `action-failed`). Any stop hands the step to the agent with the replay trace; if the agent finishes and the step is later verified, the record is rewritten and `version` increments. A record whose replay fails after a successful agent re-run is marked `stale` with the reason, never silently deleted, so the UI can show "script was re-generated on run #12".

Cache modes: `read-write` (desktop default), `read-only`, `off` (force agent), `strict` (CI: a stale script fails the run with `REPLAY_STALE` instead of calling the model).

### 5.3 Evidence produced per run

| File | Content |
| --- | --- |
| `recording.webm` | Playwright context video of the primary page, step banner overlaid like `record-flow.mjs` |
| `session.archive.json` | Schema v4 archive: `recorder.kind = "e2e-runner"`, actions tagged `step:<stepId>` and `checkpoint:<id>`, lifecycle events for step start/finish, `step` annotations with status and video offsets |
| `run-report.json` | `RunReport`: plan, per-step results, cache modes, model usage, errors, artifact index |
| `screenshots/*.png` | `[Screenshot]` steps, failed asserts, vision asserts |
| `agent-transcript.jsonl` (optional, debug) | Model requests and responses with secrets and image bytes removed |

The archive and video go through the existing evidence upload flow with `sourceType: "test-run"` and `sourceExternalId = runId`, so share links, comments, tags, the viewer and the MCP debug tools work unchanged.

### 5.4 Hosts: one runner binary, three places to run it

Decided 2026-10-03: the cloud runner is the priority, the local CLI second, and the desktop app does not host a runner. The desktop app and the web app are clients of the same backend queue.

The runner is a long-running daemon (`jl-e2e-runner`) that registers with an organisation, polls the queue, claims runs it is allowed to take, executes them and uploads evidence. It is the same package as the CLI; the CLI is the daemon running one job in the foreground. This is the GitLab Runner model, chosen because LittleLives UAT environments sit behind VPN: a runner must be deployed where it can reach the target, and that place is sometimes a devbox, not the cloud.

| Pool | Where it runs | Claims | Browser | Who sees the browser |
| --- | --- | --- | --- | --- |
| `cloud` (default) | Jittle Lamp infrastructure, N workers per organisation (`max_concurrent_runs`) | runs with `runner_affinity: cloud` | headless Chromium, fixed viewport | nobody live; step progress, screenshots and the video after the run |
| `self-hosted:<poolId>` | a devbox or CI box the organisation controls, registered with a runner token, inside the network that reaches UAT | runs whose environment is bound to that pool | headless by default | same as cloud |
| `local` | the developer's machine, `jl-e2e run` | nothing from the queue; runs the case it is given, reports the run to the backend when a token is set | headed by default | the developer |

Environment → pool binding: `test_environments.runner_pool` (`cloud` or a self-hosted pool id). A run inherits the pool from its environment; a request for a pool with no live runner is `queued` with `blocked_reason: NO_RUNNER` until one heartbeats, visible in the UI with the pool name.

**Runner registration.** `POST /runner-pools` creates a pool and a registration token; `jl-e2e-runner start --token …` registers a worker (`runner_workers`: pool, hostname, version, capabilities, last heartbeat). Workers fetch run config with the per-run config token from §9.3. The cloud pool is a pre-registered pool managed by Jittle Lamp.

**Desktop app.** Shows the same test case and run pages as the web app, triggers runs on the backend, and keeps its evidence review and local recording roles. The earlier utility-process runner, interaction lock and take-over are not in the beta. Live view of a cloud browser (stream plus take-over) is a phase 2 item and reuses the pause/resume semantics already specified: a paused run keeps recording, user actions are tagged `user:takeover`, nothing done during take-over is cached.

**Headed mode and the interaction lock** remain for `jl-e2e run --headed` on a developer machine: the injected shield between runner actions, trusted-input detection that pauses the run, and the banner. `Input.setIgnoreInputEvents` is still tried first in the spike.

**Progress while a run executes.** The runner streams step events to `PATCH /test-runs/:id` (status, current step, mode, a screenshot per finished step at reduced size); the web and desktop apps poll or subscribe over the existing desktop renderer message channel. The step list fills in live; the video attaches at finalisation.

## 6. Backend API

Mounted as `routes/test-cases.ts` and `routes/test-runs.ts`, organisation-scoped through `active-organization.ts`, with new permissions in `organization-permissions.ts` (`test_case.view|create|update|delete`, `test_run.create|cancel|view`) and default grants (QA engineer: all; developer: view + run; moderator/admin: all). AI-token routes are added to the `ai-user-access.ts` allowlist.

| Method | Path | Notes |
| --- | --- | --- |
| `GET/POST` | `/test-cases` | list (FTS search, tags by namespace, status, source, outcome, saved view), create from transcript |
| `POST` | `/test-cases/import` | transcript document, Gherkin, CSV/XLSX with mapping, Jira JQL → `batchId` |
| `GET` | `/test-cases/import/:batchId` | progress, items with lint, similarity and decisions; `PATCH` to change decisions before commit |
| `POST` | `/test-cases/:id/duplicate` | title, tags, replacements, variant or copy, inherit scripts |
| `POST` | `/test-cases/bulk` | action (`tag|untag|set-environment|archive|run|export|approve`) over ids or a saved view |
| `GET` | `/test-cases/similar` | fingerprint and trigram matches for a title or transcript |
| `GET/POST` | `/test-suites`, `/test-suites/:id/runs` | suites and group runs |
| `GET/PATCH/DELETE` | `/test-cases/:id` | transcript edits re-parse and bump `transcript_version` |
| `GET` | `/test-cases/:id/scripts` | active cached scripts with rendered code |
| `DELETE` | `/test-cases/:id/scripts[/:stepId]` | clear cache |
| `POST` | `/test-cases/:id/runs` | create run (`environmentId`, `params`, `cacheMode`, `runner`) → `runId` |
| `GET` | `/test-cases/:id/runs` | test sessions list |
| `GET/PATCH` | `/test-runs/:id` | progress updates, step results, finalise with `evidenceId` and `summary` |
| `POST` | `/test-runs/:id/cancel` | sets `cancelled`; desktop runner observes and aborts |
| `GET/POST` | `/test-environments`, `/test-credentials`, `/test-macros` | org settings |
| `POST` | `/test-cases/:id/evidences` | phase 3: link an existing evidence |

Runs created by the desktop or CLI include `runner_info_json` (runner version, Playwright version, Chrome version, model, cache mode) for reproducibility.

## 7. UI

### evidence-web (authoring and review)

The `test-cases` route currently renders `ComingSoonPage`. It becomes a master-detail workspace built for thousands of cases, with the detail pages described below.

#### Authoring at scale: create, import, duplicate, organise

Expected mix: most cases are AI-generated (from tickets, requirement docs, discovery runs, existing recordings), a large share is imported from existing suites (Gherkin `_bdd` features, TestRail or Xray exports, sheets), and manual authoring is the editing layer on top. Every path produces the same thing: a transcript, so the parser, lint and similarity checks are shared.

**One document format for everything.** A transcript document can hold many cases. A level-1 heading starts a case; optional metadata lines follow the title; steps come after. This is the paste format, the import format, the export format and the on-disk format for `jl-e2e push`/`export`.

```text
# HQ admin logout returns a clean login form
Key: TC-0412
Tags: team:qa-pcf, module:admin, feature:login, regression
Env: pcf-uat
Links: https://littlelives.atlassian.net/browse/PCF-1234
Params: role=HQ_ADMIN

[Open] /login
[Login: {role}] đăng nhập tài khoản {role} PCF
...

# Branch admin logout returns a clean login form
Duplicate-of: TC-0412
Params: role=BRANCH_ADMIN
```

`Duplicate-of` with only `Params` creates a linked variant; a full step list creates an independent case. A markdown table under `## Dataset` turns one case into N variant runs.

**Structured step editor.** Manual authoring is a list of step rows, not a text file. Each row is a type chip, an instruction field and a status column (lint, cache state, last outcome). Text inside the field is tokenised: variables, credentials, macros and files are chips, never raw braces.

| Trigger | Picker | Result |
| --- | --- | --- |
| `/` or `[` at the start of a row | step type (Act, Assert, Open, Login, Wait, Screenshot, Extract, Note) and org macros, with their declared params as fields | type chip, macro chip with param fields (`Login · profile: PCF_HQ_ADMIN`) |
| `{` | variables: environment variables, case params, dataset columns, values extracted by earlier `[Extract]` steps, plus "declare new param" | variable chip; unknown name becomes a lint with a one-click declare |
| `@` | credential profiles and project files | credential chip (lock icon, profile name only) or file chip |
| `#` on an empty row | checkpoint heading | grouping header; following asserts belong to it |
| `Enter` | new row of the same type (after an Act, an Act; after an Assert, an Assert) | |
| `Tab` / `Shift+Tab` on the chip | cycle the step type | |
| `⌘Enter` | run the case; `⌥Enter` runs from this step on the desktop | |
| `⌘D`, `⌘⇧↑/↓`, drag handle | duplicate, move, reorder; `⌘/` disables a step without deleting it | |

Smart suggestions in the instruction field: phrasing templates per type ("Verify … is visible", "Click …", "Enter … into …"), element names observed in the last run's snapshots ("menuitem Đăng xuất", "textbox Email") so a tester can write what the agent will actually find, and macro expansion shown inline and read-only under a macro row. Lint is inline with a fix action: "selector in instruction → use the visible label", "two intents → split into two steps", "assert without a checkpoint", "undeclared variable". Pasting multi-line text into a row splits it into rows through the parser, so a copied list from a ticket becomes steps in one paste.

Metadata is a form, not front matter: title, tag input grouped by namespace, environment select, links as URL chips with a Jira preview, a params table (name, default, required) and a dataset grid. Everything the editor shows serialises to the document format and back.

**Entry points.**

| Path | How it works | Lands as |
| --- | --- | --- |
| Quick create (`c`) | Title + structured step editor; pasting a multi-case document into it offers "split into N cases". Tags are suggested from the title and from similar cases | `draft` or `active` |
| Import file | `.md` transcript document, `.feature` (Given/When → `[Act]`, Then → `[Assert]`, Background → macro call, Scenario Outline + Examples → dataset), `.csv`/`.xlsx` (column mapping UI: title, preconditions, steps, expected, id, tags; "steps" and "expected" cells are split into `[Act]`/`[Assert]` lines by a model with the lint as guard), TestRail/Xray XML | `test_import_batches` → `draft` |
| Import from Jira (phase 1) | Organisation Jira credential (API token stored as a credential profile with `kind: jira`); pick issues by JQL; acceptance criteria and description go through AI generation; the Jira key becomes a link and `external_id` | `review` |
| AI generate | From pasted requirement, a Jira issue, a URL (discovery run), or an existing case ("generate similar": negative, boundary, role variants); the model returns a transcript document, so output is reviewed with the same lint and similarity checks | `review` |
| From recording (phase 3) | Archive interactions → model → draft transcript | `review` |
| Duplicate (`d`) | See below | `draft` |
| MCP | `create_test_case`, `import_test_cases` (a transcript document), `duplicate_test_case`, `generate_test_cases`, `find_similar_test_cases` | per caller |

**Import pipeline.** Upload → parse → mapping (CSV/XLSX only) → preview table with per-row lint, exact-duplicate (`fingerprint`) and near-duplicate matches (FTS5 trigram over title + transcript; embeddings later) → per-row decision `create / update existing / skip / merge` with bulk "apply to all similar" → create as a background batch on the lease worker → batch page with progress, created/updated/skipped/error counts, error CSV. Re-importing the same file is idempotent through `external_id` or `Key`. Imports of 1,000 rows must finish in under a minute without a model; rows that need the model (free-text steps) are queued and shown as "normalising".

**Duplicate.** `d` on a case or a selection opens a dialog: new title (default "<title> (copy)"), tags, find/replace across transcript and title (e.g. `HQ_ADMIN` → `BRANCH_ADMIN`), what to copy (links, tags, environment, datasets), and "link as variant" vs "independent copy". Steps whose `instructionKey` is unchanged **inherit the source's active step scripts**, so a duplicate replays on its first run instead of paying the agent again. `duplicated_from_id` keeps the lineage; the source shows "3 derived cases". Multi-select duplicate applies the same find/replace to all.

**Review queue.** AI-generated and imported cases are `review` until a person approves them. The queue is a batch view: left list, right side shows the transcript with lint and the source (ticket text, sheet row, originating case) side by side; `a` approve, `x` reject, `e` edit, `shift+a` approve all with no lint warnings. Approved cases become `active`; rejected ones are archived with a reason that feeds back into the generation prompt.

**Organising thousands.** Test cases are organisation-scoped; there is no team scope and no folder tree. Grouping is a tag system with namespaces: `team:qa-pcf`, `feature:login`, `module:enrolment`, `prio:p1`, plus free tags. Namespaces are organisation-managed (`organization_test_tags`: namespace, name, colour, description, following the existing evidence tag definitions), and the sidebar renders each namespace as a collapsible group with counts, which gives the browsing feel of folders without the single-parent limit. Suites (static membership or smart filter over tags), saved views (filter + columns + sort), and a per-org human key `TC-0412` for tickets and chat complete the structure. Permissions stay organisation-level; a team sees its own work through `team:` tags and saved views, not through access control. Search is full-text over key, title, description, transcript and tags with filters for status, tag (by namespace), environment, last outcome, stale cache, source, owner, "no runs in 30 days". The list is a virtualised table with keyboard navigation (`j`/`k`, `enter`, `/` search, `x` select, `shift+x` range), a bulk action bar (run, tag, untag, set environment, duplicate, export, archive), and inline title edit. Export of any selection or view is the same transcript document.

**Similarity on create.** While typing a title or pasting a transcript, the editor shows "3 similar cases" with a one-line diff; one click opens the existing case or turns the new one into a variant of it. The same check runs on every import row and every AI batch, so the library does not fill up with near-copies.

#### Pages

- **Test cases list.** Master list with the columns above, pass rate over the last N runs, variants count, "Run" shortcut (opens the desktop app via the existing deep-link scheme, or shows the CLI command). Selecting a row opens the detail in the right pane without leaving the list.
- **Test case detail.**
  - Header: title, description (markdown), links, tags, environment.
  - **Steps** tab, the structured editor (below). A **Text** toggle shows the same case as a transcript document for paste, diff and power users; both views are projections of the parsed step model, so switching is lossless.
  - **Test sessions** tab: table of runs with status, outcome, trigger, runner, duration, cache hit ratio, cost, evidence link, share link.
  - **Scripts** tab: rendered Playwright per step, version history, "clear" per step.
- **Run detail.** Left: step list with status, mode and timing; click seeks the shared viewer to `video_offset_ms` and filters the timeline by `step:<id>` tag. Right: `viewer-react` on the run evidence. Failed asserts show expected (instruction) vs observed (agent summary) and the screenshot. Blocked runs show `blocked_reason` first.

### desktop (execution)

- **Test runs** page: pick a test case (fetched from the backend), environment, cache mode; "Run" shows live step progress and a "Show browser" toggle (headed by default).
- Settings: Anthropic API key, model, credential secrets, Chrome channel, default viewport.
- Review parity: the run detail view reuses the same `viewer-react` components; step list component lives in `packages/ui` so both apps render it.

## 8. MCP tools (`apps/mcp`)

So a coding agent can author and trigger tests from Claude Code or Codex:

| Tool | Purpose |
| --- | --- |
| `list_test_cases`, `get_test_case` | discovery, returns transcript and step cache status |
| `create_test_case`, `update_test_case_transcript` | authoring; server-side lint errors returned as data |
| `list_test_environments`, `list_test_macros`, `list_test_credentials` | profile names only, never secrets |
| `create_test_macro` | an agent proposes a reusable sequence with declared params; stored as `draft` until approved |
| `import_test_cases` | a transcript document with many cases → import batch; returns per-case lint and similarity so the agent can fix and resubmit |
| `duplicate_test_case` | title, find/replace, variant or copy; inherits step scripts |
| `generate_test_cases` | from text, Jira key or an existing case; lands in `review` |
| `find_similar_test_cases` | query by title or transcript; used before creating to avoid near-copies |
| `run_test_case` | creates a run; executes through the local desktop companion (`POST 127.0.0.1:48115/api/test-runs`, token-authenticated, origin check relaxed for loopback with the token) or returns the CLI command when the desktop is not running |
| `get_test_run`, `list_test_runs` | progress and results; links to `get_evidence_debug` for the evidence |
| `link_evidence_to_test_case` | phase 3 |

The companion server currently accepts only `chrome-extension://` origins for writes; the run endpoint adds a local bearer token issued by the desktop app so that the MCP process can trigger runs.

## 9. Configuration: environments, variables, credentials (cloud and local)

The same test case must run against a cloud-configured environment and against a developer's local `.env`. The rule that makes this work: **code and transcripts refer to configuration by name only, and the runner resolves names through one chain**. Where the value comes from is a deployment detail.

### 9.1 What a name looks like

| In a transcript | In rendered code | Resolves to |
| --- | --- | --- |
| `[Open] /login` | `env.baseUrl + '/login'` | environment base URL |
| `{SCHOOL_CODE}` | `vars.SCHOOL_CODE` | environment variable (non-secret) |
| `[Login: PCF_HQ_ADMIN]` | `credential('PCF_HQ_ADMIN').username`, `secret('PCF_HQ_ADMIN.password')` | credential profile; secret fields are filled by the runner and masked everywhere |
| `{student}` with `--var student=...` | `params.student` | run parameter |

`secret()` never returns a string to the agent or to the report. The runner fills it into the page directly and registers the value for redaction in snapshots, console, network bodies and video banners (the extension's redaction rules already cover input events).

### 9.2 Resolution chain

For each name the runner checks, in order, and stops at the first hit:

1. **Run params** (`--var`, `--credential`, the desktop run dialog, `POST /test-cases/:id/runs { params }`).
2. **Process environment**, with `.env`, `.env.e2e` and `--env-file` loaded first (dotenv, no override of real env):
   - `JL_ENV_BASE_URL`, `JL_ENV_NAME`
   - `JL_VAR_<KEY>` → `vars.KEY`
   - `JL_CRED_<PROFILE>_<FIELD>` → `credential('PROFILE').FIELD`, e.g. `JL_CRED_PCF_HQ_ADMIN_PASSWORD`
   - `JL_MODEL`, `ANTHROPIC_API_KEY`, `JL_CACHE_MODE`, `JL_CACHE_DIR`
3. **Desktop secret store** (`safeStorage`), desktop host only.
4. **Organisation configuration on the backend**: the selected `test_environment` and the `test_credentials` it references, fetched with the user's session (desktop) or a per-run token (cloud worker).

A missing required name makes the run `blocked` with `MISSING_VARIABLE` / `MISSING_CREDENTIAL` and the list of names. Values are never logged. `jl-e2e config` prints the resolved table with secrets masked and the source column (`param`, `env`, `keychain`, `org:pcf-uat`), which is the first thing to look at when a run is blocked.

### 9.3 Cloud

- **Storage.** `test_environments.variables_json` is plaintext. `test_credentials.secret_fields_enc` is AES-256-GCM; each organisation has a data key wrapped by a server master key (`JL_SECRETS_MASTER_KEY`, pluggable provider so KMS can replace it). `key_version` allows rotation. Decryption happens only in `services/test-config.ts`; no route returns a secret to a browser.
- **Who can read.** New permission `test_config.manage` (create, edit, rotate) and `test_config.use` (run with). Reads of secrets are written to `organization_activity_logs` with run id and actor.
- **Model key.** Bring your own key per organisation: Settings → AI model stores the provider key as a credential secret (`test_credentials` with `kind: model_key`), with act and judge model ids. Every run uses the organisation key; spend is attributed to the requesting user through the run metrics. A user cannot override the key in the beta.
- **How a cloud runner gets them.** The worker claims a run, then calls `POST /test-runs/:id/config-token` and `GET /test-runs/:id/config` with that token. The response is the resolved environment plus decrypted credential fields for the profiles the transcript references, valid for the run's lease only. The worker injects them as `JL_ENV_*`, `JL_VAR_*`, `JL_CRED_*` into the runner child process. The runner then behaves exactly like a local run reading `.env`.
- **UI.** Settings → Environments (name, base URL, variables table, "used by N cases") and Settings → Credentials (profile, environment, public fields, secret fields shown masked, last used, rotate). A credential can be scoped to one environment or shared. Test case detail shows which names it needs and which are unresolved in the chosen environment.
- **API.** `GET/POST/PATCH /test-environments`, `GET/POST/PATCH /test-credentials` (write-only secret fields), `POST /test-credentials/:id/rotate`, `GET /test-cases/:id/required-config?environmentId=` (names only).

### 9.4 Local

- **Project layout.** A repo can hold an e2e folder that `jl-e2e` understands without a backend:

  ```
  e2e/
    jl-e2e.config.ts        # targets, cacheDir, video, model defaults
    cases/*.transcript.md   # same format as the cloud editor
    macros/*.transcript.md
    .env.e2e                # JL_ENV_*, JL_VAR_*, JL_CRED_* (gitignored)
    .e2e/cache/             # step scripts, one JSON per entry
  ```

- **Commands.**

  ```
  jl-e2e run cases/logout.transcript.md --env-file .env.e2e      # fully local, no backend
  jl-e2e run --case <id> --env pcf-uat                             # case from cloud, config from cloud or .env
  jl-e2e env pull pcf-uat                                          # writes .env.e2e with base URL + variables + empty JL_CRED_* placeholders
  jl-e2e env pull pcf-uat --with-secrets                           # fills secrets; requires test_config.manage, file is chmod 600 and gitignored
  jl-e2e config                                                    # resolved table, masked, with sources
  jl-e2e export --case <id> ./e2e/cases                            # cloud → files
  jl-e2e push ./e2e/cases/logout.transcript.md                     # files → cloud (creates or updates by title)
  ```

- **CI.** GitHub Actions or GitLab CI set `JL_CRED_*` from pipeline secrets and `JL_CACHE_MODE=strict`; the committed `.e2e/cache` provides replays. The runner uploads evidence with an automation token when `JL_API_TOKEN` is set, otherwise keeps artifacts in `.e2e/artifacts`.
- **Desktop.** The desktop host reads the same `JL_*` names from its own process environment first, so a developer can point the app at a local stack by launching it with `JL_ENV_BASE_URL=http://localhost:3000`.

### 9.5 Keeping cache keys stable across environments

Variable and credential **values** never enter a step's cache key; the **environment identity** (`environment_id` or, for local files, the `JL_ENV_NAME`) does. Two environments with different DOMs get separate scripts; the same environment reached from cloud or from `.env` shares one.

## 10. Concurrency: one queue per organisation, dedupe and throttle

The cloud agent pool is small (one runner per organisation by default). Several QA engineers, a CI job and a coding agent can all ask for runs at the same moment, often for the same case. The backend owns a queue; runners claim from it.

### 10.1 Queue

- Every run request creates or attaches to a `test_runs` row in `status: queued`. The queue is per organisation, ordered by `priority` then `queued_at`. Priority defaults: manual from the UI `30`, MCP `20`, CI and scheduled `10`; admins can override per environment.
- Organisation setting `max_concurrent_runs` (default `1`) applies to the cloud pool. Each self-hosted pool has its own `max_concurrent_runs`. A `local` CLI run does not go through the queue but still registers its run and takes part in dedupe below.
- A runner claims with one atomic statement, following `migration-worker.ts`: pick the first `queued` row for an organisation whose running count is below the limit, set `claimed` with `worker_lease_owner` and `worker_lease_expires_at` (30 s), heartbeat every 10 s. An expired lease returns the row to `queued` with `attempts + 1`; after 3 attempts the run is `failed` with `RUNNER_LOST`.
- Queue position and an estimated start (median duration of the last 10 completed runs of the cases ahead) are returned by `GET /test-runs/:id` and shown in the UI.

### 10.2 Dedupe

`dedupe_key = sha256(test_case_id, transcript_version, environment_id, params_hash, cache_mode)`.

- `POST /test-cases/:id/runs` looks for a `queued`, `claimed` or `running` run with the same key. If found, the request does not create a new run: the caller is added to `test_run_subscribers`, and the response is `{ runId, attached: true, requestedBy, status, queuePosition }`.
- A run that `completed` within the last `dedupe_window_seconds` (org setting, default 120) is also returned as `attached` unless the caller passes `force: true`. This stops a burst of "run it again" clicks after a flaky result while still allowing a deliberate re-run.
- `force: true` always creates a new run. Cancelling an attached run requires either the original requester or `test_run.cancel_any`; subscribers only unsubscribe.
- Group runs (phase 2) dedupe per member case with the same key.

### 10.3 Throttle

- Per organisation: at most `max_queued_runs` (default 20) queued at once; above that `POST …/runs` returns `429 QUEUE_FULL` with the current depth.
- Per test case: at most one queued run per `dedupe_key` (already implied) and at most `max_queued_per_case` (default 3) queued runs with different keys.
- Per trigger source: a token bucket of 30 run requests per 10 minutes per user or token; CI tokens get their own bucket. Rejections are `429 RATE_LIMITED` with `retryAfter`.
- Model spend guard (phase 2): a daily `cost_usd` budget per organisation; when exceeded, new runs are queued with `status: queued` and `blocked_reason: BUDGET_EXCEEDED` until midnight or an admin raises the budget.

### 10.4 What the UI shows

- Test sessions table: a `queued · #2 of 3` pill with the estimated start, and an `attached` badge listing who else is waiting on the same run.
- Run detail of a running run: live step progress, the "Take over" control if it is a desktop run owned by the viewer, "Cancel" for the requester.
- Organisation settings → Test runs: concurrency, dedupe window, queue caps, model budget.

## 10b. Notifications: in-app now, Slack later

Every run, batch, import and review event goes through one `notification_events` table (`org_id`, `kind`, `subject_type`, `subject_id`, `actor_id`, `payload_json`, `created_at`). Delivery is a separate step: `notification_channels` (`org_id`, `kind: in_app|slack|email|webhook`, `config_json`, `filter_json`, `enabled`) and `notification_deliveries` (event, channel, status, attempts). The beta ships only the `in_app` channel: a bell in the web and desktop apps, unread counts, and per-user subscriptions (my runs, runs I attached to, review queue, imports). Slack and email are channel adapters added later without touching producers. Events for the beta: `run.finished`, `run.blocked`, `batch.finished`, `import.finished`, `review.pending_count`, `runner.offline`.

## 10c. Triggers from GitLab and GitHub

Designed now, delivered in phase 2. A CI pipeline or a merge request should be able to trigger a suite against a preview or UAT environment and get the verdict back.

- **Inbound.** `webhook_endpoints` (`org_id`, `provider: gitlab|github|generic`, `secret`, `rules_json`, `enabled`). The backend route `POST /hooks/:endpointId` verifies the signature (`X-Gitlab-Token`, `X-Hub-Signature-256`), normalises the event (push, merge request opened or updated, pipeline succeeded, deployment) and evaluates rules: `when` (event type, branch pattern, label), `run` (suite id), `environment` (fixed id, or derived from the payload, e.g. a review-app URL into `baseUrl`), `priority`. A matching rule creates a `test_run_batches` row with `trigger: webhook` and `trigger_ref` (commit SHA, MR id), deduped on the SHA so a retriggered pipeline attaches to the running batch.
- **Outbound.** Per rule, optional reporting back: GitHub commit status or check run, GitLab commit status and an MR note with the batch summary and run links; a generic `callback_url` receives the batch result JSON. Credentials for the provider are a credential profile (`kind: github_app` or `gitlab_token`).
- **Pipeline-side alternative.** The CLI already covers the push model: `jl-e2e run --suite <id> --env <id> --wait --junit out.xml` inside the pipeline with an automation token. The webhook path is for the pull model where the pipeline does not need to wait.

## 11. Security and privacy

- Secrets never appear in transcripts, snapshots sent to the model, archives, rendered code or reports. Fills resolve from a param reference; the archive input events already redact values.
- The model receives accessibility text and URLs; screenshots only for `vision` asserts or debugging, and never after a secret fill in the same run.
- Model API keys: per-user in the desktop app (`safeStorage`) or `ANTHROPIC_API_KEY` locally; org-level key on the backend for cloud runs, stored like a credential secret.
- Network capture reuses the extension's redaction rules for headers, cookies and bodies.
- Runs that mutate data are the tester's responsibility, as today; `[Assert]` steps are instructed not to mutate, and the agent tool set for asserts excludes `fill`, `select` and form submission.

## 12. Phasing

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **0. Spike (1–2 weeks)** | `packages/e2e-runner` with CLI only, file cache, transcript parser in `packages/shared`, archive tags, upload via `/automation/evidences/zip` | One real PCF or ILHAM UAT case from `_bdd` runs end to end twice: first run agent-driven, second run replays every act step with zero model calls for acts; evidence opens in the viewer |
| **1. MVP (beta)** | Cloud runner pool and self-hosted pools (`jl-e2e-runner` daemon, registration, lease worker, per-run config token); backend tables, routes, permissions; run queue with dedupe and per-org concurrency; organisation BYOK model key; in-app notifications; Jira import; `.feature` import; run and step metrics (model, tokens, cost, duration); archive v4 + viewer step filter; evidence-web test-case pages, run detail, Environments and Credentials settings with encrypted secrets; desktop and web as queue clients with live step progress; `jl-e2e` CLI with `.env` support, `env pull`, `export`/`push`; MCP tools; macros and credential profiles | A tester creates a case in the web app, runs it from the desktop, reviews the run with step-seek, re-runs with cache; a coding agent creates and runs a case through MCP |
| **2. Platform** | GitLab and GitHub webhooks with status reporting, Slack channel, live view of cloud browsers with take-over, agent notes (org memory), GitHub Actions and GitLab CI templates, strict cache mode in CI, JUnit export, Jira comment integration (reuse `littlelives-jira-evidence-comment` flow), run comparison | CI pipeline runs a group of cases with an automation token and posts results |
| **3. Bridges** | Import existing evidence as test-case evidence (cross links in both views); generate a transcript from a manual recording (archive interactions → model → draft transcript with `[Act]`/`[Assert]` suggestions, user edits before save) | A legacy recording can be attached to a case; a manual session produces a runnable draft |

## 13. Decided and open questions

Decided on 2026-10-03:

- **Archive version 4.** `recorder.kind` becomes `"browser-extension" | "e2e-runner"`, `annotations` gains a `step` kind (`stepId`, `label`, `status`, `startedAt`, `endedAt`, `videoOffsetMs`). `parseSessionArchiveJson` upgrades v3 in memory. Touches `packages/shared`, `viewer-core`, desktop and web; the extension keeps writing v3 until its next release.
- **Macros take named parameters.** `[Login: PCF]` fills the first declared parameter; `[Login: profile=PCF, tenant=HQ]` fills several. A macro declares `params: [{ name, required, default?, kind: "text" | "credential" | "url" }]` and its body may use `{param}`. Macros can be created in the web app, seeded by code, or defined by an AI agent through `create_test_macro` when it notices a repeated sequence. An agent-created macro is stored as `draft` until a person approves it.

- **Model access through the Vercel AI SDK**, not a vendor SDK. Model and judge are AI SDK ids configured per organisation; tokens come from the SDK, cost from `test_model_prices`.
- **Execution core: Tester Army `e2e`** behind `packages/e2e-runner`, with a gate at the end of phase 0 (see §5.0). Stagehand is not a candidate for the core.
- **Headed by default with the interaction lock and take-over** described in §5.4; background mode per run.
- **One queue per organisation with dedupe and throttle** (§10); `max_concurrent_runs` defaults to 1.

Open:

1. **Trace → archive fidelity.** Playwright traces keep network bodies only up to Playwright's limits and drop screencast frames under redaction; confirm in phase 0 that the viewer's timeline needs nothing the trace lacks.
2. **Interaction lock mechanism.** `Input.setIgnoreInputEvents` is tried first; the injected shield is the fallback and the likely outcome.

## 14. Beta readiness: gaps closed on 2026-10-03 and questions still open

Added to the design in this pass:

- `test_case_versions` so a run can show the transcript it ran; macro version is part of expanded steps' `instructionKey`.
- `test_run_batches` for dataset variants and suite runs.
- Retries: per-case `retries` (default 0; 1 in CI). A run that passes on retry has outcome `passed` and `flaky: true`; the sessions table shows a flaky badge and the case shows a flaky rate.
- Permission `test_case.approve` for the review queue, separate from `test_case.update`.
- Agent instructions per environment (`test_environments.agent_instructions`, max 16 KB) for rules such as "never delete records", "use only the test tenant". Mandatory for the beta because agents run against shared UAT data.
- Browser: cloud and self-hosted runners use Playwright's Chromium; `jl-e2e run --headed` on a developer machine prefers the installed Chrome and falls back to a one-time Chromium download.
- Evidence retention for runs: per-organisation policy, default keep failed and blocked runs 180 days, passed runs 30 days, always keep the latest run per case; the existing bin and purge job apply.
- "Run on desktop" from the web app needs a `jittle-lamp://run?runId=` protocol handler; `main.ts` registers none today, so this is new work in phase 1. Fallback is the CLI command shown in the UI.

Answered on 2026-10-03 (recorded in ADR 0002, decisions 3, 11, 14 to 17):

1. **Beta runner.** Cloud runner first, local CLI second; the desktop app triggers cloud runs and does not host a runner. Self-hosted pools cover UAT behind VPN (§5.4).
2. **Model key.** BYOK per organisation; spend attributed per user from run metrics (§9.3).
3. **Scope.** Organisation-scoped, grouped by a namespaced tag system (`team:`, `feature:`, `module:`); no folders, no team access control (§7).
4. **Jira import.** Phase 1, organisation API token as a credential profile.
5. **Seed.** Start empty; `.feature` import is supported from phase 1.
6. **Notifications.** In-app only in the beta on a channel-based bus; Slack is a later adapter (§10b).
7. **CI triggers.** Webhooks from GitLab and GitHub are designed in §10c and delivered in phase 2; the CLI covers pipelines in the beta.
