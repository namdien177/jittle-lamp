# ADR 0002: AI-driven E2E test cases

- **Date:** 2026-10-03
- **Status:** Proposed
- **Decision owners:** Backend + Desktop + Web maintainers
- **Spec:** [docs/e2e-test-cases/design.md](../e2e-test-cases/design.md)

## Context

Jittle Lamp today stores recordings with action, console and network metadata. A recording is not tied to a test case, a document or a ticket, and it cannot be re-run: the instructions a tester followed live outside the product and are often too detailed or imprecise to reproduce.

We want Jittle Lamp to become an E2E platform where a test case is a natural-language transcript with checkpoints, an AI agent executes it in a real browser, every run is recorded as evidence, and verified steps are replayed from generated code on later runs.

The LittleLives team already runs this flow by hand: a coding agent drives Playwright through `record-flow.mjs` (`step`/`verify`/`checks`, PASS/FAIL/BLOCKED), then `jl-evidence.mjs` packs `capture.json` into a schema-v3 archive and uploads it through `POST /automation/evidences/zip`. This feature productises that loop.

Reference products: Tester Army (`tester.army`, open-source `tester-army/e2e`) and Browserbase (Stagehand). Findings are summarised in the spec.

## Decisions

1. **The transcript is the source of truth, not generated code.**
   A test case stores a plain-text transcript (`[Tag] instruction` lines with checkpoint headings) plus parsed steps. Generated code is a cache attached to a step, never edited by hand as the primary artifact. The transcript parser and schemas live in `packages/shared` so backend, desktop, web, runner and MCP validate the same model.

2. **Cached step scripts are structured action records rendered to Playwright, not raw selectors.**
   Each verified `Act` step caches an ordered list of actions whose targets are described by role, accessible name, test id, text and surrounding context (Tester Army model), plus end-state checks. The runner renders the record to readable Playwright TypeScript for display and export, and replays it with multi-strategy locator resolution. Replay hands back to the agent when a target or end state is missing; a successful hand-off re-records the step. `Assert` steps cache a deterministic check; if it fails, the model judges the screen before the step is marked failed.

3. **The runner is a standalone daemon; the cloud pool comes first, self-hosted pools cover networks the cloud cannot reach, and the desktop app is a client.**
   Revised 2026-10-03 (was: hosted first by the desktop app). `packages/e2e-runner` ships one binary that is both the `jl-e2e` CLI and the `jl-e2e-runner` daemon. The backend owns the queue; runners register to a pool with a token, claim runs with a lease, fetch per-run config, execute and upload evidence. Environments bind to a pool, so UAT behind VPN runs on a self-hosted runner on a devbox while everything else uses the cloud pool. The desktop app triggers runs and reviews evidence; it does not drive browsers.

4. **Runs are evidence.**
   A run uploads a normal evidence record (`sourceType: "test-run"`) with `recording.webm`, `session.archive.json` and `run-report.json`. Archive actions are tagged `step:<stepId>` and `checkpoint:<checkpointId>` so the shared viewer can filter the timeline by step. The session archive schema moves to version 4 to add a non-extension `recorder` kind and a `step` annotation; `parseSessionArchiveJson` upgrades v3 archives in place. The `test_runs` table links to the evidence; a separate `test_case_evidences` link table allows later manual imports of existing recordings.

5. **Model access goes through the Vercel AI SDK; the provider is a per-organisation setting.**
   Revised 2026-10-03 (was: Anthropic SDK directly). The organisation configures an act model and a judge model as AI SDK ids (`anthropic/claude-opus-5-5` and `anthropic/claude-sonnet-5-5` by default); the runner instantiates the matching `@ai-sdk/*` provider or AI Gateway. Provider-specific options such as Anthropic adaptive thinking go through `providerOptions`. Observation is an accessibility snapshot with element refs, not screenshots by default; screenshots are added for `Assert` steps marked `vision`. Every run and every step records the model id, model calls, input, cached-input, output and reasoning tokens, duration and a cost computed from an organisation price table, because the SDK reports tokens and not money.

6. **Verdicts separate execution from outcome.**
   A run has `status` (`queued|running|completed|failed|cancelled`) and `outcome` (`passed|failed|blocked`). Setup, credential or runner problems are `blocked`, never `failed`. This matches the existing `result.json` split between `behaviorStatus` and `evidenceStatus`.

7. **Macros and credential profiles are organisation objects, and macros take named parameters.**
   `[Login: PCF]` resolves to the org macro `Login` with its first positional parameter set to `PCF`; `[Login: profile=PCF, tenant=HQ]` sets several. A macro is itself a transcript with a declared parameter list. Macros can be created by people in the web app, by code (seeded per organisation), or by an AI agent through MCP when it finds a reusable sequence. Credential profiles and environments are stored server-side from phase 1 so the cloud deployment can be configured without a desktop app; see decision 9 for how secrets reach a runner.

8. **The session archive moves to schema version 4.**
   Decided 2026-10-03. v4 adds `recorder.kind: "browser-extension" | "e2e-runner"` and a `step` annotation kind; `parseSessionArchiveJson` upgrades v3 archives in memory so old recordings keep opening. The extension keeps writing v3 until its next release.

9. **One resolution chain for variables and credentials; environment variables are the common carrier.**
   Generated code and transcripts refer to configuration only by name (`env.baseUrl`, `vars.KEY`, `secret('PROFILE.field')`). At run time the runner resolves names in a fixed order: run params, process environment (`JL_ENV_*`, `JL_VAR_*`, `JL_CRED_*`, loaded from a `.env` file when present), the desktop secret store, then the organisation's environment and credentials on the backend. The cloud worker fetches the organisation configuration with a per-run token and injects it as process environment before starting the runner, so cloud, desktop and a plain local `jl-e2e run` execute the same code path. Secrets are stored encrypted (AES-256-GCM, per-organisation data key wrapped by a server master key, provider pluggable) and never written back to a local file unless the user explicitly asks. A missing name makes the run `blocked` with the names listed, never the values.

10. **Tester Army `e2e` is the execution core, wrapped by `packages/e2e-runner`, with a gate at the end of phase 0.**
    Its step semantics (`act`/`assert`/`waitFor`/`extract`, `passed|failed|blocked` with error codes), replay cache (structured records, hand-off reasons, pluggable `cache.store`), AI SDK model contract and Playwright video and trace match the design. It has no programmatic run API, so the runner generates a `case.e2e.ts` and `e2e.config.ts` from the transcript and spawns `e2e run`, backs `cache.store` with `test_step_scripts`, streams step events through a `Reporter`, parses `ai-trace.json` for per-step usage and converts the Playwright trace to archive v4. If the generated-file route, per-step usage, trace fidelity or release churn fails the spike, we switch to our own loop on AI SDK `ToolLoopAgent` keeping the same record format. Stagehand is not a candidate for the core: its cache is selector-based and opaque, it has no verdict model, and v4 dropped Playwright.
    **Gate outcome (2026-10-03): keep `e2e`.** The phase 0 spike passed assumptions 1 to 3 (generated test file, per-step usage from `ai-trace.json`, trace → archive v4) on PCF UAT: run 1 agent-driven, run 2 replayed every act with zero act model calls. Details in design.md §14 "Phase 0 outcome".

11. **Cloud runs are headless with live step progress; headed mode with the interaction lock is a local CLI feature; live view with take-over is phase 2.**
    Revised 2026-10-03 to match decision 3. A cloud or self-hosted run reports each finished step with a reduced screenshot while it executes and attaches the video at the end. `jl-e2e run --headed` on a developer machine keeps the injected shield between runner actions, trusted-input detection that pauses the run, and the banner. Take-over semantics are fixed now for phase 2's live view: paused runs keep recording, user actions are tagged `user:takeover`, nothing done during take-over is cached.

12. **One run queue per organisation with dedupe and throttle.**
    Runs are rows in `test_runs` claimed by runners with a lease (same pattern as `migration-worker.ts`). `max_concurrent_runs` defaults to 1 for the cloud pool; desktop runs use the tester's own slot. Requests with the same `dedupe_key` (case, transcript version, environment, params, cache mode) attach to the queued or running run, and to a run completed within the dedupe window, unless `force: true`. Per-organisation and per-case queue caps and a per-user token bucket return `429`. A daily model budget is phase 2.

13. **Authoring is built for thousands of cases, with one document format for every path and a structured editor for people.**
    A transcript document (level-1 heading per case, metadata lines, steps, optional dataset table) is the storage, paste, import, export and on-disk format. People do not edit that text by default: the editor is a list of typed step rows with pickers for step type and macros (`/`, `[`), variables (`{`), credentials and files (`@`), inline lint with fixes, suggestions from the last run's snapshots, and a form for metadata. The text view is a lossless projection of the same step model. AI generation, Jira import, Gherkin, CSV/XLSX and TestRail/Xray imports all produce that document, so lint, exact and near-duplicate detection run once for all of them. Imported and AI-generated cases land in a review queue (`review` status) before they become `active`. Near-identical cases are parameterised cases with datasets, not copies; a true duplicate records `duplicated_from_id` and inherits the step scripts of unchanged instructions so it replays on its first run. Organisation is folders, tags, suites and saved views over a full-text index, with a per-organisation human key (`TC-0412`).

14. **Bring your own model key per organisation.**
    The organisation stores one provider key and the act and judge model ids; every run uses it and spend is attributed to the requesting user through run metrics. No per-user keys in the beta.

15. **Test cases are organisation-scoped and grouped by namespaced tags, not folders or team scopes.**
    `team:`, `feature:`, `module:`, `prio:` namespaces are organisation-managed tag definitions; the sidebar groups by namespace. Suites and saved views build on tags. Access control stays at organisation level.

16. **Notifications go through a channel bus; the beta ships the in-app channel only.**
    Producers write `notification_events`; channels (`in_app` now, Slack and email later) deliver them. Adding Slack touches no producer.

17. **CI triggers are webhooks from GitLab and GitHub, designed now and delivered in phase 2.**
    Signed inbound endpoints with rules map provider events to suite runs and environments, dedupe on commit SHA, and report back as commit status, MR note or callback URL. The CLI covers pipelines in the beta.

## Non-goals for phase 1

- Scheduling, PR checks, webhook triggers (designed in the spec, delivered in phase 2).
- Mobile targets.
- Importing existing recordings as test-case evidence (schema is prepared, UI is phase 3).
- Generating a transcript from a manual recording (phase 3).
- Offline-first test cases in the desktop app; test cases require a signed-in organisation.
- Live view and take-over of cloud browsers.

## Consequences

- New schema surface in `packages/shared` (`test-case.ts`, archive v4) and a viewer-core change to read step annotations.
- New backend tables, routes, permissions (`test_case.*`, `test_run.*`) and AI-token allowlist entries.
- `packages/e2e-runner` carries Playwright, Tester Army `e2e` and the AI SDK with provider packages, and is deployed as the cloud pool and as self-hosted runners (Node 22.12 or newer). The desktop app gains no runner dependency.
- `apps/mcp` gains test-case and run tools so coding agents can author and trigger tests.
- The evidence-web `test-cases` placeholder route becomes real.

## Amendments

### 2026-10-03: one key per provider, not one key per organisation (decision 14)

Decision 14 says the organisation stores one provider key. Decision 5 makes the provider a per-organisation setting for the act and judge models separately, so the two can use different providers (for example act on OpenRouter, judge on xAI). One key cannot serve both, and copying the act key into the judge provider's variable would send it to a provider that did not issue it.

Amended: the organisation stores the key for the act model's provider and, only when the judge model uses another provider, a second write-only key for the judge's provider. Each key is filled in only under its own provider's environment name. A stored key is dropped when its provider changes. Saving without a needed key is allowed; the settings report it as missing and runs are blocked with `MODEL_KEY_MISSING`. An `openai-compatible/` model also needs the endpoint's base URL, stored with the model settings (not a secret) and checked with the outbound address guard. Still no per-user keys in the beta, and spend is still attributed to the requesting user. Rows saved before the amendment read as the single act key; a judge on the same provider keeps using it.

Decisions 5 and 14 are otherwise unchanged; neither requires Anthropic. The supported prefixes are listed once in `packages/shared/src/model-providers.ts` and checked at save time.


### 2026-10-03: Qwen Flash defaults through AI Gateway (decision 5)

The owner initially selected GLM-5.3-Flash during production/preprod setup. Both supplied keys returned HTTP 403 because that model requires paid AI Gateway credits. The owner then identified `alibaba/qwen3.7-flash` as available with free credits, and short requests through the runner's provider resolver returned `OK` with both environment keys.

New organisations use `gateway/alibaba/qwen3.7-flash` for both act and judge. Existing saved model settings remain in effect, and administrators can choose any supported provider, including GLM once their Gateway account has paid credits. Keys remain per-organisation BYOK, with separate keys for production and preprod.

The catalog checked on 2026-10-03 lists Qwen Flash's base tier (context up to 32k tokens) at $0.03 input, $0.006 cached input and $0.13 output per million tokens. Longer contexts use higher tiers; the flat organisation price table is an estimate, and administrators can override it for their workload. GLM-5.3-Flash estimates are $0.15/$0.03/$0.50. Reported provider cost takes precedence over estimates.
