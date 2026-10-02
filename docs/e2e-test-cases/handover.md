# Handover: AI-driven E2E test cases

For the agent or engineer who implements this feature. Read this first, then the spec. Nothing in this document repeats the spec; it tells you where things are, what was decided, what is still an assumption, and what to build in which order.

## 1. What you are building

Jittle Lamp today records browser sessions and stores them as evidence. This feature adds **test cases**: a transcript of natural-language steps with checkpoints, executed by an AI agent in a real browser, recorded as evidence, cached per step as a replayable action record, and run through a per-organisation queue on a cloud or self-hosted runner pool. Target: open beta.

| Document | Purpose |
| --- | --- |
| `docs/adr/0002-ai-driven-e2e-test-cases.md` | 17 decisions. If the spec and the ADR disagree, the ADR wins; update the spec. |
| `docs/e2e-test-cases/design.md` | The spec: data model (§3), transcript grammar (§4), runner and execution core (§5), API (§6), UI and authoring (§7), MCP (§8), config and secrets (§9), queue (§10), notifications (§10b), webhooks (§10c), security (§11), phasing (§12), decided questions (§13), beta gaps (§14). |
| `docs/e2e-test-cases/plan-viewer.html` | Interactive version of the plan with UI mockups. Open it in Chrome. The transcript parser inside it is a reference implementation of the grammar, not production code. |
| `docs/e2e-test-cases/examples/pcf-logout-clears-email.transcript.md` | A real transcript to use as the first fixture. |

The owner's answers to the final questions are in design.md §14 and ADR decisions 3, 11, 14 to 17. Do not reopen them without the owner.

## 2. Repository facts you need

Read `CLAUDE.md` and `AGENTS.md` at the repo root. The points that bite this feature:

- Bun workspace, strict TypeScript ESM, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (use `import type`). Cross-process and persisted payloads are Zod schemas in `packages/shared`.
- Build order matters: `shared` → `viewer-core` → `viewer-react`; apps consume `dist`. After changing `packages/shared`, run `bun run --cwd packages/shared build` before an app's bundler sees it. `tsc` uses path aliases to `src`, so typecheck does not need the build.
- Only `apps/backend` is Biome-linted; a pre-commit hook runs it when backend files are staged. Backend tables are one file each under `apps/backend/src/db/tables/`, re-exported from `db/schema.ts`; after changing them run `bun run --cwd apps/backend db:generate` and commit the migration under `apps/backend/drizzle/`. Dialect is Turso/libSQL.
- Tests: Bun test runner. Cross-package contract tests in root `tests/` (`*.test.ts`, see `tests/session-contracts.test.ts` for the style). Backend tests in `apps/backend/test/`. Run targeted files while working, `bun run typecheck` and `bun test` before a PR.
- You are in a git worktree (`t3code/5771ebba`). The spec files are untracked there; commit them in your first PR. Never use bare `git stash`.
- Commits: imperative, scoped (`backend: add test case tables`). PRs need a problem statement, summary, tests run, screenshots for UI.
- Versions of all apps and packages are kept in sync by `release:check-version`; a new workspace package must carry the current version (`1.8.2` at handover).

Existing code to reuse, with the files that matter:

| Need | Reuse |
| --- | --- |
| Organisation scoping and permissions | `apps/backend/src/services/active-organization.ts`, `organization-permissions.ts` (add `test_case.*`, `test_run.*`, `test_config.*`), `evidence-policy.ts` for the pattern |
| Lease-based background jobs | `apps/backend/src/services/migration-worker.ts` and the lease columns on `organizationMigrationRuns` in `db/tables/organization-migrations.ts` |
| AI-token route allowlist | `apps/backend/src/services/ai-user-access.ts` (new test-case and run routes must be added here to be reachable from `jl_ai_` tokens) |
| Evidence creation from an automation run | `apps/backend/src/routes/automation.ts` (`POST /automation/evidences/zip`, `sourceType: "automation-test"`) and the upload start/complete flow in `routes/evidence-uploads.ts` |
| Artifact storage | `apps/backend/src/services/artifact-storage.ts`; keys are built inline in routes (`uploads/${orgId}/${evidenceId}/…`) |
| Org-managed tag definitions | `db/tables/evidence-tags.ts` (`organizationEvidenceTags`) as the model for `organization_test_tags` |
| Session archive schema | `packages/shared/src/session.ts` (`sessionArchiveSchema`, `archiveRecorderInfoSchema`, `archiveAnnotationSchema`); `session-io.ts` for parsing and file names |
| Viewer | `packages/viewer-core` (state, timeline), `packages/viewer-react`; both desktop and web render the same viewer (ADR 0001, `docs/parity-checklist.md`) |
| MCP server | `apps/mcp/src/tools.ts`, `server.ts`, `client.ts`; tool registration pattern with Zod inputs |
| Web app route placeholder | `apps/evidence-web/src/router.tsx` (`test-cases` → `ComingSoonPage`), `components/workspace/workspace-shell.tsx` |
| Desktop RPC | `apps/desktop/src/rpc.ts` + `electron/main.ts` (add handler and type together) |

The manual workflow this feature replaces lives outside the repo in the owner's Claude skill `~/.claude/skills/littlelives-test-with-evidence/` (`scripts/record-flow.mjs`, `scripts/jl-evidence.mjs`, `references/runner-contract.md`). Read `record-flow.mjs` once: its `checks`/`verify` model and the `behaviorStatus`/`evidenceStatus` split are the origin of the two-level verdict. Credentials for the spike are already provisioned; see §4b.

## 3. External dependencies, pinned at handover (2026-10-03)

| Dependency | Version seen | Notes |
| --- | --- | --- |
| Tester Army `e2e` | 0.16.0, Apache-2.0, `ai` peer `^7.0.0`, Node ≥ 22.12, `@e2e-dev/web` engine | Docs: https://e2e.tester.army/docs (index at `/docs/llms.txt`). Key pages: `cache`, `executors`, `reference/config`, `reference/reporters`, `reference/agent`, `writing-an-engine`. No programmatic run API: runs through `e2e run` over `*.e2e.ts` + `e2e.config.ts`. Extension points we rely on: `cache.store`, `reporters`, `artifacts.store`, `agents.<name>.executor`. |
| Vercel AI SDK | `ai` v7, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` | Agent API `ToolLoopAgent`, `isStepCount`; usage fields `inputTokens`, `inputTokenDetails.cacheReadTokens`, `outputTokens`, `outputTokenDetails.reasoningTokens`, `totalTokens`; per-step via `steps[].usage` and `onStepEnd`. The SDK returns tokens, not cost. |
| Playwright | `playwright-core` (match `e2e`'s dev pin, 1.63 at handover) | Chromium for cloud and self-hosted runners; installed Chrome only for `--headed` local runs. |
| Electron | 44.5.0 in `apps/desktop` | Bundled Node satisfies ≥ 22.12 should anything run in the desktop process; by decision 3 nothing does. |
| Anthropic model ids | `anthropic/claude-opus-5-5` (act), `anthropic/claude-sonnet-5-5` (judge) | AI SDK id form. Price table seeded in `test_model_prices`. |

Pin exact versions in `package.json`; `e2e` is pre-1.0 and its engine version is part of its cache key.

## 4. Assumptions the phase 0 spike must confirm

These were researched, not tested. Each has a fallback already decided.

1. **`e2e` works as our execution core through a generated test file.** Fallback: own loop on AI SDK `ToolLoopAgent` keeping `e2e`'s cache record format (ADR 10 lists the four trigger conditions).
2. **Per-step token usage can be read from `ai-trace.json`** reliably enough for `test_run_steps` metrics. Fallback: `createToolLoopExecutor` with our own usage accounting through `ctx.budgets`.
3. **A Playwright trace converts to archive v4** with everything the viewer timeline needs (network with headers and bodies, console, DOM interactions, screenshots per step). Fallback: run a CDP network listener alongside, as the extension does in `apps/extension/src/background.ts` (`Network.enable`, `requestWillBeSent`, `getResponseBody`).
4. **`Input.setIgnoreInputEvents` blocks Playwright's own CDP input too.** Expected. Fallback is the injected shield (design.md §5.4), only relevant to `--headed` local runs.
5. **Trace redaction** drops screencast frames; confirm the separate `video` recording is enough for evidence.

Write the outcome of each into design.md §14 at the end of phase 0.

## 4b. Test environments and accounts (provisioned 2026-10-03)

- `docs/e2e-test-cases/examples/uat-environments.seed.json`: five UAT environments (`qa-preschool-sg-uat` is the default for browser E2E, then `pcf-uat`, `ilham-uat`, `happyschool-uat`, `newlife-uat`) with base URLs, parent-portal URLs as variables, six credential profiles with usernames, agent instructions, and `runnerPool: self-hosted:devbox`. Use it to seed `test_environments`, `test_credentials` and the first macro `Login`. No secret is in the file.
- Secrets are on the owner's machine in `~/.config/jittle-lamp/e2e/<env>.env` (chmod 600), one file per environment, in the `JL_ENV_*` / `JL_VAR_*` / `JL_CRED_*` names from design.md §9.2. Run the spike with `--env-file ~/.config/jittle-lamp/e2e/pcf-uat.env`. The owner provides these files or the backend credentials; do not look for the source they were generated from.
- `docs/e2e-test-cases/examples/.env.e2e.sample` lists every variable the runner reads, including the model key and automation token. `.env.e2e` and `.e2e/` are gitignored.
- OTP inputs on all UAT tenants accept one fixed test code, stored as `JL_VAR_OTP_CODE` and registered for redaction like a secret. Parent portals log in with the primary applicant email. ILHAM card-payment guidance lives in the owner's skill and applies only to that tenant.
- Reachability of `*.uat.sv.littlelives.com` from the cloud pool is unverified; the seed binds every environment to a self-hosted pool until a cloud runner proves it can reach them.

## 5. Build order

Each line is one PR-sized unit. Dependencies run top to bottom inside a phase; phases 1a to 1d can proceed in parallel once phase 0 lands.

### Phase 0: spike (CLI only, no backend changes)

| # | Unit | Where | Done when |
| --- | --- | --- | --- |
| 0.1 | Transcript schema and parser | `packages/shared/src/test-case.ts`, export from `index.ts`; tests in `tests/test-case-contracts.test.ts` | Parses the grammar in design.md §4 and §7 (tags, `[Tag: a=1, b=2]`, `## Checkpoint:`, bare text = Act, unknown tag = macro, `{var}`, multi-case document with metadata lines and `## Dataset` tables). Stable `stepId` by `instructionKey` across edits. Lint rules from §4 and §7 as data, not UI. Round-trip document → model → document is lossless. |
| 0.2 | Archive v4 | `packages/shared/src/session.ts`, `session-io.ts`; `viewer-core` reads `step` annotations; tests in `tests/session-contracts.test.ts`, `tests/viewer-core.test.ts` | `schemaVersion: 4`, `recorder.kind: "browser-extension" \| "e2e-runner"`, annotation `step`. `parseSessionArchiveJson` upgrades v3 in memory. Extension untouched. Viewer filters timeline by `step:<id>` tag. |
| 0.3 | Runner package skeleton | `packages/e2e-runner` (`bin`: `jl-e2e`), depends on `e2e`, `@e2e-dev/web`, `ai`, `@ai-sdk/anthropic`, `playwright-core`, `@jittle-lamp/shared` | `jl-e2e run <file.transcript.md> --env-file .env.e2e` generates `case.e2e.ts` + `e2e.config.ts` into a temp project, runs `e2e run`, writes `.e2e/report.json`. Config resolution chain from §9.2 with masked `jl-e2e config`. |
| 0.4 | Cache store and reporter | `packages/e2e-runner/src/cache/`, `src/report/` | File-backed `cache.store` in `.e2e/cache`; `Reporter` captures step events; `ai-trace.json` parsed into per-step usage; `RunReport` written. Rendered Playwright per cached step. |
| 0.5 | Trace → archive v4 and upload | `packages/e2e-runner/src/evidence/` | Produces `recording.webm`, `session.archive.json` (v4, step tags and annotations, lifecycle per step), `run-report.json`; `--upload` posts a ZIP to `POST /automation/evidences/zip` with an automation token; evidence opens in the web viewer with step filter. |
| 0.6 | Spike run | the example transcript against a real PCF or ILHAM UAT case from `_bdd` | Run 1 agent-driven, run 2 replays every Act step with zero model calls for Acts, token and cost per step present, evidence reviewable. Record §4 outcomes and the gate decision in design.md §14. |

### Phase 1: beta

| # | Unit | Where |
| --- | --- | --- |
| 1a.1 | Tables and migration | `apps/backend/src/db/tables/test-*.ts` for every table in §3.1 (cases, versions, datasets, suites, step scripts, runs, run steps, run batches, subscribers, model prices, environments, credentials with `secret_fields_enc`, macros, tags, import batches and items, runner pools and workers, notification events/channels/deliveries); FTS5 table for cases; `db:generate` |
| 1a.2 | Permissions and policy | `organization-permissions.ts` (`test_case.view/create/update/approve/delete`, `test_run.create/cancel/cancel_any/view`, `test_config.manage/use`), default role grants, `services/test-case-policy.ts` |
| 1a.3 | Secrets service | `services/test-config.ts`: AES-256-GCM, per-org data key wrapped by `JL_SECRETS_MASTER_KEY`, `key_version`, pluggable provider; add the variable to `.env.sample`; activity log on every decrypt |
| 1a.4 | Routes | `routes/test-cases.ts` (list with FTS, create, update with re-parse and version bump, duplicate with script inheritance, bulk, similar, import batch), `routes/test-runs.ts` (create with dedupe and throttle, progress PATCH, cancel, config token and config), `routes/test-config.ts` (environments, credentials, macros, tags, model key), `routes/runner-pools.ts` (pools, registration, heartbeat, claim); add all to `ai-user-access.ts` |
| 1a.5 | Queue and worker contract | claim statement with per-pool `max_concurrent_runs`, lease, heartbeat, requeue after expiry, `RUNNER_LOST` after 3 attempts; `dedupe_key`; token bucket per user and per token |
| 1a.6 | Run finalisation | metrics from `run-report.json`, cost from `test_model_prices`, evidence link with `sourceType: "test-run"`, retention policy job added to `evidence-maintenance.ts` |
| 1a.7 | Notifications | `notification_events` producers for the six beta events, `in_app` channel, unread API |
| 1b.1 | Runner daemon | `packages/e2e-runner/src/daemon/`: `jl-e2e-runner start --token`, registration, poll and claim, config token, inject `JL_*` env, run, stream progress with step screenshots, upload, finalise; Dockerfile for the cloud pool; systemd unit example for a self-hosted devbox |
| 1b.2 | Backend-backed cache store | `cache.store` over `test_step_scripts` when a run token is present |
| 1b.3 | CLI extras | `env pull`, `export`, `push`, `--suite --wait --junit` |
| 1c.1 | Web: list and detail | replace `ComingSoonPage` for `test-cases`; master-detail list (virtualised, FTS, tag namespaces in the sidebar, saved views, bulk bar, keyboard map in §7); detail with Steps / Test sessions / Scripts tabs |
| 1c.2 | Web: structured step editor | type chips, `/` `[` `{` `@` `#` pickers, inline lint with fixes, snapshot-derived element suggestions, macro expansion, metadata form, Text toggle; consider placing editor components in `packages/ui` so the desktop app can reuse them |
| 1c.3 | Web: run detail | step list with mode and timing, click seeks `viewer-react` to `video_offset_ms` and filters by step tag, live progress while running, attached and queued badges |
| 1c.4 | Web: import, review queue, duplicate | import wizard (document, `.feature`, CSV/XLSX mapping, Jira JQL), batch page, review queue with `a`/`x`/`e`, duplicate dialog |
| 1c.5 | Web: settings | Environments (with `runner_pool`, agent instructions), Credentials (masked, rotate), Macros, Tags, AI model (BYOK), Runner pools (registration token, worker list), Test runs (concurrency, dedupe window, caps), Notifications |
| 1d.1 | Desktop | same pages as web as a queue client, in-app notifications, `jittle-lamp://run?runId=` protocol handler in `electron/main.ts` with the RPC type in `rpc.ts` |
| 1d.2 | MCP tools | `apps/mcp`: the tools listed in design.md §8; `run_test_case` creates a run on the backend (no local companion path any more) |
| 1e | Docs | `docs/mcp.md` additions, a `docs/e2e-test-cases/runner-setup.md` for self-hosted pools, `.env.sample` |

Phase 2 and 3 are in design.md §12; do not start them during the beta.

## 6. Definition of done for the beta

- A QA engineer creates a case in the web app with the step editor, tags it, runs it on the cloud pool, watches step progress, reviews the run with step-seek in the viewer, re-runs and sees replayed steps with zero model calls for unchanged Acts.
- A self-hosted runner on a devbox executes a case against PCF UAT behind VPN.
- Two people requesting the same case attach to one run; a third request within the dedupe window attaches to the finished run unless forced.
- Importing a `.feature` file and a Jira JQL produces review-queue items with lint and similarity; approving makes them runnable.
- Duplicating a case with find/replace replays unchanged steps on its first run.
- Each run shows model ids, tokens, cost and duration; the case shows ten-run averages.
- An automation token runs a suite from a CI job through the CLI and gets JUnit output.
- No secret value appears in a transcript, snapshot sent to the model, archive, rendered code, report, log or API response. Add a test that greps run artifacts for the fixture password.

## 7. Working rules for this feature

- Every cross-process payload (runner ↔ backend, web ↔ backend, MCP ↔ backend) is a Zod schema in `packages/shared/src/test-case.ts` or a sibling file. Do not define parallel types in apps.
- Evidence produced by runs must open in both the desktop and web viewer; add the case to `docs/parity-checklist.md` and `tests/review-e2e-parity.test.ts`.
- Keep the extension untouched except the archive version bump path; it keeps writing v3.
- `e2e` upgrades: pin, read its changelog, re-run the spike case before bumping. Its engine version invalidates every cached script.
- Backend code is Biome-formatted; run `bun run --cwd apps/backend lint:fix` before committing.
- UI follows the existing evidence-web tokens and the motion rules used in the plan viewer: transitions under 250 ms with the custom ease-out curve, `scale(0.97)` on press, no animation on keyboard-triggered actions, `prefers-reduced-motion` respected.
- Report what the spike proves, not what the plan hoped. If the gate flips to the own-loop fallback, say so in design.md §5.0 and ADR 10 before writing the loop.

## 8. First week, concretely

1. Commit the four spec files from this worktree.
2. PR 0.1 (parser) with the example transcript and a multi-case fixture; include the lint rules as pure functions with tests.
3. PR 0.2 (archive v4) with viewer-core support and parity test.
4. PR 0.3 to 0.5 (runner CLI) as one branch, three commits.
5. Run the spike (0.6) with `~/.config/jittle-lamp/e2e/pcf-uat.env` or the qa-preschool-sg file, write the findings into design.md §14, decide the gate with the owner.
