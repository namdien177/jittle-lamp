# AI-driven E2E test cases: delivery status

Single progress log for `feat/e2e-test-cases`. One row per unit from handover §5, plus phase 2 (design.md §12) and ops units. `commit` is the last commit of the unit.

Status values: `todo`, `in progress`, `done`, `blocked: model key`, `blocked: <reason>`.

| Unit | Scope | Status | Commit | Notes |
| --- | --- | --- | --- | --- |
| 0.1 | Transcript schema and parser (`packages/shared/src/test-case.ts`) | done | 77f9a77 | `tests/test-case-contracts.test.ts` (33 tests): grammar, multi-case + dataset, stable ids, lossless round trip, 13 lint rules as data with fixes, macro expansion with version in key. Review pass: 12 findings fixed in 77f9a77. |
| 0.2 | Archive v4 + viewer-core step filter | done | 02684b3 | v3 upgraded on parse, extension writes v3 via `toExtensionWireArchive`; step chips + filter + seek in desktop and web; `PARITY-STEP-01` in parity checklist and `tests/review-e2e-parity.test.ts`. Review pass: 8 findings fixed in 02684b3. UI screenshot recorded with real runner evidence in 0.5. |
| 0.3 | Runner package skeleton, config chain, `mock:` provider | done | 4d00742 | `packages/e2e-runner`: plan → generated `case.e2e.ts`/`e2e.config.ts` (names only), `jl-e2e run/config/cache`, provider by id prefix incl. `mock:` and a claude-code bridge. Tests: `packages/e2e-runner/test` (28). Review pass: 13 findings fixed in 4d00742. |
| 0.4 | Cache store and reporter | done | 4d00742 | File `cache.store` in `.e2e/cache` with step mapping and rendered Playwright; progress reporter; run report from `report.json` + `ai-trace.json`. Browser test asserts run 2 replays all acts with 0 act calls. |
| 0.5 | Trace → archive v4 and upload | done | 4d00742 | Archive v4 with step annotations/tags, `--upload` to `/automation/evidences/zip`. Evidence: `evidence/0.5-web-viewer-steps-2.png` (step filter + seek in web viewer). Secret-leak grep in `browser/run-e2e.browser.test.ts`. run-report.json is not in the upload ZIP (endpoint accepts two files); it attaches in 1a.6. |
| 0.6 | Spike run against UAT, gate decision | done | (this commit) | PCF UAT, `claude-code/sonnet`: run 1 passed agent-driven, run 2 passed with 4/4 acts replayed and 0 act model calls; tokens and cost per step. Reports and screenshots in `docs/e2e-test-cases/evidence/0.6-*`. Gate: keep e2e (design §14, ADR 10). |
| 1a.1 | Backend tables and migration | done | 429c6f8 | Migrations 0022+ only add; `apps/backend/test/test-case-migrations.test.ts` applies them on a clean DB. |
| 1a.2 | Permissions and policy | done | 59a19eb | `test-case-policy.test.ts`. Review: leaving `review` by any route now needs `test_case.approve`; duplicates of review cases stay in review (133075f, `review-gate.test.ts`). |
| 1a.3 | Secrets service | done | bcf8732 | AES-256-GCM per-org data key; `test-config-secrets.test.ts`. |
| 1a.4 | Routes | done | 4f22c83 | `test-case-routes`, `test-run-routes`, `test-config-routes`, `test-integration-fixes` tests. Duplicates inherit macro child scripts. Review fixes: Jira import needs `test_config.use`, step scripts scoped to the run's environment, stored non-http links dropped one by one, query coercion only for known numeric/boolean keys. Beta acceptance (`packages/e2e-runner/browser/beta-acceptance.browser.test.ts`, 7 tests) runs runner + CLI + cache against this backend. |
| 1a.5 | Queue and worker contract | done | 058e3c2 | Leases, requeue, RUNNER_LOST, NO_RUNNER; `test-run-queue.test.ts`. Review fixes: claim no longer extends leases, revoked workers lose run tokens and their runs requeue, org check before batch refresh, dedupe partial unique index (migration 0026), atomic rate-limit bucket, guarded progress, per-AI-token bucket (merge of `feat/e2e-1a-fix`). |
| 1a.6 | Run finalisation | done | f2ca470 | Retries, script verification, retention; `test-run-finalize.test.ts`. Review fixes: uncompressed-size caps for XLSX (20 MB) and evidence/automation ZIPs (200 MB), evidence link limited to the run's own upload. |
| 1a.7 | Notifications (in-app) | done | 2a440c7 | Bus with in-app channel; Slack channel comes with 2.2. |
| 1b.1 | Runner daemon | done | c88b00d | Register once (credential mode 600), heartbeat, claim, per-run config, progress with per-step screenshot, evidence ZIP, finalise. Stand-in contract test (`browser/daemon.browser.test.ts`) and real backend (`beta-acceptance.browser.test.ts`). Self-hosted on this machine against PCF UAT with `claude-code/sonnet`: run 1 passed agent-driven (15 model calls, $0.43), run 2 replayed 4/4 acts ($0.07): `evidence/1b-selfhosted-pcf-run{1-agent,2-replay}.run.json`, `evidence/1b-selfhosted-pcf-run2-web.png`. Review: 14 findings fixed in 05d062b. |
| 1b.2 | Backend-backed cache store | done | 6aa0f71 | Replay from `/test-runs/:id/cache/:keyHash` verified against the real backend in the beta acceptance test and the self-hosted PCF run. |
| 1b.3 | CLI extras (`env pull`, `export`, `push`, `--suite --wait --junit`) | done | fcfc368 | `test/remote.test.ts` plus the beta acceptance test with a minted automation token (suite run, JUnit). |
| 1c.1 | Web: list and detail | done | 3f9c634 | Screenshots `evidence/1c-list.png`, `1c-quick-create.png`, `1c-sessions.png`. Review: 15 findings across 1c fixed (org-scoped query keys, keyboard and a11y, dirty guard, run polling backoff). DoD item 1 through the UI: `scripts/dev/beta-ui-flow.ts`, screenshots `evidence/dod1-1..6-*.png` (editor paste, tags, run dialog, live progress, step seek, re-run with 4/4 acts replayed and 0 model calls). |
| 1c.2 | Web: structured step editor | done | efae8f0 | `packages/ui` step editor; `evidence/1c-steps-editor.png`, `1c-text-toggle.png`. Review: serializer dropped rows starting with `#`, `//`, `[x]`; now written as `[Act] …` (a908d72) with round-trip tests. |
| 1c.3 | Web: run detail | done | d4c6825 | Shared `RunStepList` in `packages/ui`; `evidence/1c-run-detail.png`, `1c-run-blocked.png`, `1c-scripts.png`. |
| 1c.4 | Web: import, review queue, duplicate | done | 9609438 | `evidence/1c-import-*.png`, `1c-review-queue.png`, `1c-duplicate-dialog.png`. |
| 1c.5 | Web: settings | done | e7231c0 | `evidence/1c-settings-*.png`, `1c-notification-bell.png`. |
| 1d.1 | Desktop queue client + `jittle-lamp://run` | done | a8b8c4c | `evidence/1d-*.png`. Review fixes (935aa0d): http(s)-only links via the system browser, IPC sender check, cloud evidence fetched by the main process from the build-time API origin with size cap, macOS deep link with no window, list refresh. |
| 1d.2 | MCP tools | done | aead87a | Test case, macro, import and run tools; AI tokens create cases in review only, macros forced to draft (0510178). |
| 1e | Docs (`docs/mcp.md`, runner setup, `.env.sample`) | done | 7e920da | `runner-setup.md` (ops.2), `onboarding-qa.md` (ops.6), `.env.sample` (ops.7), `docs/mcp.md` (ops.5). |
| 2.1 | GitLab and GitHub webhooks with status reporting (§10c) | todo | | |
| 2.2 | Slack notification channel (§10b) | todo | | |
| 2.3 | Live view of cloud runs with take-over (§5.4) | in progress | e0a4217 | Runner side done: frames while watched, take-over pauses before the next agent action, input replayed and tagged `user:takeover`, nothing cached (browser test). Backend endpoints and web panel pending. |
| 2.4 | Agent notes per organisation | todo | | |
| 2.5 | GitHub Actions and GitLab CI templates | done | cbb8c75 | `deploy/ci/github-actions-e2e.yml`, `deploy/ci/gitlab-ci-e2e.yml` run a suite through the runner image with JUnit; end-to-end demonstration with an automation token comes with 1b.3. |
| ops.1 | Dockerfile and compose for the cloud runner pool | done | cbb8c75 | `deploy/runner/{Dockerfile,compose.yaml,runner.env.sample}`; image built locally and ran the fixture case with the mock model inside the container; CI job `build_runner_image`. |
| ops.2 | systemd unit and `runner-setup.md` | done | ef0a1a6 | `deploy/runner/jl-e2e-runner.service`, `docs/e2e-test-cases/runner-setup.md`. |
| ops.3 | Evidence retention job running | done | f2ca470 | `applyTestRunRetention` runs in the backend's hourly maintenance loop (`apps/backend/src/index.ts`), moving expired test-run evidence to the bin per org retention settings; `test-run-finalize.test.ts`. |
| ops.4 | Model cost per organisation in the UI | done | 31aef8f | Settings → Model spend, by user and model, from repriced run usage; `evidence/1c-model-spend.png`. |
| ops.5 | `docs/mcp.md` updated | done | 7e920da | Tools, permissions, automation-token and AI-token access, Jira-only generation. |
| ops.6 | QA engineer onboarding guide | done | cbb8c75 | `docs/e2e-test-cases/onboarding-qa.md`. |
| ops.7 | `.env.sample` updated | done | (this commit) | Backend `JL_SECRETS_MASTER_KEY*`; runner and CLI section (`JL_API_ORIGIN`, `JL_API_TOKEN`, `JL_RUNNER_*`, `JL_MODEL`, `JL_JUDGE_MODEL`, `JL_SECRET_NAMES`, `JL_ALLOW_CLAUDE_CODE`). |

## Beta definition of done (handover §6)

| Item | Proof |
| --- | --- |
| Create, tag, run on the cloud pool, watch progress, step-seek, re-run with zero model calls for unchanged Acts | UI: `scripts/dev/beta-ui-flow.ts`, `evidence/dod1-1..6-*.png`. API: `beta-acceptance.browser.test.ts` test 1. |
| Self-hosted runner on a devbox against PCF UAT | `evidence/1b-selfhosted-pcf-run1-agent.run.json`, `1b-selfhosted-pcf-run2-replay.run.json`, `1b-selfhosted-pcf-run2-web.png` (runner on this machine, local backend, `claude-code/sonnet`). |
| Two requests attach to one run; a third within the window attaches to the finished run unless forced | `beta-acceptance.browser.test.ts` test 1; `apps/backend/test/test-run-routes.test.ts`; race: `run-request-concurrency.test.ts`. |
| `.feature` and Jira JQL import give review items with lint and similarity; approving makes them runnable | `beta-acceptance.browser.test.ts` test 4. |
| Duplicate with find/replace replays unchanged steps on its first run | `beta-acceptance.browser.test.ts` test 3. |
| Model ids, tokens, cost, duration per run; ten-run averages per case | `beta-acceptance.browser.test.ts` test 2; `evidence/1c-run-detail.png`. |
| Automation token runs a suite from CI through the CLI with JUnit | `beta-acceptance.browser.test.ts` test 5; templates in `deploy/ci/`. |
| No secret value in transcript, model input, archive, rendered code, report, log or API response | `beta-acceptance.browser.test.ts` test 7 (greps run artifacts, stored evidence, DB rows and API responses for the fixture password); `run-e2e.browser.test.ts`; `daemon.browser.test.ts`. |

## ADR amendments

None yet.

## Log

- 2026-10-03: review fixes merged (backend 10+1, web 15, desktop/MCP 11). Runner now names steps on their first progress update (180219e; found by the UI flow). All suites green after merge: root 448, backend 167, MCP 46, runner unit 32, runner browser 19 (incl. beta acceptance 7).

- 2026-10-03: 1a, 1c and 1d merged into this branch. One credential alias rule (`resolveCredentialAlias` in shared) for runner and backend. Self-hosted runner on this machine ran the PCF case through the local backend twice (agent, then full replay). Independent reviews: backend 10 findings, web 15, desktop/MCP 11; fixes run in `feat/e2e-1a-fix`, `feat/e2e-1c-core`, `feat/e2e-1c-admin`, `feat/e2e-1d`. Phase 2 (2.1-2.4) in `feat/e2e-phase2`.

- 2026-10-03: shared HTTP contract committed (0db109d). Backend 1a delegated to one engineer (sequential units). Web 1c.1-1c.3, web 1c.4/1c.5/ops.4 and desktop/MCP 1d run in parallel worktrees (`feat/e2e-1c-core`, `feat/e2e-1c-admin`, `feat/e2e-1d`) against the contract and merge back after review. Runner daemon, backend cache store, CLI extras, runner image, systemd unit, CI templates, onboarding guide and the runner side of live view done on this branch.

- 2026-10-03: phase 0 done. 0.3 to 0.5 in `packages/e2e-runner`; review found 13 issues (secret params in labels, JSON redaction, claude-code tools, exit-code and cancel mapping, built CLI paths), all fixed with tests. 0.6 spike on PCF UAT passed both runs; the example transcript needed two corrections for an HQ admin (recorded in design §14). Gate: keep Tester Army e2e.

- 2026-10-03: 0.1 done. Parser, serializer, lint and macros in `packages/shared/src/test-case.ts`; independent review found Vietnamese word-boundary, secret-scan and round-trip gaps, all fixed with regression tests.
- 2026-10-03: 0.2 done. Archive v4 (`recorder.kind`, `step` annotations, step tags on console/network). Review found a broken manual-upload path, lost step tags in the desktop catalog and a desktop highlight bug; fixed with tests.
- 2026-10-03: branch `feat/e2e-test-cases` created from `origin/feat/e2e-test-cases-design` (5214921). Baseline: typecheck, root tests (248), backend tests (85), MCP tests (27), backend lint and version check green. Dev-auth backend env generated with `bun run dev:test-auth:setup`.
